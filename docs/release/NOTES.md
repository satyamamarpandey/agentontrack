AgentOnTrack 1.0.0-rc.7, a release candidate and **desktop preview**: a free, local-first control layer for AI coding agents. No AgentOnTrack account is required for local use. AgentOnTrack does not upload local project records by default. When you use Claude Code or Codex, information is processed by the selected AI provider. All testing so far is by the project itself, and nobody independent has evaluated it.

**Read this first**

- This is a **pre-release**. It is not the stable release, and the plain one-line installer does not install it (that still installs 1.0.0-rc.3). Earlier pre-releases (rc.5, rc.6) stay as they are.
- **Built from this repository.** These programs were built by GitHub Actions in this repository from the commit the `v1.0.0-rc.7` tag points to, and the source at that tag is what they were built from. GitHub recorded a build attestation for each file; check one with `gh attestation verify <file> -R satyamamarpandey/agentontrack`. There is no code signing, so Windows and macOS may warn that the programs are unsigned. `SHA256SUMS` only catches a damaged download.
- **Phone control is switched off.** The phone page says so and connects to nothing. Do not use this release to control a computer from a phone.
- **Provider terms are not fully settled.** Anthropic's published page says it does not stop an end user signing in to the unmodified Claude Code binary with their own subscription, and OpenAI's says a local or open-source application may continue to use Codex app-server authentication (not for commercial or hosted services). Neither provider has confirmed that every way a tool like this can start their programs is allowed; the open questions are in `docs/provider-terms.md`. So: **a single run you start yourself, and a build followed by a review you start yourself, are on. Anything that starts several runs after one click (continue over phases, repeat until the checks pass, the one-click build-then-review, unattended runs) is refused by the program for any agent signed in with a subscription.** It is allowed only for an agent using your own API key in paid API mode, with a time-limited grant you create with the terminal confirmation code. Phone-started runs need a separate setting. There is no hosted use. AgentOnTrack never reads, stores or sends your sign-in. Claude Code and Codex are names of their owners' products, used only to say what AgentOnTrack works with; there is no endorsement.
- Everything below was tested by the project itself. Nobody independent has evaluated it.

**Install this exact version (rc.7)**

- Linux, macOS: `curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh -s -- --version 1.0.0-rc.7`
- Windows (PowerShell): `$env:AOT_VERSION = '1.0.0-rc.7'; irm https://pandeysatyam.com/agentontrack/install.ps1 | iex`

The version must be given. The installer checks the download against `SHA256SUMS` and installs nothing on a mismatch. To go back: `agentontrack self rollback`; to remove: `agentontrack self uninstall`. Then, in a project: `agentontrack setup`, and `agentontrack doctor` to see what is enforced on your machine.

**New in rc.7 (since rc.6)**

- **One-click build-then-review is off for subscription logins.** The new "Review this run" button starts exactly one reviewer run from a finished run's handoff, with no grant needed; you press it yourself. The one-click chain needs the grant and your own API key in paid API mode, and is refused otherwise with a message that says so.
- **Task limits that do not depend on dollars.** Every run has a time limit in minutes (default 30, up to 240) enforced by the program, on every way of starting one. A dollar cap is shown and applied only for an API key in paid API mode; AgentOnTrack no longer shows or counts dollar figures for subscription use. (Claude Code 2.1.318 has no turn-limit option, so none is offered.)
- **Usage limits are handled as such.** When a provider says its usage limit was reached, the run is marked stopped, not failed, your session and context are kept, and the note says to resume later or start the same task with another connected agent.

From rc.6, carried forward: runs that chain are refused without the grant; Idempotency-Key retries; at most 4 agents at once; stopping a run ends the programs it started; the new connect-page probe fix; plain messages for a missing or signed-out agent. See `CHANGELOG.md`.

**What was tested, and how**

- CI on the tagged commit of this repository: unit tests on Linux, Windows and macOS; browser tests in Chromium, Firefox and WebKit and phone-sized profiles; Firebase-emulator tests; a VS Code extension host run; dependency audit, licence check and secret scan; then a clean install, version check, upgrade, rollback and uninstall on five runners (Linux x64 and arm64, macOS x64 and arm64, Windows x64). The agents in those tests are stand-ins.
- Real Claude Code 2.1.318 and Codex 0.167 on one Windows machine, one trial per check, disposable projects, subscription logins, on the rc.6 code that rc.7 builds on: new session, resume, provider choice, image attachments (both), PDF (Claude Code only), read-only, stop with the child programs gone, an isolated worktree run, a build-then-review, plain messages for a missing agent. rc.7's own changes (the gate, the manual review, the limits, usage-limit handling) were tested with stand-in agents only.

**Not tested, not claimed**

- Real-agent runs are on one Windows machine only. Linux and macOS have none. The reverse build-then-review order (Codex builds, Claude Code reviews) was not run live. Codex read-only is stricter than needed (it also declines to read files).
- Real provider usage-limit messages; voice dictation with a real microphone; a physical phone; a real Firebase project.
- **Not equal to Claude Code or Codex.** Missing: forking a session, reasoning-effort choice, steering or queueing messages mid-run, native audio, compaction control, the providers' own review commands, subagent management, and a turn limit. History lists only sessions AgentOnTrack started.
- Open limits: no total spend cap across runs; a person or script with a paired session sending separate single-start requests looks like someone clicking Start each time; the autonomy grant is a field in your own settings file; `remote.json` keys are unencrypted if a phone was ever linked.
- AgentOnTrack still adds time over the bare agent (about 3 s on a 5-second task, measured once). No time or token saving is claimed.
