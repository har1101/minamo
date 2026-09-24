import { createRetryStrategy, type DurableContext, type Serdes } from "@aws/durable-execution-sdk-js";
import { parse, stringify, type Duration, type Durable, type Retry, type StepInfo } from "@minamojs/core";

/** Binary-safe JSON for every checkpoint the core writes. */
function serdes<T>(): Serdes<T> {
  return {
    serialize: async value => value === undefined ? undefined : stringify(value),
    deserialize: async data => data === undefined ? undefined : parse<T>(data),
  };
}

/** Lambda durable functions engine. Operation IDs come from call order, which the core keeps fixed. */
export function lambda(context: DurableContext): Durable {
  const executionId = context.executionContext.durableExecutionArn;
  return {
    executionId,
    // DurablePromise is lazy; Promise.resolve starts it now, so operations start in call order.
    // Without `retry` a step runs once on every engine, instead of falling back to the SDK's default retries.
    step<T>(name: string, fn: (info: StepInfo) => Promise<T>, options?: { retry?: Retry }) {
      return Promise.resolve(context.step(name, step => fn({ attempt: step.attempt }), {
        serdes: serdes<T>(), retryStrategy: options?.retry ? retryStrategy(options.retry) : () => ({ shouldRetry: false }),
      }));
    },
    scope<T>(name: string, fn: (child: Durable) => Promise<T>) {
      return Promise.resolve(context.runInChildContext(name, child => fn(lambda(child)), { serdes: serdes<T>() }));
    },
    async signal<T>(name: string, publish: (token: string) => Promise<void>, options?: { timeout?: Duration }) {
      const raw = await context.waitForCallback(name, token => publish(token), options?.timeout ? { timeout: seconds(options.timeout) } : undefined);
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
