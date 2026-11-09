# AgentOnTrack 1.0.0-rc.7 (release candidate, desktop preview, binaries only)

AgentOnTrack is a free, local-first control layer for AI coding agents: goals, approvals, checks and a record, using each agent's own hooks and your own sign-in. No API key is needed. No AgentOnTrack account is required for local use. AgentOnTrack does not upload local project records by default. When you use Claude Code or Codex, information is processed by the selected AI provider. Optional cloud features are separately disclosed and remain experimental.

**This folder is a binary distribution.** The programs were built by GitHub Actions in the public repository from the commit the release tag points to, so the source at that tag is what they were built from. Whether anyone can rebuild bit-identical files has not been tested. What you can check: the files match the published checksums, the licence and third-party notices are inside each archive, and each archive was scanned for credentials, source files and personal paths before it was assembled (`verification.json`).

**This is a release candidate, not a stable release.** All testing so far was done by the project itself; nobody independent has evaluated it. See `RELEASE_NOTES.md` for what was and was not tested.

## Install

Install this exact version (the plain one-line commands install the latest non-pre-release, an older candidate):

| System | Command |
|---|---|
| Linux, macOS | `curl -fsSL https://pandeysatyam.com/agentontrack/install.sh \| sh -s -- --version 1.0.0-rc.7` |
| Windows (PowerShell) | `$env:AOT_VERSION = '1.0.0-rc.7'; irm https://pandeysatyam.com/agentontrack/install.ps1 \| iex` |

Neither needs administrator rights. Supported: Linux x64 and arm64 (glibc, not Alpine), macOS x64 and arm64, Windows x64. The installer downloads the archive for your system from this release, checks it against `SHA256SUMS`, and refuses a mismatch.

To check by hand instead: download the archive and `SHA256SUMS`, then `sha256sum -c --ignore-missing SHA256SUMS` (Linux), `shasum -a 256 -c --ignore-missing SHA256SUMS` (macOS), or `(Get-FileHash <file>).Hash` and compare with the line in `SHA256SUMS` (Windows). A checksum fetched from the same place as the file proves it was not damaged, not who made it. The binaries are not code-signed, so Windows and macOS may warn.

## Sign in to your agents (subscription, no API key)

AgentOnTrack never asks for, stores or sends your agent sign-ins.

| Agent | Sign in | Check |
|---|---|---|
| Claude Code | `claude`, then `/login`, and choose your Claude subscription | `claude auth status` shows `claude.ai` |
| Codex | `codex login`, and choose Sign in with ChatGPT | `codex login status` says "Logged in using ChatGPT" |

Runs start with API-key variables removed, so they use your subscription. A sign-in billed by use is refused unless you turn on paid API mode yourself.

## First run

```sh
cd your-project
agentontrack setup      # finds your agents, connects their hooks, asks for a goal and a check
agentontrack doctor     # says what is and is not enforced on this machine
agentontrack dashboard  # the local dashboard
```

## Roll back or remove

```sh
agentontrack self rollback              # return to the previous version (the installer keeps it)
agentontrack self uninstall             # removes the program, hooks and PATH lines; keeps your project records
agentontrack self uninstall --purge     # also deletes every project's record
```

Installing a different version: run `install.sh --version <x.y.z>`, or on Windows set `$env:AOT_VERSION = '<x.y.z>'` before running the `install.ps1` command; the previous version stays for rollback. Windows on Arm uses the x64 build through emulation, which is untested.

## What is experimental or unavailable in this candidate

| Feature | Status |
|---|---|
| Phone control and sign-in (Firebase) | **Switched off in this build.** The phone page says "Phone access is not switched on" and contacts nothing. Tested against local emulators only. Do not rely on it |
| Voice dictation | Uses your browser's speech service where there is one. Not verified with a real microphone |
| Attachments | Claude Code read an image and a PDF in one real trial each. Codex has no PDF input; Codex images not run live |
| Claude Code / Codex parity | **Not complete**: no fork, effort choice, steering or queueing, native audio, compaction control or subagent management |
| Anything that starts several runs after one click (continue over phases, repeat until checks pass, one-click build-then-review), and unattended runs | **Refused by the program** for any agent signed in with a subscription. Allowed only with your own API key in paid API mode and a time-limited grant made with the terminal code. Starting the build and then a review yourself (`Review this run`) is allowed |
| Phone-started runs | Refused unless a separate setting is on; phone control is off in this build |
| Provider terms | Not fully settled; see `docs/provider-terms.md` in the source repository. Use it with your own login, one run at a time |
| Codex | Works with limits. Codex fails open if its hook program is missing; start it with `agentontrack run codex`, which refuses unless the hook answers. Run against a real Codex on one Windows machine only |
| Claude Code | Best tested. Real runs on one Windows machine only |
| Linux, macOS | Install, upgrade, rollback and uninstall are tested on real runners. Real-agent runs there are **NOT TESTED** |
| Hermes, Cursor, Devin, Kiro, Antigravity and other agents | Not started by AgentOnTrack; their capability rows say what was or was not tested. Treat anything not shown as verified as unproven |
| Local models (Ollama and similar) | Deferred; not part of this candidate |
| Build provenance and code signing | Built by GitHub Actions in the public repository; each file has a build attestation you can check with `gh attestation verify <file> -R satyamamarpandey/agentontrack`. **No code signing.** See `SECURITY.md` |

## Known limitations

- AgentOnTrack adds time over the bare agent (about 3 s on a 5-second task in the latest valid measurement). No time or token saving is claimed.
- A Codex run can stop after one failed command. The run now shows the failed command, gets one recovery turn, and a cross-review workflow whose builder changed nothing ends as failed instead of being reviewed.
- Real-agent evidence is small (a few trials per check, one machine). Numbers in `RELEASE_NOTES.md` are counts, not rates.
- Codex reports no cost; none is shown.

## Reporting a security problem

Privately, as `SECURITY.md` says. Do not open a public issue for a vulnerability.

Licence: Apache-2.0 (`LICENSE`, `NOTICE`); bundled third-party notices are in each archive as `THIRD_PARTY_NOTICES.txt`.
