# Accounts and early access: what has to be switched on

Accounts are optional for the program and off in any build of the site without a Firebase config. With a config, the site has sign-in, an early-access application form, an invitation-only membership, an administrator's review page, tester feedback, and the optional cloud features (saved summaries, the phone link, anonymous usage counts). All of it is enforced by `firestore.rules`; there is no server of ours. The code passes against the Firebase **emulators** in CI (`accounts`, `early-access-emulator`, `rules`, `phone` and `phone-new-session` specs). **That is not production**: the status of the real project is recorded below and in the launch report.

## Status

| Part | Status |
|---|---|
| Sign-in (Google, email and password; GitHub behind `NEXT_PUBLIC_AUTH_PROVIDERS`), reset, sign-out, export, delete | Written. Tested against the emulators in CI |
| Early access: application form and popup, per-address de-duplication, invitation-only membership, administrator review page, revocation, audit log, tester feedback | Written. Tested against the emulators in CI (`e2e/early-access-emulator.spec.ts`) |
| Per-user Firestore rules, membership gate on every account feature, create-only usage counts | Written. Tested against the emulators |
| A real Firebase project | **Done 2026-11-10:** `agentontrack-early-access`, Firestore in `nam5`, rules deployed, web app registered, by `scripts/release/firebase-provision.mjs` from the owner's CLI login (see docs/early-access/ADMIN_RUNBOOK.md) |
| Authentication on that project | Needs the console's "Get started" once; then the script enables email and password and the authorized domains. Google sign-in needs the console's two clicks |
| A real Google sign-in on the live site | **NOT TESTED** until the owner enables Google in the console and tries it |
| App Check | Code present, **off** until a reCAPTCHA key is set. Enforcement is switched on by the owner |

## Steps

1. **Log the Firebase CLI in, as the owner** (once, in your own browser): `pnpm dlx firebase-tools@15 login`.
2. **Provision**: `node scripts/release/firebase-provision.mjs --project <id>` creates the free project, a web app, the Firestore database, deploys the rules, enables email-and-password sign-in, adds the site's domain to the authorized domains, and writes the public web config to `.local/firebase-web-config.json`. Idempotent. It tells you if a step needs the console (Authentication "Get started", or enabling Google, whose OAuth consent screen cannot be created by an API).
3. **Repository variable** on the public repository (Settings → Variables, or `gh variable set`): `FIREBASE_WEB_CONFIG` set to the config as one line of JSON. It is public identifiers, not a secret. Then export and push `main`; the pages workflow builds the site with accounts on.
4. **Make yourself the administrator**: sign in once on the live site, copy the **Account id** from the account page, and add a document with that id to the `admins` collection (console, or with owner credentials). See `docs/early-access/ADMIN_RUNBOOK.md`.
5. **Installs**: while `NEXT_PUBLIC_INSTALL_PUBLIC` is unset, the install page and the site's dashboard connection step are for active members. Set it to `1` in the pages workflow to open them to everyone.
6. **App Check (recommended later)**: register the web app with reCAPTCHA v3, set the variable `APPCHECK_SITE_KEY` to the **site key**, re-run Pages, watch the metrics, then switch enforcement on for Authentication, and for Firestore only if nobody uses the phone link (the computer cannot produce App Check tokens).
7. **Try it for real** with a controlled application: apply, approve, invite, use the invitation, install, connect, revoke. Only then is this PASS; record the result in the launch report.

## What is stored, and never stored

Under a person's own account: name and email, theme, feedback sent while signed in, project summaries they chose to save (counts only). Early access: the application's answers (keyed by the hash of the address), invitations as hashes with address and expiry, membership records, tester feedback, and the administrator's audit log. Anonymous feedback is stored without a link to anyone. Usage counts, if opted in, hold a random install id, a week, agent program names and four counts.

Never stored or sent: code, prompts, file paths, commands, goals, conversations, provider logins or tokens, invitation tokens (only their hashes). No GitHub token is read.

## Cost

Spark limits apply. If a limit is reached the site keeps working and accounts stop, because nothing else depends on them.

## Phone remote control: extra owner steps

Needed only for the phone link (see docs/workspace/PHONE.md). The link is for active members.

1. **Email/Password sign-in** must be on (the provisioning script enables it): the link makes one limited account per linked computer (`computer-<id>@agentontrack.invalid`) with a random password the computer stores in its own 0600 file. These accounts are not people and are not members; the person's own computer document admits them.
2. **Deploy `firestore.rules`** (`firebase deploy --only firestore:rules --project <your project>`).
3. **Time-to-live (optional, recommended):** in Firestore, add a TTL policy on the field `expireAt` for the collection group `responses`.
4. **App Check:** do not enforce it on Firestore for this feature.
5. **Verify with disposable accounts** first: link a computer, connect a phone from a different network, send a prompt, revoke the phone, and unlink. Until then the phone link is verified only against the emulators.
