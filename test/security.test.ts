import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, runTools, stringify, type Durable, type Tool } from "@minamojs/minamo";
import { MemoryEngine } from "@minamojs/minamo/memory";

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
