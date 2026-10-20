/**
 * Amazon Bedrock Converse adapter for minamo: `bedrock(modelId)` returns a streaming {@link Model}.
 */

import {
  BedrockRuntimeClient, ConverseStreamCommand,
  type ContentBlock, type ConverseStreamCommandInput, type ConverseStreamOutput, type Message as BedrockMessage,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message, Model, ModelEvent, Retry, Usage } from "@minamojs/minamo";

/** The SDK's document type, taken from the request so the adapter needs no direct `@smithy/types` dependency. */
type DocumentType = NonNullable<ConverseStreamCommandInput["additionalModelRequestFields"]>;

export type BedrockOptions = {
  /** Should be created with `maxAttempts: 1`: minamo retries the whole model step, SDK retries would multiply them. */
  client?: BedrockRuntimeClient;
  /** Default: 4096. */
  maxTokens?: number;
  temperature?: number;
  additionalModelRequestFields?: DocumentType;
  /** Retry policy for the model step. Default: minamo's `defaultModelRetry`. */
  retry?: Retry;
};

/** Stream events that carry an error instead of data. */
const EXCEPTIONS = [
  "internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException",
] as const;

/** A Bedrock Converse model. Reasoning content, images, and documents are not supported. */
export function bedrock(modelId: string, options: BedrockOptions = {}): Model {
  let client = options.client;
  return {
    id: modelId,
    retry: options.retry,
    async *stream({ system, messages, tools }) {
      client ??= new BedrockRuntimeClient({ maxAttempts: 1 });
      const response = await client.send(new ConverseStreamCommand({
        modelId,
        messages: toBedrock(messages, tools.length > 0),
        ...(system ? { system: [{ text: system }] } : {}),
        inferenceConfig: { maxTokens: options.maxTokens ?? 4096, ...(options.temperature === undefined ? {} : { temperature: options.temperature }) },
        ...(tools.length > 0
          ? { toolConfig: { tools: tools.map(t => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as DocumentType } } })) } }
          : {}),
        ...(options.additionalModelRequestFields === undefined ? {} : { additionalModelRequestFields: options.additionalModelRequestFields }),
      }));
      if (!response.stream) throw new Error("Bedrock returned no stream");
      yield* events(response.stream);
    },
  };
}

async function* events(stream: AsyncIterable<ConverseStreamOutput>): AsyncIterable<ModelEvent> {
  const calls = new Map<number, { id: string; name: string; input: string }>();
  let reason: string | undefined;
  let usage: Usage | undefined;
  const call = (index: number): ModelEvent | undefined => {
    const pending = calls.get(index);
    if (!pending) return undefined;
    calls.delete(index);
    let input: unknown = {};
    // Invalid JSON goes through as a string, so the core's input validation reports it to the model.
    if (pending.input) try { input = JSON.parse(pending.input); } catch { input = pending.input; }
    return { type: "tool_call", id: pending.id, name: pending.name, input };
  };
  for await (const event of stream) {
    for (const key of EXCEPTIONS) {
      const exception = event[key];
      if (!exception) continue;
      const error = new Error(exception.message ?? key);
      error.name = exception.name ?? key[0]!.toUpperCase() + key.slice(1);
      throw error;
    }
    const start = event.contentBlockStart?.start?.toolUse;
    if (start) calls.set(event.contentBlockStart!.contentBlockIndex ?? 0, { id: start.toolUseId ?? "", name: start.name ?? "", input: "" });
    const delta = event.contentBlockDelta;
    if (delta?.delta?.text) yield { type: "text", text: delta.delta.text };
    if (delta?.delta?.toolUse?.input) {
      const pending = calls.get(delta.contentBlockIndex ?? 0);
      if (pending) pending.input += delta.delta.toolUse.input;
    }
    if (event.contentBlockStop) {
      const done = call(event.contentBlockStop.contentBlockIndex ?? 0);
      if (done) yield done;
    }
    if (event.messageStop) reason = event.messageStop.stopReason;
    if (event.metadata?.usage) {
      const { inputTokens, outputTokens, totalTokens } = event.metadata.usage;
      usage = { inputTokens, outputTokens, totalTokens };
    }
  }
  for (const index of [...calls.keys()]) yield call(index)!; // a stream cut before contentBlockStop
  yield { type: "finish", reason: reason ?? "unknown", ...(usage ? { usage } : {}) };
}

/**
 * Converts minamo messages to Converse messages. Converse requires alternating roles, so consecutive messages with
 * the same role merge, tool results first. Without `toolConfig` it rejects tool blocks, so they become text then.
 */
function toBedrock(messages: readonly Message[], withTools: boolean): BedrockMessage[] {
  const out: { role: Message["role"]; results: ContentBlock[]; rest: ContentBlock[] }[] = [];
  for (const message of messages) {
    // Dropped before merging: Converse rejects empty content, and dropping later could break role alternation.
    if (!message.content.some(part => part.type !== "text" || part.text)) continue;
    let last = out.at(-1);
    if (last?.role !== message.role) out.push(last = { role: message.role, results: [], rest: [] });
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text) last.rest.push({ text: part.text });
      } else if (part.type === "tool_call") {
        last.rest.push(withTools
          ? { toolUse: { toolUseId: part.id, name: part.name, input: part.input as DocumentType } }
          : { text: `[tool call ${part.name}: ${JSON.stringify(part.input)}]` });
      } else {
        const text = part.status === "error" ? part.error : typeof part.output === "string" ? part.output : JSON.stringify(part.output);
        if (withTools) {
          last.results.push({ toolResult: { toolUseId: part.id, status: part.status === "ok" ? "success" : "error", content: [{ text }] } });
        } else {
          last.rest.push({ text: `[tool result ${part.name}${part.status === "error" ? " error" : ""}: ${text}]` });
        }
      }
    }
  }
  return out.map(({ role, results, rest }) => ({ role, content: [...results, ...rest] }));
}
