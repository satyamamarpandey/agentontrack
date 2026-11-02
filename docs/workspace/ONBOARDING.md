`# Onboarding, sign-in, projects and agents: status
`
`Release candidate 1.0.0-rc.4. Labels: PASS, FAIL, BLOCKED, PARTIAL, NOT TESTED, NOT BUILT. Everything is self-run.
`
`## P0
`
`| Requirement | Status | Notes |
`|---|---|---|
`| A welcome first screen: continue on this computer, Google, GitHub, email, labelled demo | PASS | Sign-in buttons are disabled, with the reason, until the owner switches accounts on |
`| Google, GitHub and email sign-in, reset, sign-out, export, delete, sessions that persist | PARTIAL | Written. Tested against the Firebase emulators in CI. **Not tested against a real Firebase project: BLOCKED on the owner** (`docs/accounts-setup.md`) |
`| Per-user Firestore rules | PARTIAL | Rules tested against the emulator. Not deployed |
`| App Check on feedback and sign-in | PARTIAL | Code present, off until a key is set. Enforcement is switched on by the owner in the Firebase console |
`| Signing in never grants access to the computer | PASS | Separate page and document. Tested: signed in, the dashboard still asks to connect |
`| The page finds the helper on this computer by itself | PASS | Chromium, Firefox, WebKit and Edge against a real companion. The browser's local-network permission is respected, never bypassed. Safari blocks it, so it is told to use the local dashboard |
`| Pairing only inside a guided "Connect this computer" step, still with the one-time terminal code | PASS | |
`| A screen for a disconnected computer: Download, Start, Retry, Open local dashboard | PASS | |
`| Automatic reconnection | PARTIAL | A reload in the same tab reconnects. A new tab, or a restarted helper, needs a new code, by design |
`| Registered projects appear as soon as the computer is connected | PASS | |
`| Find repositories in one folder the person names (depth 2, names only, never the whole disk) | PASS | Unit and browser tests |
`| New project, import a folder, copy a GitHub repository (URL, using the person's own git) | PARTIAL | URL parsing and refusals unit-tested. A real clone over the network was not tested |
`| List my GitHub repositories after authorizing GitHub | NOT BUILT | Would need a GitHub token. None is read or stored |
`| Recent, search, sort, archive; connection status | PASS | |
`| Cloud sync of project metadata, and showing other devices' projects | NOT BUILT | |
`| A searchable catalog of 18 platforms: install link, setup, connect, capabilities, interfaces, limits, last verified test | PASS | Statuses come from the recorded certification file, never upgraded. Antigravity is Not supported: no adapter exists |
`| Installing an agent is not treated as permission to control it | PASS | Connect is per project, and says so |
`
`## P1
`
`| Requirement | Status | Notes |
`|---|---|---|
`| A capability-driven runtime registry, with Run shown only where it works | PASS | `GET /api/runtimes`. Only Claude Code can be started |
`| Real web execution for every supported agent | **NOT BUILT** for Codex, Hermes and the others | No verified programmatic start has been built or run for them, so no Run control is shown. They run in their own terminal and report to the same record |
`| Claude implements and Codex reviews, and the reverse, as real runs | BLOCKED | Roles can be assigned, handoffs and worktrees are tested with real git. Codex cannot be started from the product |
`| Simplified navigation and workspace | PASS | Six sections, advanced detail one tab in |
`| Results and evidence center, with exportable receipts | PASS | Outside evaluation and adoption: none recorded, and it says so |
`
`## P2
`
`| Requirement | Status |
`|---|---|
`| Optional, separately consented aggregate counts, with a preview | PASS (preview, consent, rules in the emulator). Sending to a real project: BLOCKED on the owner |
`| A reproducibility package for an independent evaluator | PARTIAL: the receipts export and `docs/evaluation/INDEPENDENT.md`. No evaluator has used them |
`
`## Security
`
`| Item | Status |
`|---|---|
`| Source reads from the public site need a short terminal-confirmed grant | PASS |
`| Content-Security-Policy on the dashboard page | PASS (browsers tested). Not on the marketing pages |
`| A dedicated hostname for AgentOnTrack | **Owner action** (DNS and Pages custom domain). `--allow-origin` is ready. See `docs/security/origin-isolation.md` |
`| Real Google, GitHub and email sign-in on the live site | NOT TESTED |
