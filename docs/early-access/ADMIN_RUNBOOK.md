# Early access: the administrator's runbook

For the owner. How applications arrive, how to invite someone, how to take access away, and what to do when the review page itself is not available.

## Where things are

| What | Where |
|---|---|
| Review page | `https://pandeysatyam.com/agentontrack/admin/` (signed in as the administrator account) |
| The raw data | Firebase console → Firestore → collections `applications`, `invites`, `members`, `admins`, `audit`, `testerFeedback` |
| The rules that enforce all of it | `firestore.rules` in this repository, deployed with `firebase deploy --only firestore:rules` |
| Who is the administrator | Every document id in the `admins` collection is an account id (uid) that administers. Nothing in a browser can write that collection. |

## The flow, in order

1. **Someone applies.** The form on the home page (popup after about five seconds, the Early access button, or `/early-access/`) writes one document to `applications`, keyed by the SHA-256 of their lower-cased email, with `status: pending`. One per address: a second attempt for the same address is refused by the rules.
2. **You review.** On the review page, filter by operating system, agent tool and status, open a row, read the answers, add a private note. **Approve** or **Reject**. Both are written to `audit`.
3. **You invite.** In the drawer, choose how long the link should live (7, 14 or 30 days) and press **Create invitation link**. The link appears once. Copy it and send it yourself, by email or chat, to the address on the application. Nothing is emailed by the site. The database holds only a hash of the link's code, the address, and the expiry. Pressing it again makes a new link and revokes the old one.
4. **They join.** The link opens `/join/`. They sign in or create an account **with the invited address**, confirm the address if it is an email-and-password account (Google addresses arrive confirmed), and the invitation is used: in one transaction it becomes `redeemed` and their `members/{uid}` record is created with `status: active`. Expired, revoked, used or misaddressed links fail every rule.
5. **They test.** Active members see the install steps, can connect their own computer from the site's dashboard, can save counts-only summaries and link a phone, and get the structured tester feedback form. Everything they report lands in `testerFeedback` and shows on the review page.
6. **You revoke, if needed.** Testers tab → **Revoke access**. Every rule that asks for an active member fails on their next request: the account page, the install steps, the public-site dashboard connection, summaries, the phone link, tester feedback. Their sign-in itself stays, so **Reinstate** brings everything back. (The local dashboard on their own machine is theirs: it never depended on the site.)

## What the review page shows

- Tiles: applications, pending, approved, rejected, invitations open, invitations used, active testers, access revoked.
- Applications: searchable, filterable, with invitation and access state per row; a drawer with the full application, notes and every action.
- Testers, Invitations, Tester feedback (with any diagnostics the tester chose to paste), Insights (operating systems, tools, use cases, frequency, funnel, feedback by kind, other tools named), Audit log.
- Export: CSV and JSON of the applications, downloaded to your computer. Each export is written to the audit log.

## Recovery: when the review page is not available

The page is a client of the rules; nothing depends on it. The Firebase console does everything it does, more slowly:

- **Approve or invite by hand:** you cannot mint a link in the console (the token never exists server-side). Use the review page for links. If the page is down, fix the deploy first; the data is untouched.
- **Revoke by hand:** Firestore → `members` → the person's document → set `status` to `revoked`. Takes effect on their next request.
- **Make an administrator by hand (or recover your own access):** Firestore → `admins` → add a document whose **id is the uid** of the account (the account page shows "Account id"; the Authentication tab shows it too). That is the only way an administrator is ever created.
- **Lock everything:** Firestore → Rules → publish a rules file that denies all client access. Deploying the repository's rules again reopens it.
- **Delete someone's data on request:** delete their `applications/{hash}` document (the hash is the SHA-256 of their lower-cased address; the review page shows the reference, which is its first six characters), their `members/{uid}` document, their `users/{uid}` tree, their `testerFeedback` documents, and the account in Authentication. Deleting the membership document is not how access is removed: use Revoke access on the review page, which the audit log records. (The rules refuse a membership created from an invitation redeemed earlier, so a deleted membership cannot be re-created from the old link.)

## What is **not** automated, on purpose

- No email is sent by the system. You send invitations personally. This keeps the setup free and keeps every message in your own hands.
- No automatic approval. A submitted form never grants anything.
- No App Check unless you register a reCAPTCHA key (see `docs/accounts-setup.md`). Until then, the only spam protection is the rules' shape check and the one-per-address rule; junk applications can be deleted from the review page.

## Facts about the live deployment

| Fact | Value |
|---|---|
| Firebase project | `agentontrack-early-access` (project number 331870830044), display name AgentOnTrack, Spark plan, no billing account, owned by the owner's Google account |
| Provisioned | 2026-11-10 by `scripts/release/firebase-provision.mjs` from the owner's CLI login: Firestore database `(default)` in `nam5`, `firestore.rules` deployed, web app registered. Google Analytics was enabled by mistake in the console; the site never loads the Analytics SDK, so it collects nothing |
| Web config | `.local/firebase-web-config.json` locally; repository variable `FIREBASE_WEB_CONFIG` on `satyamamarpandey/agentontrack` (public identifiers, not secrets) |
| Sign-in methods | Recorded in the launch report once Authentication is initialised in the console (email and password through the script; Google needs the console's two clicks) |
| App Check | Off (no reCAPTCHA key registered) |
| Administrator | The owner's account id, added to `admins` after the first sign-in on the live site; recorded in the launch report |
