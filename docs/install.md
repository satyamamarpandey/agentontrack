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

## First run

```sh
cd your-project
agentontrack setup      # finds your agents, connects them, asks for a goal and a check
agentontrack doctor     # says what is and is not enforced here
```

Then use your agent as usual. On Codex, start it with `agentontrack run codex`. When an action is held: `agentontrack approvals`, then `approve <id>` or `deny <id>`. Afterwards: `agentontrack verify`. To see it all: `agentontrack dashboard`.

## Other platforms

Release 1.0.0-rc.1 includes Claude Code, Codex and Hermes. These commands are in the source and arrive in the next release.

```sh
agentontrack providers                 # what is found here, and how each behaves if its hook fails
agentontrack install copilot           # or gemini, opencode, cline, cursor, devin, kiro
agentontrack run copilot               # checks the hook first, and adds what the host needs to load it
agentontrack uninstall copilot
agentontrack mcp-config continue       # state only, with no enforcement. Also: cline, roo
agentontrack research                  # optional Perplexity config, on your own key
```

See [compatibility](compatibility.md). Do not assume an adapter works until its status says so.

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
| `Approvals are suspended` | The log failed its integrity check. Run `agentontrack audit`, then `audit --recover` |
