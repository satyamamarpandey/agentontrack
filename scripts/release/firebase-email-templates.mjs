// What AgentOnTrack's three Firebase Authentication emails should say, and a check of what the live project actually sends.
// The Identity Toolkit admin API REFUSES template writes on this project (400 EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED, tested 2026-11-12, Spark plan, no Identity Platform
// upgrade), so the values are entered by the owner in the Firebase console (docs/early-access/EMAIL_SETUP.md) and this script only READS the live project.
// Only plain structure is used (paragraphs, one link, strong): what the console editor is documented to accept, nothing the API or mail clients may strip.
//   node scripts/release/firebase-email-templates.mjs fields                 prints the exact values to type into the console
//   node scripts/release/firebase-email-templates.mjs check --project <id>   reads the live project and reports each field as matching or not
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SENDER_NAME = 'AgentOnTrack';
export const PUBLIC_NAME = 'AgentOnTrack';
export const TEMPLATES = {
  verifyEmailTemplate: {
    console: 'Email address verification',
    subject: 'Confirm your email for AgentOnTrack early access',
    body: `<p>Hello %DISPLAY_NAME%,</p>
<p>Thanks for creating your AgentOnTrack account. Please confirm that this email address is yours so you can finish joining the early-access programme.</p>
<p><a href='%LINK%'>Confirm my email address</a></p>
<p>The link works once. If it has expired, open the join page again and press "Send confirmation email" for a new one.</p>
<p>If you did not create an AgentOnTrack account, ignore this message. Nothing happens unless the link is opened.</p>
<p>Thanks,</p>
<p>The AgentOnTrack team</p>`,
  },
  resetPasswordTemplate: {
    console: 'Password reset',
    subject: 'Reset your AgentOnTrack password',
    body: `<p>Hello,</p>
<p>We received a request to reset the password for the AgentOnTrack account %EMAIL%.</p>
<p><a href='%LINK%'>Choose a new password</a></p>
<p>The link works once. Your current password stays valid until you set a new one.</p>
<p>If you did not ask for this, ignore this message and your password will not change.</p>
<p>Thanks,</p>
<p>The AgentOnTrack team</p>`,
  },
  changeEmailTemplate: {
    console: 'Email address change',
    subject: 'Your AgentOnTrack sign-in email was changed',
    body: `<p>Hello %DISPLAY_NAME%,</p>
<p>The sign-in email for your AgentOnTrack account was changed to %NEW_EMAIL%.</p>
<p>If you did not make this change, <a href='%LINK%'>use this link to undo it</a>.</p>
<p>If you made the change yourself, there is nothing more to do.</p>
<p>Thanks,</p>
<p>The AgentOnTrack team</p>`,
  },
};

const mode = process.argv[2];
const argv = process.argv.slice(3);
if (import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  if (mode === 'fields') {
    console.log(`Project settings -> General -> Public-facing name: ${PUBLIC_NAME}\n`);
    for (const t of Object.values(TEMPLATES)) console.log(`== Authentication -> Templates -> ${t.console}\nSender name: ${SENDER_NAME}\nReply to: noreply (leave)\nSubject: ${t.subject}\nMessage:\n${t.body}\n`);
  } else if (mode === 'check') {
    const i = argv.indexOf('--project'); const PROJECT = i >= 0 ? argv[i + 1] : undefined;
    if (!PROJECT) { console.error('Usage: firebase-email-templates.mjs check --project <id>'); process.exit(2); }
    const refresh = JSON.parse(readFileSync(join(homedir(), '.config', 'configstore', 'firebase-tools.json'), 'utf8')).tokens?.refresh_token;
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' }) });
    const H = { authorization: `Bearer ${(await tr.json()).access_token}`, 'x-goog-user-project': PROJECT };
    const cfg = await (await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`, { headers: H })).json();
    const proj = await (await fetch(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`, { headers: H })).json();
    const live = cfg.notification?.sendEmail ?? {};
    let bad = 0;
    const row = (name, got, want) => { const ok = got === want; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'TODO'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  (should be ${JSON.stringify(want)})`}`); };
    row('Google project display name (informational; the emails below do not depend on it)', proj.displayName, PUBLIC_NAME);
    for (const [k, t] of Object.entries(TEMPLATES)) {
      row(`${t.console}: sender name`, live[k]?.senderDisplayName ?? '(not set)', SENDER_NAME);
      row(`${t.console}: subject`, live[k]?.subject, t.subject);
      row(`${t.console}: message`, (live[k]?.body ?? '').replace(/\r/g, '').trim(), t.body);
    }
    console.log(`${bad} field(s) still to enter in the console. From address: ${live.verifyEmailTemplate?.senderLocalPart ?? 'noreply'}@${PROJECT}.firebaseapp.com (a custom address needs your own domain's DNS and is not set up). Reply-to: ${live.verifyEmailTemplate?.replyTo ?? '(none)'}`);
    process.exit(bad ? 1 : 0);
  } else { console.error('Usage: firebase-email-templates.mjs fields | check --project <id>'); process.exit(2); }
}
