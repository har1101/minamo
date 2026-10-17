# Changelog

All packages (`@minamojs/minamo`, `@minamojs/lambda-df`) share one version.

## Unreleased

- `@minamojs/lambda-df`: the step result limit follows Lambda's new quota of 1 MB per durable operation (was 256 KB), so step results between 256 KB and 1 MB no longer fail. Docs state the new quotas: 30,000 operations per execution (was 3,000), 1 MB per step result and per callback result, 100 MB in total.
- `@minamojs/minamo`: the codec escapes data shaped like its bytes marker. Before, a value such as a tool output `{"$bytes": "aGk="}` came back as a `Uint8Array` (live and on replay). **Breaking** for journals written by earlier versions that contain a one-key object `{"$$bytes": …}` (or more `$`): it now reads as `{"$bytes": …}`. Keep executions started on an earlier version running on that version (invoke a published version or alias).
- **Breaking** `@minamojs/minamo`: `ToolContext.idempotencyKey` is a SHA-256 hex digest of the execution id, the enclosing scopes, the turn, and the call id, instead of `<executionId>#<call id>`. It no longer passes the execution id (on Lambda, the execution ARN) to downstream APIs, and it differs between tool calls when a provider reuses a call id in a later turn, in a nested agent of a workflow tool, or in sibling scopes (before, they shared a key, so a deduplicating API dropped the later call). It is still stable across retries, replays, and resumes. Executions started on an earlier version get new keys if they move to this version.
- **Breaking** `@minamojs/minamo`: `Durable` has `path`, the names of the enclosing scopes. Both engines implement it; a custom engine must too.
- `@minamojs/minamo`: `runTools` rejects a turn that repeats a call id, before any tool runs. Before, the memory engine failed with a duplicate operation name and Lambda ran both calls, whose results the model could not tell apart.
- `@minamojs/minamo`: `runTools` fails when a replayed tool result names another call id or tool, instead of returning another tool's recorded result.
- README: a Security section (signal tokens and approvals, tool inputs, what the journal keeps), and the approval examples (README, `examples/lambda-bedrock`) accept only `approved === true`. Before, `{"approved": "false"}` approved the refund.
- Release workflow: dependency code runs only in a read-only `build` job, with `npm ci --ignore-scripts`; the `publish` job, which holds `contents: write` and the npm OIDC token, installs no dependencies and publishes the tarballs built and checksummed by `build`. Releases attach `SHA256SUMS`. CI also installs with `--ignore-scripts`. Actions are pinned to commit SHAs and updated by Dependabot.

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
