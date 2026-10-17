# Changelog

All packages (`@minamojs/minamo`, `@minamojs/lambda-df`) share one version.

## Unreleased

- `@minamojs/lambda-df`: the step size check follows Lambda's new quota of 1 MB per durable operation (was 256 KB). Steps between 256 KB and 1 MB, which used to fail with `StepTooLargeError`, are now recorded. Docs state the new quotas: 30,000 operations per execution (was 3,000), 1 MB per operation, and 100 MB written per execution.
- `@minamojs/minamo`: the codec escapes data shaped like one of its markers (an object whose only key is `$bytes` or `$esc`) as `{"$esc": data}`. Before, tool output or model-chosen input such as `{"$bytes": "aGk="}` came back from the journal as a `Uint8Array`. Records written by earlier versions still decode, except an object written as `{"$esc": X}` where `X` itself looks like a marker, which now decodes as `X`.
- **Breaking** `@minamojs/minamo`: `ToolContext.idempotencyKey` is a SHA-256 hex digest of the execution ID and the path of the tool call's scope, instead of `<executionId>#<call id>`. It no longer passes the execution ID (on Lambda, the execution ARN) to downstream APIs, and a call ID that the provider reuses in a later turn or in a nested agent gets its own key; before, both calls got the same key, so a deduplicating API dropped the second one. It is still stable across retries, replays, and resumes. An execution started on an earlier version passes different keys after an upgrade; keep it on the version it started with (invoke a published version or alias).
- **Breaking** for custom engines: `Durable` has `path`, the names of the enclosing scopes (`[]` at the top level, `[...path, name]` inside `scope(name, fn)`). `@minamojs/lambda-df` and `MemoryEngine` provide it.

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
