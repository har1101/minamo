# @minamojs/lambda-df

The [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) engine for [minamo](https://github.com/har1101/minamo), a small durable agent runner.

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @aws/durable-execution-sdk-js
```

```ts
import { handle } from "@minamojs/lambda-df";

export const handler = handle(support, {           // `support` is an agent() from @minamojs/minamo
  prompt: (event: { prompt: string }) => event.prompt,
  onHumanRequest: request => notify(request.summary),
});
// Or your own function of `Durable`: handle(async (event, durable) => ...)
```

- `handle()` wraps `withDurableExecution`. With an agent it runs one run per execution (run key: the agent's name) and returns the run result without `messages`.
- `lambda(context)` maps minamo's `step`, `scope`, and `signal` to the SDK's `step`, `runInChildContext`, and `waitForCallback`, with minamo's codec. Without `retry`, a step runs once instead of using the SDK's default retries. A callback timeout rejects with `SignalTimeoutError`. A step result over 1 MB (checked as 1,000,000 bytes) fails that step with an error naming it.

## Answering human requests: `@minamojs/lambda-df/callbacks`

```ts
import { callbacks } from "@minamojs/lambda-df/callbacks";

const answers = callbacks();                           // or callbacks({ client: new LambdaClient({ ... }) })
const waiting = await answers.pending(executionArn);    // [{ requestId, summary }]
const result = await answers.approve(requestId);        // or reject(requestId, reason), answer(requestId, value)
// result.status: "sent" | "closed" (expired, answered, or execution ended) | "unknown" (may or may not have arrived)
```

- No store of pending requests: it reads the execution's history (`GetDurableExecutionHistory` with payloads, every page) and follows minamo's operation names and `ParentId`s to the one open callback of the request. Anything else (missing, ambiguous, truncated, unknown format) throws `RequestLookupError` and sends nothing.
- Authorize first: that the execution belongs to the caller, and that the caller may answer this request. `requestId` is not a secret.
- IAM: `lambda:GetDurableExecutionHistory` and `lambda:SendDurableExecutionCallbackSuccess` on the agent function. This lets the caller read the execution's whole history, including model and tool payloads.
- Quota: 15 `GetDurableExecutionHistory` calls per second per account, one per page. Call `pending` on page load or refresh, not in a polling loop.
- Requires `@aws-sdk/client-lambda` in your own dependencies (optional peer).

Peer dependencies: `@minamojs/minamo` and `@aws/durable-execution-sdk-js` 2.x.

See the [repository README](https://github.com/har1101/minamo#readme) and a [deployable example with Amazon Bedrock](https://github.com/har1101/minamo/tree/main/examples/lambda-bedrock).

Experimental alpha. The API will change. MIT License.
