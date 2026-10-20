/**
 * minamo L2: `agent()` and `tool()`, a small durable agent runner on top of {@link Durable}.
 *
 * Operation tree of one run (names are the contract `@minamojs/lambda-df/callbacks` reads back):
 *   <key>                          scope: the run; records { output, newMessages, turns, finish, historyUpTo }
 *     history-head                 step (with `conversation`)
 *     model-<turn>                 step: one model call, recorded as one assistant message plus `finish`
 *     tools-<turn>:<callId>        scope per tool call, opened in call order
 *       $human:<name>              scope per human request (`approval` or `ask(name)`)
 *         request                  step: { v: 1, requestId, kind, summary }
 *         wait                     signal
 *       run                        step (plain tools); workflow tools add their own operations here
 *     history-append               step (with `conversation`)
 *
 * User functions that run outside steps must be pure and deterministic: schema validation and transforms,
 * `approval.when`, `approval.request`, and `output` validation.
 */

import {
  defaultModelRetry, defaultToolRetry, parse, SignalTimeoutError, stringify,
  type Duration, type Durable, type Retry, type ToolCall,
} from "./durable.js";

// ---------------------------------------------------------------------------------------------------------------
// Standard Schema and Standard JSON Schema (https://standardschema.dev), copied as the spec asks: no dependency.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    /** Standard JSON Schema: zod 4.2+ and ArkType have it; Valibot needs `toStandardJsonSchema()`. */
    readonly jsonSchema?: { readonly input: (options: { readonly target: string }) => Record<string, unknown> };
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }> };

export type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];

async function validate<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const result = await schema["~standard"].validate(value);
  if (!result.issues) return { ok: true, value: result.value };
  return {
    ok: false,
    error: result.issues.map(issue => {
      const path = issue.path?.map(segment => String(typeof segment === "object" ? segment.key : segment)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }).join("; "),
  };
}

function jsonSchemaOf(name: string, schema: StandardSchemaV1, given?: Record<string, unknown>): Record<string, unknown> {
  if (given) return given;
  const converter = schema["~standard"].jsonSchema;
  if (!converter) throw new Error(`Tool "${name}": the schema has no Standard JSON Schema; pass \`jsonSchema\` as well`);
  const { $schema: _, ...json } = converter.input({ target: "draft-07" });
  return json;
}

// ---------------------------------------------------------------------------------------------------------------
// Messages and the model contract. Minimal and provider-neutral: reasoning, images, and documents are not modeled.

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: unknown };
export type ToolResultPart = { type: "tool_result"; id: string; name: string } & ({ status: "ok"; output: unknown } | { status: "error"; error: string });
export type Part = TextPart | ToolCallPart | ToolResultPart;
/** Tool results travel in `user` messages, as in the Bedrock and Anthropic APIs. */
export type Message = { role: "user" | "assistant"; content: Part[] };

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export type Finish = { reason: string; usage?: Usage };
export type ModelEvent = TextPart | ToolCallPart | ({ type: "finish" } & Finish);
export type ModelRequest = { system?: string; messages: readonly Message[]; tools: readonly ToolSpec[] };

export interface Model {
  readonly id: string;
  /** Retry policy for the model step. Default: {@link defaultModelRetry}. Disable the provider SDK's own retries. */
  readonly retry?: Retry;
  /** Streams one response. Adapters join tool input fragments and emit each tool call whole. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

// ---------------------------------------------------------------------------------------------------------------
// Human in the loop.

export type HumanRequestKind = "approval" | "input";

/** The public part of a human request: safe to show the approver, the requester, and logs. */
export type HumanRequestSummary = { requestId: string; kind: HumanRequestKind; tool: string; request: unknown; expiresAt?: string };

/** Secret: `token` completes the request. Keep it on the server. */
export type HumanRequest = HumanRequestSummary & {
  token: string;
  executionId: string;
  runKey: string;
  agent: string;
  callId: string;
  input: unknown;
  summary: HumanRequestSummary;
};

/** What approvers send. Only `approved: true` (the boolean) approves; anything else denies. */
export type ApprovalAnswer = { approved: boolean; reason?: string };

export type AgentEvent = { runKey: string } & (
  | { kind: "run_started" }
  | { kind: "model_start"; call: number; attempt: number }
  | { kind: "text"; call: number; attempt: number; text: string }
  | { kind: "tool"; tool: string; callId: string; status: "started" | "ok" | "error"; result?: ToolResultPart }
  | { kind: "human_requested"; summary: HumanRequestSummary }
  | { kind: "done"; turns: number; finish: Finish }
  | { kind: "failed"; error: string }
);

export type Hooks = {
  /** Hands a human request to whoever answers it. Runs once per request, but at-least-once across crashes: dedupe by `requestId`. */
  onHumanRequest?: (request: HumanRequest) => Promise<void>;
  /** Live, provisional events. At-least-once; replays do not resend model text. Errors are ignored. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
};

/** `executionId/runKey/turn/callId/name`, each part URI-encoded. Unique across executions; not a secret. */
export function requestIdOf(parts: { executionId: string; runKey: string; turn: number; callId: string; name: string }): string {
  return [parts.executionId, parts.runKey, String(parts.turn), parts.callId, parts.name].map(encodeURIComponent).join("/");
}

export function parseRequestId(requestId: string): { executionId: string; runKey: string; turn: number; callId: string; name: string } {
  const parts = requestId.split("/");
  if (parts.length !== 5 || !/^\d+$/.test(parts[2]!)) throw new Error(`Not a minamo requestId: ${requestId}`);
  const [executionId, runKey, turn, callId, name] = parts.map(decodeURIComponent) as [string, string, string, string, string];
  return { executionId, runKey, turn: Number(turn), callId, name };
}

/** Recorded by the `request` step of every human request; `@minamojs/lambda-df/callbacks` reads it back. */
export type HumanRequestEnvelope = { v: 1; requestId: string; kind: HumanRequestKind; summary: HumanRequestSummary };

// ---------------------------------------------------------------------------------------------------------------
// Tools.

export type Approval<I> = true | {
  /** Pure. Default: always ask. */
  when?(input: I): boolean;
  timeout?: Duration;
  /** Pure. What the approver sees (`summary.request`). Default: the validated input. */
  request?(input: I): unknown;
};

export type ToolRunContext = {
  /** `executionId/runKey/turn/callId`: the same on every retry, replay, and resume. Pass it to external APIs. */
  idempotencyKey: string;
  call: ToolCall;
  attempt: number;
};

export type Ask = <T = unknown>(name: string, options?: { request?: unknown; schema?: StandardSchemaV1<unknown, T>; timeout?: Duration }) => Promise<T>;

export type WorkflowContext = {
  /** The tool call's scope. Names starting with `$` are reserved. */
  durable: Durable;
  /** Asks a human for input and waits. Each name once per tool call; `approval` is taken when the tool has `approval`. */
  ask: Ask;
  idempotencyKey: string;
  call: ToolCall;
};

type ToolBase<S extends StandardSchemaV1> = {
  description: string;
  input: S;
  /** JSON Schema for the model, when `input` lacks Standard JSON Schema. */
  jsonSchema?: Record<string, unknown>;
  approval?: Approval<InferOutput<S>>;
};

export type AgentTool = ToolBase<StandardSchemaV1> & {
  retry?: Retry;
  run?: (input: never, ctx: ToolRunContext) => unknown;
  workflow?: (input: never, ctx: WorkflowContext) => Promise<unknown>;
};

/** Declares a tool. `run` is one step; `workflow` gets its own scope and may use durable operations and `ask`. */
export function tool<S extends StandardSchemaV1>(definition: ToolBase<S> & {
  /** Default: up to 3 attempts, retrying only `RetryableError`. Other errors become error results for the model. */
  retry?: Retry;
  run: (input: InferOutput<S>, ctx: ToolRunContext) => unknown;
}): AgentTool;
export function tool<S extends StandardSchemaV1>(definition: ToolBase<S> & {
  workflow: (input: InferOutput<S>, ctx: WorkflowContext) => Promise<unknown>;
}): AgentTool;
export function tool(definition: AgentTool): AgentTool {
  return definition;
}

// ---------------------------------------------------------------------------------------------------------------
// Conversation history.

/** Thrown when another run already appended this sequence number. Does not undo the run's side effects. */
export class HistoryConflictError extends Error {
  override name = "HistoryConflictError";
}

/** Thrown when a run's messages exceed what the store can hold in one entry. Does not undo the run's side effects. */
export class HistoryTooLargeError extends Error {
  override name = "HistoryTooLargeError";
}

export interface HistoryStore {
  /** Sequence number of the last stored run; 0 for a new conversation. Must see the latest append. */
  head(conversationId: string): Promise<number>;
  /** Messages of runs 1..upTo, complete and in order. Never returns partial history: throws instead. */
  read(conversationId: string, upTo: number): Promise<Message[]>;
  /**
   * Stores run `seq`. If it exists: same `writeId` succeeds without changing it, another throws
   * {@link HistoryConflictError}. The same `writeId` always comes with the same messages.
   */
  append(conversationId: string, seq: number, messages: Message[], writeId: string): Promise<void>;
}

/** In-memory {@link HistoryStore} for tests and local runs. */
export function memoryHistory(): HistoryStore {
  const conversations = new Map<string, Map<number, { text: string; writeId: string }>>();
  return {
    async head(id) {
      return conversations.get(id)?.size ?? 0;
    },
    async read(id, upTo) {
      const runs = conversations.get(id);
      const messages: Message[] = [];
      for (let seq = 1; seq <= upTo; seq++) {
        const run = runs?.get(seq);
        if (!run) throw new Error(`Conversation ${id} has no run ${seq}`);
        messages.push(...parse<Message[]>(run.text));
      }
      return messages;
    },
    async append(id, seq, messages, writeId) {
      const runs = conversations.get(id) ?? conversations.set(id, new Map()).get(id)!;
      const existing = runs.get(seq);
      if (existing) {
        if (existing.writeId === writeId) return;
        throw new HistoryConflictError(`Conversation ${id} already has run ${seq}`);
      }
      runs.set(seq, { text: stringify(messages), writeId });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Agent.

export type RunOptions = {
  /** Identity of the run inside the execution; unique across the execution. No clocks, random values, or counters. */
  key: string;
  prompt: string;
} & (
  | { history?: readonly Message[]; conversation?: never }
  | { conversation: { id: string; store: HistoryStore }; history?: never }
);

export type RunResult<O> = {
  output: O;
  /** History plus `newMessages`. */
  messages: Message[];
  /** This run's messages; pass them as the next run's `history`. */
  newMessages: Message[];
  turns: number;
  finish: Finish;
  /** With `conversation`: the history this run continued from (runs 1..historyUpTo). */
  historyUpTo?: number;
};

export interface Agent<O> {
  readonly name: string;
  run(durable: Durable, options: RunOptions, hooks?: Hooks): Promise<RunResult<O>>;
}

export type AgentConfig<S extends StandardSchemaV1 | undefined> = {
  name: string;
  model: Model;
  instructions?: string;
  tools?: Record<string, AgentTool>;
  /** Structured output, returned through a synthesized `final_result` tool. Default: the final text. */
  output?: S;
  /** Default 10. */
  maxTurns?: number;
};

const FINAL = "final_result";
const NUDGE = `Call ${FINAL} to return the final answer.`;

/** Run keys seen per `Durable`, to catch two runs sharing a key within one invocation. */
const runKeys = new WeakMap<Durable, Set<string>>();

type RunState<O> = Omit<RunResult<O>, "messages">;
type HumanOutcome = { status: "answered"; value: unknown } | { status: "expired" } | { status: "failed"; error: string };
type Emit = (event: AgentEvent extends infer E ? E extends unknown ? Omit<E, "runKey"> : never : never) => Promise<void>;

export function agent<S extends StandardSchemaV1 | undefined = undefined>(
  config: AgentConfig<S>,
): Agent<S extends StandardSchemaV1 ? InferOutput<S> : string> {
  type O = S extends StandardSchemaV1 ? InferOutput<S> : string;
  const { name, model, instructions, output, maxTurns = 10 } = config;
  const tools = config.tools ?? {};
  if (output && FINAL in tools) throw new Error(`Tool name "${FINAL}" is reserved when \`output\` is set`);
  const specs: ToolSpec[] = Object.entries(tools).map(([toolName, t]) => ({
    name: toolName, description: t.description, inputSchema: jsonSchemaOf(toolName, t.input, t.jsonSchema),
  }));
  if (output) specs.push({ name: FINAL, description: "Returns the final answer. Call it alone, once.", inputSchema: jsonSchemaOf(FINAL, output) });
  const needsHuman = Object.values(tools).some(t => t.approval);

  async function run(durable: Durable, options: RunOptions, hooks: Hooks = {}): Promise<RunResult<O>> {
    if (options.history && options.conversation) throw new Error("Pass `history` or `conversation`, not both");
    if (needsHuman && !hooks.onHumanRequest) throw new Error(`Agent "${name}" has tools with approval but no onHumanRequest hook`);
    const keys = runKeys.get(durable) ?? runKeys.set(durable, new Set()).get(durable)!;
    if (keys.has(options.key)) throw new Error(`Run key "${options.key}" is already used in this execution`);
    keys.add(options.key);
    const state = await durable.scope(options.key, scope => loop(scope, durable.executionId, options, hooks));
    const before = options.conversation
      ? await options.conversation.store.read(options.conversation.id, state.historyUpTo!)
      : options.history ?? [];
    return { ...state, messages: [...before, ...state.newMessages] };
  }

  async function loop(scope: Durable, executionId: string, options: RunOptions, hooks: Hooks): Promise<RunState<O>> {
    const runKey = options.key;
    const emit: Emit = async event => {
      try {
        await hooks.onEvent?.({ runKey, ...event } as AgentEvent);
      } catch {
        // Live events are provisional; a failed publish must not fail or retry the work.
      }
    };
    try {
      const { conversation } = options;
      let history = options.history ?? [];
      let upTo: number | undefined;
      if (conversation) {
        upTo = await scope.step("history-head", () => conversation.store.head(conversation.id));
        // Runs 1..upTo never change, so every replay reads the same history.
        history = await conversation.store.read(conversation.id, upTo);
      }
      const newMessages: Message[] = [{ role: "user", content: [{ type: "text", text: options.prompt }] }];
      let finish: Finish = { reason: "unknown" };
      for (let turn = 1; turn <= maxTurns; turn++) {
        const step = await scope.step(`model-${turn}`, async ({ attempt }) => {
          if (turn === 1 && attempt === 1) await emit({ kind: "run_started" });
          await emit({ kind: "model_start", call: turn, attempt });
          const content: Part[] = [];
          let finish: Finish = { reason: "unknown" };
          for await (const event of model.stream({ system: instructions, messages: [...history, ...newMessages], tools: specs })) {
            if (event.type === "text") {
              if (!event.text) continue;
              const last = content.at(-1);
              if (last?.type === "text") last.text += event.text;
              else content.push({ type: "text", text: event.text });
              await emit({ kind: "text", call: turn, attempt, text: event.text });
            } else if (event.type === "tool_call") {
              content.push({ type: "tool_call", id: event.id, name: event.name, input: event.input });
            } else {
              finish = { reason: event.reason, ...(event.usage && { usage: event.usage }) };
            }
          }
          return { message: { role: "assistant", content } satisfies Message, finish };
        }, { retry: model.retry ?? defaultModelRetry });
        newMessages.push(step.message);
        finish = step.finish;
        const calls = step.message.content.filter(part => part.type === "tool_call");
        if (calls.length === 0) {
          if (output) {
            newMessages.push({ role: "user", content: [{ type: "text", text: NUDGE }] });
            continue;
          }
          const text = step.message.content.map(part => part.type === "text" ? part.text : "").join("");
          return await done(text as O, turn);
        }
        const { results, final } = await runCalls(scope, executionId, runKey, turn, calls, hooks, emit);
        newMessages.push({ role: "user", content: results });
        if (final) return await done(final.value as O, turn);
      }
      throw new Error(`Agent "${name}" gave no final answer in ${maxTurns} turns`);

      async function done(value: O, turns: number): Promise<RunState<O>> {
        if (conversation) {
          await scope.step("history-append", () => conversation.store.append(
            conversation.id, upTo! + 1, newMessages, [executionId, runKey].map(encodeURIComponent).join("/"),
          ));
        }
        await emit({ kind: "done", turns, finish });
        return { output: value, newMessages, turns, finish, ...(upTo !== undefined && { historyUpTo: upTo }) };
      }
    } catch (error) {
      if (error instanceof Error) await emit({ kind: "failed", error: error.message });
      throw error;
    }
  }

  async function runCalls(
    scope: Durable, executionId: string, runKey: string, turn: number, calls: ToolCallPart[], hooks: Hooks,
    emit: Emit,
  ): Promise<{ results: ToolResultPart[]; final?: { value: unknown } }> {
    const finals = calls.filter(call => output && call.name === FINAL);
    let final: { value: unknown } | undefined;
    // Scopes open synchronously in call order, so completion order never changes operation identity.
    const results = await Promise.all(calls.map(async (call): Promise<ToolResultPart> => {
      const base = { type: "tool_result", id: call.id, name: call.name } as const;
      if (output && call.name === FINAL) {
        if (finals.length > 1) return { ...base, status: "error", error: `Call ${FINAL} exactly once.` };
        if (calls.length > 1) return { ...base, status: "error", error: `Not accepted: look at the other tool results first, then call ${FINAL} alone in the next turn.` };
        const checked = await validate(output, call.input);
        if (!checked.ok) return { ...base, status: "error", error: `Invalid final result: ${checked.error}` };
        final = { value: checked.value };
        return { ...base, status: "ok", output: "Final result accepted." };
      }
      return scope.scope(`tools-${turn}:${call.id}`, async child => {
        const result = await callTool(child, { executionId, runKey, turn, call }, hooks, emit);
        await emit({ kind: "tool", tool: call.name, callId: call.id, status: result.status, result });
        return result;
      });
    }));
    return { results, ...(final && { final }) };
  }

  async function callTool(
    durable: Durable, at: { executionId: string; runKey: string; turn: number; call: ToolCallPart }, hooks: Hooks,
    emit: Emit,
  ): Promise<ToolResultPart> {
    const { call } = at;
    const base = { type: "tool_result", id: call.id, name: call.name } as const;
    const fail = (error: string): ToolResultPart => ({ ...base, status: "error", error });
    const definition = tools[call.name];
    if (!definition) return fail(`Unknown tool: ${call.name}`);
    const checked = await validate(definition.input, call.input);
    if (!checked.ok) return fail(`Invalid input: ${checked.error}`);
    const input = checked.value as never;
    const toolCall: ToolCall = { id: call.id, name: call.name, input: call.input };
    const idempotencyKey = [at.executionId, at.runKey, String(at.turn), call.id].map(encodeURIComponent).join("/");
    const asked = new Set<string>();

    const human = (requestName: string, kind: HumanRequestKind, request: unknown, timeout?: Duration): Promise<HumanOutcome> => {
      if (asked.has(requestName)) throw new Error(`Human request "${requestName}" is already used in this tool call`);
      asked.add(requestName);
      const onHumanRequest = hooks.onHumanRequest;
      if (!onHumanRequest) throw new Error(`Tool "${call.name}" asks a human, but the run has no onHumanRequest hook`);
      return durable.scope(`$human:${requestName}`, async scope => {
        const requestId = requestIdOf({ executionId: at.executionId, runKey: at.runKey, turn: at.turn, callId: call.id, name: requestName });
        const envelope = await scope.step("request", async (): Promise<HumanRequestEnvelope> => {
          const expiresAt = timeout && new Date(Date.now() + seconds(timeout) * 1000).toISOString();
          return { v: 1, requestId, kind, summary: { requestId, kind, tool: call.name, request, ...(expiresAt && { expiresAt }) } };
        });
        try {
          const value = await scope.signal<unknown>("wait", async token => {
            await onHumanRequest({
              ...envelope.summary, token, executionId: at.executionId, runKey: at.runKey, agent: name, callId: call.id,
              input: call.input, summary: envelope.summary,
            });
            await emit({ kind: "human_requested", summary: envelope.summary });
          }, timeout && { timeout });
          return { status: "answered", value };
        } catch (error) {
          // Anything but an Error is an engine's control flow (a crash in the memory engine): let it through.
          if (!(error instanceof Error)) throw error;
          if (error instanceof SignalTimeoutError || error.name === "SignalTimeoutError") return { status: "expired" };
          return { status: "failed", error: error.message };
        }
      });
    };

    const { approval } = definition;
    if (approval && (approval === true || (approval.when?.(input) ?? true))) {
      const settings = approval === true ? {} : approval;
      const outcome = await human("approval", "approval", settings.request ? settings.request(input) : checked.value, settings.timeout);
      if (outcome.status === "expired") return fail("The approval request expired before anyone answered. The tool did not run.");
      if (outcome.status === "failed") return fail(`The approval request failed: ${outcome.error}. The tool did not run.`);
      const answer = outcome.value;
      if (!answer || typeof answer !== "object") return fail("The approval answer was invalid. The tool did not run.");
      const { approved, reason } = answer as Partial<ApprovalAnswer>;
      if (approved !== true) {
        return fail(`A human denied this tool call${typeof reason === "string" && reason ? `: ${reason}` : ""}. The tool did not run.`);
      }
    }

    if (definition.workflow) {
      const ask: Ask = async (requestName, options = {}) => {
        if (requestName.startsWith("$")) throw new Error(`ask("${requestName}"): names starting with "$" are reserved`);
        const outcome = await human(requestName, "input", options.request, options.timeout);
        if (outcome.status === "expired") throw new Error(`Nobody answered "${requestName}" before it expired`);
        if (outcome.status === "failed") throw new Error(`Asking "${requestName}" failed: ${outcome.error}`);
        if (!options.schema) return outcome.value as never;
        const answer = await validate(options.schema, outcome.value);
        // The callback is spent, so the same token cannot be answered again: the tool fails.
        if (!answer.ok) throw new Error(`Invalid answer to "${requestName}": ${answer.error}`);
        return answer.value;
      };
      try {
        await emit({ kind: "tool", tool: call.name, callId: call.id, status: "started" });
        const result = await definition.workflow(input, { durable: reserved(durable), ask, idempotencyKey, call: toolCall });
        return { ...base, status: "ok", output: result ?? null };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return fail(error.message);
      }
    }

    const run = definition.run!;
    const retry = definition.retry ?? defaultToolRetry;
    try {
      // Business errors are returned as data inside the step, so they are recorded once and never retried.
      return await durable.step("run", async (info): Promise<ToolResultPart> => {
        if (info.attempt === 1) await emit({ kind: "tool", tool: call.name, callId: call.id, status: "started" });
        try {
          return { ...base, status: "ok", output: (await run(input, { idempotencyKey, call: toolCall, attempt: info.attempt })) ?? null };
        } catch (error) {
          if (error instanceof Error && retry.when?.(error) !== false) throw error;
          return fail(String(error instanceof Error ? error.message : error));
        }
      }, { retry });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Retries exhausted: the model sees the failure instead of the execution dying.
      return fail(error.message);
    }
  }

  return { name, run } as Agent<O>;
}

/** Keeps workflow operations out of the `$` namespace that minamo uses inside a tool call's scope. */
function reserved(durable: Durable): Durable {
  const check = (name: string) => {
    if (name.startsWith("$")) throw new Error(`Durable operation names starting with "$" are reserved: ${name}`);
  };
  return {
    executionId: durable.executionId,
    step: (name, fn, options) => (check(name), durable.step(name, fn, options)),
    scope: (name, fn) => (check(name), durable.scope(name, fn)),
    signal: (name, publish, options) => (check(name), durable.signal(name, publish, options)),
  };
}

function seconds({ days = 0, hours = 0, minutes = 0, seconds = 0 }: Duration): number {
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}
