# @minamojs/minamo

The core of [minamo](https://github.com/har1101/minamo): a small, dependency-free durable agent runner. It runs the model/tool loop and records each model call and each tool call as a durable operation, so a crash, a redeploy, or a long wait for human approval resumes from the last completed call.

- No dependencies. Web standard APIs only.
- `@minamojs/minamo`: `agent()`, `tool()` (Standard Schema input, `approval`, `workflow` with `ask()`), `Message`, the `Model` and `HistoryStore` contracts, `memoryHistory()`, and the lower-level `Durable`, `model()`, `runTools()`, `RetryableError`, `Retry`, codec.
- `@minamojs/minamo/memory`: `MemoryEngine`, an in-memory engine with replay, crash injection, `pending()`, and `expire()`.
- `@minamojs/minamo/testing`: `fakeModel()` and `MemoryEngine`.
- Engines and providers are separate packages: [`@minamojs/lambda-df`](https://www.npmjs.com/package/@minamojs/lambda-df), [`@minamojs/bedrock`](https://www.npmjs.com/package/@minamojs/bedrock), [`@minamojs/dynamodb`](https://www.npmjs.com/package/@minamojs/dynamodb).

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @minamojs/bedrock@alpha @aws/durable-execution-sdk-js @aws-sdk/client-bedrock-runtime zod
```

```ts
import { agent, tool } from "@minamojs/minamo";
import { z } from "zod";

const support = agent({
  name: "support",
  model, // e.g. bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0")
  tools: {
    issue_refund: tool({
      description: "Refunds an order after a human approves it.",
      input: z.object({ orderId: z.string() }),
      approval: true,
      run: async ({ orderId }, { idempotencyKey }) => payments.refund(orderId, { idempotencyKey }),
    }),
  },
});
```

See the [repository README](https://github.com/har1101/minamo#readme) for the full example and API ([日本語](https://github.com/har1101/minamo/blob/main/README.ja.md)).

Experimental alpha. The API will change. MIT License.
