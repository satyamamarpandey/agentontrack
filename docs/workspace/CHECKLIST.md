# Workspace programme: checklist and status

Started 2026-11-02, on top of 1.0.0-rc.2. Rule: no change may break what rc.2 does. Every row is PASS, FAIL, BLOCKED, PARTIAL or NOT_TESTED, and only a real run, not a contract test with a mock, can make an integration row PASS.

## Phase 1: shared architecture

| # | Item | Status |
|---|---|---|
| 1.1 | Safe workspace files over the companion: list, read, save with a content hash, conflict on a stale hash, no symlink escape, no `.git` | PASS (local automated tests) |
| 1.2 | Protected files (goal, safety and instruction files, hook files) saved only through the human proof path | PASS (local automated tests) |
| 1.3 | Revision on every read, `expectGoalVersion` on goal changes, so a stale window cannot overwrite newer state | PASS (local automated tests) |
| 1.4 | Event catch-up by id, for reconnecting clients (web, CLI, IDE) | PASS (local automated tests) |
| 1.5 | Project rename, archive, and a guard on where a browser may create a project | PASS (local automated tests) |
| 1.6 | Concurrent-client consistency test | PASS (local automated tests) |

## Phase 2: web workspace

Explorer, editor with preview and diff, prompt composer, live output, team panel, task board, git status, handoff panel.

| Item | Status |
|---|---|
| Workspace UI against the real companion: file save and stale-file conflict, protected file through confirmation, Markdown preview, roles both ways, approvals, handoffs, worktree diff, verification, layout and palette, dialog focus | PASS in Chromium, Firefox, WebKit and Edge (local) |
| Mobile (focused views, tab bar) | PASS (Pixel 7 profile, local) |
| axe on the Workspace: editor, preview, every right and bottom panel, tasks, composer, palette and the confirmation dialog, in both themes | PASS (found and fixed three real defects: tablist structure, feed focus, gutter contrast) |
| Real Claude Code through the new composer: project created in the UI, agent connected, task, file written, push held, denied, approved, real push, cancel, stale file, second window, unauthorized caller, reconnect, Verify, receipt, VERIFIED, dashboard | PASS (local, 4 runs, about $0.011 list price), kept in the private evidence record |
| Code diff of a change made by the composer's agent | PARTIAL: diffs are shown for worktree changes. Composer runs edit the project folder, not a worktree, so no diff is shown for them |
| Same chain against the published HTTPS site | NOT_TESTED until the site is deployed from this commit |

## Phase 3: multi-agent execution

Isolated worktrees per task or agent, ownership, overlap detection, merge preview and approval-gated merge, roles, sequential and parallel workflows, handoff v2 with authorization revalidation, capability-aware failover. Real git is used throughout and tested. The `spec-review` workflow (docs/workspace/SPEC-REVIEW.md) plans fresh-session reviewers and has a deterministic structure check. Claude coding with Codex reviewing, and the reverse, as REAL RUNS: BLOCKED/PARTIAL. Only Claude Code can be started from the product, Codex is not installed on the owner's machine, and a hosted Codex model has no login. Roles can be assigned, which is not execution. Details follow:  rework prevention. PARTIAL: worktrees, merge preview and approval-gated merge, roles, workflows, handoff v2, failover are built and tested locally against real git; running agents other than Claude from the companion, and a multi-agent demonstration with real agents, are NOT_TESTED.

## Phase 4: CLI

`project list|add|open|rename|archive`, `agents list|connect`, `team set`, `handoff`, `usage`, JSON output, shell completion. Existing commands unchanged. PASS (local automated tests, including a cross-surface test with the companion); shell completion NOT_TESTED.

## Phase 5: editors

VS Code extension (VSIX, installed into a real VS Code extension host), then Cursor, then Antigravity and others, by what each documents. PARTIAL: VSIX builds and its client passes 9 tests; a real Claude Code run through the extension client PASSED locally (write, push held, approved with a terminal code, pushed, verified). The real VS Code extension-host test is written but NOT_TESTED until the CI job runs. Cursor and Antigravity are NOT_TESTED. VS Code and Cursor need an editor on a runner, which is feasible on GitHub Actions. Antigravity may be BLOCKED by its login.

## Phases 6 to 9

Agent integrations (see `docs/compatibility.md`), analytics (nothing invented: see `docs/workspace/METRICS.md` when written), certification, release candidate. NOT_TESTED. Nothing is published without the owner's approval.

## Standing limits

Cursor, Devin and Kiro adapters have never run on the real programs. Hosted-model tests for Codex, Hermes, Copilot and Gemini are BLOCKED on logins. Nobody independent has evaluated any of this.
