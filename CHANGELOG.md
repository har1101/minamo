# Changelog

All packages (`@minamojs/minamo`, `@minamojs/lambda-df`) share one version.

## Unreleased

- **Breaking:** `@minamojs/minamo`: `Durable.executionId` is replaced by `Durable.id`, which identifies one scope instead of the execution. It is the same on every replay and resume and differs for every other scope of every execution. An engine must not put a sensitive execution identifier in it.
- **Breaking:** `@minamojs/minamo`: `ToolContext.idempotencyKey` is now the `id` of the call's scope, an opaque string, instead of `<executionId>#<call id>`. A call ID reused in a later turn or in a nested `runTools` no longer shares a key with an earlier call, and on Lambda the key no longer contains the execution ARN (it is a SHA-256 hex digest). Upgrading changes every idempotency key, so a tool retried after the deploy can run twice against a deduplicating API: let running executions finish on the old version by invoking a published version or alias.
- **Breaking:** `@minamojs/lambda-df`: a repeated operation name in one scope fails with `Duplicate durable operation name`, as on the memory engine. The SDK alone accepted it.
- `@minamojs/minamo/memory`: `MemoryEngine` percent-encodes `%`, `/`, and `#` inside each operation name, so a tool call ID such as `a/run` no longer replays another operation's journal entry. `crash(path)` and signal tokens see the encoded path.
- `@minamojs/minamo`: the codec no longer turns data shaped like its bytes marker into a `Uint8Array`. A one-key object whose key is `$bytes`, `$$bytes`, and so on gains one `$` when recorded and loses it when read, so a tool output or model event such as `{"$bytes": "aGk="}` replays unchanged. Journals written by 0.1.0-alpha.1 decode as before, except a recorded one-key object whose key is `$$bytes` or longer, which loses one `$`.
- `@minamojs/lambda-df`: a step result can be up to 1 MB, Lambda's new limit per durable operation (was 256 KB). The README states Lambda's new limit of 30,000 operations per execution (was 3,000).

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
