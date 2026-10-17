import { createHash } from "node:crypto";
import { createRetryStrategy, type DurableContext, type Serdes } from "@aws/durable-execution-sdk-js";
import { JournalError, parse, stringify, type Duration, type Durable, type Retry, type StepInfo } from "@minamojs/minamo";

/** Binary-safe JSON for every scope result the core writes. Signals skip it: their sender writes plain JSON. */
function serdes<T>(): Serdes<T> {
  return {
    serialize: async value => value === undefined ? undefined : stringify(value),
    deserialize: async data => data === undefined ? undefined : parse<T>(data),
  };
}

/** Step results are serialized inside the step (see {@link encodeStep}), so the checkpoint stores the text as is. */
const passthrough: Serdes<string | undefined> = { serialize: async value => value, deserialize: async data => data };

/** Lambda caps the payload of one durable operation at 1 MB (OperationUpdate `Payload`). */
const STEP_PAYLOAD_LIMIT = 1024 * 1024;

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

/** SHA-256 hex. One-way, so an `id` never reveals the execution ARN (account, function, execution name). */
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Names started on each SDK context, shared by every `Durable` that wraps the same context. */
const claimed = new WeakMap<DurableContext, Set<string>>();

/** Lambda durable functions engine. Pass the handler's own context; child scopes are derived from it. */
export function lambda(context: DurableContext): Durable {
  return wrap(context, digest(context.executionContext.durableExecutionArn));
}

/** Operation IDs come from call order, which the core keeps fixed. */
function wrap(context: DurableContext, id: string): Durable {
  // The SDK accepts a repeated name. minamo rejects it, as name-keyed engines must: unique names keep child ids unique.
  const names = claimed.get(context) ?? new Set();
  claimed.set(context, names);
  const claim = (name: string) => {
    if (names.has(name)) throw new JournalError(`Duplicate durable operation name: ${name}`);
    names.add(name);
  };
  return {
    id,
    // SDK operations take their ID and start when called, so `claim` and the SDK call both run before the first
    // `await`: the core calling them in a fixed order keeps IDs stable.
    async step<T>(name: string, fn: (info: StepInfo) => Promise<T>, options?: { retry?: Retry }) {
      claim(name);
      const result = await context.step(name, async step => encodeStep(name, await fn({ attempt: step.attempt })), {
        serdes: passthrough, retryStrategy: options?.retry ? retryStrategy(options.retry) : noRetry,
      });
      return result === undefined ? undefined as T : parse<T>(result);
    },
    async scope<T>(name: string, fn: (child: Durable) => Promise<T>) {
      claim(name);
      // A fixed-length parent id keeps this unambiguous. JSON.stringify escapes lone surrogates, which UTF-8 would
      // turn into one replacement character, so names that `claim` tells apart never share an id.
      return context.runInChildContext(name, child => fn(wrap(child, digest(id + JSON.stringify(name)))), { serdes: serdes<T>() });
    },
    async signal(name: string, publish: (token: string) => Promise<void>, options?: { timeout?: Duration }) {
      claim(name);
      // `publish` runs as the SDK's submitter step, which would otherwise get the SDK's default retries.
      const raw = await context.waitForCallback(name, token => publish(token), {
        retryStrategy: noRetry, ...(options?.timeout && { timeout: seconds(options.timeout) }),
      });
      return raw ? JSON.parse(raw) as unknown : null;
    },
  };
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
