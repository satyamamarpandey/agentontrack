# Development instructions

pnpm monorepo, TypeScript, Node >= 24. `pnpm build`, then `pnpm test` (MCP and CLI tests run the built `dist`).

- `packages/core/src/decide.ts` stays pure: no model calls, no network.
- Never add an MCP tool that grants approval, changes policy or creates tasks, or a shell tool.
- Never add `ask` to hook output: Codex treats it as a failure and runs the tool.
- Do not claim novelty, safety or savings without evidence. Never say first, only, novel, proof of execution, tamper-proof, cryptographically guarantees, or complete mediation; or that a filesystem diff catches every effect; or that this improves task success beyond stating the goal; or that it saves tokens.
- Never edit a benchmark scenario or a recorded result to improve a number. Add a new versioned set.
- Mark anything not run against a real runtime as NOT TESTED.
