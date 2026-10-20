import type { Model, ModelEvent, ModelRequest } from "./agent.js";

export { MemoryEngine } from "./memory.js";

/** One scripted response: plain text, or events (a `finish` event is added when missing). */
export type FakeTurn = string | ModelEvent[] | ((request: ModelRequest) => string | ModelEvent[]);

/**
 * A scripted {@link Model}: the n-th real call plays `script[n]`. Replays never call it, so `requests.length`
 * counts the model calls that actually ran.
 */
export function fakeModel(script: readonly FakeTurn[]): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: "fake",
    requests,
    async *stream(request) {
      const turn = script[requests.length];
      requests.push(request);
      if (turn === undefined) throw new Error(`fakeModel: no scripted response for call ${requests.length}`);
      const played = typeof turn === "function" ? turn(request) : turn;
      const events: ModelEvent[] = typeof played === "string" ? [{ type: "text", text: played }] : played;
      yield* events;
      if (!events.some(event => event.type === "finish")) {
        yield { type: "finish", reason: events.some(event => event.type === "tool_call") ? "tool_use" : "end_turn" };
      }
    },
  };
}
