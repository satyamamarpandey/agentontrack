# Public pre-release security triage (desktop only, phone relay off)

Branch `feat/production-readiness`, base commit `9b8b146`, triaged 2026-11-08; the fixes listed at the end are committed in 52ec4f9 and a follow-up commit. The original review report (#1 to #12) is not in the repository, so every item below was re-derived from the code. Only #1, #2, #4 and #10 were identified by number in the task; the rest are the ten topics that were asked for.

This is a triage by code reading plus targeted local tests. It is not an audit, and nothing here says the build is safe. Anything not run against a real runtime is marked NOT TESTED.

## Scope of the build being triaged

- Desktop companion and dashboard. The site is built without `NEXT_PUBLIC_FIREBASE_CONFIG`, so no Firebase code is in the web or dashboard bundles and the dashboard shows "Phone access ... not switched on".
- `--allow-public-site` and `--allow-origin` are opt-in flags of `agentontrack dashboard`. Without them `allowedOrigins` is empty, no outside origin can pair, and the REMOTE_FREE paths below are unreachable.

## Summary table

Severity is for the public desktop build as shipped. "Phone-on" is the severity if a user later enables the relay.

| # | Topic | Severity (desktop) | Phone-on | Exploitable in the desktop build? | Status |
|---|---|---|---|---|---|
| 1 | Codex read-only approvals | High (original) | High | Mitigated by the fix; fake-protocol tests only, NOT TESTED against real Codex | Fixed in code; test added for the companion wiring; live confirmation NOT RUN |
| 2 | Claude tool permissions | Medium (original) | Medium | Mitigated for read-only; standard policy is hook-gated by design | Fixed in code; MCP/skills residual NOT TESTED against real Claude |
| 4 | Run and spend caps | Low | Medium | Only by a paired local caller | Phone caps exist; no aggregate cap; open |
| 10 | Process-tree stop | Medium | Medium | Yes, by the user's own Stop button leaving children | Reproduced, fixed on Windows; POSIX NOT TESTED |
| a | Remote-control secret storage | Low | Medium | No, unless a paired session calls `prepare` | Open |
| b | Transcript retention | Low | Low | Paired sessions only | Open (documented) |
| c | Orphaned processes | Low | Low | On companion exit without close | Open |
| d | Malformed input and NUL | Low | Low | No | Covered; test added |
| e | Error detail sent to phones | Low | Low | N/A (no phone) | Fixed |
| f | Cross-project and cross-device authorization | Low (N/A) | Medium | N/A (no phone) | One real defect fixed; design limits listed |
| g | Duplicate new-session requests | Low | Low | N/A for phone; local UI can double-submit | Covered by existing tests |
| h | Unintended filesystem effects | Low | Low | Only with `--allow-public-site` for the feedback item | One item fixed; others open |

Blockers: none. I found no exploitable High for the public desktop build. The one issue that would have been a Medium-to-High in a phone-enabled build (a phone could approve a write to the agent's own hook settings, or outside the project) is fixed and is not reachable in this build.

## Verification of #1 and #2

### #1 Codex read-only approvals

Code: `packages/adapters/src/codex-appserver.ts` `onServerRequest` declines every parsed approval when `sandbox === 'read-only'` without calling the callback; unparseable approvals are declined; nothing sends "accept for session". `packages/companion/src/index.ts` passes `sandbox: 'read-only'` to `CodexAppServer` for policy `read-only`, also passes it on `thread/resume`, and `startRun` re-applies read-only when a read-only session is continued by session id or by run id. `codex exec` gets `--sandbox read-only`, and resuming a read-only session through `codex exec` is refused with 409 because that transport takes no sandbox flag on resume.

Tests that exist:
- `packages/adapters/test/codex-appserver.test.ts` "never accepts an approval in a read-only run ... and does not even ask it". I removed the guard and the test failed; restored.
- `packages/companion/test/codex-run.test.ts` read-only `--sandbox` and the resume refusal.
- `packages/companion/test/agent-sessions.test.ts` read-only is kept when continued.
- Gap found: nothing tested that the companion hands `sandbox: 'read-only'` to the app-server. I added `packages/companion/test/codex-appserver-run.test.ts` "a read-only run is started with the read-only sandbox ...". With the wiring removed, it fails.

NOT TESTED: a real Codex. The adapter header says the protocol field names were written from documentation and are unconfirmed. If real Codex ignores the `sandbox` parameter on `thread/start`, the decline-every-approval guard is the remaining control, and it only covers actions Codex asks about.

### #2 Claude tool permissions

Code: `claudeToolArgs('read-only')` gives `--tools Read,Grep,Glob --allowedTools Read,Grep,Glob --disallowedTools Bash,PowerShell,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch --permission-mode default`. The standard policy is `--allowedTools Bash,Write,Edit,Read,Grep,Glob --permission-mode acceptEdits`, which pre-approves Bash and edits and relies on the installed hooks as the gate. That matches SECURITY.md (network use and writes outside the project are not seen in the standard profile).

Tests: `agent-sessions.test.ts` asserts the exact argv for read-only and standard, that continuing keeps read-only, and that unknown policies are refused. I changed `--tools` out of the argv and three tests failed; restored. Commit `32af770` records a live run with real Claude Code 2.1.318; I did not rerun it.

Residual risk, NOT TESTED: `--tools` limits built-in tools. I did not check whether MCP servers or skills configured in a project (`--setting-sources project,local`) are still available in a read-only run. Adding `--strict-mcp-config` to the read-only argv is worth testing against a real Claude before a release that advertises read-only as a boundary.

## Reachability of the phone link in the desktop build

Claim to prove: with no Firebase config, the phone link cannot be driven.

1. The only thing that starts the relay is `startRemoteIfLinked()` / `makeRemote()` in `packages/companion/src/index.ts`, and it runs only when `remote.json` holds a `link` (account uid, Firebase project config, computer credentials). Nothing in the companion reads a build variable; the gate is that no `link` exists.
2. A `link` is written only by `POST /api/remote/link`, which needs (a) a paired session, (b) the CSRF header, (c) a challenge code, and the Firebase config is supplied in the request body, not read from the build.
3. The dashboard hides the link UI when `accountsEnabled()` is false (`apps/dashboard/src/remote.tsx`). That is a UI gate only. `DefaultProjectCard` is rendered even when accounts are off, and its "Set up" button calls `POST /api/remote/prepare`, which writes `remote.json` containing the computer's private keys (no link, so no relay).
4. Can a local HTTP caller on the companion reach it? Not without pairing. `route()` answers only `/api/health` and `/api/pair` before the session check; every `/api/remote/*` path returns 401 for an unpaired caller. Pairing needs the terminal's one-use code, valid 5 minutes, spent after 5 wrong tries. A paired local session (the user's own dashboard cookie) can call all of `/api/remote/*`, as it can call `/api/runs`; that is full control already, not additional privilege.
5. With `--allow-public-site`, an outside origin's POSTs to `/api/remote/*` are not in `REMOTE_FREE`, so each needs a terminal code bound to that exact request.

Test: `packages/companion/test/preview-triage.test.ts` ("the phone link in a build with no cloud account"): all eight `/api/remote/*` routes return 401 GET and POST when unpaired and no `remote.json` is created; wrong-code pairing is spent; a paired session sees `{ exists: false }`, `link` without a challenge is refused and with one returns 409 and still creates no `remote.json`.

Conclusion, limited to what was tested: in the desktop build with no relay linked, phone items below are not reachable by an unpaired local caller. They are reachable by a paired local session if that session supplies its own Firebase config. They are N/A for the public pre-release only as long as nobody links a computer.

## Items

### #4 / aggregate spend and run limits (Low desktop, Medium phone-on)

- Phone (`remote-actions.ts`): `run.start` and `session.new` refuse when 3 runs are going (`MAX_RUNNING_FOR_PHONE_START`); per-device rate limit 12 control requests per minute; per-run cap `min(maxUsdPerRun, 5)`, default 1 USD, passed as `--max-budget-usd` to Claude. The `run.start` cap is the fix in `d80a2ea`; I confirmed the check at `remote-actions.ts` `case 'run.start'`.
- Not capped: total or daily spend, runs per hour. Codex has no spend flag ("not enforceable" is written into its `run.started` event). `plan.continue` and `plan.loop` do not check the 3-run count; they are bounded by one sequence per project, 3 phases or 5 rounds, and the plan's own `limits.maxUsd`.
- Local `POST /api/runs` and `/api/agent-sessions`: no concurrency cap and no total cap; Claude per-run cap max 5 USD. Reproduction by reading: a paired caller can post N runs and N agent processes start.
- Exploitability: needs a paired local session, or in the phone-on case a trusted control phone. Remaining risk: runaway cost or load by a bug or a stolen phone. Open: an aggregate daily cap; a global running-run cap for all sources.

### #10 / process-tree cancellation (Medium) and orphaned processes (Low)

- Reproduction (run, Windows): a program starts a detached child, then `child.kill()` on the parent. Parent dead, child alive (a one-off script, not committed; it printed "grandchild alive= true"). `terminate()` and the five direct `child.kill()` calls in `index.ts` did exactly this: they ended the agent process only, so anything the agent started (a build, a server, a shell) kept running after Stop, while the UI said "stopped".
- Fix: new `packages/adapters/src/proctree.ts` `killTree(pid)` (`taskkill /T /F` on Windows; descendants found with `ps` and sent SIGTERM elsewhere); used by `terminate()`, a `killChild()` helper in the companion for the other kill sites, and `CodexAppServer.kill()`. Test: `packages/companion/test/terminate-tree.test.ts` uses real processes; with the `killTree` call removed it fails by timeout. Windows only. The POSIX branch is NOT TESTED.
- Not verified against the real `claude` or `codex` binaries, which may place children in their own job or process group.
- Remaining: (1) `agentontrack dashboard` has no SIGINT/SIGTERM/SIGHUP handler that calls `close()`, so closing the terminal or killing the companion leaves running agents to finish by themselves (bounded by `--max-budget-usd` for Claude, unbounded for Codex). Ctrl+C in a console also reaches children in the same console group; detached grandchildren are not. Untested, so left as an open item and not fixed. (2) The Codex app-server stop reports `requested`, not confirmed: `terminate()` cannot see its exit.

### a. Local remote-control secret storage (Low)

`~/.agentontrack/remote.json` holds the computer's ECDSA and ECDH private keys as plain JWK, and the Firebase computer account's email and password in clear. Written with mode 0600 (`saveRemote`); on Windows the mode is ignored and the file relies on the profile directory ACL. No keychain, no encryption at rest. `idempotency` store is separate and holds results (project id, session id), no secrets. `e.env` is git-ignored and its values are held in memory only (`envfile.ts`).

- Exploitability: needs same-user code execution or backup/file-sync access. Impact: impersonate the computer to its phones and read the Firebase credentials; cannot issue commands as a trusted phone because those keys live on the phone.
- Desktop build: the file does not exist unless something called `prepare` (see reachability item 3).
- Open: OS keychain or DPAPI; at least an ACL check on Windows. SECURITY.md already lists same-user attacks as out of scope for several controls.

### b. Transcript retention (Low)

- `keepTranscripts` defaults to off. When on, up to 4000 characters of each prompt and 8000 of each run's output are appended to the project's hash-chained event log, which is append-only: turning the setting off does not delete earlier text; only "delete this project record" does. Exports (`/api/data/export`) include it.
- Finding: `run.finished` always stores `resultText` (first 2000 characters of the agent's final answer), whatever the setting says (`finishRun`, `index.ts`). Retention-off therefore does not mean no agent text is stored.
- Any paired session, including an outside origin, can read these events through `/api/events` and the event stream without the file-read grant, which guards only files and diffs. SECURITY.md says a compromised page "can read your record".
- Run output lines are kept in memory for the life of the companion, without a count limit, and a phone sees the last 12 lines per run regardless of the setting.
- Open: make `resultText` follow the setting; cap `run.events`; document that retention cannot be undone short of deleting the record.

### d. Malformed input and NUL bytes (Low)

- Local API: `RunInput` refuses NUL in prompts and hyphen-first prompts; model, ids and attachments are regex-bound; JSON-only bodies, 256 KB cap; workspace paths reject NUL, `..`, drive letters and symlink escape (`cleanRelative`, `resolveInRoot`).
- Test added (`preview-triage.test.ts`): NUL in a prompt, title, model, `file` path, `files` dir and project folder gives a non-5xx answer and the companion keeps serving; oversized and malformed JSON give 413 and 400. Existing: `agent-sessions.test.ts` "refuses a prompt with a NUL", `remote-session-new.test.ts` (D8), `workspace.test.ts`.
- Phone `run.start` has no NUL check in its schema; the later `RunInput.parse` refuses it before any process starts, and the refusal text was a raw validation dump (now clipped and path-stripped, see e).
- Remaining: child output is split into lines with unbounded buffers (`LineSplitter`, Claude `buf`) if an agent prints without a newline; that is output from the user's own agent, not attacker input. Hook input from agents with NUL in command strings: only the existing core tests cover it; I did not add more.

### e. Excessive error detail sent to phones (Low, fixed)

`RemoteHost.process` forwarded `err.message` of any executor exception to the phone. Messages from `projectFor` ("Project folder is missing: <absolute path>"), file-system errors, and validation dumps could carry absolute paths, although `projects.list` is designed never to give a path. Fix: `phoneSafeMessage()` in `remote-host.ts` replaces Windows, UNC and POSIX absolute paths and cuts messages to 300 characters; the error `code` is cut to 40. Test: `preview-triage.test.ts` "has file paths taken out and is cut short". Not covered: the content of agent output that a phone is deliberately shown, which can include paths; Codex's stderr tail (300 characters) enters run events when a Codex run fails.

### f. Cross-project and cross-device authorization (N/A desktop; Medium phone-on)

- Project scoping, by code reading: every phone action resolves `project` against the registry, then uses that project's store for sessions, approvals, worktrees and handoffs, so a session id, approval id or worktree id from another project is not found. `run.stop` additionally checks `run.project === projectId`. `session.status` is keyed by device id.
- Defect found and fixed: `approval.decide` let a control phone approve any held `fs.write`, including writes held because the target is a protected file (`.claude/**`, `.codex/**`, `.env`, keys; the agent's own hook settings) or is outside the project root. The code comment said these are undoable with git; they are not, and a write to hook settings can switch the gate off. Fix: `NEEDS_DESKTOP_REASON` in `remote-actions.ts` refuses with `needs-desktop`, and the snapshot reports `fromPhone: false`; declining stays allowed. Test: `remote-actions.test.ts` "cannot approve a write to a protected file or outside the project". With the fix removed the test fails (reproduction).
- By design, not changed: trust is per phone and per level (view or control) for the whole computer, not per project. Any trusted phone can read any project's Markdown and status; any control phone can stop any run and approve in-scope writes in any project; one phone can read another's session by id if it knows the project and session id (`session.get` is not device-scoped).
- Fingerprint confirmation, device cap (5), revoke, counters, replay cache, and rate limits are covered by `remote-host.test.ts` (run, passing).

### g. Duplicate new-session requests (Low)

`session.new` requires a 22 to 64 character key bound to a hash of the whole request; the store records `starting` before any process starts and is consulted per device. Same key and request returns the first result with `deduped: true`; same key with a different request is refused; a crash between start and record yields `in-doubt` and starts nothing. Per-device lanes serialize requests. Tests: `idempotency.test.ts`, `remote-session-new.test.ts`, `remote-session-status.test.ts` (all pass). Remaining: different keys with the same text start two sessions (intended); the local `/api/agent-sessions` has no idempotency, so a double submit starts two; the store keeps 500 entries for 24 hours.

### h. Unintended filesystem effects (Low)

- `POST /api/feedback` is in `REMOTE_FREE` and appended to `feedback.jsonl` with no size limit, so a paired outside page (only with `--allow-public-site`) could fill the disk. Fixed: refuses with 429 above 1 MiB. Test in `preview-triage.test.ts`; fails with the check removed.
- `POST /api/plan/draft` is also `REMOTE_FREE` and appends to the project's append-only log with no rate or size limit beyond the 256 KB body. Open.
- `POST /api/projects/clone` removes the destination folder if the clone fails; it only runs when the folder was absent or empty. `POST /api/projects` with `create` makes folders at any absolute path the OS allows except a drive root, the home folder and AgentOnTrack's own folder. Both need a paired session, and a terminal code from an outside origin.
- Agent-caused effects are the product's documented limits (SECURITY.md table: network use and out-of-project writes are not seen in the standard profile; Windows has no OS sandbox). Not re-triaged here.
- Hook installation writes `.claude/settings.json` or `.codex` config only on a confirmed request.

## Changes made in this triage (committed on the rc.6 branch; not yet run in CI)

Source: `packages/adapters/src/proctree.ts` (new), `packages/adapters/src/index.ts`, `packages/adapters/src/codex-appserver.ts`, `packages/companion/src/terminate.ts`, `packages/companion/src/index.ts`, `packages/companion/src/remote-actions.ts`, `packages/companion/src/remote-host.ts`.

Tests: `packages/companion/test/preview-triage.test.ts` (new), `packages/companion/test/terminate-tree.test.ts` (new), `packages/companion/test/remote-actions.test.ts`, `packages/companion/test/codex-appserver-run.test.ts`.

Run, all passing: `pnpm typecheck`, `oxlint --deny-warnings` on adapters and companion, and `pnpm exec vitest run packages/companion packages/adapters --no-file-parallelism` (45 files, 451 tests). Each new test was checked by temporarily removing its fix and seeing it fail. Not run: the rest of the suite, browsers, the Firebase emulator job, real Claude Code or Codex.

## Open items, in order

1. Test `--strict-mcp-config` (or equivalent) for Claude read-only against a real Claude; confirm Codex honours `sandbox` on `thread/start` and `thread/resume` against a real Codex.
2. Signal handling in `agentontrack dashboard` so exit stops running agents.
3. Aggregate and global run caps for all sources.
4. `resultText` should follow the transcript setting; cap in-memory `run.events`.
5. Windows ACL or OS keychain for `remote.json`.
6. Rate or size limit for `/api/plan/draft` from outside origins.
7. Decide whether phone trust should be scoped per project.
8. POSIX test of `killTree`.
9. D6 and D7 from the earlier QA review are recorded as open in commit `d80a2ea`; not re-examined.
