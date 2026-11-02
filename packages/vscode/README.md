# AgentOnTrack for VS Code

Goals, approvals, evidence and handoffs for your AI coding agents, in the sidebar. Everything runs on your machine: the extension talks only to the AgentOnTrack companion at `127.0.0.1`.

## Use

1. Install AgentOnTrack: `curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh` (Windows: `irm https://pandeysatyam.com/agentontrack/install.ps1 | iex`).
2. In a project, `agentontrack setup`, then `agentontrack dashboard`.
3. In VS Code: **AgentOnTrack: Connect to the companion**, and type the pairing code the terminal printed.

The sidebar shows the project, its goal and task, what is waiting for approval, the agent team, handoffs and usage. Select code and use the editor menu to review, explain, fix or write tests for it, which runs your own Claude Code in the project.

## What it can and cannot do

- **It cannot confirm anything on its own.** Approving, denying, starting a run, verifying and handing off each show a code in the terminal where `agentontrack dashboard` runs, and you type it here. Another extension cannot do this for you.
- **It starts a run for Claude Code only.** Other agents run in their own terminal, and their hooks report to the same record, which the sidebar shows.
- **It sends nothing off this machine.** The address is a machine-scoped setting, and anything that is not `127.0.0.1` or `localhost` is refused, so a project's own settings cannot redirect it.
- **In an untrusted workspace it only reads.**
- **It does not enforce anything.** Enforcement is the agent's own hook, installed by `agentontrack install`. Run `agentontrack doctor` to see what is and is not enforced on your machine.

Cursor and other editors based on VS Code can install the same VSIX. Whether this works in Cursor is recorded, from a real run, in the integrations page. Until it says so, it is not claimed.

## Install from a file

```sh
code --install-extension agentontrack-vscode.vsix
```
