// Runs the deployed example end to end: start an execution, approve the refund when the agent asks, wait for the
// answer, then print the durable operation history. Usage: node scripts/smoke.mjs [approve|reject]
// Env: STACK_NAME (default minamo-example), AWS_REGION (default us-east-1).
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  GetDurableExecutionCommand, GetDurableExecutionHistoryCommand, InvokeCommand, LambdaClient,
  SendDurableExecutionCallbackSuccessCommand,
} from "@aws-sdk/client-lambda";

const stack = process.env.STACK_NAME ?? "minamo-example";
const region = process.env.AWS_REGION ?? "us-east-1";
const decision = process.argv[2] ?? "approve";
const prompt = "Order A-1001 arrived broken. Please refund 3000 yen, and tell me the weather in Tokyo for the redelivery.";

const aliasArn = execFileSync("aws", ["cloudformation", "describe-stacks", "--region", region, "--stack-name", stack,
  "--query", "Stacks[0].Outputs[?OutputKey=='AliasArn'].OutputValue", "--output", "text"], { encoding: "utf8" }).trim();
const client = new LambdaClient({ region });

async function history(arn) {
  const events = [];
  let Marker;
  do {
    const page = await client.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: arn, IncludeExecutionData: true, Marker }));
    events.push(...(page.Events ?? []));
    Marker = page.NextMarker;
  } while (Marker);
  return events;
}

async function until(label, check) {
  for (let waited = 0; waited < 300; waited += 2) {
    const value = await check();
    if (value) return value;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const name = `smoke-${Date.now()}`;
const started = await client.send(new InvokeCommand({
  FunctionName: aliasArn, InvocationType: "Event", DurableExecutionName: name, Payload: JSON.stringify({ prompt }),
}));
const arn = started.DurableExecutionArn;
console.log(`Started ${name}\n  ${arn}`);

const callback = await until("the approval request", async () =>
  (await history(arn)).find(event => event.EventType === "CallbackStarted"));
console.log(`Agent asked for approval (callback ${callback.CallbackStartedDetails.CallbackId.slice(0, 16)}...). Waiting 5 s so the invocation suspends.`);
await sleep(5000);
await client.send(new SendDurableExecutionCallbackSuccessCommand({
  CallbackId: callback.CallbackStartedDetails.CallbackId,
  Result: new TextEncoder().encode(JSON.stringify({ approved: decision === "approve", reviewer: "smoke-test" })),
}));
console.log(`Sent ${decision}.`);

const execution = await until("the result", async () => {
  const current = await client.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn }));
  return ["SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"].includes(current.Status) ? current : undefined;
});
console.log(`\nStatus: ${execution.Status}`);
console.log(execution.Result ? JSON.stringify(JSON.parse(execution.Result), null, 2) : JSON.stringify(execution.Error));

const events = await history(arn);
const names = new Map(events.filter(event => event.Name).map(event => [event.Id, event.Name]));
console.log("\nDurable operations (parent/name: event):");
for (const event of events) {
  if (!event.EventType.startsWith("Step") && !event.EventType.startsWith("Context") && !event.EventType.startsWith("Callback")) continue;
  const retry = event.StepFailedDetails?.RetryDetails ?? event.StepSucceededDetails?.RetryDetails;
  const note = event.StepFailedDetails ? ` (${event.StepFailedDetails.Error?.Payload?.ErrorMessage ?? "error"})` : "";
  console.log(`  ${names.get(event.ParentId) ?? ""}/${event.Name ?? names.get(event.Id) ?? `(${event.SubType ?? "unnamed"})`}: ${event.EventType}${retry ? ` attempt=${retry.CurrentAttempt}` : ""}${note}`);
}
const invocations = events.filter(event => event.EventType === "InvocationCompleted").length;
const modelSteps = events.filter(event => event.EventType === "StepSucceeded" && /^model-\d+$/.test(event.Name ?? "")).length;
console.log(`\nInvocations: ${invocations}. Model calls recorded: ${modelSteps} (each ran once; the resumed invocation replayed them).`);
if (execution.Status !== "SUCCEEDED") process.exit(1);
