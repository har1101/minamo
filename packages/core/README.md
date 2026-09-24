# @minamojs/minamo

The core of [minamo](https://github.com/har1101/minamo): a tiny, dependency-free library for durable AI agent loops. It records each model call and each tool call as a durable operation, so a crash, a redeploy, or a long wait for human approval resumes from the last completed call.

- No dependencies. Web standard APIs only.
- `@minamojs/minamo`: `Durable`, `model()`, `runTools()`, `RetryableError`, `Retry`, and the checkpoint codec.
- `@minamojs/minamo/memory`: `MemoryEngine`, an in-memory engine for tests, with replay and crash injection.
- Engines are separate packages: [`@minamojs/lambda-df`](https://www.npmjs.com/package/@minamojs/lambda-df) for AWS Lambda durable functions.

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @aws/durable-execution-sdk-js
```

```ts
import { model, runTools, type Durable } from "@minamojs/minamo";

const events = await model(durable, "model-1", () => provider.stream(messages));
const results = await runTools(durable, "tools-1", calls, tools);
```

See the [repository README](https://github.com/har1101/minamo#readme) for the full example and API ([日本語](https://github.com/har1101/minamo/blob/main/README.ja.md)).

Experimental alpha. The API will change. MIT License.
