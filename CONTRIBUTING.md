# Contributing

Issues and pull requests are welcome, and optional feedback through GitHub Discussions too.

## Setup

Node 24 or newer and pnpm.

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Browser tests: `pnpm exec playwright install chromium`, `pnpm build:pages`, then `pnpm exec playwright test --project=chromium`. Tests named `live` spend real inference and only run with `AGENTONTRACK_LIVE=1`.

Real-host checks: `node benchmarks/live/host-checks.mjs claude-code` runs the real agent program against a scripted model, with a throwaway config folder and no login.

## Rules for changes

- A security fix comes with a regression test.
- Never report a mocked or scripted result as a live one. Results carry labels: `live`, `real host, scripted model`, `NOT TESTED`.
- Keep failed and negative results. Do not add savings or safety claims unless a benchmark in `benchmarks/` supports them.
- If it cannot be enforced on a host, say so in `coverageFor` and in `SECURITY.md`.

Much of this code was written by an AI coding agent. AI-assisted contributions are fine, and you remain responsible for checking them. By contributing, you license your work under Apache-2.0.
