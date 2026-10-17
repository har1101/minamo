import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, runTools, stringify, type Durable, type Tool } from "@minamojs/minamo";
import { MemoryEngine } from "@minamojs/minamo/memory";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { lambda } from "@minamojs/lambda-df";
import { agent, type Provider } from "./agent.js";

test("codec: data shaped like the bytes marker stays data", () => {
  const value = {
    note: { $bytes: "aGk=" },
    escaped: { $$bytes: "aGk=" },
    deeper: { $$$bytes: { $bytes: "aGk=" } },
    number: { $bytes: 1 },
    list: [{ $bytes: "aGk=" }],
    bytes: new Uint8Array([104, 105]),
    nested: { $bytes: { inner: new Uint8Array([1]) } },
  };
  const decoded = parse<typeof value>(stringify(value));
  assert.deepEqual(decoded, value);
  assert.ok(!(decoded.note instanceof Uint8Array), "a string marker from data is not bytes");
  assert.ok(decoded.bytes instanceof Uint8Array);
  assert.ok(decoded.nested.$bytes.inner instanceof Uint8Array);
  assert.deepEqual(parse(stringify({ $bytes: "aGk=" })), { $bytes: "aGk=" }, "also at the top level");
});

test("memory engine: a tool output shaped like the bytes marker replays unchanged", async () => {
  const output = { $bytes: "c2VjcmV0" };
  const tools: Record<string, Tool> = { echo: { run: async () => output } };
  const engine = new MemoryEngine();
  const handler = (durable: Durable) =>
    runTools(durable, "tools-1", [{ id: "a", name: "echo", input: {} }], tools);
  const live = await engine.run(handler, null);
  const replayed = await engine.run(handler, null);
  assert.deepEqual(live[0], { id: "a", name: "echo", status: "ok", output });
  assert.deepEqual(replayed[0], live[0], "the replayed result is the recorded data, not bytes");
});

/** Every turn requests the given calls, all with call id `call_0`, as some providers do; then answers. */
function reusingIds(turns: { name: string; input: unknown }[][]): Provider {
  return async function* (messages) {
    const calls = turns[messages.filter(message => message.role === "assistant").length];
    if (!calls) {
      yield { type: "text", text: "done" };
      return;
    }
    for (const call of calls) yield { type: "tool_call", call: { id: "call_0", ...call } };
  };
}

test("memory engine: idempotency keys differ per tool call even when call ids repeat", async () => {
  const keys = new Map<number, Set<string>>();
  const refund: Tool<{ amount: number }> = {
    run: async ({ amount }, { idempotencyKey }) => {
      let seen = keys.get(amount);
      if (!seen) keys.set(amount, seen = new Set());
      seen.add(idempotencyKey);
      return { refunded: amount };
    },
  };
  const refundOnly = (amount: number) => [[{ name: "refund", input: { amount } }]];
  const delegate: Tool<{ amount: number }> = {
    // A sub-agent whose provider issues the same call id as the outer agent.
    workflow: async ({ amount }, { durable }) => (await agent(durable, "sub", { provider: reusingIds(refundOnly(amount)), tools: { refund } })).text,
  };
  const tools = { refund, delegate } as Record<string, Tool>;
  const engine = new MemoryEngine({ crash: () => true });
  await engine.run(async durable => {
    // A later turn reuses call_0, and turn 2's tool is a workflow that runs a nested agent.
    await agent(durable, "go", {
      provider: reusingIds([[{ name: "refund", input: { amount: 10 } }], [{ name: "delegate", input: { amount: 20 } }]]),
      tools,
    });
    // Two agents in sibling scopes with the same turn names and call ids.
    await Promise.all(["a", "b"].map((agentName, index) => durable.scope(`agent-${agentName}`, child =>
      agent(child, "go", { provider: reusingIds(refundOnly(30 + index)), tools }))));
  }, null);

  assert.deepEqual([...keys.keys()].sort(), [10, 20, 30, 31]);
  for (const [amount, seen] of keys) assert.equal(seen.size, 1, `every attempt of refund ${amount} saw the same key`);
  const all = [...keys.values()].map(seen => [...seen][0]!);
  assert.equal(new Set(all).size, all.length, "every tool call has its own key");
  for (const key of all) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(engine.executionId), "the key does not reveal the execution id");
  }
});

test("memory engine: a turn that repeats a call id fails before any tool runs", async () => {
  let runs = 0;
  const tools: Record<string, Tool> = { lookup: { run: async () => ++runs } };
  const calls = [{ id: "a", name: "lookup", input: {} }, { id: "a", name: "lookup", input: {} }];
  await assert.rejects(new MemoryEngine().run(durable => runTools(durable, "tools-1", calls, tools), null),
    /Turn tools-1 repeats tool call id "a"/);
  assert.equal(runs, 0);
});

test("memory engine: a recorded result of another tool is not replayed as this call's result", async () => {
  let runs = 0;
  const tools: Record<string, Tool> = { lookup: { run: async () => ++runs } };
  const engine = new MemoryEngine();
  engine.journal.set("tools-1:a", { ok: true, text: stringify({ id: "a", name: "transfer", status: "ok", output: { status: "sent" } }) });
  await assert.rejects(engine.run(durable => runTools(durable, "tools-1", [{ id: "a", name: "lookup", input: {} }], tools), null),
    /Journal mismatch: tool call "a" \(lookup\) replayed the result of "a" \(transfer\)/);
  assert.equal(runs, 0);
});

test("Lambda engine: tool calls with the same id in sibling scopes get different keys", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const keys: string[] = [];
  const tools: Record<string, Tool> = { refund: { run: async (_input, { idempotencyKey }) => { keys.push(idempotencyKey); return "ok"; } } };
  const calls = [{ id: "call_0", name: "refund", input: {} }];
  const handler = withDurableExecution(async (_event: unknown, context) => {
    const durable = lambda(context);
    assert.deepEqual(durable.path, []);
    return Promise.all(["agent-a", "agent-b"].map(name => durable.scope(name, child => {
      assert.deepEqual(child.path, [name]);
      return runTools(child, "tools-1", calls, tools);
    })));
  });
  const execution = await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});
