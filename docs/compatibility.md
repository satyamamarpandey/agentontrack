# Compatibility

The current record for every platform is `benchmarks/results/provider-certification.json`, shown on the website's Integrations page. The Codex, Claude Code and Hermes details follow. For any other platform: `agentontrack providers`, `agentontrack install <id>`, `agentontrack uninstall <id>`, and `agentontrack run <id>`, which refuses to start the agent unless its hook refuses a test request.

MCP gives a client goals, evidence and state, and stops nothing. Perplexity is optional research on your own key, billed by Perplexity, and an answer is never evidence that work is done. Treat any platform not shown as verified as unproven: adapters for Cursor, Devin and Kiro are written from their docs and have never run on the real programs.

Labels: **live model** means the real agent with a real model. **Scripted model** means the real agent program, with its real hooks, shell, MCP client and OS sandbox, driven by planned tool calls, so it tests the host and gate and not how a model behaves. All of it is self-run. Versions are those tested: Claude Code 2.1.316, Codex 0.166.0, Hermes 0.22.5.

## Agents

| Capability | Claude Code | Codex | Hermes |
|---|---|---|---|
| Support level | **Supported** | Supported with limits | Supported with limits |
| Tested with a normal hosted model | Yes, Haiku | **Yes, on one Windows machine** with a ChatGPT sign-in (codex-cli 0.167.0-alpha.3): app-server, `codex exec`, resume, attachments, worktree, handoff with Claude Code. Few trials; Linux and macOS not run with a real sign-in | **No** (same) |
| Push held, denied, then allowed once after approval | Live model and scripted | Scripted. With `qwen2.5:3b`: held in each of two runs, and allowed after approval in one | Scripted. With `qwen2.5:3b`: never reached a push, since its tool call was malformed in one run and timed out in another |
| Hook program missing | **Blocks** | **RUNS THE ACTION** | **Blocks**, with `fail_closed: true`. Its own default fails open |
| Start refused if the hook is broken | `agentontrack run claude-code` | `agentontrack run codex`. Running `codex` directly skips this check | Not built |
| OS containment of scripts | `install --sandbox`: **verified on macOS**. **Linux: could not start on the cloud runner, so not verified.** Native Windows: none | `agentontrack run codex`: verified on Linux. Windows and macOS not tested | None known |
| MCP in the real host | Live model and scripted | Scripted | Scripted, with Hermes' optional `mcp` package installed. Without it the server silently does not load |
| Compaction seen by hooks, gate holds after resume | Scripted | Not tested | Not tested |
| Dashboard can start it | Yes | Yes, through the Codex app-server (approvals answered by a person) or `codex exec`; a metered sign-in is refused unless you allow it | No: run it yourself, and its hooks report |
| Usage reported | Provider-reported | Recorded from Codex's own token counts; Codex reports no cost, so none is shown | Field names unverified |

An approval given on one agent does not carry over to another unless you made it portable. This was tested between real Codex and real Hermes with a scripted model.

## Which ways of starting an agent are allowed (1.0.0-rc.7)

Enforced by the companion program itself, not only by the screen. Details and the reasons: [docs/provider-terms.md](provider-terms.md). Neither provider has confirmed that every way of starting its program is allowed.

| Way of starting | Claude Code | Codex |
|---|---|---|
| One run, started by a person clicking Start | On, with the person's own login | On, with the person's own login |
| Build, then a separate click to review it (`Review this run`) | On, two single runs | On, two single runs |
| One-click build then review (cross-review), continue over several phases, retry loops, unattended runs | Refused on a subscription login. Allowed only with the person's own API key in paid API mode and a time-limited grant made with the terminal confirmation code | Same |
| Started from a phone | Off in the releases; refused unless a separate setting is on | Same |
| Hosted or commercial | Not offered | Not offered |

Limits that apply to every run: a time limit in minutes (default 30), at most 4 agents at once, output kept in memory capped at 2000 lines. A dollar cap exists only for an API key in paid API mode; AgentOnTrack does not show or invent dollar figures for subscription use. When a provider says its usage limit is reached, the run is marked stopped (not failed), the session and its context are kept, and the note says to resume later or start the same task with another connected agent.

## What each sandbox does

Sandboxes come from the agent, not from AgentOnTrack. With them on, some ordinary work may fail, such as anything that needs the network. `agentontrack run codex --allow-network` turns network back on for Codex.

`agentontrack run codex` also closes `/tmp` to writes, which Codex's own default leaves open. Tools that write temporary files there may fail.

## Local models

A model server is not an agent. It has no tools, approvals or sessions. Enforcement comes from the agent in front of it, so there are two separate questions:

| Question | Ollama | LM Studio, vLLM, llama.cpp |
|---|---|---|
| Model API works (`agentontrack probe <url>`) | Yes, `qwen2.5:3b` on a cloud runner: tool call seen in one trial | **Not tested** |
| A real agent makes a real call through it | `qwen2.5:3b` on a CPU-only runner, each call taking minutes: Claude Code and Codex yes. Hermes no. Results varied between runs | **Not tested** |

Small local models often fail to make valid tool calls, in which case nothing reaches the gate. That shows nothing about safety either way.

## Operating systems

Clean install, upgrade, rollback and uninstall: Windows x64, Linux x64 and arm64, macOS x64 and arm64.  Alpine and other musl systems are not supported. Windows on Arm runs the x64 build, and is untested.

## Editors

| Editor | Status |
|---|---|
| VS Code | Extension client: PASS (unit). Real Claude Code run through the extension client: PASS (local). Real VS Code extension host on a GitHub runner: PASS from source (activates, 20 commands, 5 views, reads the project, approves with a terminal code, makes a handoff), PASS from the installed VSIX (the installed copy cannot be driven by a test input box, so only reading, a refused wrong code and disconnect are checked there), and PASS in an untrusted workspace (it reads, asks for no code and decides nothing). Windows and macOS hosts: NOT TESTED. |
| Cursor | NOT TESTED. It installs VS Code extensions, so the VSIX may work. No run on the real editor. |
| Antigravity | NOT TESTED. Documented plugin interfaces were not exercised. |
| JetBrains, Zed, others | Not supported. |

## Large plugin collections (for example ECC)

Some Claude Code plugin collections ship dozens of agents, hundreds of skills, slash-command shims and their own hooks (the ECC repository, MIT licensed, describes itself this way). AgentOnTrack does **not** bundle, copy or depend on any of it: it governs the agent you already run, whatever instructions that agent was given.

What to know before combining them. **None of this has been tested** with ECC or any similar collection:

* Their hooks and ours both run. AgentOnTrack's decision is made by its own hook, and `agentontrack doctor` tests that hook. It cannot see or vouch for what another hook decides. Do not enable a plugin that auto-approves tools or loosens permissions in a project you want governed.
* Agent, skill and hook files are instructions the agent obeys. AgentOnTrack treats the host's config folders as protected paths, so an agent cannot edit them by itself. A plugin you install yourself is outside that protection. Review it as you would code you run.
* Skills and agents do not make AgentOnTrack's evidence stronger. A skill that says "all tests pass" is a claim, not a receipt.
* Install only from the plugin's official source. The ECC project warns that unofficial mirrors may contain malware.

## Agents started from the product

**Claude Code** (verified) and **Codex** (app-server verified with a real Codex on 2026-11-07, one trial each; exec transport and attachments not) can be started from the web workspace. Hermes and the other platforms run in their own terminal, and their hooks report to the same record. Assigning a role to an agent in the Team panel records the plan. It does not start that agent.

## Browsers, for the public site

Chromium, Edge, Firefox and WebKit pass pairing against a local copy of the site. The real https page has been run end to end with Chromium, the installed release and real Claude Code. Safari blocks requests from a public page to your machine, so use the local address the companion prints.

## Starting agents from AgentOnTrack (updated 2026-11-06)

| | Claude Code | Codex |
|---|---|---|
| Start, stream, stop | Verified with the real program | Verified with a real Codex 0.167.0-alpha.3 on a ChatGPT sign-in, 1 trial (the maintainers' record "live-codex-appserver.json" (not published)) |
| Approval at the moment of the action | Hook holds the action until a person approves (real agent) | The app-server asks before running; AgentOnTrack answers from the same approval records. One-time accepts only. Real Codex asked, a decline kept a file from being deleted (`live-codex-resume.json`); an approve-then-run was seen in a real cross-review (1 trial) |
| Runs inside an isolated worktree | Verified with the real program, 1 trial | Verified with a real Codex, 1 trial (the maintainers' record "live-worktree-codex.json" (not published)): file only in the worktree, project folder unchanged, a push held for a person, clean merge preview |
| Resume, attachments, usage | Resume and a text attachment verified (1 trial each) | Resume and usage verified with a real Codex (1 trial); attachments fixture only |
| Claude ↔ Codex handoff (cross-review, both orders) | Real agents, 1 trial per order, 6 of 6 checks (`live-handoff.json`) | same |
| Sign-in | Your Claude subscription; API-key variables removed from the agent's environment | Your ChatGPT subscription through `codex login`; nothing is read or copied |

Steps to repeat the Codex checks yourself: `docs/codex-setup.md`.

Windows: Claude Code's Bash tool runs in Git Bash. `/tmp/x` and `/d/x` there mean the Windows temp folder and drive D, and AgentOnTrack reads them that way for the Bash tool only. WSL's bash is not covered by this.
