# @minamojs/bedrock

The [Amazon Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) model adapter for [minamo](https://github.com/har1101/minamo), a tiny core for durable AI agent loops.

```bash
npm install @minamojs/minamo@alpha @minamojs/bedrock@alpha @aws-sdk/client-bedrock-runtime
```

```ts
import { agent } from "@minamojs/minamo";
import { bedrock } from "@minamojs/bedrock";

const support = agent({
  model: bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", { maxTokens: 1024 }),
  // system, tools, ...
});
```

`bedrock(modelId, options?)` returns a `Model` that calls `ConverseStream`. Options: `client`, `maxTokens` (default 4096), `temperature`, `additionalModelRequestFields`, and `retry` (default: minamo's model retry).

- Without `client`, it creates one `BedrockRuntimeClient({ maxAttempts: 1 })` on first use. minamo retries the whole model step, so SDK retries would multiply them: create a client you pass in with `maxAttempts: 1` too.
- Text streams as it arrives. Tool input fragments are joined, and each tool call is emitted whole when its block ends. Invalid tool input JSON is passed on as a string, so minamo's input validation reports it to the model.
- Stream exception events (`throttlingException`, `serviceUnavailableException`, ...) are thrown as errors named after the exception, so minamo's default model retry recognizes the transient ones.
- Converse needs alternating roles, so consecutive messages with the same role are merged, tool results first.
- Converse rejects tool blocks in history when a request has no tools. Then tool calls and results in history are sent as text, like `[tool call name: {...}]` and `[tool result name: ...]`.
- Reasoning content, images, and documents are not supported. Reasoning deltas are ignored.

Peer dependencies: `@minamojs/minamo` and `@aws-sdk/client-bedrock-runtime` 3.x.

See the [repository README](https://github.com/har1101/minamo#readme).

Experimental alpha. The API will change. MIT License.
