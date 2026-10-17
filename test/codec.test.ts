import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, runTools, stringify, type Tool } from "@minamojs/minamo";
import { MemoryEngine } from "@minamojs/minamo/memory";

const roundTrip = (value: unknown) => parse(stringify(value));

test("codec: Uint8Array values round-trip at any depth", () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  assert.deepEqual(roundTrip(bytes), bytes);
  assert.deepEqual(roundTrip({ image: { data: bytes }, list: [bytes, "text"] }), { image: { data: bytes }, list: [bytes, "text"] });
});

test("codec: data shaped like a codec marker stays data", () => {
  const values = [
    { $bytes: "aGk=" },
    { $esc: { $bytes: "aGk=" } },
    { $esc: { $esc: "x" } },
    { $bytes: 1 },
    { $esc: null },
    [{ $bytes: "aGk=" }, { nested: { $bytes: "aGk=" } }],
    { $bytes: "aGk=", other: true },
    { $esc: new Uint8Array([1, 2]) },
  ];
  for (const value of values) assert.deepEqual(roundTrip(value), value, JSON.stringify(value));
  assert.deepEqual(roundTrip({ data: new Uint8Array([104, 105]), note: { $bytes: "aGk=" } }), { data: new Uint8Array([104, 105]), note: { $bytes: "aGk=" } });
});

test("codec: a __proto__ key stays an own data property", () => {
  const value = parse<Record<string, unknown>>(stringify(JSON.parse('{"__proto__":{"polluted":true},"x":{"$bytes":"aGk="}}')));
  assert.deepEqual(Object.keys(value), ["__proto__", "x"]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
});

test("memory engine: a tool result shaped like the bytes marker replays as the same JSON", async () => {
  const note = { $bytes: "aGk=" };
  const tools: Record<string, Tool> = { echo: { run: async () => note } };
  const engine = new MemoryEngine({ crash: () => true });
  const results = await engine.run(durable => runTools(durable, "tools-1", [{ id: "a", name: "echo", input: {} }], tools), null);
  assert.deepEqual(results, [{ id: "a", name: "echo", status: "ok", output: note }]);
});
