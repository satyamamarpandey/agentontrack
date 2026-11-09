# User guide

What a person does, in order. Every command here exists in the CLI; run `agentontrack --help` for the rest. Anything marked NOT TESTED has not been run against the real program.

## 1. Install
`docs/install.md`. One command per OS; it needs no administrator rights. Upgrade by running the same command again (the installer checks the archive against `SHA256SUMS` and keeps the previous version for rollback). Uninstall and purge are in the same file.

## 2. Connect your agents
`agentontrack setup` finds the agents on this computer, connects their hooks, and asks for a goal and a check. It uses each agent's own sign-in; it never reads, copies or sends it.

- **Claude Code:** start, stream, stop, resume, isolated worktrees, goal and phase loops: run against a real Claude Code.
- **Codex:** sign in yourself with `codex login`, then follow `docs/codex-setup.md`. Start, stream, approvals, resume, text and image attachments (app-server and `codex exec`), an isolated worktree and Claude ↔ Codex cross-review were run against a real Codex on one Windows machine; see the maintainers' record "CERTIFICATION.md" (not published).
- Others: see the capability matrix in `docs/compatibility.md`.

## 3. Work
Use your agent as usual, or start one from the dashboard (`agentontrack dashboard`). Actions that need a person wait in **Approvals**: `agentontrack approvals`, then `approve <id>` or `deny <id>`. Each approval is for one action and expires.

## 4. Hand work to another agent
A handoff carries the goal, decisions, limits and changed files, never an approval. the maintainers' record "PRODUCT_READINESS.md" (not published) says which handoffs ran with real agents and which with test scripts.

## 5. Check the result
`agentontrack verify`. `VERIFIED` means your checks passed on the current code and nothing unauthorized is open. It is only as good as your checks.

## 6. Phone
Optional. `docs/workspace/PHONE.md`. Needs a Firebase project you own: **BLOCKED** until you set one up (`docs/accounts-setup.md`).

## Optional settings
`docs/e-env.md`. Values stay in a private file and are never logged.
