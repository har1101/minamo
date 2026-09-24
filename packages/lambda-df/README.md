# @minamojs/lambda-df

The [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) engine for [minamo](https://github.com/har1101/minamo), a tiny core for durable AI agent loops.

```bash
npm install @minamojs/core@alpha @minamojs/lambda-df@alpha @aws/durable-execution-sdk-js
```

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { lambda } from "@minamojs/lambda-df";

export const handler = withDurableExecution(async (event: { prompt: string }, context) =>
  agent(lambda(context), event.prompt)); // `agent` is your loop, written with @minamojs/core
```

`lambda(context)` maps minamo's `step`, `scope`, and `signal` to the SDK's `step`, `runInChildContext`, and `waitForCallback`. It stores every value with minamo's codec. Without a `retry` option, a step runs once instead of using the SDK's default retries.

Peer dependencies: `@minamojs/core` and `@aws/durable-execution-sdk-js` 2.x.

See the [repository README](https://github.com/har1101/minamo#readme) and a [deployable example with Amazon Bedrock](https://github.com/har1101/minamo/tree/main/examples/lambda-bedrock).

Experimental alpha. The API will change. MIT License.
