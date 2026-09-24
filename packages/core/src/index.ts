/**
 * minamo core: durable primitives for AI agent loops. Web standard APIs only: no `node:` imports, no Buffer,
 * no AsyncLocalStorage. Engines (`minamo/lambda`, `minamo/memory`) implement {@link Durable}.
 *
 * Portability rule: every durable operation has a unique, deterministic name within its scope AND the core starts
 * operations in a fixed order. Name-keyed engines (Cloudflare Workflows, the memory engine) need the first;
 * call-order-keyed engines (Lambda) need the second.
 */

export type Duration = { seconds?: number; minutes?: number; hours?: number; days?: number };

/** Declarative retry policy; every engine can express it (Lambda retryStrategy, Cloudflare `retries`, ...). */
export type Retry = {
  /** Total attempts including the first. */
  maxAttempts: number;
  initialDelay?: Duration;
  maxDelay?: Duration;
  backoffRate?: number;
  /** Errors worth another attempt. Default: all. */
  when?: (error: Error) => boolean;
};

export type StepInfo = { attempt: number };

export interface Durable {
  /** Stable for the whole execution, across replays and resumes. */
  readonly executionId: string;
  /** Runs `fn` and records its result. Without `retry` it runs once. `fn` must not use durable operations. */
  step<T>(name: string, fn: (info: StepInfo) => Promise<T>, options?: { retry?: Retry }): Promise<T>;
  /** Runs `fn` in a child scope that may use durable operations. A completed scope replays its recorded result. */
  scope<T>(name: string, fn: (child: Durable) => Promise<T>): Promise<T>;
  /** Suspends until someone completes `token` with a JSON value. `publish` hands the token out; keep it idempotent. */
  signal<T>(name: string, publish: (token: string) => Promise<void>, options?: { timeout?: Duration }): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------------------
// Codec: every engine persists values through this, so durable values are JSON plus Uint8Array (Web base64).

const BYTES = "$bytes";

export function stringify(value: unknown): string {
  return JSON.stringify(value ?? null, function (this: Record<string, unknown>, key, current) {
    const original = this[key];
    if (!(original instanceof Uint8Array)) return current;
    let binary = "";
    for (const byte of original) binary += String.fromCharCode(byte);
    return { [BYTES]: btoa(binary) };
  });
}

export function parse<T>(text: string): T {
  return JSON.parse(text, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const keys = Object.keys(current);
      if (keys.length === 1 && keys[0] === BYTES && typeof current[BYTES] === "string") {
        return Uint8Array.from(atob(current[BYTES]), c => c.charCodeAt(0));
      }
    }
    return current;
  }) as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Model calls: one step per call; the stream is recorded and replayed as an event array.

export type ModelCallOptions<E> = {
  /** Default: up to 4 attempts, retrying throttling, 5xx, timeouts, and dropped connections. */
  retry?: Retry;
  /** Live, provisional events while the step runs. A retried attempt streams again with a new `attempt`. */
  onEvent?: (event: E, info: StepInfo) => void | Promise<void>;
};

const TRANSIENT_MODEL_ERROR = /throttl|too many requests|rate.?limit|overloaded|service.?unavailable|internal.?server|ModelNotReady|timed? ?out|ECONNRESET|socket hang up/i;

const defaultModelRetry: Retry = {
  maxAttempts: 4, initialDelay: { seconds: 2 }, maxDelay: { seconds: 30 },
  when: error => TRANSIENT_MODEL_ERROR.test(`${error.name} ${error.message}`),
};

/** Runs one model call as one step and returns every event it streamed. A replay returns the recorded events. */
export async function model<E>(
  durable: Durable,
  name: string,
  call: () => AsyncIterable<E> | Promise<AsyncIterable<E>>,
  options: ModelCallOptions<E> = {},
): Promise<E[]> {
  return durable.step(name, async info => {
    const captured: E[] = [];
    for await (const event of await call()) {
      captured.push(event);
      await options.onEvent?.(event, info);
    }
    return captured;
  }, { retry: options.retry ?? defaultModelRetry });
}

// ---------------------------------------------------------------------------------------------------------------
// Tools.

/** Throw from a tool to retry its step. Any other error is a business result shown to the model. */
export class RetryableError extends Error {
  override name = "RetryableError";
}

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolContext = {
  /** `<executionId>#<tool call id>`: identical on every retry, replay, and resume. Pass it to external APIs. */
  idempotencyKey: string;
};

export type Tool<I = never> =
  | {
    /** Plain tool: one step. Must not use durable operations. */
    run: (input: I, ctx: ToolContext & StepInfo) => Promise<unknown>;
    /** Default: up to 3 attempts, retrying only {@link RetryableError}. */
    retry?: Retry;
    workflow?: never;
  }
  | {
    /** Workflow tool: runs in its own scope and may use steps and signals (approvals, sub-agents, waits). */
    workflow: (input: I, ctx: ToolContext & { durable: Durable }) => Promise<unknown>;
    run?: never;
  };

export type ToolResult = { id: string; name: string } & ({ status: "ok"; output: unknown } | { status: "error"; error: string });

const defaultToolRetry: Retry = {
  maxAttempts: 3, initialDelay: { seconds: 1 }, maxDelay: { seconds: 30 },
  when: error => error instanceof RetryableError || error.name === "RetryableError",
};

/**
 * Runs one model turn's tool calls concurrently. Each call gets its own scope, opened synchronously in call order,
 * so completion order never changes operation identity.
 */
export function runTools(durable: Durable, turn: string, calls: readonly ToolCall[], tools: Record<string, Tool>): Promise<ToolResult[]> {
  // Inputs are model output and are not validated here; each tool validates its own input.
  return Promise.all(calls.map(call => durable.scope(`${turn}:${call.id}`, child => runTool(child, call, tools[call.name]))));
}

async function runTool(durable: Durable, call: ToolCall, tool: Tool | undefined): Promise<ToolResult> {
  const input = call.input as never;
  const base = { id: call.id, name: call.name };
  if (!tool) return { ...base, status: "error", error: `Unknown tool: ${call.name}` };
  const ctx: ToolContext = { idempotencyKey: `${durable.executionId}#${call.id}` };
  try {
    if (tool.workflow) return { ...base, status: "ok", output: await tool.workflow(input, { ...ctx, durable }) };
    const retry = tool.retry ?? defaultToolRetry;
    // Business errors are returned as data inside the step, so they are recorded once and never retried.
    return await durable.step("run", async (info): Promise<ToolResult> => {
      try {
        return { ...base, status: "ok", output: await tool.run(input, { ...ctx, ...info }) };
      } catch (error) {
        if (error instanceof Error && retry.when?.(error) !== false) throw error;
        return { ...base, status: "error", error: String(error instanceof Error ? error.message : error) };
      }
    }, { retry });
  } catch (error) {
    // Retries exhausted (or a workflow failed): the model sees the failure instead of the execution dying.
    return { ...base, status: "error", error: String(error instanceof Error ? error.message : error) };
  }
}
