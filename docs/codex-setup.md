# Codex: what is built, and the steps only you can do

AgentOnTrack starts Codex through `codex app-server`, the interface that lets an action wait for an answer. Codex signs in with your ChatGPT account through its own `codex login`. AgentOnTrack never reads, copies or forwards that login, and removes API-key variables from the environment it gives Codex.

**Status (2026-11-07): verified once against a real Codex** (codex-cli 0.167.0-alpha.3, ChatGPT sign-in, Windows): handshake, a turn that wrote a file, usage, interrupt, one approval request (the maintainers' record "live-codex-appserver.json" (not published)); resume in a second process and a declined deletion (`live-codex-resume.json`); Claude Code ↔ Codex cross-review in both orders (`live-handoff.json`). One trial each, one machine. Not tested with a real Codex: the exec transport and attachments. A worktree run passed once (`live-worktree-codex.json`). The first live run found a bug the protocol script could not: the model name `default` is rejected on a ChatGPT sign-in, so it now means "send no model".

**The Codex desktop app carries its own CLI**, e.g. `%LOCALAPPDATA%OpenAICodexin<hash>codex.exe`. If `codex` is not on PATH, add that folder to PATH for the terminal you run the scripts in. Nothing is installed or copied.

## Steps for you (about five minutes)

1. Install Codex using OpenAI's own instructions (their current install page, or `npm install -g @openai/codex`). AgentOnTrack does not install it for you.
2. Sign in: `codex login`, then choose **Sign in with ChatGPT**. Check with `codex login status`.
3. From the AgentOnTrack folder, after `pnpm build`:

   ```
   node scripts/live-codex.mjs
   ```

   It works in a throwaway folder and writes the maintainers' record "live-codex-appserver.json" (not published). It checks: handshake and session id, a completed turn, a file written, usage reported, and interrupt. If any check fails, the JSON shows the events Codex really sent, which is what is needed to correct the field names.
4. Then the two-agent check (real Claude Code and real Codex, cross-review in both orders; refuses to start if either is missing, signed out, or billed by use):

   ```
   node scripts/live-handoff.mjs
   ```

   It writes the maintainers' record "live-handoff.json" (not published) and says PASS only if both orders pass every check. One trial per order.
5. Send me those JSON files file (it holds no login data), and I will fix any mismatch and change the capability matrix from `unverified` to `supported` only for what it shows.

## How approvals work for Codex

- Codex runs with approval policy `untrusted` and the `workspace-write` sandbox, so it asks before anything it does not know to be safe.
- Each ask is checked by the same decision engine and approval records the hooks use. A denied action is declined. An action that needs a person waits; it is accepted only after you approve it in the dashboard, and declined if you deny it, stop the run, or ten minutes pass.
- AgentOnTrack never answers "accept for the session". Each approval is for one action.
- If Codex's hooks are also connected to the project, the hook spends the approval when the action runs, so you approve once.
- An action Codex considers safe under its own policy does not ask, and is therefore not mediated by this path. Hooks remain the second layer.
