import assert from "node:assert/strict";
import { test } from "node:test";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { parse, stringify, type Tool } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";
import { MemoryEngine } from "@minamojs/minamo/memory";
import { agent, scripted } from "./agent.js";

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
