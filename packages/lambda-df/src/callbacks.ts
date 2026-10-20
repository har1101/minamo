/**
 * The answering side of minamo's human requests on Lambda durable functions, without a store of pending requests:
 * the execution's own history says what is waiting. Requires `@aws-sdk/client-lambda`.
 *
 * Matching rule (no guessing at "nearby" callbacks): decode the requestId, read every history page, group events by
 * operation `Id`, then follow `Name` and `ParentId` from the run scope (runKey) to `tools-<turn>:<callId>` to
 * `$human:<name>`. Its `request` step holds the envelope; the open callback is the one `CallbackStarted` among its
 * descendants that has no Succeeded, Failed, or TimedOut event. SDK-internal child names are never used.
 *
 * Authorize before calling: that the execution belongs to the caller (before reading), and that the caller may
 * answer this request (before answering). A requestId is not a secret and proves nothing.
 */
import {
  GetDurableExecutionHistoryCommand, LambdaClient, LambdaServiceException, SendDurableExecutionCallbackSuccessCommand, type Event,
} from "@aws-sdk/client-lambda";
import {
  parse, parseRequestId, requestIdOf, stringify,
  type ApprovalAnswer, type HumanRequestEnvelope, type HumanRequestKind, type HumanRequestSummary,
} from "@minamojs/minamo";

export type PendingRequest = { requestId: string; summary: HumanRequestSummary };

/**
 * - `sent`: the answer was accepted; the first accepted answer wins.
 * - `closed`: nothing to answer any more: expired, already answered, or the execution ended.
 * - `unknown`: the connection or the service failed after sending, so the answer may or may not have been accepted.
 * Throttling, access denied, and other errors are thrown as is.
 */
export type AnswerResult = { status: "sent" } | { status: "closed" } | { status: "unknown"; error: Error };

/** The history does not show exactly one request to answer. Never a reason to send anything. */
export class RequestLookupError extends Error {
  override name = "RequestLookupError";
  constructor(readonly reason: "invalid" | "not-found" | "not-waiting" | "ambiguous" | "unreadable", message: string) {
    super(message);
  }
}

export interface Callbacks {
  /**
   * Requests of one execution that can be answered now. Reads the whole history with payloads (one call per page,
   * against a 15 calls/s account quota): call it on first display, reload, or refresh, not on a polling loop.
   */
  pending(executionArn: string): Promise<PendingRequest[]>;
  approve(requestId: string, options?: { reason?: string }): Promise<AnswerResult>;
  reject(requestId: string, reason?: string): Promise<AnswerResult>;
  /** Answers an `ask()`; the tool validates the value against its schema. */
  answer(requestId: string, value: unknown): Promise<AnswerResult>;
}

type Operation = {
  id: string;
  name?: string;
  parentId?: string;
  kind?: string;
  ended: boolean;
  result?: { payload?: string; truncated?: boolean };
  callbackId?: string;
};

type Found = { requestId: string; envelope?: HumanRequestEnvelope; open: Operation[]; closed: number };

type History = { operations: Map<string, Operation>; children: Map<string, Operation[]>; ended: boolean; executionArn: string };

const KINDS = ["Execution", "Context", "Step", "Callback", "Wait", "ChainedInvoke", "Invocation"];
const EXECUTION_END = new Set(["ExecutionSucceeded", "ExecutionFailed", "ExecutionTimedOut", "ExecutionStopped"]);
const OPERATION_END = new Set(["ContextSucceeded", "ContextFailed", "StepSucceeded", "CallbackSucceeded", "CallbackFailed", "CallbackTimedOut"]);
const NETWORK_ERROR = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|socket hang up|TimeoutError|NetworkingError|RequestTimeout|aborted/i;

export function callbacks(options: { client?: LambdaClient } = {}): Callbacks {
  const client = options.client ?? new LambdaClient({});

  async function read(executionArn: string): Promise<History> {
    const events: Event[] = [];
    let marker: string | undefined;
    do {
      const page = await client.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: executionArn, IncludeExecutionData: true, Marker: marker }));
      if (!page.Events) throw new RequestLookupError("unreadable", `History of ${executionArn} has no events`);
      events.push(...page.Events);
      marker = page.NextMarker;
    } while (marker);

    // One operation per `Id`; its start and end events are state changes of the same operation.
    const operations = new Map<string, Operation>();
    let ended = false;
    for (const event of events) {
      const type = event.EventType ?? "";
      if (EXECUTION_END.has(type)) ended = true;
      if (!event.Id) continue;
      const operation = operations.get(event.Id) ?? operations.set(event.Id, { id: event.Id, ended: false }).get(event.Id)!;
      operation.name ??= event.Name;
      operation.parentId ??= event.ParentId;
      operation.kind ??= KINDS.find(kind => type.startsWith(kind));
      if (OPERATION_END.has(type)) operation.ended = true;
      if (type === "CallbackStarted") operation.callbackId = event.CallbackStartedDetails?.CallbackId;
      if (type === "StepSucceeded") {
        const result = event.StepSucceededDetails?.Result;
        operation.result = { payload: result?.Payload, truncated: result?.Truncated };
      }
    }
    const children = new Map<string, Operation[]>();
    for (const operation of operations.values()) {
      if (operation.parentId) (children.get(operation.parentId) ?? children.set(operation.parentId, []).get(operation.parentId)!).push(operation);
    }
    return { operations, children, ended, executionArn };
  }

  /** Every `$human:<name>` scope in the history, with what its record and callbacks say. */
  function humanRequests({ operations, children, executionArn }: History): Found[] {
    const found: Found[] = [];
    for (const human of operations.values()) {
      if (human.kind !== "Context" || !human.name?.startsWith("$human:")) continue;
      const tools = human.parentId ? operations.get(human.parentId) : undefined;
      const run = tools?.parentId ? operations.get(tools.parentId) : undefined;
      const call = tools?.name?.match(/^tools-(\d+):(.*)$/s);
      if (!call || tools?.kind !== "Context" || run?.kind !== "Context" || !run.name) {
        throw new RequestLookupError("unreadable", `Unexpected history shape around ${human.name}`);
      }
      const requestId = requestIdOf({ executionId: executionArn, runKey: run.name, turn: Number(call[1]), callId: call[2]!, name: human.name.slice("$human:".length) });
      const callbackOps: Operation[] = [];
      const queue = [...children.get(human.id) ?? []];
      for (let operation; (operation = queue.shift());) {
        if (operation.kind === "Callback") callbackOps.push(operation);
        queue.push(...children.get(operation.id) ?? []);
      }
      const record = children.get(human.id)?.find(child => child.kind === "Step" && child.name === "request" && child.result);
      if (record?.result?.truncated || (record && record.result?.payload === undefined)) {
        throw new RequestLookupError("unreadable", `The record of ${requestId} is truncated or missing; read it with IncludeExecutionData`);
      }
      const envelope = record && parse<HumanRequestEnvelope>(record.result!.payload!);
      if (envelope && (envelope.v !== 1 || envelope.requestId !== requestId)) {
        throw new RequestLookupError("unreadable", `The record of ${requestId} has an unknown format`);
      }
      const open = callbackOps.filter(operation => !operation.ended);
      if (open.some(operation => !operation.callbackId)) throw new RequestLookupError("unreadable", `A callback of ${requestId} has no CallbackId`);
      found.push({ requestId, envelope, open, closed: callbackOps.length - open.length });
    }
    return found;
  }

  async function send(requestId: string, kind: HumanRequestKind, value: unknown): Promise<AnswerResult> {
    let executionArn: string;
    try {
      executionArn = parseRequestId(requestId).executionId;
    } catch (error) {
      throw new RequestLookupError("invalid", error instanceof Error ? error.message : String(error));
    }
    const history = await read(executionArn);
    const matches = humanRequests(history).filter(found => found.requestId === requestId);
    if (matches.length === 0) throw new RequestLookupError("not-found", `No request ${requestId} in the history`);
    if (matches.length > 1) throw new RequestLookupError("ambiguous", `${matches.length} requests match ${requestId}`);
    const [match] = matches as [Found];
    if (match.envelope && match.envelope.kind !== kind) {
      throw new RequestLookupError("invalid", `${requestId} is a ${match.envelope.kind} request, not ${kind}`);
    }
    if (history.ended) return { status: "closed" };
    if (match.open.length > 1) throw new RequestLookupError("ambiguous", `${match.open.length} open callbacks under ${requestId}`);
    if (match.open.length === 0) {
      if (match.closed > 0) return { status: "closed" };
      throw new RequestLookupError("not-waiting", `${requestId} is not waiting for an answer yet`);
    }
    if (!match.envelope) throw new RequestLookupError("unreadable", `${requestId} waits without a request record`);
    try {
      await client.send(new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: match.open[0]!.callbackId, Result: new TextEncoder().encode(stringify(value)),
      }));
      return { status: "sent" };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Service errors carry response metadata; a dropped connection has none.
      const metadata = error instanceof LambdaServiceException ? error.$metadata : undefined;
      // Expired and already answered look the same. After a retry, the first attempt may have been the one accepted.
      if (error.name === "CallbackTimeoutException") return (metadata?.attempts ?? 1) > 1 ? { status: "unknown", error } : { status: "closed" };
      const status = metadata?.httpStatusCode;
      if ((status === undefined && NETWORK_ERROR.test(`${error.name} ${error.message}`)) || (status !== undefined && status >= 500)) {
        return { status: "unknown", error };
      }
      throw error;
    }
  }

  return {
    async pending(executionArn) {
      const history = await read(executionArn);
      if (history.ended) return [];
      return humanRequests(history).flatMap(found => {
        if (found.open.length === 0) return [];
        if (found.open.length > 1) throw new RequestLookupError("ambiguous", `${found.open.length} open callbacks under ${found.requestId}`);
        if (!found.envelope) throw new RequestLookupError("unreadable", `${found.requestId} waits without a request record`);
        return [{ requestId: found.requestId, summary: found.envelope.summary }];
      });
    },
    approve: (requestId, { reason } = {}) => send(requestId, "approval", { approved: true, ...(reason && { reason }) } satisfies ApprovalAnswer),
    reject: (requestId, reason) => send(requestId, "approval", { approved: false, ...(reason && { reason }) } satisfies ApprovalAnswer),
    answer: (requestId, value) => send(requestId, "input", value),
  };
}
