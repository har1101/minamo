import assert from "node:assert/strict";
import { test } from "node:test";
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { model, RetryableError, type Tool } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";
import { MemoryEngine } from "@minamojs/minamo/memory";
import { agent, scripted } from "./agent.js";

// Real timers only where the platform clock matters: lookups finish out of call order, and the Lambda SDK's
// 20 ms idle cooldown must pass before a callback arrives.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const EXPECTED = 'Done: a="SLOW", b="FAST", c={"status":"sent","amount":100}';

/** Turn 1 asks for a slow lookup, a fast lookup (finishes first), and a transfer that needs human approval. */
function scenario() {
  const token = Promise.withResolvers<string>();
  const log = { runs: [] as string[], keys: {} as Record<string, string[]>, executed: 0, published: 0, token: token.promise };
  const { provider, counter } = scripted([
    { id: "a", name: "lookup", input: { q: "slow", delayMs: 30 } },
    { id: "b", name: "lookup", input: { q: "fast", delayMs: 1 } },
    { id: "c", name: "transfer", input: { amount: 100 } },
  ]);
  const lookup: Tool<{ q: string; delayMs: number }> = {
    run: async ({ q, delayMs }, ctx) => {
      log.runs.push(q);
      (log.keys[q] ??= []).push(ctx.idempotencyKey);
      await sleep(delayMs);
      return q.toUpperCase();
    },
  };
  const transfer: Tool<{ amount: number }> = {
    workflow: async ({ amount }, { durable }) => {
      const answer = await durable.signal<{ approved: boolean }>("approval", async t => {
        log.published++;
        token.resolve(t);
      });
      if (!answer.approved) return { status: "rejected" };
      return durable.step("execute", async () => {
        log.executed++;
        return { status: "sent", amount };
      });
    },
  };
  return { log, counter, deps: { provider, tools: { lookup, transfer } } };
}

test("memory engine: suspends for approval and resumes without repeating work", async () => {
  const { log, counter, deps } = scenario();
  const engine = new MemoryEngine();
  const running = engine.run((durable, prompt: string) => agent(durable, prompt, deps), "go");
  engine.complete(await log.token, { approved: true });
  const result = await running;

  assert.equal(result.text, EXPECTED);
  assert.equal(counter.calls, 2, "model-1 is replayed, not re-requested");
  assert.deepEqual(log.runs, ["slow", "fast"], "each lookup ran once");
  assert.equal(log.executed, 1);
  assert.equal(log.published, 1);
  assert.equal(engine.invocations, 2);
});

test("memory engine: crash after every journaled operation still converges", async () => {
  const { log, counter, deps } = scenario();
  const engine = new MemoryEngine({ crash: () => true });
  const running = engine.run((durable, prompt: string) => agent(durable, prompt, deps), "go");
  engine.complete(await log.token, { approved: true });
  const result = await running;

  assert.equal(result.text, EXPECTED);
  assert.equal(counter.calls, 2, "a journaled model call is never requested again");
  assert.equal(log.executed, 1);
  assert.equal(log.published, 1);
  for (const [q, keys] of Object.entries(log.keys)) {
    assert.equal(new Set(keys).size, 1, `every attempt of ${q} saw the same idempotency key`);
  }
  assert.ok(log.runs.filter(q => q === "slow").length >= 2, "a lookup cut off by a crash runs again (at-least-once)");
  assert.ok(engine.invocations > 5);
});

test("memory engine: retryable errors retry the step, other errors become tool results", async () => {
  let flakyAttempts = 0;
  let brokenAttempts = 0;
  const { provider, counter } = scripted([
    { id: "f", name: "flaky", input: {} },
    { id: "x", name: "broken", input: {} },
    { id: "u", name: "missing", input: {} },
  ]);
  const tools: Record<string, Tool> = {
    flaky: {
      run: async (_input, { attempt }) => {
        flakyAttempts++;
        if (attempt === 1) throw new RetryableError("503 from upstream");
        return "ok";
      },
    },
    broken: {
      run: async () => {
        brokenAttempts++;
        throw new Error("card declined");
      },
    },
  };
  const result = await new MemoryEngine().run((durable, prompt: string) => agent(durable, prompt, { provider, tools }), "go");
  assert.equal(result.text, 'Done: f="ok", x!card declined, u!Unknown tool: missing');
  assert.equal(flakyAttempts, 2);
  assert.equal(brokenAttempts, 1, "a business error is not retried");
  assert.equal(counter.calls, 2);
});

test("memory engine: model calls retry transient provider errors only", async () => {
  const outcomes = [new Error("ThrottlingException: Rate exceeded"), "ok", new Error("ValidationException: max_tokens")];
  let calls = 0;
  const call = async function* () {
    const outcome = outcomes[calls++];
    if (outcome instanceof Error) throw outcome;
    yield outcome;
  };
  const engine = new MemoryEngine();
  assert.deepEqual(await engine.run(durable => model(durable, "model-1", call), null), ["ok"]);
  assert.equal(calls, 2, "throttling is retried");
  await assert.rejects(new MemoryEngine().run(durable => model(durable, "model-1", call), null), /ValidationException/);
  assert.equal(calls, 3, "a validation error is not retried");
});

test("Lambda engine: the same agent suspends on a durable callback and replays on resume", async t => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  t.after(() => LocalDurableTestRunner.teardownTestEnvironment());
  const { log, counter, deps } = scenario();
  const handler = withDurableExecution(async (event: { prompt: string }, context) => agent(lambda(context), event.prompt, deps));
  const runner = new LocalDurableTestRunner({ handlerFunction: handler });

  const running = runner.run({ payload: { prompt: "go" } });
  const callback = runner.getOperation("approval");
  await callback.waitForData(WaitingOperationStatus.SUBMITTED);
  await sleep(200);
  await callback.sendCallbackSuccess(JSON.stringify({ approved: true }));
  const execution = await running;

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(execution.getResult()!.text, EXPECTED);
  assert.equal(counter.calls, 2, "model-1 is replayed from the journal");
  assert.deepEqual(log.runs, ["slow", "fast"], "completed lookups are not re-run on resume");
  assert.equal(log.executed, 1);
  assert.ok(execution.getInvocations().length >= 2, "the execution suspended and resumed");

  const operations = execution.getOperations();
  const names = new Map(operations.map(op => [op.getId(), op.getName()]));
  const tree = operations.map(op => `${names.get(op.getParentId()) ?? ""}/${op.getName()}`);
  for (const expected of ["/tools-1:a", "tools-1:a/run", "tools-1:b/run", "tools-1:c/approval", "tools-1:c/execute", "/model-2"]) {
    assert.ok(tree.includes(expected), expected);
  }
  const scopes = tree.filter(entry => entry.startsWith("/tools-1:"));
  assert.deepEqual(scopes, ["/tools-1:a", "/tools-1:b", "/tools-1:c"], "scopes follow call order, not completion order");
});

