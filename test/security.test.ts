import assert from "node:assert/strict";
import { test } from "node:test";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { parse, stringify, type Tool, type ToolCall } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";
import { MemoryEngine } from "@minamojs/minamo/memory";
import { agent, scripted, type Provider } from "./agent.js";

test("codec: data shaped like a codec marker round-trips as data", () => {
  const value = {
    note: { $bytes: "aGk=" },
    wrapped: { $esc: { $bytes: "aGk=" } },
    deeper: { $esc: { $esc: { $bytes: "aGk=" } } },
    text: { $esc: "plain" },
    list: [{ $bytes: "aGk=" }],
    bytes: new Uint8Array([104, 105]),
    nested: { bytes: new Uint8Array([0, 255]) },
  };
  const decoded = parse<typeof value>(stringify(value));
  assert.deepEqual(decoded, value);
  assert.ok(decoded.bytes instanceof Uint8Array);
  assert.ok(!(decoded.note instanceof Uint8Array));
  assert.ok(!(decoded.list[0] instanceof Uint8Array));
});

test("codec: a record written before escaping existed still decodes", () => {
  assert.deepEqual(parse('{"b":{"$bytes":"aGk="},"e":{"$esc":"x"},"o":{"$esc":{"a":1}}}'), {
    b: new Uint8Array([104, 105]), e: { $esc: "x" }, o: { $esc: { a: 1 } },
  });
});

test("memory engine: tool output shaped like a byte marker is replayed unchanged", async () => {
  const output = { note: { $bytes: "aGk=" } };
  const { provider } = scripted([{ id: "a", name: "echo", input: {} }]);
  const tools: Record<string, Tool> = { echo: { run: async () => output } };
  // Crashing after every operation makes every result come back from the journal.
  const result = await new MemoryEngine({ crash: () => true }).run((durable, prompt: string) => agent(durable, prompt, { provider, tools }), "go");
  assert.equal(result.text, `Done: a=${JSON.stringify(output)}`);
});

test("Lambda engine: tool output shaped like a byte marker is replayed unchanged", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const output = { note: { $bytes: "aGk=" } };
  const { provider } = scripted([{ id: "a", name: "echo", input: {} }]);
  const tools: Record<string, Tool> = { echo: { run: async () => output } };
  const handler = withDurableExecution(async (_event: unknown, context) => (await agent(lambda(context), "go", { provider, tools })).text);
  const execution = await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(execution.getResult(), `Done: a=${JSON.stringify(output)}`);
});

/** A provider that requests `turns[n]` in turn n + 1, then answers with the results of the last turn. */
function reusing(turns: ToolCall[][]): Provider {
  return async function* (messages) {
    const calls = turns[messages.filter(message => message.role === "assistant").length];
    if (calls) {
      for (const call of calls) yield { type: "tool_call", call };
      return;
    }
    const last = messages.at(-1)!;
    yield { type: "text", text: last.results!.map(r => r.status === "ok" ? `${r.id}=${JSON.stringify(r.output)}` : `${r.id}!${r.error}`).join(", ") };
  };
}

/** `refund` records its idempotency key; `delegate` runs a nested agent whose provider reuses the same call ID. */
function refunds() {
  const keys: { amount: number; key: string }[] = [];
  const refund: Tool<{ amount: number }> = {
    run: async ({ amount }, { idempotencyKey }) => {
      keys.push({ amount, key: idempotencyKey });
      return { refunded: amount };
    },
  };
  const tools: Record<string, Tool> = { refund };
  const delegate: Tool<{ amount: number }> = {
    workflow: async ({ amount }, { durable }) => (await agent(durable, "nested", {
      provider: reusing([[{ id: "call_0", name: "refund", input: { amount } }]]), tools,
    })).text,
  };
  tools.delegate = delegate;
  return { keys, tools };
}

test("memory engine: a call ID reused in a later turn or a nested agent gets its own idempotency key", async () => {
  const { keys, tools } = refunds();
  const provider = reusing([
    [{ id: "call_0", name: "refund", input: { amount: 10 } }],
    [{ id: "call_0", name: "refund", input: { amount: 20 } }],
    [{ id: "call_0", name: "delegate", input: { amount: 30 } }],
  ]);
  const engine = new MemoryEngine();
  await engine.run((durable, prompt: string) => agent(durable, prompt, { provider, tools }), "go");

  assert.deepEqual(keys.map(k => k.amount), [10, 20, 30]);
  assert.equal(new Set(keys.map(k => k.key)).size, 3, "a deduplicating payment API must not drop a refund");
  for (const { key } of keys) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(engine.executionId));
  }

  // Another execution with the same call IDs gets other keys too.
  const again = refunds();
  await new MemoryEngine().run((durable, prompt: string) => agent(durable, prompt, { provider, tools: again.tools }), "go");
  assert.equal(new Set([...keys, ...again.keys].map(k => k.key)).size, 6);
});

test("Lambda engine: a call ID reused in a later turn or a nested agent gets its own idempotency key", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const { keys, tools } = refunds();
  const provider = reusing([
    [{ id: "call_0", name: "refund", input: { amount: 10 } }],
    [{ id: "call_0", name: "refund", input: { amount: 20 } }],
    [{ id: "call_0", name: "delegate", input: { amount: 30 } }],
  ]);
  let arn = "";
  const handler = withDurableExecution(async (_event: unknown, context) => {
    arn = context.executionContext.durableExecutionArn;
    return (await agent(lambda(context), "go", { provider, tools })).text;
  });
  const execution = await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.deepEqual(keys.map(k => k.amount), [10, 20, 30]);
  assert.equal(new Set(keys.map(k => k.key)).size, 3);
  for (const { key } of keys) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(arn));
  }
});
