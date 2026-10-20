# Changelog

All packages (`@minamojs/minamo`, `@minamojs/lambda-df`, `@minamojs/bedrock`, `@minamojs/dynamodb`) share one version.

## 0.1.0-alpha.2 (2026-10-20)

minamo becomes a small durable agent runner: the L0/L1 API (`Durable`, `model()`, `runTools()`) stays as it is, with an L2 API on top. Design: [`docs/agent-api.ja.md`](./docs/agent-api.ja.md).

- `@minamojs/minamo`: `agent()` runs the model/tool loop as durable operations (`<key>` scope, `model-<turn>` steps, `tools-<turn>:<callId>` scopes). `run()` needs a `key`, takes `history` or `conversation`, and returns `{ output, messages, newMessages, turns, finish, historyUpTo? }`. `output` (Standard Schema) adds a `final_result` tool; a `final_result` mixed with other tools runs them and asks again.
- `@minamojs/minamo`: `tool()` takes a Standard Schema (zod 4.2+, ArkType; others with `jsonSchema`) for validation and the model's JSON Schema. Invalid input goes back to the model. `approval` (`when`, `timeout`, `request`) waits for a human before `run`; `workflow` tools get `ask()`. Every human request is a `$human:<name>` scope with a `request` step (the public summary) and a `wait` signal. Denied, expired, invalid answers, and failed notifications become distinct tool errors.
- `@minamojs/minamo`: a minimal message format (`text`, `tool_call`, `tool_result`), the `Model` contract, `Hooks` (`onHumanRequest`, `onEvent` with `AgentEvent`), `requestIdOf`/`parseRequestId`, `HistoryStore` with `memoryHistory()`, `HistoryConflictError`, `HistoryTooLargeError`, `SignalTimeoutError`, and exported `defaultModelRetry`/`defaultToolRetry`.
- `@minamojs/minamo/memory`: `MemoryEngine.pending()` waits for the execution to suspend and lists unanswered signals; `expire(token)` times one out.
- `@minamojs/minamo/testing` (new): `fakeModel(script)` and `MemoryEngine`.
- `@minamojs/lambda-df`: `handle(agent, { prompt, onHumanRequest, ... })` and `handle(fn)` wrap `withDurableExecution`. A signal timeout rejects with `SignalTimeoutError`. The step size check follows the new 1 MB checkpoint limit (checked as 1,000,000 bytes).
- `@minamojs/lambda-df/callbacks` (new, optional peer `@aws-sdk/client-lambda`): `callbacks()` answers human requests by `requestId` from the execution's history, with no store of pending requests: `pending(executionArn)`, `approve`, `reject`, `answer`, typed `sent`/`closed`/`unknown` results, and `RequestLookupError`.
- `@minamojs/bedrock` (new): `bedrock(modelId)`, a streaming Converse `Model`.
- `@minamojs/dynamodb` (new): `dynamoHistory({ client, table })`, a `HistoryStore` with consistent reads and conditional, idempotent appends.
- `examples/lambda-bedrock`: rewritten with `agent()`; the smoke test answers through `callbacks()`.

## 0.1.0-alpha.1 (2026-09-25)

- `@minamojs/lambda-df`: `signal` no longer retries a failing `publish` with the SDK's default retry strategy (6 attempts); it runs once, as on every engine (#1).
- `@minamojs/lambda-df`: a step result over Lambda's 256 KB STEP checkpoint limit (for example, a long `model()` stream) now fails that step with an error naming the step and its size, instead of failing at checkpoint time (#2).
- `@minamojs/minamo`: `ToolContext` has `call`, the `ToolCall` being run, so tools no longer parse the call ID out of `idempotencyKey` (#3).
- `@minamojs/lambda-df`: `retry: { backoffRate: undefined }` no longer overrides the SDK's default backoff rate, which made every delay after the first `NaN` seconds (#5). Only the fields of `Retry` reach the SDK; undeclared SDK options such as `retryableErrors` are no longer forwarded, so a policy behaves the same on every engine.

## 0.1.0-alpha.0 (2026-09-24)

First alpha, published to npm with the `alpha` dist-tag.

- `@minamojs/minamo`: the `Durable` interface (`step`, `scope`, `signal`), declarative `Retry`, a JSON codec that keeps `Uint8Array`, `model()` for one durable step per model call, and `runTools()` for concurrent tool calls with a deterministic journal.
- `@minamojs/minamo/memory`: in-memory engine for tests, with replay, crash injection, and signals.
- `@minamojs/lambda-df`: engine for AWS Lambda durable functions.
- `examples/lambda-bedrock`: a deployable support agent on Lambda durable functions with Amazon Bedrock Converse and human approval.
