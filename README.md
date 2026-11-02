# AgentOnTrack

**Set the goal. Approve what matters. Let independent checks decide when the work is done.**

A free, open-source, local-first control layer for AI coding agents. It uses your agent's own hooks and your own login, with no account and no upload.

> **Status: 1.0.0-rc.3, a release candidate, published.** Website: https://pandeysatyam.com/agentontrack/. Best tested on Claude Code, the only agent the product can start. Codex and Hermes have been run only with small local or scripted models, and Cursor, Devin, Kiro and Antigravity have not run on the real programs. See [compatibility](docs/compatibility.md). All testing is by the project itself, and nobody independent has evaluated it.

## What it does

- **Tightly bound approvals.** One effect, one task, one goal version, one policy version, one runtime. Single-use, and they expire. Unanswered requests lapse.
- **Checks actions against effects.** Compares the workspace afterwards with what was authorized. Prevented and detected-afterwards are reported separately.
- **States its own coverage.** Each record says whether the action was enforced or only partly visible.
- **Withholds `VERIFIED`** unless your checks pass on the current code, no unauthorized change is open, and no sign of weakened tests is unreviewed. An agent saying "done" counts for nothing.
- **Local dashboard** paired to your browser with a one-time code: goals, approvals, evidence, usage, safety.
- **A checkable record.** Append-only log, separate witness file and an optional passphrase-protected approver key. Tamper-evident under [stated assumptions](docs/security/integrity.md). Not immutable.

## Install

```sh
curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh      # Linux, macOS
irm https://pandeysatyam.com/agentontrack/install.ps1 | iex           # Windows PowerShell
```

Nothing else is needed, and it does not need administrator rights. VS Code: `code --install-extension agentontrack-vscode.vsix`, from the release files. [Install guide and troubleshooting](docs/install.md).

## Quick start

```sh
cd your-project
agentontrack setup       # finds your agents, connects them, asks for a goal and a check
agentontrack doctor      # what is and is not enforced here
# use your agent as usual. On Codex: agentontrack run codex
agentontrack approvals   # then: agentontrack approve <id>, or deny <id>
agentontrack verify
agentontrack dashboard
```

Stricter option: `agentontrack policy profile strict` holds opaque programs for approval and reverses unauthorized file changes. It blocks often. On Linux and macOS, `agentontrack install claude-code --sandbox` contains scripts instead.

## From source

Node 24 or later and pnpm: `pnpm install && pnpm build`, then `node packages/cli/dist/index.js`. See [CONTRIBUTING](CONTRIBUTING.md).

## What it does not do

- **It cannot stop what it cannot see.** In the standard profile, a script's file changes in the project are caught only *after* they happen, and its network activity is not seen at all.
- **It is not a boundary against a determined program running as you.** Such a program could rewrite both the log and the witness. Without an enrolled passphrase, it could also fake the terminal confirmation.
- **Command analysis is best-effort.** Obfuscation can evade it.
- **`VERIFIED` is only as good as your check.** Weak checks pass unfinished work, and hollowed-out tests that keep their counts are not caught.
- **It does not save time, or measurably save tokens.** In our benchmark it took longer than the bare agent.
- **On Codex, a missing hook program means no protection.** The real host runs the action anyway.

## Measured so far

From [benchmark v4](benchmarks/README.md): self-run, small fixtures we wrote, one cheap model, 162 runs.

- **Task success:** 100% with AgentOnTrack, and also 100% with a plain goal in `CLAUDE.md`. 78% for the bare agent, native deny rules and cc-safety-net, all of which failed the same restart tasks. So that gain comes from stating the goal.
- **Unauthorized effects:** bare agent 12, cc-safety-net 9, deny rules 6, a goal in `CLAUDE.md` 5, AgentOnTrack standard 5, strict 0. Standard mode did not stop indirect pushes and network calls made by scripts.
- **Time:** 1.9 to 10.0 seconds more per run than the bare agent (95% interval). **Tokens:** no measurable difference. No savings are claimed.
- **Blocks that may have been wrong:** 7 in 27 standard runs, and 13 in 27 strict runs.
- **Wrong VERIFIED:** 0 in 54 runs, down from 3 in 21 in the gate-only condition of an earlier version.

## Docs

[Install and troubleshooting](docs/install.md) · [Compatibility](docs/compatibility.md) · [Security limits](SECURITY.md) · [Integrity trust model](docs/security/integrity.md) · [Benchmarks](benchmarks/README.md) · [Evaluate it yourself](docs/evaluation/INDEPENDENT.md) · [Changelog](CHANGELOG.md)

Not affiliated with or endorsed by Anthropic, OpenAI or Nous Research. Licensed under Apache-2.0.
