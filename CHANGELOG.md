# Changelog

## Unreleased

- Core: `Durable` interface (`step`, `scope`, `signal`), declarative `Retry`, a JSON codec that keeps `Uint8Array`, `model()` for one durable step per model call, and `runTools()` for concurrent tool calls with a deterministic journal.
- `minamo/lambda`: adapter for AWS Lambda durable functions.
- `minamo/memory`: in-memory engine for tests, with replay, crash injection, and signals.
- `examples/lambda-bedrock`: a deployable support agent on Lambda durable functions with Amazon Bedrock Converse and human approval.
