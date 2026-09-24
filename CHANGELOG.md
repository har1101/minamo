# Changelog

All packages (`@minamojs/core`, `@minamojs/lambda-df`) share one version.

## 0.1.0-alpha.0 (2026-09-24)

First alpha, published to npm with the `alpha` dist-tag.

- `@minamojs/core`: the `Durable` interface (`step`, `scope`, `signal`), declarative `Retry`, a JSON codec that keeps `Uint8Array`, `model()` for one durable step per model call, and `runTools()` for concurrent tool calls with a deterministic journal.
- `@minamojs/core/memory`: in-memory engine for tests, with replay, crash injection, and signals.
- `@minamojs/lambda-df`: engine for AWS Lambda durable functions.
- `examples/lambda-bedrock`: a deployable support agent on Lambda durable functions with Amazon Bedrock Converse and human approval.
