import assert from "node:assert/strict";
import { test } from "node:test";
import type { BedrockRuntimeClient, ConverseStreamCommand, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { defaultModelRetry, type Message, type ModelEvent, type ModelRequest } from "@minamojs/minamo";
import { bedrock } from "@minamojs/bedrock";

/** A client whose `send` records the request and answers with the given stream events. */
function fake(events: ConverseStreamOutput[] | undefined) {
  const inputs: ConverseStreamCommand["input"][] = [];
  const client = {
    send: async (command: ConverseStreamCommand) => {
      inputs.push(command.input);
      return { stream: events && (async function* () { yield* events; })() };
    },
  } as unknown as BedrockRuntimeClient;
  return { client, inputs };
}

async function collect(events: ConverseStreamOutput[], request: Partial<ModelRequest> = {}) {
  const { client, inputs } = fake(events);
  const out: ModelEvent[] = [];
  for await (const event of bedrock("m", { client }).stream({ messages: [], tools: [], ...request })) out.push(event);
  return { out, input: inputs[0]! };
}

const conversation: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "" }, { type: "tool_call", id: "t1", name: "lookup", input: { q: "x" } }] },
  { role: "user", content: [{ type: "tool_result", id: "t1", name: "lookup", status: "ok", output: { found: true } }] },
  { role: "user", content: [{ type: "text", text: "and?" }, { type: "tool_result", id: "t2", name: "lookup", status: "error", error: "boom" }] },
];
const lookup = { name: "lookup", description: "Looks up", inputSchema: { type: "object", properties: { q: { type: "string" } } } };

test("request carries system, tools, and merged messages", async () => {
  const { input } = await collect([], { system: "be brief", messages: conversation, tools: [lookup] });
  assert.equal(input.modelId, "m");
  assert.deepEqual(input.system, [{ text: "be brief" }]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 4096 });
  assert.deepEqual(input.toolConfig, { tools: [{ toolSpec: { name: "lookup", description: "Looks up", inputSchema: { json: lookup.inputSchema } } }] });
  assert.deepEqual(input.messages, [
    { role: "user", content: [{ text: "hi" }] },
    { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "lookup", input: { q: "x" } } }] },
    {
      role: "user",
      content: [
        { toolResult: { toolUseId: "t1", status: "success", content: [{ text: '{"found":true}' }] } },
        { toolResult: { toolUseId: "t2", status: "error", content: [{ text: "boom" }] } },
        { text: "and?" },
      ],
    },
  ]);
});

test("without tools, history tool parts become text and toolConfig is absent", async () => {
  const { input } = await collect([], { messages: conversation });
  assert.equal(input.system, undefined);
  assert.equal(input.toolConfig, undefined);
  assert.deepEqual(input.messages, [
    { role: "user", content: [{ text: "hi" }] },
    { role: "assistant", content: [{ text: '[tool call lookup: {"q":"x"}]' }] },
    { role: "user", content: [{ text: '[tool result lookup: {"found":true}]' }, { text: "and?" }, { text: "[tool result lookup error: boom]" }] },
  ]);
});

test("options shape the inference config", async () => {
  const { client, inputs } = fake([]);
  const model = bedrock("m", { client, maxTokens: 100, temperature: 0.2, additionalModelRequestFields: { top_k: 5 } });
  for await (const _ of model.stream({ messages: [], tools: [] }));
  assert.deepEqual(inputs[0]!.inferenceConfig, { maxTokens: 100, temperature: 0.2 });
  assert.deepEqual(inputs[0]!.additionalModelRequestFields, { top_k: 5 });
});

test("streams text deltas in order, joins tool input, and finishes with usage", async () => {
  const { out } = await collect([
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "hmm" } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "a", name: "lookup" } } } },
    { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "b", name: "ping" } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"x"}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { contentBlockStop: { contentBlockIndex: 2 } },
    { contentBlockStart: { contentBlockIndex: 3, start: { toolUse: { toolUseId: "c", name: "lookup" } } } },
    { contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: '{"q":' } } } },
    { contentBlockStop: { contentBlockIndex: 3 } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } },
  ]);
  assert.deepEqual(out, [
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "tool_call", id: "a", name: "lookup", input: { q: "x" } },
    { type: "tool_call", id: "b", name: "ping", input: {} },
    { type: "tool_call", id: "c", name: "lookup", input: '{"q":' },
    { type: "finish", reason: "tool_use", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
});

test("finish without stop reason or usage", async () => {
  assert.deepEqual((await collect([])).out, [{ type: "finish", reason: "unknown" }]);
});

test("stream exception events throw with their name, so the default retry classifies them", async () => {
  const exception = { name: "ThrottlingException", message: "slow down" } as ConverseStreamOutput["throttlingException"];
  await assert.rejects(collect([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } }, { throttlingException: exception! }]), error => {
    assert.equal((error as Error).name, "ThrottlingException");
    assert.equal((error as Error).message, "slow down");
    assert.ok(defaultModelRetry.when!(error as Error));
    return true;
  });
  await assert.rejects(collect([{ serviceUnavailableException: {} as never }]), { name: "ServiceUnavailableException" });
});

test("a response without a stream throws", async () => {
  const { client } = fake(undefined);
  await assert.rejects(bedrock("m", { client }).stream({ messages: [], tools: [] })[Symbol.asyncIterator]().next(), /no stream/);
});
