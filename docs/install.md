# Install and troubleshooting

No administrator rights, Node or account are needed. Each archive bundles its own Node runtime. Everything goes in `~/.agentontrack`.

## Install

Linux and macOS:

```sh
curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://pandeysatyam.com/agentontrack/install.ps1 | iex
```

Prefer to read it first? Download `install.sh` or `install.ps1` and the archive from [Releases](https://github.com/satyamamarpandey/agentontrack/releases), then run the script with `--from <folder>` (or `$env:AOT_FROM` on Windows).

Manual check: `sha256sum -c SHA256SUMS --ignore-missing`, or on Windows `Get-FileHash <file>` compared with `SHA256SUMS`.

Builds: Linux x64 and arm64 (glibc), macOS x64 and arm64, Windows x64.

## Sign in to your agents (subscription, no API key)

AgentOnTrack never asks for, stores or sends your agent sign-ins. You sign in with each agent yourself, and AgentOnTrack starts the agent with API-key variables removed from its environment, so a run uses your subscription and not a metered key.

| Agent | Sign in | Check |
|---|---|---|
| Claude Code | `claude`, then `/login`, and choose your Claude subscription (Pro, Max or Team) | `claude auth status` shows `claude.ai` |
| Codex | `codex login`, and choose Sign in with ChatGPT | `codex login status` says "Logged in using ChatGPT" |

The Agents page shows the sign-in type it found. A sign-in that is billed by use (an API key) is refused unless you turn on paid API mode yourself. If the Agents page says Codex is not installed but you use the Codex desktop app, the app carries its own `codex` program: add its folder to PATH for the terminal you start AgentOnTrack from (see `docs/codex-setup.md`). A Codex run also needs the project to be a git repository; Codex refuses to run in a folder that is not one.

## First run

```sh
cd your-project
agentontrack setup      # finds your agents, connects them, asks for a goal and a check
agentontrack doctor     # says what is and is not enforced here
```

Then use your agent as usual. On Codex, start it with `agentontrack run codex`. When an action is held: `agentontrack approvals`, then `approve <id>` or `deny <id>`. Afterwards: `agentontrack verify`. To see it all: `agentontrack dashboard`.

## Other platforms

```sh
agentontrack providers                 # what is found here, and how each behaves if its hook fails
agentontrack install copilot           # or gemini, opencode, cline, cursor, devin, kiro
agentontrack run copilot               # checks the hook first, and adds what the host needs to load it
agentontrack uninstall copilot
agentontrack mcp-config continue       # state only, with no enforcement. Also: cline, roo
agentontrack research                  # optional Perplexity config, on your own key
```

See [compatibility](compatibility.md). Do not assume an adapter works until its status says so.

## VS Code and editors based on it

Download `agentontrack-vscode.vsix` from the release page, next to the archives, and check it against `SHA256SUMS`. Then:

```sh
code --install-extension agentontrack-vscode.vsix
```

In a project, run `agentontrack dashboard`. In VS Code, run **AgentOnTrack: Connect to the companion** and type the pairing code the terminal printed. Approving, denying, starting a run, verifying and handing off each show a code in that terminal, and you type it in VS Code. The extension cannot confirm anything by itself.

Cursor and other editors that install VS Code extensions can use the same file. That is **not tested** on Cursor yet, so treat it as unverified. Antigravity: **not tested**; its extension and plugin interfaces are separate and not covered here.

### Extension troubleshooting

| Symptom | What to check |
|---|---|
| "AgentOnTrack is not connected" | Is `agentontrack dashboard` running? Run **AgentOnTrack: Diagnostics**, which shows the address, trust, project and the last error. |
| The address is refused | It must be `127.0.0.1` or `localhost`, and it is a machine-scoped setting: a project's own settings cannot change it. |
| Nothing can be approved or started | The workspace is not trusted. Trust it in VS Code to allow changes; the extension only reads until you do. |
| The code is rejected | The code is for one request and expires. Ask again, and type the one the terminal now shows. |
| The session is gone after a restart | The companion keeps sessions in memory. Pair again with a new code. |
| Remote or container windows | The companion address is on the machine that runs `agentontrack dashboard`. A window on another machine cannot reach `127.0.0.1` there. Not tested. |

Uninstall: `code --uninstall-extension satyamamarpandey.agentontrack-vscode`.

## Upgrade, roll back, remove

```sh
agentontrack self upgrade                 # or --version 1.0.1
agentontrack self rollback
agentontrack self uninstall               # removes the program, hooks and PATH lines; keeps your records
agentontrack self uninstall --purge       # also deletes every project's record
```

Uninstall removes hooks only from projects it knows about, and leaves files such as `GOAL.md` that `init` wrote.

## Troubleshooting

| Message or symptom | Cause and fix |
|---|---|
| `agentontrack: command not found` | Open a new terminal, so the PATH change applies |
| `checksum mismatch` | The download is damaged or altered. Nothing was installed. Try again, and report it if it repeats |
| `musl systems are not supported` | Alpine is not supported, because the bundled Node needs glibc |
| Windows SmartScreen or macOS warning | The binaries are not code-signed. Check the checksum, or build from source |
| `Refusing to start codex: ...` | The hook would not answer. Run the suggested `agentontrack install codex` |
| Codex ignores the hook | Codex skips a hook until you trust it, with `/hooks` |
| `--sandbox cannot be honoured` | Native Windows has no Claude Code sandbox. Use `agentontrack policy profile strict`, or WSL |
| Sandbox fails on Linux | Claude Code's sandbox needs `bubblewrap` and `socat`. Some systems also restrict user namespaces |
| Task stays `IMPLEMENTED_UNVERIFIED` with `Weak check` | Your check can pass without the work being done. Strengthen it, or run `agentontrack task accept-weak <id>` |
| `changed with no gate firing` | Files changed while no hook ran. Run `agentontrack doctor`, then review them and run `agentontrack ack <seq>` |
| Public site says it cannot reach the companion | Run `agentontrack dashboard --allow-public-site`, and allow local network access if the browser asks. Safari blocks this: use the local address the command prints |
| `Refusing to start <agent>` | Its hook did not refuse a test request. Run `agentontrack install <id>` |
| Copilot `-p` ignores the gate | Repo hooks load only in a trusted folder. Use `agentontrack run copilot`, or add `--trust-folder` |
| Gemini hook not running | Project hooks are untrusted by default. Trust the folder, and check `hooksConfig` |
| Cline ends the run on a held action | That is how Cline handles a refusal |
| Hermes does not list the AgentOnTrack MCP tools | MCP is an optional Hermes extra. Install the `mcp` package into its environment |
| `Approvals are suspended` | The log failed its integrity check. Run `agentontrack audit`, then `audit --recover` |
