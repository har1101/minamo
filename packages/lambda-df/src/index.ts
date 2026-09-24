import { createRetryStrategy, type DurableContext, type Serdes } from "@aws/durable-execution-sdk-js";
import { parse, stringify, type Duration, type Durable, type Retry, type StepInfo } from "@minamojs/minamo";

/** Binary-safe JSON for every scope result the core writes. */
function serdes<T>(): Serdes<T> {
  return {
    serialize: async value => value === undefined ? undefined : stringify(value),
    deserialize: async data => data === undefined ? undefined : parse<T>(data),
  };
}

/** Step results are serialized inside the step (see {@link encodeStep}), so the checkpoint stores the text as is. */
const passthrough: Serdes<string | undefined> = { serialize: async value => value, deserialize: async data => data };

/** Lambda caps a STEP checkpoint payload at 256 KB (OperationUpdate `Payload`). */
const STEP_PAYLOAD_LIMIT = 256 * 1024;

/** An oversized result fails its step with a clear error, instead of failing the checkpoint after the work is done. */
function encodeStep(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const encoded = stringify(value);
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so most results skip the byte count.
  if (encoded.length * 3 > STEP_PAYLOAD_LIMIT) {
    const bytes = new TextEncoder().encode(encoded).length;
    if (bytes > STEP_PAYLOAD_LIMIT) {
      throw new Error(`Step "${name}" result is ${bytes} bytes; Lambda durable functions record at most ${STEP_PAYLOAD_LIMIT} bytes per step`);
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
    // DurablePromise is lazy; Promise.resolve starts it now, so operations start in call order.
    step<T>(name: string, fn: (info: StepInfo) => Promise<T>, options?: { retry?: Retry }) {
      return Promise.resolve(context.step(name, async step => encodeStep(name, await fn({ attempt: step.attempt })), {
        serdes: passthrough, retryStrategy: options?.retry ? retryStrategy(options.retry) : noRetry,
      })).then(result => result === undefined ? undefined as T : parse<T>(result));
    },
    scope<T>(name: string, fn: (child: Durable) => Promise<T>) {
      return Promise.resolve(context.runInChildContext(name, child => fn(lambda(child)), { serdes: serdes<T>() }));
    },
    async signal<T>(name: string, publish: (token: string) => Promise<void>, options?: { timeout?: Duration }) {
      // `publish` runs as the SDK's submitter step, which would otherwise get the SDK's default retries.
      const raw = await context.waitForCallback(name, token => publish(token), {
        retryStrategy: noRetry, ...(options?.timeout && { timeout: seconds(options.timeout) }),
      });
      return parse<T>(raw || "null");
    },
  };
}

function retryStrategy({ when, initialDelay, maxDelay, ...rest }: Retry) {
  const strategy = createRetryStrategy({
    ...rest, ...(initialDelay && { initialDelay: seconds(initialDelay) }), ...(maxDelay && { maxDelay: seconds(maxDelay) }),
  });
  return (error: Error, attempts: number) => (when?.(error) ?? true) ? strategy(error, attempts) : { shouldRetry: false };
}

function seconds({ days = 0, hours = 0, minutes = 0, seconds = 0 }: Duration) {
  return { seconds: ((days * 24 + hours) * 60 + minutes) * 60 + seconds };
}
