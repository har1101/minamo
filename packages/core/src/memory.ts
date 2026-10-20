import { parse, SignalTimeoutError, stringify, type Durable, type StepInfo } from "./durable.js";

type Entry = { ok: true; text: string } | { ok: false; error: string; timeout?: true };

const PUBLISHED = "#published";

const CRASH = Symbol("crash");

/**
 * In-memory durable engine for tests, with real replay semantics: every invocation re-runs the handler from the top
 * and completed operations return their journaled results. Name-keyed, like Cloudflare Workflows and Inngest.
 * `crash(path)` kills the invocation right after that operation is journaled, to exercise recovery.
 * Retry delays are not simulated, and signals time out only through `expire`. A signal's token is its operation path.
 */
export class MemoryEngine {
  readonly executionId = `memory-${crypto.randomUUID()}`;
  readonly journal = new Map<string, Entry>();
  invocations = 0;
  private readonly crashed = new Set<string>();
  private wake = Promise.withResolvers<void>();
  private idle = Promise.withResolvers<void>();

  constructor(private readonly options: { crash?: (path: string) => boolean } = {}) {}

  /** Waits until the execution suspends or ends, then lists the signals waiting for an answer. */
  async pending(): Promise<{ token: string }[]> {
    await this.idle.promise;
    return [...this.journal.keys()].flatMap(key => {
      const token = key.slice(0, -PUBLISHED.length);
      return key.endsWith(PUBLISHED) && !this.journal.has(token) ? [{ token }] : [];
    });
  }

  /** Completes a pending signal; the execution resumes in a new invocation. */
  complete(token: string, value: unknown): void {
    this.resume(token, { ok: true, text: stringify(value) });
  }

  /** Times out a pending signal: it rejects with {@link SignalTimeoutError} in a new invocation. */
  expire(token: string): void {
    this.resume(token, { ok: false, error: "Signal timed out", timeout: true });
  }

  private resume(token: string, entry: Entry) {
    this.journal.set(token, entry);
    this.idle = Promise.withResolvers();
    this.wake.resolve();
  }

  async run<I, O>(handler: (durable: Durable, input: I) => Promise<O>, input: I): Promise<O> {
    try {
      for (;;) {
        this.invocations++;
        const outcome = await this.invoke(handler, input);
        if (outcome.done) return outcome.value;
        if (outcome.suspended) {
          this.idle.resolve();
          await this.wake.promise;
          this.wake = Promise.withResolvers();
        }
      }
    } finally {
      this.idle.resolve();
    }
  }

  private invoke<I, O>(handler: (durable: Durable, input: I) => Promise<O>, input: I) {
    type Outcome = { done: true; value: O } | { done: false; suspended: boolean };
    const stop = Promise.withResolvers<Outcome>();
    const seen = new Set<string>();
    let inflight = 0;
    let waiting = 0;
    let dead = false;

    const engine = this;
    const checkIdle = () => setTimeout(() => {
      if (!dead && inflight === 0 && waiting > 0) {
        dead = true;
        stop.resolve({ done: false, suspended: true });
      }
    });
    const claim = (path: string) => {
      if (dead) throw CRASH;
      if (seen.has(path)) throw new Error(`Duplicate durable operation name: ${path}`);
      seen.add(path);
    };
    const record = (path: string, entry: Entry) => {
      if (dead) throw CRASH;
      engine.journal.set(path, entry);
      if (engine.options.crash?.(path) && !engine.crashed.has(path)) {
        engine.crashed.add(path);
        dead = true;
        stop.resolve({ done: false, suspended: false });
        throw CRASH;
      }
    };
    const replay = (entry: Entry) => {
      if (entry.ok) return parse(entry.text);
      throw entry.timeout ? new SignalTimeoutError(entry.error) : new Error(entry.error);
    };

    const durable = (prefix: string): Durable => ({
      executionId: engine.executionId,
      async step(name, fn, options) {
        const path = prefix + name;
        claim(path);
        const done = engine.journal.get(path);
        if (done) return replay(done) as never;
        inflight++;
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              const text = stringify(await fn({ attempt } satisfies StepInfo));
              record(path, { ok: true, text });
              return parse(text);
            } catch (error) {
              if (error === CRASH || !(error instanceof Error)) throw error;
              const retry = options?.retry;
              if (retry && attempt < retry.maxAttempts && (retry.when?.(error) ?? true)) continue;
              record(path, { ok: false, error: error.message });
              throw error;
            }
          }
        } finally {
          inflight--;
          checkIdle();
        }
      },
      async scope(name, fn) {
        const path = prefix + name;
        claim(path);
        const done = engine.journal.get(path);
        if (done) return replay(done) as never;
        let text;
        try {
          text = stringify(await fn(durable(`${path}/`)));
        } catch (error) {
          if (error !== CRASH && error instanceof Error) record(path, { ok: false, error: error.message });
          throw error;
        }
        record(path, { ok: true, text });
        return parse(text);
      },
      async signal(name, publish) {
        const path = prefix + name;
        claim(path);
        const done = engine.journal.get(path);
        if (done) return replay(done) as never;
        // Publishing is journaled like a step, so a replay does not hand out the token twice.
        const published = path + PUBLISHED;
        if (!engine.journal.has(published)) {
          await publish(path);
          record(published, { ok: true, text: "null" });
        }
        waiting++;
        checkIdle();
        return new Promise<never>(() => {});
      },
    });

    handler(durable(""), input).then(
      value => { if (!dead) { dead = true; stop.resolve({ done: true, value }); } },
      error => { if (!dead) { dead = true; stop.reject(error); } },
    );
    return stop.promise;
  }
}
