import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { parse, runTools, stringify, type Tool, type ToolCall } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";
import { MemoryEngine } from "@minamojs/minamo/memory";

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
