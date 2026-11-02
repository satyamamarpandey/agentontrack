# Accounts: what the owner has to switch on

Accounts are optional, and off in any build without a Firebase config. The code for Google, GitHub and email sign-in, password reset, export, deletion and optional usage counts is in the repository and passes against the Firebase **emulators** in CI. **That is not production.** Nothing here is working for real visitors until the owner has done the steps below, and until a real sign-in has been tried on the live site.

## Status

| Part | Status |
|---|---|
| Sign-in code for Google, GitHub and email, reset, sign-out, export, delete | Written. Tested against the Auth and Firestore emulators in CI |
| Per-user Firestore rules, and create-only usage counts | Written. Tested against the emulator |
| A real Firebase project | **Owner action, not done** |
| A real Google or GitHub sign-in on the live site | **NOT TESTED** |
| App Check | Code present, **off** until a key is set. Enforcement is switched on by the owner |

## Steps (owner only)

1. **Create a Firebase project** (the free Spark plan is enough) and register a web app. Copy its web config: `apiKey`, `authDomain`, `projectId`, `appId`. These are public identifiers, not secrets.
2. **Authentication:** enable Google, GitHub and Email/Password. For GitHub, create an OAuth app at GitHub, set its callback to the URL Firebase shows, and paste the client id and secret into Firebase (the secret goes only into Firebase). Turn on email enumeration protection, and add `pandeysatyam.com` (and any dedicated hostname) to Authorized domains.
3. **Firestore:** create the database in production mode, then deploy `firestore.rules` from this repository.
4. **Repository variables** (public repo, Settings, Variables): `FIREBASE_WEB_CONFIG` set to the config as one line of JSON. Re-run the Pages workflow.
5. **App Check (recommended):** register the web app with reCAPTCHA v3, set the variable `APPCHECK_SITE_KEY` to the **site key** (public), re-run Pages, watch the App Check metrics for a few days, then switch enforcement on for Authentication in the console, and for Firestore too only if you do not use the phone link (the computer cannot produce App Check tokens; see "Phone remote control" below). Feedback and usage counts are the calls an anonymous visitor can make, so they are the ones to protect.
6. **Try it for real:** sign in with Google, with GitHub and with an email, send feedback, export, then delete, on the live site. Only then is this PASS.

## What is stored, and never stored

Stored, under the person's own user id: name and email, theme, feedback they sent while signed in, project summaries they chose to save (counts only). Anonymous feedback is stored without a link to anyone. Usage counts, if a person opts in, hold a random install id, a week, agent program names and four counts.

Never stored or sent: code, prompts, file paths, commands, goals, conversations, provider logins or tokens. No GitHub token is read: sign-in keeps only the name and email, and importing a repository uses your own git setup on your own computer.

## Cost

Spark limits apply. If a limit is reached the site keeps working and accounts stop, because nothing else depends on them.

## Phone remote control: extra owner steps

These are needed only if you want the phone link (see docs/workspace/PHONE.md). Everything below is done in the Firebase console or with the Firebase CLI; nothing here can be done by the code.

1. **Enable the Email/Password sign-in provider.** The phone link makes one limited account per linked computer (`computer-<id>@agentontrack.invalid`) with a random password the computer stores in its own 0600 file. These accounts are not for people.
2. **Deploy `firestore.rules`** (`firebase deploy --only firestore:rules --project <your project>`). Without the new rules the link cannot work, and with the old rules it is closed by default.
3. **Time-to-live (optional, recommended):** in Firestore, add a TTL policy on the field `expireAt` for the collection groups `responses`. Requests, snapshots and presence are small and replaced; responses are deleted by the phone after reading, and TTL cleans the rest.
4. **App Check:** set `APPCHECK_SITE_KEY` (already covered above) so the phone and link pages attach tokens. **Do not enforce App Check on Firestore** for this feature: the computer is a Node program that cannot produce reCAPTCHA tokens. Enforcing it on Authentication is fine.
5. **Authorized domains:** the Pages host must be listed under Authentication, Settings, Authorized domains.
6. **Verify with disposable accounts** in a disposable project first: link a computer, connect a phone from a different network, send a prompt, revoke the phone, and unlink. Record the result in docs/STATE.md. Until then the phone link is verified only against the emulators.
