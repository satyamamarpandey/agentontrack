# Changelog

## Unreleased

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
