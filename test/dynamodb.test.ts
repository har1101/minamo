import assert from "node:assert/strict";
import { test } from "node:test";
import { type AttributeValue, ConditionalCheckFailedException, type DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { dynamoHistory } from "@minamojs/dynamodb";
import { HistoryConflictError, HistoryTooLargeError, type Message } from "@minamojs/minamo";

type Item = Record<string, AttributeValue>;

/** In-memory DynamoDB with the Query/PutItem semantics dynamoHistory relies on; Query returns `pageSize` items per page. */
function fakeDynamo(pageSize = 2) {
  const items = new Map<string, Map<number, Item>>();
  const sent: (QueryCommand | PutItemCommand)[] = [];
  let failure: Error | undefined;
  const send = async (command: QueryCommand | PutItemCommand) => {
    sent.push(command);
    if (failure) throw failure;
    if (command instanceof PutItemCommand) {
      const item = command.input.Item!;
      const runs = items.get(item.conversationId!.S!) ?? items.set(item.conversationId!.S!, new Map()).get(item.conversationId!.S!)!;
      const seq = Number(item.seq!.N);
      const old = runs.get(seq);
      if (old) {
        throw new ConditionalCheckFailedException({
          message: "The conditional request failed", $metadata: {},
          Item: command.input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? old : undefined,
        });
      }
      runs.set(seq, item);
      return {};
    }
    const { ExpressionAttributeValues: values, ScanIndexForward, Limit, ExclusiveStartKey, ConsistentRead } = command.input;
    assert.equal(ConsistentRead, true);
    const upTo = values![":upTo"] ? Number(values![":upTo"].N) : Infinity;
    let list = [...(items.get(values![":id"]!.S!) ?? new Map<number, Item>()).entries()].filter(([seq]) => seq <= upTo).sort(([a], [b]) => a - b);
    if (ScanIndexForward === false) list.reverse();
    if (ExclusiveStartKey) list = list.slice(list.findIndex(([seq]) => seq === Number(ExclusiveStartKey.seq!.N)) + 1);
    const limit = Math.min(Limit ?? Infinity, pageSize);
    const page = list.slice(0, limit);
    const last = page.at(-1)?.[1];
    return {
      Items: page.map(([, item]) => item),
      LastEvaluatedKey: list.length > limit && last ? { conversationId: last.conversationId!, seq: last.seq! } : undefined,
    };
  };
  return {
    client: { send } as unknown as DynamoDBClient,
    items, sent,
    fail(error: Error) { failure = error; },
  };
}

const run = (text: string): Message[] => [{ role: "user", content: [{ type: "text", text }] }, { role: "assistant", content: [{ type: "text", text: `re ${text}` }] }];

test("head is 0 for a new conversation and the last seq otherwise, in one request", async () => {
  const db = fakeDynamo();
  const store = dynamoHistory({ client: db.client, table: "t" });
  assert.equal(await store.head("c"), 0);
  for (let seq = 1; seq <= 3; seq++) await store.append("c", seq, run(`m${seq}`), `w${seq}`);
  db.sent.length = 0;
  assert.equal(await store.head("c"), 3);
  assert.equal(db.sent.length, 1);
});

test("read follows pages and returns runs 1..upTo in order, keeping Uint8Array values", async () => {
  const db = fakeDynamo(2);
  const store = dynamoHistory({ client: db.client, table: "t" });
  for (let seq = 1; seq <= 5; seq++) await store.append("c", seq, run(`m${seq}`), `w${seq}`);
  const bytes: Message = { role: "user", content: [{ type: "tool_result", id: "x", name: "f", status: "ok", output: new Uint8Array([1, 2]) }] };
  await store.append("c", 6, [bytes], "w6");
  db.sent.length = 0;
  assert.deepEqual(await store.read("c", 4), [...run("m1"), ...run("m2"), ...run("m3"), ...run("m4")]);
  assert.equal(db.sent.length, 2);
  assert.deepEqual((await store.read("c", 6)).at(-1), bytes);
  db.sent.length = 0;
  assert.deepEqual(await store.read("c", 0), []);
  assert.equal(db.sent.length, 0);
});

test("read throws instead of returning partial history", async () => {
  const db = fakeDynamo(2);
  const store = dynamoHistory({ client: db.client, table: "t" });
  for (let seq = 1; seq <= 4; seq++) await store.append("c", seq, run(`m${seq}`), `w${seq}`);
  await assert.rejects(store.read("c", 5), /no run 5/);
  db.items.get("c")!.delete(2);
  await assert.rejects(store.read("c", 4), /no run 2/);
  await assert.rejects(store.read("other", 1), /no run 1/);
});

test("append is idempotent for the same writeId and never rewrites history", async () => {
  const db = fakeDynamo();
  const store = dynamoHistory({ client: db.client, table: "t" });
  await store.append("c", 1, run("first"), "w");
  await store.append("c", 1, run("first"), "w");
  assert.deepEqual(await store.read("c", 1), run("first"));
  await assert.rejects(store.append("c", 1, run("second"), "other"), HistoryConflictError);
  assert.deepEqual(await store.read("c", 1), run("first"));
  assert.equal(await store.head("c"), 1);
});

test("errors other than the condition check propagate unchanged", async () => {
  const db = fakeDynamo();
  const store = dynamoHistory({ client: db.client, table: "t" });
  const network = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
  db.fail(network);
  await assert.rejects(store.append("c", 1, run("x"), "w"), error => error === network);
});

test("a run over 400 KB throws HistoryTooLargeError without sending", async () => {
  const db = fakeDynamo();
  const store = dynamoHistory({ client: db.client, table: "t" });
  // run() holds the text twice: 140k three-byte characters are ~420 KB in UTF-8, though only 140k UTF-16 units long.
  await assert.rejects(store.append("c", 7, run("あ".repeat(70_000)), "w"), (error: Error) =>
    error instanceof HistoryTooLargeError && /c/.test(error.message) && /run 7/.test(error.message) && /not undone/.test(error.message));
  assert.equal(db.sent.length, 0);
  await store.append("c", 1, run("a".repeat(195 * 1024)), "w");
  assert.equal(await store.head("c"), 1);
});
