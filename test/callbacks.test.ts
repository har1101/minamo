import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CallbackTimeoutException, GetDurableExecutionHistoryCommand, SendDurableExecutionCallbackSuccessCommand, type Event, type LambdaClient,
} from "@aws-sdk/client-lambda";
import { LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { agent, tool, type HumanRequest } from "@minamojs/minamo";
import { fakeModel } from "@minamojs/minamo/testing";
import { handle } from "@minamojs/lambda-df";
import { callbacks, RequestLookupError } from "@minamojs/lambda-df/callbacks";
import { z } from "zod";

// Real timer on purpose: the Lambda SDK's idle cooldown must pass on the platform clock before a callback arrives
// (same constraint as test/engines.test.ts); the local runner exposes no event for it.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs an approval on the SDK's local runner and returns the history as it looked while waiting, and after. */
async function approvalHistory() {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  const refunds: string[] = [];
  const requests: HumanRequest[] = [];
  const support = agent({
    name: "support",
    model: fakeModel([[{ type: "tool_call", id: "c1", name: "issue_refund", input: { orderId: "A-1" } }], "done"]),
    tools: {
      issue_refund: tool({
        description: "Refunds an order.",
        input: z.object({ orderId: z.string() }),
        approval: true,
        run: async ({ orderId }) => void refunds.push(orderId),
      }),
    },
  });
  const handler = handle(support, { prompt: (event: { prompt: string }) => event.prompt, onHumanRequest: async r => void requests.push(r) });
  const runner = new LocalDurableTestRunner({ handlerFunction: handler });
  try {
    const running = runner.run({ payload: { prompt: "refund A-1" } });
    await runner.getOperation("wait").waitForData(WaitingOperationStatus.SUBMITTED);
    await sleep(200);
    await runner.getOperation("wait").sendCallbackSuccess(JSON.stringify({ approved: true }));
    const execution = await running;
    assert.equal(execution.getStatus(), "SUCCEEDED");
    assert.deepEqual(refunds, ["A-1"]);
    const events = execution.getHistoryEvents();
    const answered = events.findIndex(event => event.EventType === "CallbackSucceeded");
    assert.ok(answered > 0);
    const ids = new Map(events.map(event => [event.Id, event.Name]));
    const tree = new Set(events.filter(event => event.Name).map(event => `${ids.get(event.ParentId) ?? ""}/${event.Name}`));
    for (const expected of ["/support", "support/model-1", "support/tools-1:c1", "tools-1:c1/$human:approval", "$human:approval/request", "$human:approval/wait", "tools-1:c1/run", "support/model-2"]) {
      assert.ok(tree.has(expected), `${expected} in ${[...tree].join(", ")}`);
    }
    return { waiting: events.slice(0, answered), done: events, request: requests[0]! };
  } finally {
    await LocalDurableTestRunner.teardownTestEnvironment();
  }
}

/** A LambdaClient that serves `events` two per page and records sent callbacks. */
function fakeLambda(events: Event[], sendError?: Error) {
  const sent: { CallbackId?: string; Result?: string }[] = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof GetDurableExecutionHistoryCommand) {
        assert.equal(command.input.IncludeExecutionData, true);
        const start = Number(command.input.Marker ?? 0);
        return { Events: events.slice(start, start + 2), ...(start + 2 < events.length && { NextMarker: String(start + 2) }) };
      }
      if (command instanceof SendDurableExecutionCallbackSuccessCommand) {
        if (sendError) throw sendError;
        const result = command.input.Result;
        assert.ok(result instanceof Uint8Array);
        sent.push({ CallbackId: command.input.CallbackId, Result: new TextDecoder().decode(result) });
        return {};
      }
      throw new Error("unexpected command");
    },
  };
  return { client: client as unknown as LambdaClient, sent };
}

test("callbacks: finds the open request in a real SDK history and answers its callback", async () => {
  const { waiting, done, request } = await approvalHistory();
  const live = fakeLambda(waiting);
  const answers = callbacks({ client: live.client });

  assert.deepEqual(await answers.pending(request.executionId), [{ requestId: request.requestId, summary: request.summary }]);
  assert.deepEqual(await answers.approve(request.requestId, { reason: "ok" }), { status: "sent" });
  assert.deepEqual(live.sent, [{ CallbackId: request.token, Result: '{"approved":true,"reason":"ok"}' }]);
  await assert.rejects(answers.answer(request.requestId, 1), (error: RequestLookupError) => error.reason === "invalid");
  await assert.rejects(answers.approve(request.requestId.replace(/\/c1\//, "/c2/")), (error: RequestLookupError) => error.reason === "not-found");

  // After the answer, nothing is pending and a second answer is "closed", without a send.
  const finished = fakeLambda(done);
  assert.deepEqual(await callbacks({ client: finished.client }).pending(request.executionId), []);
  assert.deepEqual(await callbacks({ client: finished.client }).reject(request.requestId, "late"), { status: "closed" });
  assert.equal(finished.sent.length, 0);

  // The service decides last: expired or already answered is "closed", unless a retry may have delivered the first try.
  const closed = new CallbackTimeoutException({ message: "closed", $metadata: { attempts: 1 } });
  assert.deepEqual(await callbacks({ client: fakeLambda(waiting, closed).client }).approve(request.requestId), { status: "closed" });
  const retried = new CallbackTimeoutException({ message: "closed", $metadata: { attempts: 2 } });
  assert.equal((await callbacks({ client: fakeLambda(waiting, retried).client }).approve(request.requestId)).status, "unknown");
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal((await callbacks({ client: fakeLambda(waiting, reset).client }).approve(request.requestId)).status, "unknown");
  const denied = Object.assign(new Error("not allowed"), { name: "AccessDeniedException" });
  await assert.rejects(callbacks({ client: fakeLambda(waiting, denied).client }).approve(request.requestId), /not allowed/);

  // A truncated record is an error, never an empty list.
  const truncated = waiting.map(event => event.EventType === "StepSucceeded" && event.Name === "request"
    ? { ...event, StepSucceededDetails: { ...event.StepSucceededDetails!, Result: { Truncated: true } } }
    : event);
  await assert.rejects(callbacks({ client: fakeLambda(truncated).client }).pending(request.executionId), (error: RequestLookupError) => error.reason === "unreadable");
});
