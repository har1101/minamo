import { type DynamoDBClient, PutItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { HistoryConflictError, type HistoryStore, HistoryTooLargeError, type Message, parse, stringify } from "@minamojs/minamo";

/** DynamoDB's item size limit. */
const MAX_ITEM_BYTES = 400 * 1024;

/**
 * {@link HistoryStore} backed by a DynamoDB table with partition key `conversationId` (S) and sort key `seq` (N).
 * Each run is one immutable item `{ conversationId, seq, writeId, messages }`; reads are strongly consistent.
 */
export function dynamoHistory(options: { client: DynamoDBClient; table: string }): HistoryStore {
  const { client, table } = options;
  // `#seq` avoids any clash with DynamoDB's reserved words.
  const names = { "#id": "conversationId", "#seq": "seq" };
  return {
    async head(id) {
      const { Items } = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#id = :id",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":id": { S: id } },
        ProjectionExpression: "#seq",
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 1,
      }));
      const seq = Items?.[0]?.seq?.N;
      return seq === undefined ? 0 : Number(seq);
    },

    async read(id, upTo) {
      if (upTo === 0) return [];
      const messages: Message[] = [];
      let expected = 1;
      let start: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: "#id = :id AND #seq <= :upTo",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ":id": { S: id }, ":upTo": { N: String(upTo) } },
          ConsistentRead: true,
          ScanIndexForward: true,
          ExclusiveStartKey: start,
        }));
        for (const item of page.Items ?? []) {
          const seq = Number(item.seq?.N);
          // Partial or reordered history would silently corrupt the conversation, so refuse it.
          if (seq !== expected) throw new Error(`Conversation ${id} has no run ${expected} (found ${item.seq?.N ?? "no seq"})`);
          const text = item.messages?.S;
          if (text === undefined) throw new Error(`Conversation ${id} run ${seq} has no messages attribute`);
          messages.push(...parse<Message[]>(text));
          expected++;
        }
        start = page.LastEvaluatedKey;
      } while (start);
      if (expected !== upTo + 1) throw new Error(`Conversation ${id} has no run ${expected}`);
      return messages;
    },

    async append(id, seq, messages, writeId) {
      const text = stringify(messages);
      // Approximation of DynamoDB's item size: UTF-8 bytes of attribute names and values, numbers as decimal strings.
      const size = new TextEncoder().encode("conversationId" + id + "seq" + String(seq) + "writeId" + writeId + "messages" + text).length;
      if (size > MAX_ITEM_BYTES) {
        throw new HistoryTooLargeError(
          `Conversation ${id} run ${seq} is ${size} bytes, over DynamoDB's ${MAX_ITEM_BYTES}-byte item limit; ` +
          "the run's side effects are not undone");
      }
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { conversationId: { S: id }, seq: { N: String(seq) }, writeId: { S: writeId }, messages: { S: text } },
          // Never overwrite: history is immutable, and a retry of the same write is recognized by its writeId below.
          ConditionExpression: "attribute_not_exists(conversationId)",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }));
      } catch (error) {
        // Match by name so a second copy of the SDK (different class identity) still works.
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
        const existing: Record<string, AttributeValue> | undefined = "Item" in error ? error.Item as Record<string, AttributeValue> : undefined;
        if (existing?.writeId?.S === writeId) return;
        throw new HistoryConflictError(`Conversation ${id} already has run ${seq}`);
      }
    },
  };
}
