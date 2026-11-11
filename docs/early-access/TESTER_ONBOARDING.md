# Early access: getting started as a tester

You received a personal invitation link. Here is what to expect, in order. Nothing in AgentOnTrack runs on a server of ours: your agents, your code and your records stay on your own computer.

## 1. Use your invitation

Open the link. Sign in, or create your account, **with the email address the invitation was sent to**; it works for that address only, once, and expires. An email-and-password account asks you to confirm the address first. When it says **You are in**, your account is active.

## 2. Install the desktop preview

The install page (`Install` in the menu) now shows the steps. One command, no administrator rights:

- Linux and macOS: `curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh`
- Windows PowerShell: `irm https://pandeysatyam.com/agentontrack/install.ps1 | iex`

The installer checks every file against the published checksums and installs nothing if they differ. Open a new terminal afterwards so `agentontrack` is on your PATH.

## 3. Connect your agents

In a project folder, with Claude Code or Codex already installed and logged in:

```
agentontrack setup
```

It finds your agents, installs their hooks, tests them, and offers to set a goal and a first task. `agentontrack doctor` tells you at any time what is and is not enforced. Claude Code's hooks fail closed; **Codex runs an action anyway if its hook is missing**, so start Codex through `agentontrack run codex`, which refuses to start if the hook self-test fails.

What is supported today, honestly: Claude Code and Codex can be started and observed from AgentOnTrack. Hermes and the other adapters (Gemini CLI, Cursor, Copilot, Devin, OpenCode, Kiro, Cline) have hook adapters written from their documentation and run in their own terminals; the integrations page says exactly what has been run for real.

## 4. Use the dashboard

- `agentontrack dashboard` prints a local address. It always works and needs no account.
- `agentontrack dashboard --allow-public-site` also lets the dashboard on this website connect to your computer, with a one-time pairing code shown in your terminal, and a terminal code for every change asked for from the site. As a tester, the site's dashboard lets you connect; visitors see a sign-in gate.

## 5. Tell us what you find

The feedback page shows you the tester form: bug, feature request, interface, connector compatibility, or overall experience, with the version (`agentontrack self status`), operating system and connector. Diagnostics are attached only when you paste them yourself and tick the box; read them first and remove anything private. Reports go to the maintainer only.

## What your account holds

Your name and email, your theme, project summaries you choose to save (counts only; never code, prompts or paths), and feedback you send while signed in. The optional phone link, if you switch it on, carries sealed messages between your phone and your computer through Firebase. You can export or delete all of it on the account page. Access can be withdrawn during early access; your local installation keeps working regardless.

## If something is wrong

- "Refusing to start" → `agentontrack doctor`, then `agentontrack setup` again.
- The site's dashboard cannot reach your computer → use the local address it printed; Safari blocks a secure page from reaching a local address by design.
- Your invitation link says it is not valid → it may have expired or been used; ask the person who invited you for a new one.
