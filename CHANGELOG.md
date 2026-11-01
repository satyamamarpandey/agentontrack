# Changelog

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
