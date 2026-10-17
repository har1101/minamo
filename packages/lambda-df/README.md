# @minamojs/lambda-df

The [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) engine for [minamo](https://github.com/har1101/minamo), a tiny core for durable AI agent loops.

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @aws/durable-execution-sdk-js
```

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { lambda } from "@minamojs/lambda-df";

export const handler = withDurableExecution(async (event: { prompt: string }, context) =>
  agent(lambda(context), event.prompt)); // `agent` is your loop, written with @minamojs/minamo
```

`lambda(context)` maps minamo's `step`, `scope`, and `signal` to the SDK's `step`, `runInChildContext`, and `waitForCallback`. It stores step and scope results with minamo's codec. A signal returns the callback's JSON as is, unvalidated. Without a `retry` option, a step runs once instead of using the SDK's default retries. A repeated operation name in one scope fails, which the SDK alone would accept. Each scope's `id` is a SHA-256 digest of the execution ARN and the scope names, so it does not contain the ARN. An unkeyed hash can still confirm a guessed ARN.

Call `lambda()` once, on the handler's own context. Run parallel agents in `durable.scope` calls, not by wrapping SDK child contexts (`runInChildContext`, `parallel`, `map`) with `lambda()`: every wrapper starts from the same root id, so those agents would share ids and idempotency keys.

Peer dependencies: `@minamojs/minamo` and `@aws/durable-execution-sdk-js` 2.x.

See the [repository README](https://github.com/har1101/minamo#readme) and a [deployable example with Amazon Bedrock](https://github.com/har1101/minamo/tree/main/examples/lambda-bedrock).

Experimental alpha. The API will change. MIT License.
