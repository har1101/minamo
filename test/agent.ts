import { model, runTools, type Durable, type Tool, type ToolCall, type ToolResult } from "@minamojs/minamo";

export type Message = { role: "user" | "assistant" | "tool"; text?: string; calls?: ToolCall[]; results?: ToolResult[] };
export type ModelEvent = { type: "text"; text: string } | { type: "tool_call"; call: ToolCall };
export type Provider = (messages: readonly Message[]) => AsyncIterable<ModelEvent>;

/** A complete durable agent loop written against the engine-neutral core. The same function runs on every engine. */
export async function agent(durable: Durable, prompt: string, deps: { provider: Provider; tools: Record<string, Tool> }) {
  const messages: Message[] = [{ role: "user", text: prompt }];
  for (let turn = 1; turn <= 8; turn++) {
    const events = await model(durable, `model-${turn}`, () => deps.provider(messages));
    const calls = events.flatMap(event => event.type === "tool_call" ? [event.call] : []);
    const text = events.flatMap(event => event.type === "text" ? [event.text] : []).join("");
    messages.push({ role: "assistant", text, calls });
    if (calls.length === 0) return { text, messages };
    messages.push({ role: "tool", results: await runTools(durable, `tools-${turn}`, calls, deps.tools) });
  }
  throw new Error("Turn limit reached");
}

/** Scripted provider: first turn requests `calls`, later turns summarize the tool results. Counts real calls. */
export function scripted(calls: ToolCall[]) {
  const counter = { calls: 0 };
  const provider: Provider = async function* (messages) {
    counter.calls++;
    const last = messages.at(-1)!;
    if (last.role === "user") {
      yield { type: "text", text: "Working on it." };
      for (const call of calls) yield { type: "tool_call", call };
      return;
    }
    const summary = last.results!.map(r => r.status === "ok" ? `${r.id}=${JSON.stringify(r.output)}` : `${r.id}!${r.error}`);
    yield { type: "text", text: "Done: " };
    yield { type: "text", text: summary.join(", ") };
  };
  return { provider, counter };
}
