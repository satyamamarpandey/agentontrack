# Changelog

## Unreleased: website redesign and invitation-only early access

Website and accounts only; the desktop program is unchanged from rc.7.

- **One design system for the site and the dashboard.** Shared tokens (byte-identical blocks, kept so by a unit test), bundled fonts under the SIL Open Font License (Inter for the interface and headlines, JetBrains Mono for code; served from the site's own files, so no third-party requests), a translucent header that marks the current page, refined buttons, cards, tables, forms, dialogs, toasts and skeletons, and motion that carries state: dialog and drawer entrances, a live-status pulse, counters that count up when they scroll into view, scroll-linked reveals in CSS alone. Every transition and animation sits under `prefers-reduced-motion: no-preference`; forced-colors mode keeps real borders. The phone layout now follows the light and dark themes like the rest. The final look (2026-11-11) is the owner's own, made in Claude Design from a staged copy of these sources and merged back: a steel-blue accent in place of the teal, square panels and hairlines instead of shadows, a rail with numbered stations down the landing page and in the dashboard's timeline and phase plan, registration marks on frames, 16:10 frames that show the 1440×900 captures whole, a header whose links drop to a second row before they fold into the menu, jump-key hints in the dashboard rail, and one-shot entrances for the headline, the terminal lines and chart bars; fades animate a mask rather than opacity so text keeps its contrast while it arrives, and everything still sits under the reduced-motion query.
- **Early access, invitation-only, enforced by the Firestore rules.** A three-step application form (popup about five seconds after arriving on the home page, once per session, never for someone signed in or who already applied; also behind the permanent Early access button and `/early-access/`). One application per address, keyed by the hash of the email; nobody but the administrator can read the pile. The administrator's review page (`/admin/`) shows tiles, a filterable table (status, operating system, agent tool, search), the full application, private notes, approve/reject, single-use expiring invitation links stored only as hashes, revoke and reinstate, tester feedback, insights, CSV/JSON export, and an audit log that no browser can edit. Using an invitation (`/join/`) creates the membership in one transaction with the redemption; expired, revoked, used or misaddressed links fail every rule. Every account feature (profile, preferences, summaries, the phone link, tester feedback) now requires an active member; revoking stops them on the next request. A new sign-in page with Google and email (GitHub behind `NEXT_PUBLIC_AUTH_PROVIDERS`), a password visibility toggle, plain error sentences and reset; no public sign-up anywhere.
- **Installs gated during early access.** With accounts on and `NEXT_PUBLIC_INSTALL_PUBLIC` unset, the install steps and the public-site dashboard's connection step are shown to active testers; visitors see how to apply and a plain note that the source and releases are public on GitHub regardless. The local dashboard address never depends on any of this.
- **Tester feedback.** Approved testers get a structured form: kind of report, rating, message, version, operating system, connector, and diagnostics only when pasted in and agreed to.
- **Dashboard:** the inert Diagnostics checkbox is gone (it recorded a preference nothing read); the Fork button is replaced by the sentence that explained why it was disabled; the Comparisons page no longer claims Codex and Hermes are not installed; the Settings intro says what the cloud features would send instead of "sends nothing anywhere"; the demo's Workspace no longer crashes on its Plan tab (the demo now answers `/api/plan` and `/api/discovery`).
- **Companion: no more stalls from agent probes.** `/api/agents` probed `claude`, `codex` and `hermes` (and Claude Code's login state) with synchronous processes on every request, and `/api/runtimes` did the same whenever its one-minute cache expired, blocking the companion for 4–9 seconds at a time on a loaded machine; the dashboard waited that long on a click. Both now share one cache; the first answer is still probed on the spot, and an expired answer is served as it is while an asynchronous process refreshes it. Found by the accessibility sweep, whose fifteen-screen walk also gets a timeout that matches it.
- **Measured, then made lighter.** The site declares Inter through Next's font loader (preloaded, with the fallback's metrics matched automatically), so the home page's headline no longer moves when the font arrives: its layout shift went from 0.101 to 0 at a 4x CPU slow-down. The application form is its own chunk, fetched when an Early access button is hovered or focused, a second and a half before the popup is due, or at the latest when the dialog is asked for; the dialog waits up to 400 ms for it so its entrance does not share frames with the chunk, and says so plainly if the chunk cannot be fetched. Home-page main-thread blocking roughly halved in the same measurement. `node scripts/measure-web.mjs --runs 3` now reports the median of three runs and keeps each run in the file; transfer sizes come from the browser's own request sizes.
- **Dashboard charts enter cheaply.** The redesign grew every chart bar with a per-rect SVG transform animation, which Chromium runs on the main thread and repaints each frame: the demo overview blocked for 452 ms at a 4x CPU slow-down on desktop (budget 300 ms; the phone layout, which has no such charts, stayed at 145 ms). Each plot now rises from its baseline once as a single composited clip-path reveal.
- **Two findings from an independent security review, fixed before publication.** A membership record can now be created only in the same transaction that redeems the invitation (the rules compare the redemption's time with the request's), so an invitation used long ago can no longer re-create a membership an administrator deleted. The administrator's CSV export neutralises cells that a spreadsheet would run as a formula. Also: the install page no longer shifts when it hydrates (the visitor's gate is what the server renders; a signed-in tester's check happens inside the same box).
- **Release tooling:** `scripts/release/live-check-early-access.mjs` applies on the live site from a real browser with a test address and expects the confirmation and then the duplicate refusal; `scripts/release/firestore-admin.mjs` reads, writes, lists and deletes documents with the project owner's CLI login (bootstrap and clean-up only: it bypasses the rules, and says so).
- **Privacy, terms, pricing and security pages** describe the applications, invitations, membership records, tester feedback and the audit log, what is kept and how to withdraw. The phone link remains tested against emulators only; the account features now run on a real Firebase project where the owner provisions one (`scripts/release/firebase-provision.mjs`; `docs/accounts-setup.md`).
- **Tests:** unit tests for the application model and the design-system contract; a browser spec for the popup, the form and its accessibility on Chromium, Firefox, WebKit and a phone profile; an emulator spec that walks the whole flow (apply, review, invite, join with email confirmation, gated pages, dashboard pairing and a saved summary, revoke, reinstate, export, withdraw) and makes the black-box requests an outsider, a holder of someone else's link, or an expired link would make, straight at the database. The existing emulator specs grant membership outright where the invitation is not the subject.

## 1.0.0-rc.7 (pre-release candidate; desktop only)

- **Cross-review is gated.** `POST /api/workflows/cross-review` runs a builder and then a reviewer with nobody acting in between, so it now follows the same server-side policy as the other chained paths: it needs an unattended-runs grant for the project (it spends one grant run for each of its two runs) and an agent signed in with your own API key while paid API mode is on. Otherwise it is refused with 409 and a message naming the compliant paths. New `POST /api/workflows/review {runId, reviewer, model}` is the manual two-step path: you start the build, then start one reviewer run from a validated handoff of that finished run. It starts exactly one run, supports Idempotency-Key, needs no grant and works with a subscription sign-in. The dashboard session view has a Review this run button. There is no cross-review control in the dashboard or on the phone, so nothing there changed.
- **Per-run limits without invented dollar figures.** Every start route takes `maxMinutes` (1 to 240, default 30); the companion ends the run's process tree when it is reached and records `Stopped: the time limit of N minutes was reached`. The dollar cap (`--max-budget-usd`) is passed and recorded only for an agent signed in with an API key while paid API mode is on; for a subscription or unidentified sign-in no dollar cap is passed, no dollar cost is recorded, and the dashboard shows Time limit (minutes) instead of a dollar field. Clients that still send `maxBudgetUsd` are not broken. Claude Code 2.1.318 has no `--max-turns` option, so there is no turn limit.
- **Usage limits are reported plainly.** When a provider run ends with a usage, rate or quota limit message, the run shows `<Agent> says its usage limit was reached. Your session and context are kept: resume it later, or start the same task with another connected agent.`, is recorded as stopped (not failed) with `limitReached`, and its session stays resumable. The dashboard session view shows the message. NOT TESTED against a real provider limit; tested with scripted agents.

## 1.0.0-rc.6 (pre-release candidate; desktop only)

- **Scope:** desktop companion and dashboard. Cloud-backed phone control is **off** in this build (no Firebase configuration; the phone address says so). It stays in the source for later certification. Provider-terms questions are open (docs/provider-terms.md); nothing here claims compliance.
- **Security triage fixes:** Stop ends the agent's whole process tree on Windows (POSIX descendants get SIGTERM then SIGKILL after 2 s; POSIX is untested locally and runs only in the Linux and macOS CI jobs); a phone can no longer approve a write to a protected file or outside the project; error text sent to a phone has file paths removed (a path is removed to the end of its line, so text after it goes too) and is cut to 300 characters; the phone is off in this build; `/api/feedback` refuses above 1 MiB; a regression test for the Codex read-only sandbox wiring. Open Lows are listed in docs/security/PREVIEW_TRIAGE.md (no aggregate spend or run cap, no signal handler to stop agents on exit, `remote.json` keys unencrypted, transcript settings).
- **Server-enforced autonomy policy:** multi-phase continue, retry loops and the dashboard's run-the-plan (now a server route, `POST /api/plan/continue`) need an autonomy grant (project, run budget, expiry, cancel; terminal-code proof) and are refused for subscription sign-ins even with a grant; phone-started runs need `allowMobileExecution`. Retries of a start use an `Idempotency-Key` (the earlier 5-second duplicate guard is gone). Also: transcript retention governs agent answer text; 4-agent cap; 2000-line output cap with a marker; agents stopped on dashboard exit; plain errors for a missing or signed-out agent (Claude and Codex); Claude read-only adds `--strict-mcp-config`.
- **Attachments:** Claude Code read an image and a PDF given by path in one live trial each. The Codex attach hint says Codex has no PDF input. Voice dictation is not verified with a real microphone.
- **Phone New session and sessions pane:** claude/Codex feature parity is not complete (fork, effort, steering, queueing, native audio, subagents are missing).
- Earlier unreleased items:


- **Fix:** stopping a run that is not running (finished, or already stopped) from the dashboard is now refused with "That run is not running.", as the phone already did, instead of marking it stopped again and answering 200.
- **Stop tells the truth:** a stop answers "stopped" only once the agent process has exited, hard-kills one that ignores the first signal, and reports a signal that cannot be delivered or a process that will not go as a failure instead of as stopped (HTTP 500; the phone gets a `stop-failed` refusal with the reason).
- **Dashboard:** a stale Stop click, or a run that ends while the plan's cancel loop is stopping runs, no longer fails silently or aborts the loop; a failed stop is shown.
- **Tests:** deterministic cancellation tests with a real process and a gate file (no timers); the phone-cancel end-to-end test no longer acts on a stale row from the test before it. See docs/release/FLAKE-phone-cancel.md.

## 1.0.0-rc.5 (candidate, built and certified on the private branch, not published)

- **Fix, Codex:** the model name `default` is now sent as no model. A ChatGPT sign-in rejects the literal name, so every such run failed within seconds; found by the first real Codex run.
- **Codex sign-in detection:** the run list asks `codex login status` and shows subscription or API-key; a metered Codex sign-in is refused unless paid API mode is on.
- **Plan editor:** a refresh from the server no longer overwrites unsaved edits (fixed a Windows CI timeout).
- Real-agent evidence: `live-codex-appserver.json`, `live-codex-resume.json`, `live-handoff.json` (one trial each).
- **Codex through its app-server** (default transport). Each action Codex asks to take waits for AgentOnTrack's answer, from the same decision engine and approval records the hooks use. Accepts are one-time only; anything unclear, forgotten or timed out is declined. **NOT TESTED against a real Codex** (none installed on the build machine): fixture-tested only. `docs/codex-setup.md` has the steps, and `node scripts/live-codex.mjs` is the check that will settle it.
- **Runs inside isolated worktrees** (`worktreeId` on a run). The project's hooks are copied into the worktree and must refuse a test request from there before the agent starts. The hook command names the main project, so the worktree's actions are judged and recorded there. The copied hook file is left out of diffs and commits. One real Claude run was checked end to end (`benchmarks/results/live-worktree.json`, 1 trial).
- **Fix, Windows:** Claude Code's Bash tool uses Git Bash, where `/tmp/x` and `/d/x` are the Windows temp folder and drive D. They were read as `C:/tmp/x`, so a write inside the project was held for approval. Found with a real agent (a managed-loop run was blocked). Fixed for the Bash tool only.
- A real managed goal, plan and phase run with Claude Code verified a phase by running its check itself (the maintainers' record "live-loop.json" (not published), 1 trial).
- A test that lists every skipped test with its reason, so a new skip is a reviewed decision. Adversarial tests for the Codex approval boundary.
- Not claimed: any token or time saving; anything about platforms other than the one Windows machine used for real-agent runs.
- **Codex through `codex exec`, with attachments (text and PNG), resume and a write, ran against a real Codex** (the maintainers' record "live-codex-exec.json" (not published)). The first attempt failed for a reason the product did not explain: Codex refuses a folder that is not a git repository. A failed Codex run now shows what Codex printed.
- **Fix, release:** the VS Code extension manifest still said rc.3. It follows the program version now, and a test enforces it.
- **Codex commands that fail are visible:** a failed or declined Codex command is shown in the run with its exit code and output tail, and the cross-review workflow warns when the builder changed nothing. Found by 3 failed real handoffs in 18, where Codex gave up after one failed command and the run still said finished.
- **Command-failure recovery (Codex):** if a Codex turn ends right after a failed command with nothing succeeding after it, AgentOnTrack sends one fixed follow-up (no command output in it) in the same thread asking Codex to try another way, and shows `[recovery]` or `[unresolved]` in the run. Off with `codexRecoveryTurns: 0`.
- **An unchanged project is not a success:** a cross-review whose builder finished but changed nothing now ends as `builder-changed-nothing`; no handoff, review or checks run.
- **Experimental labels:** phone access and sign-in carry an "experimental" label and a plain note (emulator-tested only). The Codex catalog text and the website no longer say Codex starts only in its own terminal or was never run.
- **Binary-only distribution:** `scripts/release/binary-distribution.mjs` checks a release folder (checksums, five platforms, licences, no source, no credentials, no personal paths) and assembles a binary-only folder; the maintainers' record "DISTRIBUTION.md" (not published) is the proposal. Nothing is published.
- **Docs:** the compatibility table and the agent catalog no longer say Codex was never run with a real sign-in.
- Repeated real-agent runs (3 trials each, one Windows machine) and what they showed: the maintainers' record "CERTIFICATION.md" (not published). A build-repeatability check (`scripts/release/compare-builds.mjs`).

## 1.0.0-rc.4

- A new first screen: choose to continue on this computer, sign in (Google, GitHub or email, once the site's owner switches accounts on), or look at a labelled demo. Signing in never gives the website access to your computer.
- Connecting a computer is a guided step. The page looks for AgentOnTrack on your computer by itself, shows how to get and start it if it is not there, and asks for the one-time code from your terminal. If the computer stops answering, a clear screen offers Retry, Connect again, Download and the local dashboard.
- Projects registered on your computer appear as soon as it is connected, with search, sort, archive, and a way to find Git repositories inside one folder you name, import a folder, or copy a GitHub repository.
- A searchable catalog of 18 agents, editors, model servers and research tools, each with its maker's install page, how it connects, what has really been tested, and what it can and cannot do. Only agents that can really be started from AgentOnTrack show a Run control, decided by the helper.
- Six places to go: Projects, Workspace, Agents, Activity, Analytics, Settings. A Results and evidence center, with an exportable receipts file.
- Reading source files from the public site now needs a short permission you give in your terminal. The dashboard page has a Content-Security-Policy. `agentontrack dashboard --allow-origin` takes a dedicated hostname.
- Optional anonymous usage counts, off by default, with a preview of exactly what would be sent.
- Not changed or not claimed: sign-in is written and tested against emulators only, and is off until the owner creates a Firebase project. Only Claude Code starts from the product. AgentOnTrack still used more tokens and time than the agent alone in its own benchmarks.

- **Phone remote control** for projects that already exist on a computer you have linked: sign in with the same account, compare fingerprints, approve the phone at the computer, then see progress, phases, activity, evidence and suggestions, send a prompt, stop, pause, continue or loop a phase, handle handoffs, and decline or (for small file writes only) approve. Everything is signed and encrypted end to end, rate-limited, and the computer checks every request against the current goal, plan and approvals. It has no terminal, no code editing and no project creation. Installable as a PWA. Details and limits: docs/workspace/PHONE.md.
- **Plans**: a goal becomes editable phases with dependencies and acceptance checks; limits are enforced by the computer; a managed loop repeats a phase until its checks pass (at most five rounds) and can be cancelled.
- **Agent and model discovery** from what the computer really reports (a runtime's own session init, its config, models used in recorded runs, local model servers). A listed model is never called available to you; only a run that used it says "worked here".
- **Commands**: a prompt starting with a slash is sent only if that agent reported the command. Otherwise it is refused with the reason.
- **Next-prompt suggestions** (at most three, from the record, each with the fact it came from, an editable prompt and a recommended agent), in the website, on the phone and with `agentontrack next`. `agentontrack models` lists models.
- Fixes: a configured agent command counts as installed; password reset says the same thing whether or not an account exists.
- Not claimed: sign-in and the phone link are verified only against the Firebase emulators until the owner creates a project; Android and iPhone results are device profiles, not physical phones.

## 1.0.0-rc.3

- A redesigned dashboard and site: one set of design tokens, a command palette, grouped navigation, light and dark themes, and an accessible dialog that traps focus.
- A **Workspace** screen: project files with a hash-checked editor that refuses to overwrite a changed file, Markdown preview, a prompt composer with live output (Claude Code), team roles, approvals, handoffs, isolated git worktrees with diffs and merge, verification and receipts. Resizable panels, saved layout, focused mobile views.
- VS Code extension (`agentontrack-vscode.vsix`): a sidebar over the same companion. It confirms nothing by itself, and only reads in an untrusted workspace.
- CLI commands for projects, agents, team, handoff and usage, with JSON output.
- Team roles and workflows, including `spec-review` (draft, structure check, fresh-session reviewers, go or no-go, a person approves) and a deterministic spec structure check.
- Handoff v2 with revalidation: approvals are never carried over, and a stale handoff needs a person's acknowledgement.
- Not changed, and not claimed: AgentOnTrack still used more tokens and time than the agent alone in its own benchmarks. Only Claude Code starts from the product. Cursor, Antigravity, Devin and Kiro are not tested on the real programs.

- The dashboard opens on a grid of projects. A project page shows its overview, workflow timeline, usage, verification and environment, using only companion endpoints from 1.0.0-rc.2.
- A saving appears only against a baseline the user enters, kept in the browser. A negative one is shown as a cost. Without a baseline, it says Unavailable.
- The website has a new layout, and optional accounts, off unless a Firebase config is set at build time.

## 1.0.0-rc.2

- One provider layer over the same engine: Copilot CLI, Gemini CLI, OpenCode and Cline verified on the real programs with a scripted model; Cursor, Devin and Kiro written from docs and never run on the real programs.
- `agentontrack providers`, `mcp-config`, `research`, and `run` and `install` for each platform.
- A pre-action hook that cannot read a request now refuses it.
- Host config folders are protected paths, so an agent cannot edit its own hooks.

## 1.0.0-rc.1, not yet published

First installable version.

### Added

- Installers for Linux, macOS and Windows, with a bundled Node runtime and checksum checks. No administrator rights needed.
- `agentontrack setup`, `self upgrade`, `self rollback`, `self uninstall [--purge]`.
- `agentontrack run codex`: refuses to start unless the hook answers, and uses the Codex OS sandbox with the network off and `/tmp` closed.
- `agentontrack anchor config|push|verify`: appends the log head to a git remote, which catches a same-user rewrite of log and witness if that remote refuses force-pushes.
- `agentontrack task accept-weak`.
- Agents and hook failure behaviour on the dashboard.

### Changed

- **A weak check now withholds VERIFIED** until a person accepts it. Before, it only warned.
- `agentontrack verify` finds files changed while no hook fired.
- The public site can change nothing without a code shown in your terminal for that exact request. Its sessions are tied to its origin and last two hours.
- Read tools no longer start a hook process. A premature completion claim now reports to you instead of costing a model turn (`stopCheck: block` restores the old way).
- Strict mode recognises more read-only commands and harmless variables on allow-listed commands.

### Removed

- Hosted accounts and cloud sync. They were never deployed. The website is static.

### Measured

Benchmark v4, 162 runs. It shows no token savings, more time than the bare agent, and that goal text alone matches task success. See `benchmarks/README.md`.

### Known limits

See `SECURITY.md` and `docs/compatibility.md`.
