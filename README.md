# minamo

[日本語](./README.ja.md)

> **水面 (minamo)**: the surface of water. Calm on top, whatever runs underneath.

A tiny, dependency-free core for durable AI agent loops on [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html).

Write your agent loop as plain TypeScript. minamo records each model call and each tool call as a durable operation, so a crash, a redeploy, or a week-long wait for human approval resumes from the last completed call instead of starting over and paying for the same tokens again.

> [!WARNING]
> Experimental alpha (`0.1.0-alpha.1`). The API will change.

- **No dependencies.** The core uses only Web standard APIs: no `node:` imports, no `Buffer`, no `AsyncLocalStorage`. It is under 2 KB minified and about 1 KB gzipped.
- **Bring your own loop and model.** minamo does not define a message format. It records whatever your model stream yields.
- **Engine adapters, not engine lock-in.** The core talks to a three-operation `Durable` interface. `@minamojs/lambda-df` implements it with the Lambda durable execution SDK. Cloudflare Workflows is the candidate for a second engine.

## Install

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @aws/durable-execution-sdk-js
```

Requires Node.js 22 or later.

| Package | Contents |
| --- | --- |
| `@minamojs/minamo` | The core (`Durable`, `model`, `runTools`, `Retry`, codec) and `@minamojs/minamo/memory`, an engine for tests. No dependencies. |
| `@minamojs/lambda-df` | The AWS Lambda durable functions engine. Peer dependency: `@aws/durable-execution-sdk-js` 2.x. |

## Example

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { model, RetryableError, runTools, type Durable, type Tool } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";

const tools: Record<string, Tool> = {
  weather: {
    run: async ({ city }: { city: string }) => {
      const response = await getWeather(city);
      if (response.status === 503) throw new RetryableError("weather API unavailable"); // retried
      return response.forecast; // any other throw becomes an error result for the model
    },
  },
  refund: {
    // Workflow tools may use durable operations: here, wait (without compute cost) until a human answers.
    workflow: async ({ orderId }: { orderId: string }, { durable, idempotencyKey }) => {
      const answer = await durable.signal<{ approved?: unknown } | null>("approval", token => notifyReviewer(orderId, token));
      // Approve only an explicit `true`: "false", "yes", 1, or a missing field all reject.
      if (answer?.approved !== true) return { status: "rejected" };
      return durable.step("refund", () => payments.refund(orderId, { idempotencyKey }));
    },
  },
};

async function agent(durable: Durable, prompt: string) {
  const messages: Message[] = [{ role: "user", content: prompt }];
  for (let turn = 1; turn <= 10; turn++) {
    // One durable step per model call: on replay, the recorded events come back without a new request.
    const events = await model(durable, `model-${turn}`, () => provider.stream(messages));
    const calls = events.flatMap(event => event.type === "tool_call" ? [event.call] : []);
    messages.push({ role: "assistant", content: events });
    if (calls.length === 0) return events;
    // Tool calls run concurrently; each one is journaled on its own.
    messages.push({ role: "tool", content: await runTools(durable, `tools-${turn}`, calls, tools) });
  }
  throw new Error("Too many turns");
}

export const handler = withDurableExecution(async (event: { prompt: string }, context) => agent(lambda(context), event.prompt));
```

`provider`, `Message`, `getWeather`, `notifyReviewer`, and `payments` are your code. This example is type-checked in [`test/readme-example.ts`](./test/readme-example.ts).

For a complete, deployable version with Amazon Bedrock Converse, see [examples/lambda-bedrock](./examples/lambda-bedrock).

## API

### `Durable`

The engine interface. Adapters implement it; you pass it around.

| Member | Meaning |
| --- | --- |
| `step(name, fn, { retry }?)` | Runs `fn` and records its result. Without `retry` it runs once; with `retry` it runs again for errors that `retry.when` accepts. On replay, returns the recorded result without running `fn`. `fn` must not use durable operations. |
| `scope(name, fn)` | Runs `fn` with a child `Durable` that may use durable operations. A completed scope returns its recorded result. |
| `signal(name, publish, { timeout }?)` | Suspends until someone completes the token that `publish` receives. `publish` runs once, like a step without `retry`. On Lambda this is `waitForCallback`, and the function does not run while it waits. |
| `executionId` | Stable across replays and resumes. |
| `path` | Names of the enclosing scopes, outermost first. Empty at the top level. |

Names must be unique within a scope and deterministic: build them from your input and from recorded results, never from time or randomness.

### `model(durable, name, call, options?)`

Runs one model call as one step. `call` returns an async iterable of events (any JSON-compatible type). The step records every event, and the function returns the array. By default the step is attempted up to 4 times for throttling, service-unavailable and internal-server errors, timeouts, and dropped connections. Any other error fails the call at once. `options.onEvent` receives events live while the step runs, for streaming to a UI. These live events are provisional: a retried attempt streams again.

### `runTools(durable, turn, calls, tools)`

Runs one turn's tool calls concurrently and returns their results in call order. Each call gets its own scope named `<turn>:<call id>`, opened in call order before any tool starts, so the order in which tools finish never changes the journal.

- A tool with `run` is a plain tool: one step.
- A tool with `workflow` gets its own `Durable` and may use steps, scopes, and signals, for example approvals or sub-agents.
- Throw `RetryableError` to retry a plain tool's step (default: 3 attempts with exponential backoff). Any other error is recorded once as an error result that the model sees. Set `retry` on a tool to change this.
- Unknown tools, exhausted retries, and failed workflows also become error results, so the model can react. A tool is found only among the own properties of `tools`.
- Call IDs must be non-empty strings, distinct within the turn; otherwise `runTools` throws before any tool runs. Results are matched to calls by ID, so a repeated ID cannot be answered correctly.
- A replayed result must name the same call ID and tool as the call; otherwise `runTools` throws, because the journal and the code disagree.
- Every tool receives `idempotencyKey`, which stays the same on every retry, replay, and resume, and differs for every other tool call. Pass it to external APIs. It is a SHA-256 hex digest of the execution ID and the path of the call's scope, so it does not reveal the execution ID, and a call ID that the provider reuses in a later turn or in a nested agent gets a different key.
- Every tool also receives `call`, the `ToolCall` it runs, for example to key progress events by `call.id`.

### Values

Recorded values are JSON plus `Uint8Array`, which is stored as `{"$bytes": base64}`. An object that only looks like that marker (one key, `$bytes` or `$esc`), for example in tool output, is stored escaped and comes back unchanged. Engines apply the same codec to every step, scope, and signal.

## Engines

| Import | Engine | Status |
| --- | --- | --- |
| `@minamojs/lambda-df` | AWS Lambda durable functions (`@aws/durable-execution-sdk-js` 2.x) | Works, on deployed Lambda and with `LocalDurableTestRunner` |
| `@minamojs/minamo/memory` | In-memory engine for tests | Works |
| — | Cloudflare Workflows | Candidate |

## Testing without AWS

`MemoryEngine` replays like a real engine: each invocation runs your handler from the top and returns recorded results. `crash` stops an invocation right after an operation is recorded, so you can test recovery at every point:

```ts
import { MemoryEngine } from "@minamojs/minamo/memory";

const engine = new MemoryEngine({ crash: () => true }); // crash after every recorded operation
const running = engine.run((durable, prompt: string) => agent(durable, prompt), "hello");
engine.complete(token, { approved: true }); // answer a signal; the token is what `publish` received
const result = await running;
```

## Guarantees and limits

- **At-least-once.** A tool can run again if the process stops after its side effect and before its result is recorded. Use `idempotencyKey` with external APIs.
- **Determinism.** Code outside steps runs again on every replay. It must make the same durable calls in the same order.
- **Lambda quotas.** An execution can have up to 30,000 durable operations and can write up to 100 MB of checkpoint data in total. Each durable operation's payload can be up to 1 MB, a limit that cannot be raised. This covers each step result, such as the events of one model call, and the result that completes a signal. `@minamojs/lambda-df` fails a larger step with an error that names it; Lambda rejects a larger callback result when it is sent. A scope result over 256 KB is not stored: the SDK runs the scope again on replay and rebuilds the result from the scope's recorded operations. Split long conversations across executions. Invoke a published version or alias, so that replays run the same code.

## Security

- **Approvals.** On Lambda, the token that `publish` receives is a callback ID. Anyone who has it and may call `lambda:SendDurableExecutionCallbackSuccess` on the function can answer, and minamo does not know who answered. Send tokens only to your approval backend, never to the user who asked for the action, and do not log them. The backend must authenticate the approver and check that this person may approve this request. Validate the answer in the tool, as in the example: approve only `approved === true`, because `"false"` is truthy. Set a `timeout`.
- **What the journal keeps.** Recorded model events, tool inputs, tool results, and tool error messages stay in the execution's checkpoints as plain JSON for its retention period. Grant `lambda:GetDurableExecution*` only to principals that may see this data, and keep secrets out of tool results and error messages: errors are shown to the model and recorded.
- **Model output is input.** Tool inputs and call IDs come from the model, so prompt injection can choose them. Each tool validates its own input. `runTools` rejects a turn with missing or repeated call IDs, and looks tools up among the own properties of `tools` only.

## Design

See [docs/design.ja.md](./docs/design.ja.md) (Japanese).

## License

[MIT](./LICENSE)
