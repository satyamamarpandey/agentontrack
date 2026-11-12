# Early access: the three Firebase emails

Firebase Authentication sends three messages for AgentOnTrack: confirm an address, reset a password, and "your sign-in email was changed". Early access only sends the first one in normal use (an invited tester confirms their address on the join page).

## What is verified and what is not (2026-11-12)

- **Delivery is real.** The live join page asked the live project to send a confirmation to a plus-address of the owner's Gmail; it arrived in the inbox at 19:24, the link opened, the account became confirmed, a token issued after the click carries `email_verified`, and the used link, a damaged link and a replay were all refused. Record: `.local/live-walkthrough/email-result.json` (not committed; it holds an address).
- **The API cannot change the text.** `PATCH identitytoolkit.googleapis.com/admin/v2/projects/<id>/config?updateMask=notification.sendEmail.verifyEmailTemplate` answers `400 EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED` on this project (Spark plan, no Identity Platform upgrade). So the text is changed in the console, by hand. No paid upgrade is needed or suggested.
- **The sender address cannot be changed without a domain.** It stays `noreply@agentontrack-early-access.firebaseapp.com`. A custom From address needs DNS records for a domain you own (Authentication, Templates, "Customize domain") and has not been set up. The sender *name* can be changed.
- **What the stock email got wrong:** the sign-off and subject used `%APP_NAME%`, which Firebase filled with `project-331870830044`; a long bare link; no explanation. The values below write the product name in, so they do not depend on that setting.
- **Rich layout (buttons, logo) is not claimed.** The console editor is for the message text and basic markup. The values below use only paragraphs and one link, which is what Firebase's own default uses.

## Owner steps (about five minutes, console only)

Open https://console.firebase.google.com/project/agentontrack-early-access/authentication/emails

For each of the three templates, press the pencil, then set exactly the values printed by:

```
node scripts/release/firebase-email-templates.mjs fields
```

In short, for every template: **Sender name** `AgentOnTrack`; **Reply to** leave `noreply` (it is a no-reply address; people reach you through the feedback page); **Subject** and **Message** as printed. Save each one.

Also check **Project settings, General, Public-facing name**: it should read `AgentOnTrack` (it is what Google's sign-in screen shows). The API reports the project's display name as `AgentOnTrack`; the public-facing name is a separate field the API does not expose to this account.

Then confirm what Firebase actually holds:

```
node scripts/release/firebase-email-templates.mjs check --project agentontrack-early-access
```

Every line should say `ok`. Then send a real message and read it (nothing is stored but a disposable account, removed by the second command):

```
node scripts/release/live-email-delivery.mjs send   --project agentontrack-early-access --inbox <you>@gmail.com
# open the email, press the link
node scripts/release/live-email-delivery.mjs finish --project agentontrack-early-access
```

The scripts never print or store the link or its code. If you paste the link to `finish --link`, it only uses it to try replay and damage in memory.

## Links that were already used or have expired

- A link works once. Opening it again, or after Firebase's expiry window, shows Firebase's own "link expired or already used" page; the join page's "Send confirmation email" button sends a new one. The scripts check the used and damaged cases against the live API; an *expired* link cannot be produced on demand, so that case is covered by the same refusal path and is not separately timed.
- `finish` no longer fails when the link was clicked before it ran: whether the address was confirmed at send time is read from what the send phase recorded.
