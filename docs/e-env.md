# Optional settings: `e.env`

AgentOnTrack works with **no** `e.env`. Your Claude Code, Codex and other agent subscriptions are **not** set here: sign in with each agent's own command (`claude auth login`, `codex login`). AgentOnTrack never reads, copies or stores those sign-ins.

`e.env` (next to where you start the companion, or in `~/.agentontrack/`, or the path in `AGENTONTRACK_ENV_FILE`) holds optional settings. Copy `e.env.example` to `e.env` and fill in only what you want.

| Name | What it does |
|---|---|
| `AOT_ALLOW_PAID_API` | Off unless exactly `1`. While off, API-key variables are removed from every agent AgentOnTrack starts, and an agent signed in with an API key or cloud account is refused. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Given to that one agent, and only when `AOT_ALLOW_PAID_API=1`. Using them bills you by use. |
| `OLLAMA_HOST` | Address of a local Ollama server. Default `http://127.0.0.1:11434`. |

What is guaranteed, and tested (`packages/core/test/envfile.test.ts`, `packages/companion/test/env-file.test.ts`):
- `e.env` is in `.gitignore`, is never tracked, and is not part of the public export.
- Values are held in memory by the companion and are **not** copied into `process.env`, so no program it starts inherits them by accident.
- Values never appear in JSON, logs, `inspect` output or any API response. `GET /api/env-status` returns names and whether each is set.
- A name that is not listed above is ignored.
- Each key reaches only its own agent, and only in paid API mode.

What is not guaranteed: anyone who can read your files can read `e.env`. On Windows the file created for you is restricted to your account; on macOS and Linux run `chmod 600 e.env` (the companion reports a warning if others can read it). A program you run yourself in the same terminal can read your shell environment as usual.
