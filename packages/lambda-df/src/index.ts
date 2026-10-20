import {
  CallbackTimeoutError, createRetryStrategy, withDurableExecution, type DurableContext, type DurableLambdaHandler, type Serdes,
} from "@aws/durable-execution-sdk-js";
import {
  parse, SignalTimeoutError, stringify,
  type Agent, type Duration, type Durable, type Hooks, type Message, type HistoryStore, type Retry, type RunResult, type StepInfo,
} from "@minamojs/minamo";

/** Binary-safe JSON for every scope result the core writes. */
function serdes<T>(): Serdes<T> {
  return {
    serialize: async value => value === undefined ? undefined : stringify(value),
    deserialize: async data => data === undefined ? undefined : parse<T>(data),
  };
}

/** Step results are serialized inside the step (see {@link encodeStep}), so the checkpoint stores the text as is. */
const passthrough: Serdes<string | undefined> = { serialize: async value => value, deserialize: async data => data };

/**
 * Lambda caps a checkpoint payload at 1 MB (raised from 256 KB on 2026-10-13). AWS does not say whether that is
 * 10^6 or 2^20 bytes, so this takes the smaller one: failing slightly early beats failing after the work is done.
 */
const STEP_PAYLOAD_LIMIT = 1_000_000;

/** Deterministic, so never retried: another attempt would redo the work (e.g. a model call) and fail the same way. */
class StepTooLargeError extends Error {
  override name = "StepTooLargeError";
}

/** An oversized result fails its step with a clear error, instead of failing the checkpoint after the work is done. */
function encodeStep(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const encoded = stringify(value);
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so most results skip the byte count.
  if (encoded.length * 3 > STEP_PAYLOAD_LIMIT) {
    const bytes = new TextEncoder().encode(encoded).length;
    if (bytes > STEP_PAYLOAD_LIMIT) {
      throw new StepTooLargeError(`Step "${name}" result is ${bytes} bytes; Lambda durable functions record at most ${STEP_PAYLOAD_LIMIT} bytes per step`);
    }
  }
  return encoded;
}

// Without `retry` an operation runs once on every engine, instead of falling back to the SDK's default retries.
const noRetry = () => ({ shouldRetry: false });

/** Lambda durable functions engine. Operation IDs come from call order, which the core keeps fixed. */
export function lambda(context: DurableContext): Durable {
  const executionId = context.executionContext.durableExecutionArn;
  return {
    executionId,
    // SDK operations take their ID and start when called, so the core calling them in a fixed order keeps IDs stable.
    // Promise.resolve only turns the SDK's DurablePromise thenable into a real Promise, as `Durable` promises.
    step<T>(name: string, fn: (info: StepInfo) => Promise<T>, options?: { retry?: Retry }) {
      return Promise.resolve(context.step(name, async step => encodeStep(name, await fn({ attempt: step.attempt })), {
        serdes: passthrough, retryStrategy: options?.retry ? retryStrategy(options.retry) : noRetry,
      })).then(result => result === undefined ? undefined as T : parse<T>(result));
    },
    scope<T>(name: string, fn: (child: Durable) => Promise<T>) {
      return Promise.resolve(context.runInChildContext(name, child => fn(lambda(child)), { serdes: serdes<T>() }));
    },
    async signal<T>(name: string, publish: (token: string) => Promise<void>, options?: { timeout?: Duration }) {
      let raw: string | undefined;
      try {
        // `publish` runs as the SDK's submitter step, which would otherwise get the SDK's default retries.
        raw = await context.waitForCallback(name, token => publish(token), {
          retryStrategy: noRetry, ...(options?.timeout && { timeout: seconds(options.timeout) }),
        });
      } catch (error) {
        if (error instanceof CallbackTimeoutError) throw new SignalTimeoutError(error.message);
        throw error;
      }
      return parse<T>(raw || "null");
    },
  };
}

export type HandleOptions<E> = Hooks & {
  /** The user prompt of this execution. */
  prompt: (event: E) => string;
  /** Run key. Default: the agent's name. */
  key?: string;
} & (
  | { history?: (event: E) => readonly Message[]; conversation?: never }
  | { conversation: (event: E) => { id: string; store: HistoryStore }; history?: never }
);

/** What `handle(agent)` returns from the execution: the run result without `messages`, which would repeat the history. */
export type HandleResult<O> = Omit<RunResult<O>, "messages">;

/**
 * Lambda handler for one agent run per durable execution, or for your own function of `Durable`.
 * Deploy it with `DurableConfig` and invoke a published version or alias.
 */
export function handle<E, O>(agent: Agent<O>, options: HandleOptions<E>): DurableLambdaHandler;
export function handle<E, R>(fn: (event: E, durable: Durable) => Promise<R>): DurableLambdaHandler;
export function handle<E>(target: Agent<unknown> | ((event: E, durable: Durable) => Promise<unknown>), options?: HandleOptions<E>): DurableLambdaHandler {
  if (typeof target === "function") return withDurableExecution((event: E, context: DurableContext) => target(event, lambda(context)));
  const { prompt, key = target.name, history, conversation, onHumanRequest, onEvent } = options!;
  return withDurableExecution(async (event: E, context: DurableContext): Promise<HandleResult<unknown>> => {
    const { messages: _, ...result } = await target.run(lambda(context), {
      key, prompt: prompt(event), ...(conversation ? { conversation: conversation(event) } : { history: history?.(event) }),
    }, { onHumanRequest, onEvent });
    return result;
  });
}

function retryStrategy({ when, maxAttempts, initialDelay, maxDelay, backoffRate }: Retry) {
  // Only set fields reach the SDK: its `{ ...defaults, ...config }` merge would let `undefined` replace a default.
  const strategy = createRetryStrategy({
    maxAttempts, ...(initialDelay && { initialDelay: seconds(initialDelay) }), ...(maxDelay && { maxDelay: seconds(maxDelay) }),
    ...(backoffRate !== undefined && { backoffRate }),
  });
  return (error: Error, attempts: number) =>
    !(error instanceof StepTooLargeError) && (when?.(error) ?? true) ? strategy(error, attempts) : { shouldRetry: false };
}

function seconds({ days = 0, hours = 0, minutes = 0, seconds = 0 }: Duration) {
  return { seconds: ((days * 24 + hours) * 60 + minutes) * 60 + seconds };
}
