// A support agent on Lambda durable functions: Bedrock Converse + minamo, no agent framework.
import {
  BedrockRuntimeClient, ConverseStreamCommand,
  type ContentBlock, type ConverseStreamOutput, type Message, type Tool as BedrockTool,
} from "@aws-sdk/client-bedrock-runtime";
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { model, RetryableError, runTools, type Durable, type Tool, type ToolResult } from "@minamojs/core";
import { lambda } from "@minamojs/lambda-df";

const bedrock = new BedrockRuntimeClient({ maxAttempts: 1 }); // minamo retries the whole model step instead
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const MAX_TURNS = 8;

const SYSTEM = [
  "You are a customer support agent for an online shop.",
  "Use the tools. Call independent tools in the same turn.",
  "Refunds need human approval, which the issue_refund tool requests; tell the customer the outcome.",
].join(" ");

const toolSpecs: BedrockTool[] = [
  {
    toolSpec: {
      name: "get_weather",
      description: "Weather forecast for a city, used to plan a redelivery.",
      inputSchema: { json: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
    },
  },
  {
    toolSpec: {
      name: "issue_refund",
      description: "Refunds an order after a human approves it.",
      inputSchema: {
        json: {
          type: "object",
          properties: { orderId: { type: "string" }, amountYen: { type: "number" } },
          required: ["orderId", "amountYen"],
        },
      },
    },
  },
];

const tools: Record<string, Tool> = {
  get_weather: {
    run: async ({ city }: { city: string }, { attempt }) => {
      if (typeof city !== "string" || city === "") throw new Error("city is required");
      // Stand-in for a flaky upstream API: fail the first attempt so the step retry shows up in the history.
      if (attempt === 1) throw new RetryableError("weather API timed out");
      return { city, forecast: city.length % 2 === 0 ? "sunny" : "light rain", highC: 18 + (city.length % 7) };
    },
  },
  issue_refund: {
    workflow: async ({ orderId, amountYen }: { orderId: string; amountYen: number }, { durable, idempotencyKey }) => {
      const answer = await durable.signal<{ approved: boolean; reviewer?: string }>("approval", async token => {
        // In a real app, notify a reviewer (Slack, email, a web app) with the token.
        console.log(JSON.stringify({ type: "approval_requested", orderId, amountYen, token }));
      }, { timeout: { hours: 1 } });
      if (!answer?.approved) return { status: "rejected", orderId };
      // Pass the idempotency key to the payment API so a retried step never refunds twice.
      return durable.step("refund", async () => ({
        status: "refunded", orderId, amountYen, reviewer: answer.reviewer ?? null, idempotencyKey,
      }));
    },
  },
};

async function* converse(messages: Message[]): AsyncIterable<ConverseStreamOutput> {
  const response = await bedrock.send(new ConverseStreamCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM }],
    messages,
    toolConfig: { tools: toolSpecs },
    inferenceConfig: { maxTokens: 1024 },
  }));
  if (!response.stream) throw new Error("Bedrock returned no stream");
  yield* response.stream;
}

/** Rebuilds the assistant message from recorded stream events. */
function assemble(events: ConverseStreamOutput[]) {
  const blocks = new Map<number, { text: string; toolUse?: { toolUseId: string; name: string; input: string } }>();
  const block = (index = 0) => blocks.get(index) ?? blocks.set(index, { text: "" }).get(index)!;
  let stopReason: string | undefined;
  for (const event of events) {
    const start = event.contentBlockStart?.start?.toolUse;
    if (start) block(event.contentBlockStart!.contentBlockIndex).toolUse = { toolUseId: start.toolUseId!, name: start.name!, input: "" };
    const delta = event.contentBlockDelta;
    if (delta?.delta?.text) block(delta.contentBlockIndex).text += delta.delta.text;
    if (delta?.delta?.toolUse?.input) block(delta.contentBlockIndex).toolUse!.input += delta.delta.toolUse.input;
    if (event.messageStop) stopReason = event.messageStop.stopReason;
  }
  const content: ContentBlock[] = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value.toolUse
    ? { toolUse: { toolUseId: value.toolUse.toolUseId, name: value.toolUse.name, input: JSON.parse(value.toolUse.input || "{}") } }
    : { text: value.text });
  return { message: { role: "assistant", content } satisfies Message, stopReason };
}

function toolResultMessage(results: ToolResult[]): Message {
  return {
    role: "user",
    content: results.map(result => ({
      toolResult: {
        toolUseId: result.id,
        status: result.status === "ok" ? "success" : "error",
        content: [{ text: result.status === "ok" ? JSON.stringify(result.output) : result.error }],
      },
    })),
  };
}

async function agent(durable: Durable, prompt: string) {
  const messages: Message[] = [{ role: "user", content: [{ text: prompt }] }];
  const toolCalls: string[] = [];
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const events = await model(durable, `model-${turn}`, () => converse(messages));
    const { message, stopReason } = assemble(events);
    messages.push(message);
    const calls = message.content.flatMap(block => block.toolUse
      ? [{ id: block.toolUse.toolUseId!, name: block.toolUse.name!, input: block.toolUse.input }]
      : []);
    if (calls.length === 0) {
      const answer = message.content.map(block => block.text ?? "").join("");
      return { answer, stopReason, turns: turn, toolCalls };
    }
    toolCalls.push(...calls.map(call => `${turn}:${call.name}`));
    messages.push(toolResultMessage(await runTools(durable, `tools-${turn}`, calls, tools)));
  }
  throw new Error(`No final answer after ${MAX_TURNS} turns`);
}

export const handler = withDurableExecution(async (event: { prompt: string }, context: DurableContext) =>
  agent(lambda(context), event.prompt));
