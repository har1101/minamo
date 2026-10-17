import assert from "node:assert/strict";
import { test } from "node:test";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { runTools, type Durable, type Tool, type ToolCall } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";
import { MemoryEngine } from "@minamojs/minamo/memory";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const refund = (id: string, amount: number): ToolCall => ({ id, name: "refund", input: { amount } });

/**
 * Turn 1 refunds 10 with call ID `call_0`; turn 2 refunds 20 with the same ID, and a workflow tool runs a nested
 * agent turn that also uses `tools-1` and `call_0`. Both conversations run in their own scope.
 */
function reusedIds() {
  const keys: Record<string, string[]> = {};
  const tools: Record<string, Tool> = {
    refund: {
      run: async ({ amount }: { amount: number }, { idempotencyKey }) => {
        (keys[amount] ??= []).push(idempotencyKey);
        return amount;
      },
    },
    delegate: {
      workflow: async (_input, { durable }) => runTools(durable, "tools-1", [refund("call_0", 30)], tools),
    },
  };
  const conversation = async (durable: Durable, base: number) => {
    await runTools(durable, "tools-1", [refund("call_0", base + 10)], tools);
    await runTools(durable, "tools-2", [refund("call_0", base + 20), { id: "call_1", name: "delegate", input: {} }], tools);
  };
  const handler = async (durable: Durable) => {
    await durable.scope("a", child => conversation(child, 0));
    await durable.scope("b", child => conversation(child, 100));
  };
  return { keys, handler };
}

test("memory engine: a reused call ID gets its own idempotency key in every turn, scope, and nested agent", async () => {
  const { keys, handler } = reusedIds();
  const engine = new MemoryEngine({ crash: () => true });
  await engine.run(handler, null);

  for (const amount of [10, 20, 110, 120]) {
    assert.equal(new Set(keys[amount]).size, 1, `refund ${amount} saw one key across crashes and replays`);
  }
  assert.equal(new Set(keys[30]).size, 2, "the nested refunds of conversations a and b are two tool calls");
  const all = new Set(Object.values(keys).flat());
  assert.equal(all.size, 6, "six tool calls, six keys");
  for (const key of all) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(engine.executionId), "the execution ID is not passed on");
  }
});

test("Lambda engine: idempotency keys are distinct per tool call and stable across a resume", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const seen: { before?: string; after?: string; nested: string[] } = { nested: [] };
  const tools: Record<string, Tool> = {
    refund: { run: async (_input, { idempotencyKey }) => { seen.nested.push(idempotencyKey); return "ok"; } },
    approve: {
      workflow: async (_input, { durable, idempotencyKey }) => {
        await durable.step("before", async () => { seen.before = idempotencyKey; });
        await durable.signal("approval", async () => {});
        await durable.step("after", async () => { seen.after = idempotencyKey; });
        return runTools(durable, "tools-1", [refund("call_0", 1)], tools);
      },
    },
  };
  const handler = withDurableExecution(async (_event: unknown, context) =>
    runTools(lambda(context), "tools-1", [{ id: "call_0", name: "approve", input: {} }], tools));
  const runner = new LocalDurableTestRunner({ handlerFunction: handler });
  const running = runner.run({ payload: {} });
  const callback = runner.getOperation("approval");
  await callback.waitForData(WaitingOperationStatus.SUBMITTED);
  await sleep(200);
  await callback.sendCallbackSuccess("true");
  const execution = await running;

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.ok(execution.getInvocations().length >= 2, "the execution suspended and resumed");
  assert.match(seen.before!, /^[0-9a-f]{64}$/);
  assert.equal(seen.after, seen.before, "the same key after the resume");
  assert.equal(seen.nested.length, 1);
  assert.notEqual(seen.nested[0], seen.before, "a nested call with the same turn and call ID gets another key");
});

test("Lambda engine: a turn that repeats a call ID fails before any tool runs", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const refunded: number[] = [];
  const tools: Record<string, Tool> = { refund: { run: async ({ amount }: { amount: number }) => refunded.push(amount) } };
  const handler = withDurableExecution(async (_event: unknown, context) =>
    runTools(lambda(context), "tools-1", [refund("call_0", 10), refund("call_0", 20)], tools));
  const execution = await new LocalDurableTestRunner({ handlerFunction: handler }).run({ payload: {} });

  assert.equal(execution.getStatus(), "FAILED");
  assert.match(execution.getError()?.errorMessage ?? "", /repeat call ID "call_0"/);
  assert.deepEqual(refunded, []);
});

test("memory engine: a replayed tool result must belong to the same call and tool", async () => {
  const tools: Record<string, Tool> = {
    lookup: { run: async () => "lookup result" },
    transfer: { run: async () => "sent" },
  };
  const engine = new MemoryEngine();
  const turn = (name: string) => (durable: Durable) => runTools(durable, "tools-1", [{ id: "a", name, input: {} }], tools);
  assert.deepEqual(await engine.run(turn("lookup"), null), [{ id: "a", name: "lookup", status: "ok", output: "lookup result" }]);
  // The same journal, but the code now makes a different call under the same ID, as after a non-deterministic change.
  await assert.rejects(engine.run(turn("transfer"), null), /Journal mismatch: tool call "a" \(transfer\) replayed the result of "a" \(lookup\)/);
});
