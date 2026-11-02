# Phone remote control

The phone is a **remote control for projects that already exist on a computer you have authorized**. It is not a development environment: no terminal, no code editing, no new projects, no local model install, no arbitrary file access. The desktop web app, the CLI and the IDE extensions remain the full workspace.

## How it works

1. **Link the computer once** (desktop, Settings, Phone access). You must be signed in to your account. This creates a limited per-computer account and records the computer's public key under your account. A person confirms it with the usual dialog.
2. **Open the phone page** (`/dashboard/?m=1`, installable as a PWA), sign in with the same account. You see the computers linked to it and their online state. Signing in grants nothing.
3. **Connect this phone**: the phone shows the computer's fingerprint and you compare it with the one on the computer's screen. The phone remembers the key it saw. It asks to connect and shows its own fingerprint.
4. **Approve at the computer**: the computer shows the phone's fingerprint. A person approves it as *look only* or *look and control*. Only then is anything answered.
5. Projects already registered on that computer appear. Live status arrives as sealed snapshots. Prompts and controls travel as sealed requests; answers come back sealed.

## What Firebase can and cannot do

Firebase carries sealed messages and presence. It has **no authority to execute anything**. Every message is ECDSA-signed and AES-GCM encrypted with a key derived (ECDH + HKDF) from the phone's and computer's own keys, which Firestore never sees. The computer validates each request against the current project, goal, plan, policy and approvals, then runs it itself. The companion is never exposed publicly: it makes outbound calls only.

| Property | Where it is enforced | Tested by |
|---|---|---|
| Encryption, signatures, recipient and time binding | `@agentontrack/remote` | `packages/remote/test/protocol.test.ts` (real crypto) |
| Replay, duplicates, idempotent answers, expiry, revocation, 5-device cap, view/control levels, rate limits | `remote-host.ts` | `remote-host.test.ts` |
| What a phone may ask, schema per action, protected files, one-use small-file approvals, `needs-desktop` for everything else | `remote-actions.ts` | `remote-actions.test.ts` |
| Quota backoff, snapshot throttling, stale timestamps | `remote-service.ts` | `remote-service.test.ts` |
| Account isolation, computer vs phone principals, lifetimes, field whitelists | `firestore.rules` | `e2e/rules.spec.ts` (emulator) |
| The real flow, link to evidence, revocation | all of it | `e2e/phone.spec.ts` (emulator, real companion, fake agent script) |
| The phone page, PWA files, service-worker privacy | `mobile.tsx`, `sw.js` | `e2e/phone-shell.spec.ts`, `packages/remote/test/sw.test.ts` |

## What the phone may do

Read: projects, snapshots (progress, phases, activity tail, receipts, usage, suggestions), Markdown/text files that are not protected, diffs, handoffs, agents, models.
Control (only for phones approved to control): start a run or a phase, stop a run, pause/resume/skip a phase, continue a bounded number of phases, loop a phase until its checks pass (max 5 rounds), run a phase's checks, create and accept handoffs, decline any approval, and approve **one file write for ten minutes**.
Never from a phone: approve pushes, deployments, deletions, credentials, policy, team or goal changes, or approve the plan. These return `needs-desktop`.

## Offline and stale

The phone shows the last permitted snapshot with its age. When the computer has not been seen for three minutes it says so, says nothing is live, and disables every control. It does not queue commands.

## Abuse controls

Per-phone rate limits (60 reads and 12 controls per minute), request lifetime at most 10 minutes (rules and host), envelope size caps, a five-phone cap, daily-quota backoff that pauses publishing and says so, and optional Firebase App Check on the phone and link pages (reCAPTCHA v3, `APPCHECK_SITE_KEY`). **App Check does not protect the computer's own connection**: the Node client cannot mint reCAPTCHA tokens, so enforcing App Check on Firestore would stop the computer. Keep Firestore enforcement off (or monitor-only) for this link; the signed and sealed payloads, the rules and the rate limits are what protect it. Authentication enforcement is fine.

## Verification status

See `docs/STATE.md` for the dated results. Emulator results are never production results; real Firebase remains owner-activated (docs/accounts-setup.md). Emulated device profiles (Pixel, iPhone) are not physical phones; a physical-device pass is recorded separately and is NOT DONE unless marked otherwise there.
