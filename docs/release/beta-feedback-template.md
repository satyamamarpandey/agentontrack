# AgentOnTrack beta feedback

**Before you write:** do not include prompts, code, file paths, your username, repository names, or any credential. If a field would need one, describe it in words instead. A **security** problem (for example an action that should have been held but ran) goes through the private channel in `SECURITY.md`, not here.

## 1. Your setup

| | |
|---|---|
| AgentOnTrack version (`agentontrack --version`) | |
| Operating system and version | |
| CPU (Intel / Apple silicon / ARM Linux / other) | |
| Claude Code version and sign-in type (subscription / API key) | |
| Codex version and sign-in type (ChatGPT / API key) | |
| How you installed (pinned command / other) | |
| Experience with AI coding agents (new / some / a lot) | |

For `agentontrack doctor`: paste **only** the lines that name an agent and say whether it is enforced. Delete any line that contains a folder path. Do not paste `doctor --json`, which contains local paths.

## 2. Tasks

Mark each: **PASS**, **FAIL**, **NOT TRIED**, or **N/A** (you do not have that agent). Add a short note for anything that was not a clean pass.

| # | Task | Result | Note |
|---|---|---|---|
| T1 | Install the pinned version; `--version` prints it | | |
| T2 | `setup`, then `doctor` | | |
| T3 | `git push` is held for approval and does not run | | |
| T4 | Start a run from the dashboard | | |
| T5 | Resume the session | | |
| T6 | Attach a text file and an image | | |
| T7 | Claude Code and Codex cross-review (if you have both) | | |
| T8 | Cancel a run; it really stops. If a finished run still shows a Stop button, press it and say what the page said | | |
| T9 | Run in an isolated worktree; the change is only there | | |
| T10 | Roll back and uninstall cleanly | | |

Time from install to your first successful run (T4), in minutes:

## 3. Problems

One block per problem.

- **What you did** (steps, in words):
- **What you expected:**
- **What happened:**
- **Does it happen every time?** (always / sometimes / once):
- **How much did it matter?** (blocked me / got in the way / minor / cosmetic):
- **Which task?**

## 4. What was confusing

Anything in the install, the setup, the dashboard wording, or the documents that you had to guess at.

## 5. Anything else

## 6. Consent

- [ ] I understand this feedback may be published (for example as a public GitHub issue) and contains nothing private.
- [ ] I understand I can stop at any time.
