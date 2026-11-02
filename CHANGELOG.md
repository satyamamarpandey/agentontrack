# Changelog

## 1.0.0-rc.4

- A new first screen: choose to continue on this computer, sign in (Google, GitHub or email, once the site's owner switches accounts on), or look at a labelled demo. Signing in never gives the website access to your computer.
- Connecting a computer is a guided step. The page looks for AgentOnTrack on your computer by itself, shows how to get and start it if it is not there, and asks for the one-time code from your terminal. If the computer stops answering, a clear screen offers Retry, Connect again, Download and the local dashboard.
- Projects registered on your computer appear as soon as it is connected, with search, sort, archive, and a way to find Git repositories inside one folder you name, import a folder, or copy a GitHub repository.
- A searchable catalog of 18 agents, editors, model servers and research tools, each with its maker's install page, how it connects, what has really been tested, and what it can and cannot do. Only agents that can really be started from AgentOnTrack show a Run control, decided by the helper.
- Six places to go: Projects, Workspace, Agents, Activity, Analytics, Settings. A Results and evidence center, with an exportable receipts file.
- Reading source files from the public site now needs a short permission you give in your terminal. The dashboard page has a Content-Security-Policy. `agentontrack dashboard --allow-origin` takes a dedicated hostname.
- Optional anonymous usage counts, off by default, with a preview of exactly what would be sent.
- Not changed or not claimed: sign-in is written and tested against emulators only, and is off until the owner creates a Firebase project. Only Claude Code starts from the product. AgentOnTrack still used more tokens and time than the agent alone in its own benchmarks.

## 1.0.0-rc.3

- A redesigned dashboard and site: one set of design tokens, a command palette, grouped navigation, light and dark themes, and an accessible dialog that traps focus.
- A **Workspace** screen: project files with a hash-checked editor that refuses to overwrite a changed file, Markdown preview, a prompt composer with live output (Claude Code), team roles, approvals, handoffs, isolated git worktrees with diffs and merge, verification and receipts. Resizable panels, saved layout, focused mobile views.
- VS Code extension (`agentontrack-vscode.vsix`): a sidebar over the same companion. It confirms nothing by itself, and only reads in an untrusted workspace.
- CLI commands for projects, agents, team, handoff and usage, with JSON output.
- Team roles and workflows, including `spec-review` (draft, structure check, fresh-session reviewers, go or no-go, a person approves) and a deterministic spec structure check.
- Handoff v2 with revalidation: approvals are never carried over, and a stale handoff needs a person's acknowledgement.
- Not changed, and not claimed: AgentOnTrack still used more tokens and time than the agent alone in its own benchmarks. Only Claude Code starts from the product. Cursor, Antigravity, Devin and Kiro are not tested on the real programs.

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
