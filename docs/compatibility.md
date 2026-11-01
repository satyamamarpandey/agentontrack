# Compatibility

Labels: **live model** means the real agent with a real model. **Scripted model** means the real agent program, with its real hooks, shell, MCP client and OS sandbox, driven by planned tool calls, so it tests the host and gate and not how a model behaves. All of it is self-run. Versions are those tested: Claude Code 2.1.316, Codex 0.166.0, Hermes 0.22.5.

## Agents

| Capability | Claude Code | Codex | Hermes |
|---|---|---|---|
| Support level | **Supported** | Supported with limits | Supported with limits |
| Tested with a normal hosted model | Yes, Haiku | **No** (needs a login not available here) | **No** (same) |
| Push held, denied, then allowed once after approval | Live model and scripted | Scripted. With `qwen2.5:3b`: held in each of two runs, and allowed after approval in one | Scripted. With `qwen2.5:3b`: never reached a push, since its tool call was malformed in one run and timed out in another |
| Hook program missing | **Blocks** | **RUNS THE ACTION** | **Blocks**, with `fail_closed: true`. Its own default fails open |
| Start refused if the hook is broken | `agentontrack run claude-code` | `agentontrack run codex`. Running `codex` directly skips this check | Not built |
| OS containment of scripts | `install --sandbox`: **verified on macOS**. **Linux: could not start on the cloud runner, so not verified.** Native Windows: none | `agentontrack run codex`: verified on Linux. Windows and macOS not tested | None known |
| MCP in the real host | Live model and scripted | Scripted | **Not observed:** the server did not load in the test, and the cause is unknown |
| Compaction seen by hooks, gate holds after resume | Scripted | Not tested | Not tested |
| Dashboard can start it | Yes | No: run it yourself, and its hooks report | No: run it yourself, and its hooks report |
| Usage reported | Provider-reported | In its own output, not yet recorded by AgentOnTrack | Field names unverified |

An approval given on one agent does not carry over to another unless you made it portable. This was tested between real Codex and real Hermes with a scripted model.

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

## Browsers, for the public site

Chromium, Edge, Firefox and WebKit pass pairing against a local copy of the site. The real https page has been run end to end with Chromium, the installed release and real Claude Code. Safari blocks requests from a public page to your machine, so use the local address the companion prints.
