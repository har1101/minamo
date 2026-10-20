# @minamojs/dynamodb

An [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) conversation history store for [minamo](https://github.com/har1101/minamo), a tiny core for durable AI agent loops.

```bash
npm install @minamojs/minamo@alpha @minamojs/dynamodb@alpha @aws-sdk/client-dynamodb
```

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { dynamoHistory } from "@minamojs/dynamodb";

const store = dynamoHistory({ client: new DynamoDBClient({}), table: process.env.HISTORY_TABLE! });
// Pass `{ conversation: { id, store } }` to your agent's run options.
```

Create the table with partition key `conversationId` (String) and sort key `seq` (Number):

```bash
aws dynamodb create-table --table-name minamo-history \
  --attribute-definitions AttributeName=conversationId,AttributeType=S AttributeName=seq,AttributeType=N \
  --key-schema AttributeName=conversationId,KeyType=HASH AttributeName=seq,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

The function needs `dynamodb:Query` and `dynamodb:PutItem` on the table.

Behavior:

- Each run is one item `{ conversationId, seq, writeId, messages }`, where `messages` is a string written with minamo's codec. Items are never overwritten.
- `head` and `read` use strongly consistent queries, so a run always sees the previous run's append. `read` follows every page and throws if any run in `1..upTo` is missing rather than returning partial history.
- `append` is a conditional put. If the run already exists with the same `writeId` (a retried step), it succeeds without writing; with another `writeId`, it throws `HistoryConflictError`. Other errors, such as throttling or network failures, propagate unchanged.
- A run whose item exceeds DynamoDB's 400 KB item limit throws `HistoryTooLargeError` before sending. The size is approximated as the UTF-8 bytes of attribute names and values, with numbers counted as decimal strings. Like a conflict, this does not undo the run's side effects (tool calls already made).

Peer dependencies: `@minamojs/minamo` and `@aws-sdk/client-dynamodb` 3.x.

See the [repository README](https://github.com/har1101/minamo#readme).

Experimental alpha. The API will change. MIT License.
