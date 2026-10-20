# minamo

[日本語](./README.ja.md)

> **水面 (minamo)**: the surface of water. Calm on top, whatever runs underneath.

A small, dependency-free durable agent runner for [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html).

Declare an agent and its tools. minamo runs the model/tool loop and records each model call and each tool call as a durable operation, so a crash, a redeploy, or a week-long wait for human approval resumes from the last completed call instead of starting over and paying for the same tokens again. Human approval is one line on the tool, and the answering side needs no database: the execution itself knows what is waiting.

> [!WARNING]
> Experimental alpha. The API will change.

- **No dependencies in the core.** Web standard APIs only: no `node:` imports, no `Buffer`, no `AsyncLocalStorage`. About 10 KB minified, 4 KB gzipped.
- **Schemas you already use.** Tool inputs and structured output take a [Standard Schema](https://standardschema.dev) (zod 4.2+, ArkType; others with a JSON Schema next to them). minamo validates the model's input and derives the JSON Schema the model sees.
- **Replay stays out of your code.** Operation names, idempotency keys, and replay-safe history are minamo's job. You write the tools.
- **Adapters, not lock-in.** The core talks to a three-operation `Durable` interface. `@minamojs/lambda-df` implements it on Lambda; providers plug in through a small `Model` contract.

## Install

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @minamojs/bedrock@alpha @aws/durable-execution-sdk-js @aws-sdk/client-bedrock-runtime zod
```

Requires Node.js 22 or later.

| Package | Contents |
| --- | --- |
| `@minamojs/minamo` | `agent()`, `tool()`, messages, the `Model` and `HistoryStore` contracts, and the lower-level `Durable`, `model()`, `runTools()`. `/memory`: an engine for tests. `/testing`: `fakeModel()`. No dependencies. |
| `@minamojs/lambda-df` | The Lambda durable functions engine and `handle()`. `/callbacks`: answer human requests by `requestId` (optional peer: `@aws-sdk/client-lambda`). |
| `@minamojs/bedrock` | `bedrock(modelId)`: Amazon Bedrock Converse streaming. Peer: `@aws-sdk/client-bedrock-runtime`. |
| `@minamojs/dynamodb` | `dynamoHistory()`: conversation history in one DynamoDB table. Peer: `@aws-sdk/client-dynamodb`. Optional. |

## Example

```ts
import { agent, RetryableError, tool } from "@minamojs/minamo";
import { bedrock } from "@minamojs/bedrock";
import { handle } from "@minamojs/lambda-df";
import { z } from "zod";

const support = agent({
  name: "support",
  model: bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
  instructions: "You are a customer support agent for an online shop.",
  tools: {
    get_weather: tool({
      description: "Weather forecast for a city, used to plan a redelivery.",
      input: z.object({ city: z.string() }),
      run: async ({ city }) => {
        const response = await weather.forecast(city);
        if (response.status === 503) throw new RetryableError("weather API unavailable"); // retried
        return response.body; // any other throw becomes an error result for the model
      },
    }),
    issue_refund: tool({
      description: "Refunds an order after a human approves it.",
      input: z.object({ orderId: z.string(), amountYen: z.number().positive() }),
      approval: { when: ({ amountYen }) => amountYen >= 10_000, timeout: { hours: 1 } },
      run: async (input, { idempotencyKey }) => payments.refund({ ...input, idempotencyKey }),
    }),
  },
});

export const handler = handle(support, {
  prompt: (event: { prompt: string }) => event.prompt,
  onHumanRequest: request => slack.notify(request.summary), // requestId and what to show; the token stays on the server
});
```

And the approver's side, in any HTTP framework:

```ts
import { callbacks } from "@minamojs/lambda-df/callbacks";

const answers = callbacks();
await answers.pending(executionArn);                     // [{ requestId, summary }] waiting now
await answers.approve(requestId, { reason: "looks fine" }); // { status: "sent" | "closed" | "unknown" }
```

`weather`, `payments`, and `slack` are your code. This example is type-checked in [`test/readme-example.ts`](./test/readme-example.ts). For a deployable version with a smoke test, see [examples/lambda-bedrock](./examples/lambda-bedrock).

## Agents

`agent({ name, model, instructions?, tools?, output?, maxTurns? = 10 })` returns an agent. `handle(agent, options)` runs it once per durable execution with `agent.name` as the run key. To compose, run it yourself inside `handle(async (event, durable) => ...)`:

```ts
const result = await support.run(durable, { key: "support", prompt, history }, { onHumanRequest, onEvent });
// { output, messages, newMessages, turns, finish: { reason, usage? }, historyUpTo? }
```

- `key` names the run's scope. Make it unique within the execution and never derive it from time or randomness.
- `history` (earlier `Message`s) or `conversation: { id, store }` (a `HistoryStore`, see below). `newMessages` is valid as the next run's `history`.
- `output`: a Standard Schema for structured output. minamo adds a `final_result` tool. If the model calls it together with other tools, the other tools run and `final_result` is asked again.
- Operation tree: `<key>` scope → `model-<turn>` steps and `tools-<turn>:<callId>` scopes (opened in call order) → `run` step, or the workflow's own operations.

## Tools

`tool({ description, input, approval?, retry?, run })` or `tool({ description, input, approval?, workflow })`.

- `input` is validated outside any step, so its refinements and transforms must be pure. Invalid input goes back to the model as an error result.
- `run(input, { idempotencyKey, call, attempt })` is one step. Throw `RetryableError` to retry it (default: 3 attempts); any other error is recorded once as an error result.
- `workflow(input, { durable, ask, idempotencyKey, call })` runs in the call's scope and may use durable operations and `ask(name, { request?, schema?, timeout? })`. Names starting with `$` are reserved.
- `idempotencyKey` is `executionId/runKey/turn/callId`: the same on every retry, replay, and resume. Pass it to external APIs.

## Human in the loop

`approval: true | { when?, timeout?, request? }` asks a human before `run`. `ask()` asks inside a workflow. Both become a `$human:<name>` scope with a `request` step (the public summary) and a `wait` signal; the function does not run while it waits.

- `onHumanRequest(request)` receives `{ requestId, kind, tool, request, expiresAt?, summary, token, ... }` once per request (at-least-once across crashes: dedupe by `requestId`). Send only `summary` to browsers and chats.
- Only `{ approved: true }` (the boolean) approves. Denied, expired, invalid answers, and failed notifications reach the model as distinct error results; the tool does not run.
- `callbacks().pending(executionArn)` reads the execution's history and lists what can be answered now; `approve`, `reject`, and `answer` find the open callback for a `requestId` and send the answer. `closed` means expired, already answered, or the execution ended; `unknown` means the answer may or may not have arrived. The rules it follows are in [`packages/lambda-df/src/callbacks.ts`](./packages/lambda-df/src/callbacks.ts).
- Authorize before calling: that the execution belongs to the caller, and that the caller may answer. `requestId` is not a secret.
- `GetDurableExecutionHistory` allows 15 calls per second per account, one per history page. Notify with `onHumanRequest` and call `pending` on page load or refresh, not in a polling loop. For an inbox across many executions, store `requestId` and `summary` yourself (not the token) and still answer with `approve(requestId)`.

## Conversation history

```ts
interface HistoryStore {
  head(conversationId: string): Promise<number>;
  read(conversationId: string, upTo: number): Promise<Message[]>;
  append(conversationId: string, seq: number, messages: Message[], writeId: string): Promise<void>;
}
```

With `conversation: { id, store }`, a run records only the history position (`history-head`), reads runs `1..upTo` outside steps, and appends its own messages as run `upTo + 1` (`history-append`) with an idempotent `writeId`. A second run that appends the same `seq` gets `HistoryConflictError`; it does not undo that run's side effects, so allow one run per conversation at a time. `memoryHistory()` is in the core; `dynamoHistory({ client, table })` is in `@minamojs/dynamodb`.

## Testing without AWS

```ts
import { fakeModel, MemoryEngine } from "@minamojs/minamo/testing";

const engine = new MemoryEngine({ crash: () => true }); // optional: crash after every recorded operation
const running = engine.run(d => support.run(d, { key: "t", prompt: "refund A-1" }, { onHumanRequest: async () => {} }), null);
const [request] = await engine.pending(); // signals waiting for an answer
engine.complete(request.token, { approved: true }); // or engine.expire(request.token)
const result = await running;
```

`MemoryEngine` replays like a real engine: each invocation runs the handler from the top and returns recorded results. `fakeModel([...])` plays one scripted response per real model call. Timeouts on Lambda and large scope results are covered by tests with the SDK's `LocalDurableTestRunner`.

## Lower level

The agent runner is built on three exported pieces you can use directly:

- `Durable`: `step(name, fn, { retry }?)`, `scope(name, fn)`, `signal(name, publish, { timeout }?)` (rejects with `SignalTimeoutError`), and `executionId`. Names must be unique within a scope and deterministic.
- `model(durable, name, call, options?)`: one model call as one step that records every streamed event (default retry: `defaultModelRetry`).
- `runTools(durable, turn, calls, tools)`: one turn's tool calls, concurrently, one scope each.

Recorded values are JSON plus `Uint8Array` (stored as base64).

## Guarantees and limits

- **At-least-once.** A tool can run again if the process stops after its side effect and before its result is recorded. Use `idempotencyKey`. `onHumanRequest` and `onEvent` are at-least-once too.
- **Determinism.** Code outside steps runs again on every replay: schema validation, `approval.when`, `approval.request`, and `output` validation must be pure.
- **Lambda quotas.** Up to 30,000 operations and 100 MB of checkpoint data per execution, and 1 MB per operation; `@minamojs/lambda-df` fails a larger step with an error that names it. Keep tool results small and put large data elsewhere with a reference. Invoke a published version or alias, so that replays run the same code.

## Design

See [docs/agent-api.ja.md](./docs/agent-api.ja.md) and [docs/design.ja.md](./docs/design.ja.md) (Japanese).

## License

[MIT](./LICENSE)
