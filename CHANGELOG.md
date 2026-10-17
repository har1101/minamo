# Changelog

All packages (`@minamojs/minamo`, `@minamojs/lambda-df`) share one version.

## Unreleased

- `@minamojs/lambda-df`: the step result limit follows Lambda's new quota of 1 MB per durable operation (was 256 KB). Steps between 256 KB and 1 MB no longer fail. The docs now give the new quota of 30,000 operations per execution (was 3,000).
- `@minamojs/minamo`: the codec escapes data shaped like one of its markers (`{"$bytes": …}`, `{"$esc": …}`) as `{"$esc": data}`. Before, a tool or model result such as `{"$bytes": "aGk="}` came back from the journal as a `Uint8Array`. **Breaking for running executions:** a value written by an earlier version that is a one-key object `{"$esc": x}` now decodes as `x`. Keep executions started on an earlier version on that version (invoke a published version or alias).
- **Breaking:** `@minamojs/minamo`: `ToolContext.idempotencyKey` is the SHA-256 hex digest of the execution ID and the tool call's scope path, instead of `<executionId>#<call id>`. It no longer passes the execution ID (on Lambda, the execution ARN) to the APIs that receive it, and it no longer collides when a provider reuses a call ID in a later turn, in another scope, or in a nested agent (before, a deduplicating API dropped the second call). It is still stable across retries, replays, and resumes. A tool call that started on an earlier version gets a different key after the upgrade.
- **Breaking:** `@minamojs/minamo`: `Durable` has `path`, the names of the scopes it runs in. Engines must provide it; `@minamojs/lambda-df` and `@minamojs/minamo/memory` do.
- `@minamojs/minamo`: `runTools` opens its scopes after hashing the keys, so it no longer opens them synchronously when called. They still open in call order before any tool starts.
- `@minamojs/minamo`: `runTools` rejects a turn whose calls repeat a call ID, before any tool starts. Before, the memory engine failed with a duplicate operation name after the first tool had started, and on Lambda both calls ran with the same idempotency key.
- `@minamojs/minamo`: on replay, `runTools` rejects a recorded tool result whose call ID or tool name differs from the call it is replayed for, instead of handing it to the model.
- README, `examples/lambda-bedrock`: approve only `approved === true`. Before, the approval check was truthiness, so an answer of `{"approved": "false"}` approved the refund. Added a Security section on approval tokens, what the journal keeps, and tool input.

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
