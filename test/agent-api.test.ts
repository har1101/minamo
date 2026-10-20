import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, memoryHistory, parseRequestId, tool, type HumanRequest, type Message, type ToolResultPart } from "@minamojs/minamo";
import { fakeModel, MemoryEngine } from "@minamojs/minamo/testing";
import { z } from "zod";

const call = (id: string, name: string, input: unknown) => ({ type: "tool_call", id, name, input }) as const;
const lastResults = (messages: Message[]) => messages.at(-1)!.content as ToolResultPart[];

function shop(script: Parameters<typeof fakeModel>[0]) {
  const refunds: string[] = [];
  const model = fakeModel(script);
  const support = agent({
    name: "support",
    model,
    tools: {
      issue_refund: tool({
        description: "Refunds an order.",
        input: z.object({ orderId: z.string(), amountYen: z.number().positive() }),
        approval: { when: ({ amountYen }) => amountYen >= 10_000, request: ({ orderId, amountYen }) => ({ orderId, amountYen }) },
        run: async ({ orderId }, { idempotencyKey }) => {
          refunds.push(idempotencyKey);
          return { refunded: orderId };
        },
      }),
    },
  });
  return { support, model, refunds };
}

/** The model asks for a refund, then answers with whatever the tool result said. */
const refundScript = (amountYen: number) => [
  [call("c1", "issue_refund", { orderId: "A-1", amountYen })],
  (request: { messages: readonly Message[] }) => `result: ${JSON.stringify(lastResults([...request.messages]))}`,
];

test("approval: suspends, then runs the tool once after approve; replays never re-call the model", async () => {
  const { support, model, refunds } = shop(refundScript(20_000));
  const requests: HumanRequest[] = [];
  const engine = new MemoryEngine();
  const running = engine.run(d => support.run(d, { key: "chat", prompt: "refund A-1" }, { onHumanRequest: async r => void requests.push(r) }), null);

  const [pending] = await engine.pending();
  assert.equal(refunds.length, 0, "nothing runs before the approval");
  assert.equal(requests.length, 1);
  const [request] = requests as [HumanRequest];
  assert.equal(request.token, pending!.token);
  assert.deepEqual(request.summary, { requestId: request.requestId, kind: "approval", tool: "issue_refund", request: { orderId: "A-1", amountYen: 20_000 } });
  assert.deepEqual(parseRequestId(request.requestId), { executionId: engine.executionId, runKey: "chat", turn: 1, callId: "c1", name: "approval" });

  engine.complete(pending!.token, { approved: true });
  const result = await running;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0], `${encodeURIComponent(engine.executionId)}/chat/1/c1`);
  assert.equal(model.requests.length, 2);
  assert.equal(result.turns, 2);
  assert.match(result.output, /"status":"ok"/);
  assert.equal(result.finish.reason, "end_turn");
  assert.deepEqual(result.newMessages.map(m => m.role), ["user", "assistant", "user", "assistant"]);
});

test("approval: anything but approved === true denies, with the reason shown to the model", async () => {
  for (const [answer, expected] of [
    [{ approved: false, reason: "too large" }, /denied this tool call: too large/],
    [{ approved: "true" }, /denied this tool call\./],
    ["yes", /approval answer was invalid/],
  ] as const) {
    const { support, refunds } = shop(refundScript(20_000));
    const engine = new MemoryEngine();
    const running = engine.run(d => support.run(d, { key: "chat", prompt: "refund" }, { onHumanRequest: async () => {} }), null);
    const [pending] = await engine.pending();
    engine.complete(pending!.token, answer);
    const result = await running;
    const [toolResult] = lastResults(result.newMessages.slice(0, -1));
    assert.equal(toolResult!.status, "error");
    assert.match(toolResult!.status === "error" ? toolResult!.error : "", expected);
    assert.equal(refunds.length, 0);
  }
});

test("approval: an expired request does not run the tool and says so", async () => {
  const { support, refunds } = shop(refundScript(20_000));
  const engine = new MemoryEngine();
  const running = engine.run(d => support.run(d, { key: "chat", prompt: "refund" }, { onHumanRequest: async () => {} }), null);
  const [pending] = await engine.pending();
  engine.expire(pending!.token);
  const result = await running;
  assert.match(JSON.stringify(lastResults(result.newMessages.slice(0, -1))), /expired before anyone answered/);
  assert.equal(refunds.length, 0);
});

test("approval: `when` false skips the request; invalid input never reaches the tool", async () => {
  const { support, refunds } = shop([
    [call("small", "issue_refund", { orderId: "A-1", amountYen: 500 }), call("bad", "issue_refund", { orderId: "A-2", amountYen: -1 })],
    "done",
  ]);
  const result = await new MemoryEngine().run(d => support.run(d, { key: "chat", prompt: "refund" }, { onHumanRequest: async () => assert.fail("no request") }), null);
  const [small, bad] = lastResults(result.newMessages.slice(0, -1));
  assert.equal(small!.status, "ok");
  assert.equal(bad!.status, "error");
  assert.match(bad!.status === "error" ? bad!.error : "", /^Invalid input: amountYen:/);
  assert.equal(refunds.length, 1);
});

test("approval tools without onHumanRequest fail before the first model call", async () => {
  const { support, model } = shop(["never"]);
  await assert.rejects(new MemoryEngine().run(d => support.run(d, { key: "chat", prompt: "x" }), null), /no onHumanRequest/);
  assert.equal(model.requests.length, 0);
});

test("output: final_result mixed with other tools runs them and defers the final answer; history stays complete", async () => {
  let looked = 0;
  const model = fakeModel([
    [call("a", "lookup", { q: "x" }), call("f1", "final_result", { answer: "early" })],
    [call("f2", "final_result", { answer: "X!" })],
  ]);
  const answerer = agent({
    name: "answerer",
    model,
    output: z.object({ answer: z.string() }),
    tools: { lookup: tool({ description: "Looks up.", input: z.object({ q: z.string() }), run: async ({ q }) => (looked++, q.toUpperCase()) }) },
  });
  const result = await new MemoryEngine().run(d => answerer.run(d, { key: "a", prompt: "go" }), null);
  const answer: string = result.output.answer;
  assert.equal(answer, "X!");
  assert.equal(looked, 1);
  const [lookup, early] = lastResults(result.newMessages.slice(0, 3));
  assert.equal(lookup!.status, "ok");
  assert.equal(early!.status, "error");
  assert.deepEqual(lastResults(result.newMessages), [{ type: "tool_result", id: "f2", name: "final_result", status: "ok", output: "Final result accepted." }]);
  assert.deepEqual(model.requests[0]!.tools.map(t => t.name), ["lookup", "final_result"]);
  const clash = tool({ description: "Clashes.", input: z.object({}), run: async () => null });
  assert.throws(() => agent({ name: "x", model, output: z.object({}), tools: { final_result: clash } }), /reserved/);
});

test("ask: answers flow into the workflow; a repeated name and an invalid answer fail the tool, not the run", async () => {
  const seen: unknown[] = [];
  const model = fakeModel([
    [call("w", "wire", {}), call("twice", "twice", {})],
    "done",
  ]);
  const ops = agent({
    name: "ops",
    model,
    tools: {
      wire: tool({
        description: "Asks for an amount.",
        input: z.object({}),
        workflow: async (_input, { ask, durable }) => {
          const amount = await ask("amount", { request: { question: "How much?" }, schema: z.number() });
          seen.push(amount);
          return durable.step("send", async () => ({ sent: amount }));
        },
      }),
      twice: tool({
        description: "Asks the same thing twice.",
        input: z.object({}),
        workflow: async (_input, { ask }) => {
          await ask("same");
          return ask("same");
        },
      }),
    },
  });
  const requests: HumanRequest[] = [];
  const engine = new MemoryEngine();
  const running = engine.run(d => ops.run(d, { key: "k", prompt: "go" }, { onHumanRequest: async r => void requests.push(r) }), null);
  const pending = await engine.pending();
  assert.deepEqual(requests.map(r => [r.kind, parseRequestId(r.requestId).name]).sort(), [["input", "amount"], ["input", "same"]]);
  for (const { token } of pending) engine.complete(token, 42);
  const result = await running;
  const [wire, twice] = lastResults(result.newMessages.slice(0, -1));
  assert.deepEqual(wire, { type: "tool_result", id: "w", name: "wire", status: "ok", output: { sent: 42 } });
  assert.match(twice!.status === "error" ? twice!.error : "", /already used in this tool call/);
  assert.deepEqual(seen, [42]);

  const strict = agent({
    name: "ops",
    model: fakeModel([[call("w", "wire", {})], "done"]),
    tools: {
      wire: tool({
        description: "Asks for an amount.",
        input: z.object({}),
        workflow: async (_input, { ask }) => ask("amount", { schema: z.number() }),
      }),
    },
  });
  const engine2 = new MemoryEngine();
  const running2 = engine2.run(d => strict.run(d, { key: "k", prompt: "go" }, { onHumanRequest: async () => {} }), null);
  const [amount] = await engine2.pending();
  engine2.complete(amount!.token, "lots");
  const [invalid] = lastResults((await running2).newMessages.slice(0, -1));
  assert.match(invalid!.status === "error" ? invalid!.error : "", /Invalid answer to "amount"/);
});

test("conversation: runs append in order; a crash after any operation converges to the same history", async () => {
  const store = memoryHistory();
  const model = fakeModel([
    "first answer",
    request => `I see ${request.messages.length} messages`,
  ]);
  const chat = agent({ name: "chat", model });
  const first = await new MemoryEngine().run(d => chat.run(d, { key: "turn", prompt: "hi", conversation: { id: "c", store } }), null);
  assert.equal(first.historyUpTo, 0);
  const engine = new MemoryEngine({ crash: () => true });
  const second = await engine.run(d => chat.run(d, { key: "turn", prompt: "again", conversation: { id: "c", store } }), null);
  assert.equal(second.historyUpTo, 1);
  assert.equal(second.output, "I see 3 messages");
  assert.equal(model.requests.length, 2, "a crash never repeats a recorded model call");
  assert.equal(await store.head("c"), 2);
  assert.deepEqual(await store.read("c", 2), second.messages);
  assert.equal(second.messages.length, 4);
});
