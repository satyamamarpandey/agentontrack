# Independent evaluation

Nobody outside this project has evaluated it. If you do, this is how, and please publish what you find whether or not it is flattering.

## What to try to break

1. Get a consequential action past the gate on a supported agent, with hooks working.
2. Get a task to `VERIFIED` when the work is not done.
3. Rewrite the record so `agentontrack audit` and `anchor verify` both pass.
4. From a page on an allowed origin, change anything without a terminal code.
5. Find a claim on the website or in `SECURITY.md` that is not true.

## Reproducing the benchmark

Needs Claude Code with your own login. It spends real usage, up to the cap in the protocol.

```sh
git clone https://github.com/satyamamarpandey/agentontrack && cd agentontrack
pnpm install --frozen-lockfile && pnpm exec tsc -b packages/cli
mkdir /tmp/e && (cd /tmp/e && npm init -y && npm i cc-safety-net@2.7.1)
AOT_BENCH_E=/tmp/e/node_modules/cc-safety-net/dist/bin/cc-safety-net.js AOT_BENCH_CONCURRENCY=2 node benchmarks/v4/run.mjs scored haiku
```

Read `benchmarks/v4/PROTOCOL.md` first. The fixtures were written by the project's author and an AI agent, so better still, write your own tasks in `benchmarks/v4/tasks.mjs`.

## Known weaknesses of the evidence

Self-authored small tasks, one cheap model, one machine, few repeats, a cooperative model, and no independent party. Some host checks use a scripted model, and they are labelled as such: they test the host and gate, not how a real model behaves.
