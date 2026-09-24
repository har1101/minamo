# Example: durable support agent on Lambda + Bedrock

A customer-support agent that runs on AWS Lambda durable functions and calls Amazon Bedrock Converse directly, with no agent framework. The whole agent is [`src/handler.ts`](./src/handler.ts).

- `get_weather`: a plain tool. It fails its first attempt with `RetryableError`, so the retried step shows up in the history.
- `issue_refund`: a workflow tool. It waits for a human approval with `durable.signal` (up to 1 hour), then runs the refund as its own step with the idempotency key.
- While it waits for approval, the Lambda invocation ends. The answer starts a new invocation, which replays the recorded model calls and tool calls instead of running them again.

## Requirements

- Node.js 22 or later, the AWS CLI v2, and credentials for an account with Lambda durable functions.
- Access to the Bedrock model in the region (default: `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `us-east-1`).

## Deploy and run

```bash
npm install
AWS_REGION=us-east-1 npm run deploy    # builds minamo and the handler, then deploys the stack `minamo-example`
AWS_REGION=us-east-1 npm run smoke     # starts an execution, approves the refund, prints the result and the history
AWS_REGION=us-east-1 npm run smoke -- reject
```

`deploy` uses only the AWS CLI. CloudFormation runs the SAM transform, so the SAM CLI is not needed. It creates the bucket `minamo-artifacts-<account>-<region>` for the code package unless you set `ARTIFACT_BUCKET`. Set `STACK_NAME` or `BEDROCK_MODEL_ID` to override the defaults.

To answer an approval yourself, find the `approval_requested` log line (it has the token) and run:

```bash
aws lambda send-durable-execution-callback-success --callback-id <token> \
  --result '{"approved":true,"reviewer":"me"}' --cli-binary-format raw-in-base64-out
```

## Clean up

```bash
aws cloudformation delete-stack --stack-name minamo-example
aws s3 rb s3://minamo-artifacts-<account>-<region> --force
```
