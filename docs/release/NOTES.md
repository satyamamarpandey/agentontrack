AgentOnTrack 1.0.0-rc.8, a release candidate and **desktop preview**: a free, local-first control layer for AI coding agents. No AgentOnTrack account is required for local use. AgentOnTrack does not upload local project records by default. When you use Claude Code or Codex, information is processed by the selected AI provider. All testing so far is by the project itself, and nobody independent has evaluated it.

**Read this first**

- **This is a security release. If you run rc.7 or earlier, upgrade.** A self-run audit on 2026-11-19 found ways an agent could do an approval-required action without approval, and ways another local program could act as the dashboard. They are fixed here; the list is below and the full record is `docs/security/AUDIT-2026-11-19.md`.
- This is a **pre-release**. It is not the stable release, and the plain one-line installer does not install it (that still installs 1.0.0-rc.3). Earlier pre-releases stay as they are.
- **After upgrading, each browser pairs with the dashboard once more.** Your projects stay connected.
- **Built from this repository.** These programs were built by GitHub Actions in this repository from the commit the `v1.0.0-rc.8` tag points to, and the source at that tag is what they were built from. GitHub recorded a build attestation for each file; check one with `gh attestation verify <file> -R satyamamarpandey/agentontrack`. There is no code signing, so Windows and macOS may warn that the programs are unsigned. `SHA256SUMS` only catches a damaged download.
- **Phone control is switched off.** The phone page says so and connects to nothing. Do not use this release to control a computer from a phone.
- **Provider terms are not fully settled.** Anthropic's published page says it does not stop an end user signing in to the unmodified Claude Code binary with their own subscription, and OpenAI's says a local or open-source application may continue to use Codex app-server authentication (not for commercial or hosted services). Neither provider has confirmed that every way a tool like this can start their programs is allowed; the open questions are in `docs/provider-terms.md`. So: **a single run you start yourself, a build followed by a review you start yourself, and the four stages Plan, Build, Review, Verify each started by you, are on. Anything that starts several runs after one click is refused by the program for any agent signed in with a subscription.** It is allowed only for an agent using your own API key in paid API mode, with a time-limited grant you create with the terminal confirmation code. There is no hosted use. AgentOnTrack never reads, stores or sends your sign-in. Claude Code and Codex are names of their owners' products, used only to say what AgentOnTrack works with; there is no endorsement.
- Everything below was tested by the project itself. Nobody independent has evaluated it.

**Install this exact version (rc.8)**

- Linux, macOS: `curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh -s -- --version 1.0.0-rc.8`
- Windows (PowerShell): `$env:AOT_VERSION = '1.0.0-rc.8'; irm https://pandeysatyam.com/agentontrack/install.ps1 | iex`

The version must be given. The installer checks the download against `SHA256SUMS` and installs nothing on a mismatch. To go back: `agentontrack self rollback`; to remove: `agentontrack self uninstall`. Then, in a project: `agentontrack setup`, and `agentontrack doctor` to see what is enforced on your machine.

**Fixed in rc.8 (since rc.7)**

- **The gate reads commands it used to miss.** `git.exe push`, `npm.cmd publish` and `curl.exe -T` (a Windows suffix or a folder on the program name) are a push, a publish and an upload. `git send-pack`, `git subtree push`, `git lfs push`, `hub push` and `gh repo sync` are pushes. A git alias, a rewritten remote and a git verb that is not git's own are held for approval. `cmd /c`, `Start-Process`, encoded PowerShell, `timeout`, `sudo -u` and `xargs` no longer hide the command inside them. More tools are recognised (`gh gist`, `gh workflow run`, `yarn npm publish`, `rsync` to a host, `rclone`, `gsutil`, `ftp`).
- **The gate asks more often** for git commands that use a personal alias (`git co`) or change a remote. That is the cost of not guessing.
- **The gate cannot be made slow.** A command built to take a long time to read is decided in milliseconds or held without being parsed. Some agents run the action when the gate does not answer in time.
- **`agentontrack run` on Windows** passes a prompt containing quotes, `&` or `|` as text. Before, cmd.exe could read part of it as a command.
- **The session cookie alone no longer does anything.** A browser sends it to every port on this computer, so the dashboard now also sends a second value kept in storage that browsers isolate by port, on every request.
- **A protected file cannot be saved under another spelling of its name**; disconnecting an agent needs a confirmation code; a hook file AgentOnTrack did not write is never run and never shows as connected; a folder of keys or sign-ins cannot be registered as a project.
- **Phone link (still off):** unlinking really revokes every phone; revoking works without the link service; the phone checks the computer's key itself and binds each answer to its request.
- **Model roles:** Plan, Build, Review and Verify as four stages, each started by you with the agent and model you pick, with the model the agent reported recorded beside your choice. A Fable model, which may charge usage credits on top of a subscription, is refused unless you accept that for the run.

**What was tested, and how**

- CI on the tagged commit of this repository: unit tests on Linux, Windows and macOS; browser tests in Chromium, Firefox and WebKit and phone-sized profiles; Firebase-emulator tests; a VS Code extension host run; dependency audit, licence check and secret scan; then a clean install, version check and uninstall on five runners (Linux x64 and arm64, macOS x64 and arm64, Windows x64). The agents in those tests are stand-ins.
- A sweep of every page and dashboard screen at six widths from 320 to 1920 in both themes; every enabled button clicked; every internal link resolved (run once, in Chromium).
- Real Claude Code on one Windows machine, subscription login: the four stages on Haiku, Sonnet, Opus and Haiku, each reporting the model chosen; a Fable model refused without consent. Fable was never run.
- Each audit finding has a test that fails without its fix. The audit is the project's own.

**Not tested, not claimed**

- **Codex was not run for this release**: its model list and the new stages are tested with a stand-in only. Real-agent runs are on one Windows machine only. Linux and macOS have none.
- A physical phone; voice dictation with a real microphone; real provider usage-limit messages; Outlook delivery of the sign-in emails.
- **Not equal to Claude Code or Codex.** Missing: forking a session, reasoning-effort choice, steering or queueing messages mid-run, native audio, compaction control, the providers' own review commands, subagent management, and a turn limit. History lists only sessions AgentOnTrack started.
- Open limits: a program running as you can read or change AgentOnTrack's own files; in the standard profile a script's own network activity is not seen; Codex runs an action if its hook program is missing; no total spend cap across runs; the autonomy grant is a field in your own settings file; `remote.json` keys are unencrypted if a phone was ever linked.
- AgentOnTrack still adds time over the bare agent (about 3 s on a 5-second task, measured once). No time or token saving is claimed.
