import { agent, RetryableError, tool, type HumanRequestSummary } from "@minamojs/minamo";
import { bedrock } from "@minamojs/bedrock";
import { handle } from "@minamojs/lambda-df";
import { callbacks } from "@minamojs/lambda-df/callbacks";
import { z } from "zod";

// Stand-ins for the reader's own code.
declare const weather: { forecast(city: string): Promise<{ status: number; body: string }> };
declare const payments: { refund(input: { orderId: string; amountYen: number; idempotencyKey: string }): Promise<{ refundId: string }> };
declare const slack: { notify(summary: HumanRequestSummary): Promise<void> };
declare const executionArn: string;
declare const requestId: string;

const support = agent({
  name: "support",
  model: bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
  instructions: "You are a customer support agent for an online shop.",
  tools: {
    get_weather: tool({
      description: "Weather forecast for a city, used to plan a redelivery.",
      input: z.object({ city: z.string() }),
      run: async ({ city }) => {
        const response = await weather.forecast(city);
        if (response.status === 503) throw new RetryableError("weather API unavailable"); // retried
        return response.body; // any other throw becomes an error result for the model
      },
    }),
    issue_refund: tool({
      description: "Refunds an order after a human approves it.",
      input: z.object({ orderId: z.string(), amountYen: z.number().positive() }),
      approval: { when: ({ amountYen }) => amountYen >= 10_000, timeout: { hours: 1 } },
      run: async (input, { idempotencyKey }) => payments.refund({ ...input, idempotencyKey }),
    }),
  },
});

export const handler = handle(support, {
  prompt: (event: { prompt: string }) => event.prompt,
  onHumanRequest: request => slack.notify(request.summary), // requestId and what to show; the token stays on the server
});

const answers = callbacks();
await answers.pending(executionArn);
await answers.approve(requestId, { reason: "looks fine" });
