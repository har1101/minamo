// A support agent on Lambda durable functions: Bedrock Converse + minamo's agent runner.
import { agent, RetryableError, tool } from "@minamojs/minamo";
import { bedrock } from "@minamojs/bedrock";
import { handle } from "@minamojs/lambda-df";
import { z } from "zod";

const support = agent({
  name: "support",
  model: bedrock(process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0", { maxTokens: 1024 }),
  instructions: "You are a customer support agent for an online shop. Call independent tools in the same turn. "
    + "Refunds need human approval, which the issue_refund tool requests by itself: call it, then tell the customer the outcome.",
  tools: {
    get_weather: tool({
      description: "Weather forecast for a city, used to plan a redelivery.",
      input: z.object({ city: z.string().min(1) }),
      run: async ({ city }, { attempt }) => {
        // Stand-in for a flaky upstream API: fail the first attempt so the step retry shows up in the history.
        if (attempt === 1) throw new RetryableError("weather API timed out");
        return { city, forecast: city.length % 2 === 0 ? "sunny" : "light rain", highC: 18 + (city.length % 7) };
      },
    }),
    issue_refund: tool({
      description: "Refunds an order after a human approves it.",
      input: z.object({ orderId: z.string(), amountYen: z.number().positive() }),
      approval: { timeout: { hours: 1 } },
      // Pass the idempotency key to the payment API so a retried step never refunds twice.
      run: async ({ orderId, amountYen }, { idempotencyKey }) => ({ status: "refunded", orderId, amountYen, idempotencyKey }),
    }),
  },
});

export const handler = handle(support, {
  prompt: (event: { prompt: string }) => event.prompt,
  // In a real app, notify a reviewer (Slack, email, a web app). The summary is public; the token stays here.
  onHumanRequest: async request => console.log(JSON.stringify({ type: "approval_requested", ...request.summary })),
});
