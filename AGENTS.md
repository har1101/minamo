# Agent notes

- Handoff notes and lessons learned live in https://github.com/har1101/strands-lambda-durable-ts under `docs/context/`. Read the latest `*-handoff.md` and `*-learnings.md` first, and record progress there, as its `docs/context/README.md` describes.
- Design and scope: `docs/design.ja.md`. Lambda durable functions first, Cloudflare Workflows at most. No framework adapters.
- `src/index.ts` must stay dependency-free and use Web standard APIs only: no `node:` imports, no `Buffer`, no `AsyncLocalStorage`.
- Every durable operation needs a unique, deterministic name within its scope, and the core must start operations in a fixed order.
- Checks: `npm run typecheck`, `npm test`, `npm run build`.
