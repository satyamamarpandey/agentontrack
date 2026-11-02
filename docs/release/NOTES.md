First installable release candidate of AgentOnTrack: a free, local-first control layer for AI coding agents. No account, nothing uploaded. All testing so far is by the project itself, and nobody independent has evaluated it.

**Install**

- Linux, macOS: `curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh`
- Windows: `irm https://pandeysatyam.com/agentontrack/install.ps1 | iex`

Then, in a project: `agentontrack setup`, and `agentontrack doctor` to see what is enforced on your machine.

**New in rc.3**

A redesigned dashboard and a **Workspace** screen: files with a hash-checked editor, a prompt composer with live output (Claude Code), team roles, approvals, handoffs, isolated git worktrees with diffs, and verification receipts. A **VS Code extension** (`agentontrack-vscode.vsix`, in this release's files, checked by `SHA256SUMS`): `code --install-extension agentontrack-vscode.vsix`. It confirms nothing by itself. A `spec-review` workflow and a spec structure check. Handoffs never carry approvals.

**What rc.3 does not show:** AgentOnTrack still used more tokens and time than the agent alone in its own benchmarks, and no saving is claimed. Only Claude Code starts from the product. Cursor and Antigravity are untested. Codex-reviews-Claude as a real run is not shown.

**New in rc.2**

Adapters over the same engine. Verified on the real programs, with a scripted model and no account: GitHub Copilot CLI, Gemini CLI, OpenCode and Cline CLI. Continue gets state over MCP, with no enforcement. Cursor, Devin and Kiro adapters are written from their docs and **have never run on the real programs**, since those need accounts. See `agentontrack providers`.

**Before you rely on it**

- **Claude Code** is the best-tested agent. **Codex** runs an action anyway if its hook program is missing, so start it with `agentontrack run codex`. **Codex and Hermes** have not been tested with their normal hosted models.
- On Gemini CLI and Cline CLI, a hook that crashes lets the action run. On Copilot CLI a hook timeout does, and plain `copilot -p` in an untrusted folder skips the hook, so use `agentontrack run copilot`.
- In the standard profile, a script's network use and writes outside the project are **not stopped**. Use an agent's OS sandbox where it works, or the strict profile, which blocks often.
- It does **not** save tokens or time. In our benchmark it took more time than the bare agent, and a plain goal in `CLAUDE.md` matched its task success.
- Binaries are not code-signed. Check `SHA256SUMS`, which only catches corruption if fetched from the same place as the file.

See `SECURITY.md`, `docs/compatibility.md`, `docs/install.md` and `benchmarks/README.md`. Reports and attempts to break it are welcome: `docs/evaluation/INDEPENDENT.md`.
