import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { JournalError, parse, RetryableError, runTools, stringify, type Durable, type Tool, type ToolCall } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";
import { MemoryEngine } from "@minamojs/minamo/memory";
import { agent, scenario, sleep } from "./agent.js";

const markers = {
  bytes: new Uint8Array([1, 2, 3]),
  note: { $bytes: "aGk=" },
  escaped: { $$bytes: "aGk=" },
  nested: { $$bytes: { $bytes: "aGk=" } },
  list: [{ $bytes: "aGk=" }, new Uint8Array([4])],
};
const echo: Record<string, Tool> = { echo: { run: async () => markers } };

test("codec: data shaped like a bytes marker round-trips as data", () => {
  assert.deepEqual(parse(stringify(markers)), markers);
  assert.deepEqual(parse('{"$bytes":"AQI="}'), new Uint8Array([1, 2]), "bytes written by 0.1.0-alpha.1");
  assert.deepEqual(parse('{"$bytes":1}'), { $bytes: 1 }, "a non-string marker written by 0.1.0-alpha.1 is data");
});

test("codec: a multi-megabyte string round-trips in linear time", () => {
  const text = "x".repeat(4 * 1024 * 1024);
  const started = performance.now();
  const decoded = parse<{ text: string; list: string[] }>(stringify({ text, list: [text] }));
  const elapsed = performance.now() - started;
  assert.equal(decoded.text, text);
  assert.equal(decoded.list[0], text);
  assert.ok(elapsed < 1000, `${Math.round(elapsed)} ms`);
});

test("codec: an own __proto__ key round-trips without touching any prototype", () => {
  const value = JSON.parse('{"__proto__":{"$bytes":"AA=="}}');
  const decoded = parse<Record<string, unknown>>(stringify(value));
  assert.ok(Object.hasOwn(decoded, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value, { $bytes: "AA==" });
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(({} as Record<string, unknown>).$bytes, undefined);
});

test("memory engine: tool output shaped like a codec marker replays as data", async () => {
  const [result] = await new MemoryEngine({ crash: () => true }).run(
    durable => runTools(durable, "tools-1", [{ id: "a", name: "echo", input: {} }], echo), null);
  assert.deepEqual(result, { id: "a", name: "echo", status: "ok", output: markers });
});

// Lambda tests here run on real time: skipTime's global fake clock can drop the test reporter's pending timers when
// it is installed right after a memory engine test, which silently ends the run.

test("Lambda engine: tool output shaped like a codec marker replays as data", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const execution = await new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_event: unknown, context) => {
      const durable = lambda(context);
      const [result] = await runTools(durable, "tools-1", [{ id: "a", name: "echo", input: {} }], echo);
      // A retried step ends the invocation, so the next one replays the tool's scope from its checkpoint.
      await durable.step("again", async ({ attempt }) => { if (attempt === 1) throw new Error("once more"); }, { retry: { maxAttempts: 2, initialDelay: { seconds: 1 } } });
      return result.status === "ok" && isDeepStrictEqual(result.output, markers);
    }),
  }).run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.ok(execution.getInvocations().length >= 2, "replayed");
  assert.equal(execution.getResult(), true);
});

test("memory engine: a signal answer shaped like a codec marker arrives as data", async () => {
  const engine = new MemoryEngine();
  const token = Promise.withResolvers<string>();
  const running = engine.run(durable => durable.signal("approval", async t => token.resolve(t)), null);
  engine.complete(await token.promise, { approved: { $bytes: "AQ==" } });
  assert.deepEqual(await running, { approved: { $bytes: "AQ==" } });
});

test("memory engine: a call ID containing / gets its own journal entry", async () => {
  const tools: Record<string, Tool> = { echo: { run: async (input: number) => input } };
  const calls: ToolCall[] = [{ id: "a", name: "echo", input: 1 }, { id: "a/run", name: "echo", input: 2 }];
  const results = await new MemoryEngine({ crash: () => true }).run(durable => runTools(durable, "tools-1", calls, tools), null);
  assert.deepEqual(results.map(r => r.status === "ok" ? r.output : r.error), [1, 2]);
});

/**
 * The provider reuses `call_0` in every turn. Turn 1 delegates to a workflow tool whose nested `runTools` reuses
 * `tools-1` and `call_0`; turn 2 refunds directly. Every refund attempt records its key and the first one fails.
 */
function refunds() {
  const seen: { amount: number; key: string; invocation: number }[] = [];
  let invocation = 0;
  const tools: Record<string, Tool> = {
    refund: {
      run: async ({ amount }: { amount: number }, { idempotencyKey, attempt }) => {
        seen.push({ amount, key: idempotencyKey, invocation });
        if (attempt === 1) throw new RetryableError("503 from payments");
        return { refunded: amount };
      },
    },
    delegate: {
      workflow: async ({ amount }: { amount: number }, { durable }) =>
        runTools(durable, "tools-1", [{ id: "call_0", name: "refund", input: { amount } }], tools),
    },
  };
  const handler = async (durable: Durable) => {
    invocation++;
    return [
      await runTools(durable, "tools-1", [{ id: "call_0", name: "delegate", input: { amount: 10 } }], tools),
      await runTools(durable, "tools-2", [{ id: "call_0", name: "refund", input: { amount: 20 } }], tools),
    ];
  };
  const keys = (amount: number) => [...new Set(seen.filter(r => r.amount === amount).map(r => r.key))];
  const invocations = (amount: number) => new Set(seen.filter(r => r.amount === amount).map(r => r.invocation)).size;
  return { seen, tools, handler, keys, invocations };
}

test("memory engine: idempotency keys differ for a reused call ID and a nested runTools, and survive crashes", async () => {
  const { seen, handler, keys } = refunds();
  await new MemoryEngine({ crash: () => true }).run(handler, null);
  assert.ok(seen.length >= 4, "each refund retried at least once");
  assert.equal(keys(10).length, 1, "one key across every attempt and replay of the nested refund");
  assert.equal(keys(20).length, 1);
  assert.notEqual(keys(10)[0], keys(20)[0]);
});

test("Lambda engine: idempotency keys differ for a reused call ID and a nested runTools, survive resume, and do not contain the ARN", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const { seen, handler, keys, invocations } = refunds();
  let arn = "";
  const execution = await new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_event: unknown, context) => {
      arn = context.executionContext.durableExecutionArn;
      return handler(lambda(context));
    }),
  }).run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(seen.length, 4, "each refund retried once");
  assert.ok(invocations(10) > 1 || invocations(20) > 1, "a retry suspended the execution and a new invocation resumed it");
  assert.equal(keys(10).length, 1, "one key across the retry and the replays of the nested refund");
  assert.equal(keys(20).length, 1);
  assert.notEqual(keys(10)[0], keys(20)[0], "a deduplicating payment API must not drop the second refund");
  const pieces = arn.split(/[:/-]/).filter(piece => piece.length >= 8);
  assert.ok(pieces.length > 0);
  for (const key of [keys(10)[0], keys(20)[0]]) {
    assert.ok(!key.includes(arn), key);
    for (const piece of pieces) assert.ok(!key.includes(piece), `${key} contains ${piece}`);
  }
});

test("Lambda engine: call IDs that differ only in a lone surrogate get different idempotency keys", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const tools: Record<string, Tool> = { key: { run: async (_input, { idempotencyKey }) => idempotencyKey } };
  const calls: ToolCall[] = [{ id: "x\uD800", name: "key", input: {} }, { id: "x\uDC00", name: "key", input: {} }];
  const execution = await new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_event: unknown, context) =>
      (await runTools(lambda(context), "tools-1", calls, tools)).map(result => result.status === "ok" && result.output)),
  }).run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  const [first, second] = execution.getResult() as string[];
  assert.notEqual(first, second);
});

test("Lambda engine: a repeated operation name in one scope fails the execution, even through a second wrapper", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  let second = 0;
  const execution = await new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_event: unknown, context) => {
      await lambda(context).scope("x", async () => 1);
      return lambda(context).scope("x", async () => ++second);
    }),
  }).run({ payload: {} });

  assert.equal(execution.getStatus(), "FAILED");
  assert.equal(execution.getError()?.errorType, "JournalError");
  assert.match(execution.getError()?.errorMessage ?? "", /Duplicate durable operation name: x/);
  assert.equal(second, 0);
});

const repeated: ToolCall[] = [
  { id: "call_0", name: "refund", input: { amount: 10 } },
  { id: "call_0", name: "refund", input: { amount: 20 } },
];

test("memory engine: a turn that repeats a call ID fails before any tool runs", async () => {
  const { seen, tools } = refunds();
  await assert.rejects(new MemoryEngine().run(durable => runTools(durable, "tools-1", repeated, tools), null), JournalError);
  assert.equal(seen.length, 0);
});

test("memory engine: a nested turn that repeats a call ID fails the execution, not the workflow tool", async () => {
  const { seen, tools } = refunds();
  tools.delegate = { workflow: async (_input, { durable }) => runTools(durable, "tools-1", repeated, tools) };
  const engine = new MemoryEngine();
  await assert.rejects(engine.run(durable => runTools(durable, "tools-1", [{ id: "d", name: "delegate", input: {} }], tools), null),
    JournalError);
  assert.equal(seen.length, 0);
});

test("memory engine: a repeated operation name inside a workflow tool fails the execution", async () => {
  let runs = 0;
  const tools: Record<string, Tool> = {
    twice: {
      workflow: async (_input, { durable }) => {
        await durable.step("x", async () => ++runs);
        return durable.step("x", async () => ++runs);
      },
    },
  };
  await assert.rejects(new MemoryEngine().run(durable => runTools(durable, "tools-1", [{ id: "a", name: "twice", input: {} }], tools), null),
    JournalError);
  assert.equal(runs, 1);
});

test("Lambda engine: a turn that repeats a call ID fails before any tool runs", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const { seen, tools } = refunds();
  const execution = await new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_event: unknown, context) => runTools(lambda(context), "tools-1", repeated, tools)),
  }).run({ payload: {} });

  assert.equal(seen.length, 0);
  assert.equal(execution.getStatus(), "FAILED");
  assert.equal(execution.getError()?.errorType, "JournalError");
  assert.match(execution.getError()?.errorMessage ?? "", /Repeated tool call ID/);
});

test("memory engine: a replayed result recorded for another tool fails with Journal mismatch", async () => {
  // A redeploy under a running execution: after the crash, the code maps call `a` to another tool.
  const engine = new MemoryEngine({ crash: path => path === "tools-1:a" });
  const tools: Record<string, Tool> = { lookup: { run: async () => "lookup" }, search: { run: async () => "search" } };
  const handler = (durable: Durable) =>
    runTools(durable, "tools-1", [{ id: "a", name: engine.invocations === 1 ? "lookup" : "search", input: {} }], tools);
  await assert.rejects(engine.run(handler, null), JournalError);
});

test("memory engine: a Journal mismatch inside a workflow tool fails the execution instead of becoming its result", async () => {
  // The nested runTools of a sub-agent maps call `n` to another tool after the crash.
  const engine = new MemoryEngine({ crash: path => path === "outer:a/inner:n" });
  const tools: Record<string, Tool> = {
    lookup: { run: async () => "lookup" },
    search: { run: async () => "search" },
    delegate: {
      workflow: async (_input, { durable }) =>
        runTools(durable, "inner", [{ id: "n", name: engine.invocations === 1 ? "lookup" : "search", input: {} }], tools),
    },
  };
  await assert.rejects(engine.run(durable => runTools(durable, "outer", [{ id: "a", name: "delegate", input: {} }], tools), null),
    JournalError);
  assert.notEqual(engine.journal.get("outer:a")?.ok, true, "the outer call has no recorded result");
});

test("memory engine: a replayed result that is not a tool result fails with Journal mismatch", async () => {
  const engine = new MemoryEngine();
  engine.journal.set("tools-1:a", { ok: true, text: '"lookup"' });
  const tools: Record<string, Tool> = { lookup: { run: async () => "lookup" } };
  await assert.rejects(engine.run(durable => runTools(durable, "tools-1", [{ id: "a", name: "lookup", input: {} }], tools), null),
    /Journal mismatch/);
});

test("memory engine: the approval workflow approves only an explicit true", async () => {
  const transfer = async (answer: unknown) => {
    const { log, deps } = scenario();
    const engine = new MemoryEngine();
    const running = engine.run((durable, prompt: string) => agent(durable, prompt, deps), "go");
    engine.complete(await log.token, answer);
    const { text } = await running;
    return { result: text.slice(text.indexOf("c=")), executed: log.executed };
  };
  for (const answer of [{ approved: "false" }, "false", null, {}, { approved: "true" }]) {
    assert.deepEqual(await transfer(answer), { result: 'c={"status":"rejected"}', executed: 0 }, JSON.stringify(answer));
  }
  assert.deepEqual(await transfer({ approved: true }), { result: 'c={"status":"sent","amount":100}', executed: 1 });
});

test("Lambda engine: a callback payload shaped like a codec marker arrives as plain data", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const runner = new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_event: unknown, context) => {
      const answer = await lambda(context).signal("approval", async () => {}) as { approved?: unknown };
      return { isBytes: answer.approved instanceof Uint8Array, answer };
    }),
  });
  const running = runner.run({ payload: {} });
  const callback = runner.getOperation("approval");
  await callback.waitForData(WaitingOperationStatus.SUBMITTED);
  await sleep(200);
  await callback.sendCallbackSuccess(JSON.stringify({ approved: { $bytes: "AQ==" } }));
  const execution = await running;

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.deepEqual(execution.getResult(), { isBytes: false, answer: { approved: { $bytes: "AQ==" } } });
});

declare const durable: Durable;
// @ts-expect-error A signal answer is whatever the token holder sent: `unknown`, with no type argument to trust.
void (() => durable.signal<{ approved: boolean }>("approval", async () => {}));
