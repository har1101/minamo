# Example: durable support agent on Lambda + Bedrock

A customer-support agent that runs on AWS Lambda durable functions and calls Amazon Bedrock Converse, written with minamo's `agent()` and `tool()`. The whole agent is [`src/handler.ts`](./src/handler.ts).

- `get_weather`: a plain tool. It fails its first attempt with `RetryableError`, so the retried step shows up in the history.
- `issue_refund`: a tool with `approval`. minamo records the request's public summary, waits for a human (up to 1 hour), and runs the refund only after `{ approved: true }`. The refund gets an idempotency key.
- While it waits for approval, the Lambda invocation ends. The answer starts a new invocation, which replays the recorded model calls and tool calls instead of running them again.
- Nothing stores the pending approval: the smoke test finds it with `callbacks().pending(executionArn)` and answers it by `requestId`.

## Requirements

- Node.js 22 or later, the AWS CLI v2, and credentials for an account with Lambda durable functions.
- Access to the Bedrock model in the region (default: `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `us-east-1`).

## Deploy and run

```bash
npm install                            # at the repository root (npm workspaces)
cd examples/lambda-bedrock
AWS_REGION=us-east-1 npm run deploy    # builds the minamo packages and the handler, then deploys the stack `minamo-example`
AWS_REGION=us-east-1 npm run smoke     # starts an execution, approves the refund, prints the result and the history
AWS_REGION=us-east-1 npm run smoke -- reject
```

`deploy` uses only the AWS CLI. CloudFormation runs the SAM transform, so the SAM CLI is not needed. It creates the bucket `minamo-artifacts-<account>-<region>` for the code package unless you set `ARTIFACT_BUCKET`. Set `STACK_NAME` or `BEDROCK_MODEL_ID` to override the defaults.

The smoke test needs `lambda:GetDurableExecutionHistory` and `lambda:SendDurableExecutionCallbackSuccess` on the function, in addition to invoking it.

To answer an approval yourself, find the `approval_requested` log line (it has the `requestId`) and run:

```bash
node --input-type=module -e '
import { callbacks } from "@minamojs/lambda-df/callbacks";
console.log(await callbacks().approve(process.argv[1], { reason: "me" }));' '<requestId>'
```

## Clean up

```bash
aws cloudformation delete-stack --stack-name minamo-example
aws s3 rb s3://minamo-artifacts-<account>-<region> --force
```
