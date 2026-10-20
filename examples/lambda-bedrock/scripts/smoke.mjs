// Runs the deployed example end to end: start an execution, find the pending approval with `callbacks().pending()`,
// answer it by requestId, wait for the result, then print the durable operation tree.
// Usage: node scripts/smoke.mjs [approve|reject]. Env: STACK_NAME (default minamo-example), AWS_REGION (default us-east-1).
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { GetDurableExecutionCommand, GetDurableExecutionHistoryCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { callbacks } from "@minamojs/lambda-df/callbacks";

const stack = process.env.STACK_NAME ?? "minamo-example";
const region = process.env.AWS_REGION ?? "us-east-1";
const decision = process.argv[2] ?? "approve";
const prompt = "Order A-1001 arrived broken. Please refund 3000 yen, and tell me the weather in Tokyo for the redelivery.";

const aliasArn = execFileSync("aws", ["cloudformation", "describe-stacks", "--region", region, "--stack-name", stack,
  "--query", "Stacks[0].Outputs[?OutputKey=='AliasArn'].OutputValue", "--output", "text"], { encoding: "utf8" }).trim();
const client = new LambdaClient({ region });
const answers = callbacks({ client });

async function until(label, check) {
  for (let waited = 0; waited < 300; waited += 3) {
    const value = await check();
    if (value) return value;
    await sleep(3000); // GetDurableExecutionHistory allows 15 calls/s per account: poll gently
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const name = `smoke-${Date.now()}`;
const started = await client.send(new InvokeCommand({
  FunctionName: aliasArn, InvocationType: "Event", DurableExecutionName: name, Payload: JSON.stringify({ prompt }),
}));
const arn = started.DurableExecutionArn;
console.log(`Started ${name}\n  ${arn}`);

const request = await until("the approval request", async () => (await answers.pending(arn)).at(0));
console.log(`Pending: ${request.requestId}\n  summary: ${JSON.stringify(request.summary)}`);
const outcome = decision === "approve"
  ? await answers.approve(request.requestId, { reason: "smoke test" })
  : await answers.reject(request.requestId, "smoke test says no");
console.log(`Sent ${decision}: ${JSON.stringify(outcome)}`);
const again = await answers.approve(request.requestId).catch(error => ({ error: `${error.name}: ${error.message}` }));
console.log(`A second answer: ${JSON.stringify(again)}`);

const execution = await until("the result", async () => {
  const current = await client.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn }));
  return ["SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"].includes(current.Status) ? current : undefined;
});
console.log(`\nStatus: ${execution.Status}`);
const result = execution.Result ? JSON.parse(execution.Result) : undefined;
console.log(result ? `Output: ${result.output}\nTurns: ${result.turns}, finish: ${JSON.stringify(result.finish)}` : JSON.stringify(execution.Error));
console.log(`Pending after the run: ${JSON.stringify(await answers.pending(arn))}`);

const events = [];
let Marker;
do {
  const page = await client.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: arn, Marker }));
  events.push(...page.Events ?? []);
  Marker = page.NextMarker;
} while (Marker);
const names = new Map(events.filter(event => event.Name).map(event => [event.Id, event.Name]));
console.log("\nDurable operations (parent/name: event):");
for (const event of events) {
  if (!/^(Step|Context|Callback)/.test(event.EventType)) continue;
  const retry = event.StepFailedDetails?.RetryDetails ?? event.StepSucceededDetails?.RetryDetails;
  console.log(`  ${names.get(event.ParentId) ?? ""}/${event.Name ?? names.get(event.Id) ?? `(${event.SubType ?? "unnamed"})`}: ${event.EventType}${retry ? ` attempt=${retry.CurrentAttempt}` : ""}`);
}
const invocations = events.filter(event => event.EventType === "InvocationCompleted").length;
const modelSteps = events.filter(event => event.EventType === "StepSucceeded" && /^model-\d+$/.test(event.Name ?? "")).length;
console.log(`\nInvocations: ${invocations}. Model calls recorded: ${modelSteps}.`);
if (execution.Status !== "SUCCEEDED" || outcome.status !== "sent") process.exit(1);
