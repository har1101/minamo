import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { model, RetryableError, runTools, type Durable, type Tool, type ToolCall, type ToolResult } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";

// Stand-ins for the reader's own code.
type Message = { role: string; content: unknown };
type ModelEvent = { type: "text"; text: string } | { type: "tool_call"; call: ToolCall };
declare const provider: { stream(messages: Message[]): AsyncIterable<ModelEvent> };
declare function getWeather(city: string): Promise<{ status: number; forecast: string }>;
declare function notifyReviewer(orderId: string, token: string): Promise<void>;
declare const payments: { refund(orderId: string, options: { idempotencyKey: string }): Promise<{ refundId: string }> };

const tools: Record<string, Tool> = {
  weather: {
    run: async ({ city }: { city: string }) => {
      const response = await getWeather(city);
      if (response.status === 503) throw new RetryableError("weather API unavailable"); // retried
      return response.forecast; // any other throw becomes an error result for the model
    },
  },
  refund: {
    // Workflow tools may use durable operations: here, wait (for free) until a human answers.
    workflow: async ({ orderId }: { orderId: string }, { durable, idempotencyKey }) => {
      const { approved } = await durable.signal<{ approved: boolean }>("approval", token => notifyReviewer(orderId, token));
      if (!approved) return { status: "rejected" };
      return durable.step("refund", () => payments.refund(orderId, { idempotencyKey }));
    },
  },
};

async function agent(durable: Durable, prompt: string) {
  const messages: Message[] = [{ role: "user", content: prompt }];
  for (let turn = 1; turn <= 10; turn++) {
    // One durable step per model call: after a crash or resume, the recorded events come back without a new request.
    const events = await model(durable, `model-${turn}`, () => provider.stream(messages));
    const calls = events.flatMap(event => event.type === "tool_call" ? [event.call] : []);
    messages.push({ role: "assistant", content: events });
    if (calls.length === 0) return events;
    // Tool calls run concurrently; each one is journaled on its own.
    const results: ToolResult[] = await runTools(durable, `tools-${turn}`, calls, tools);
    messages.push({ role: "tool", content: results });
  }
  throw new Error("Too many turns");
}

export const handler = withDurableExecution(async (event: { prompt: string }, context) => agent(lambda(context), event.prompt));
