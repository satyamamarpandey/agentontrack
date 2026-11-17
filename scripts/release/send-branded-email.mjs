// Sends the branded verification email, with an action link generated on THIS computer by the Identity Toolkit admin endpoint, using the
// project owner's Firebase CLI login. Nothing is stored; the link and its code are never printed or logged. The Admin credential stays on
// the owner's computer: it is never in GitHub Pages, the browser bundle, or the repository.
//
//   node scripts/release/send-branded-email.mjs preview                         writes a preview with a fake link to .local/email-preview/
//   node scripts/release/send-branded-email.mjs send --project <id> --to <address> [--name "Ada"] [--provider resend|brevo]
//
// Sending needs an owner-approved transactional provider and a sending domain with SPF, DKIM and DMARC (docs/early-access/EMAIL_SETUP.md):
//   AOT_MAIL_PROVIDER   resend | brevo (or --provider)
//   AOT_MAIL_API_KEY    the provider's API key, in this shell only
//   AOT_MAIL_FROM       a verified sender, for example "AgentOnTrack <access@your-domain>"
// Without all three, `send` stops before generating any link. The account must already exist (the invited person created it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderVerification } from './email-render.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const cmd = argv[0];

if (cmd === 'preview') {
  const project = 'agentontrack-early-access';
  const r = renderVerification({ displayName: 'Ada', verifyUrl: `https://${project}.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=PREVIEW-NOT-A-REAL-CODE`, project });
  const dir = join('.local', 'email-preview'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verification.html'), r.html); writeFileSync(join(dir, 'verification.txt'), r.text);
  console.log(`Subject: ${r.subject}\nWrote ${join(dir, 'verification.html')} and .txt (fake link).`);
  process.exit(0);
}
if (cmd !== 'send') { console.error('Usage: send-branded-email.mjs preview | send --project <id> --to <address> [--name <name>] [--provider resend|brevo]'); process.exit(2); }

const project = opt('--project'); const to = opt('--to'); const name = opt('--name', '');
const provider = opt('--provider', process.env.AOT_MAIL_PROVIDER); const apiKey = process.env.AOT_MAIL_API_KEY; const from = process.env.AOT_MAIL_FROM;
if (!project || !to || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) { console.error('Give --project and a plain --to address.'); process.exit(2); }
if (!['resend', 'brevo'].includes(provider ?? '') || !apiKey || !from) {
  console.error('Not sending: set AOT_MAIL_PROVIDER (resend or brevo), AOT_MAIL_API_KEY and AOT_MAIL_FROM first. This is an owner step; see docs/early-access/EMAIL_SETUP.md.');
  process.exit(3);
}

async function accessToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(store)) throw new Error('No Firebase CLI login found.');
  const refresh = JSON.parse(readFileSync(store, 'utf8')).tokens?.refresh_token;
  if (!refresh) throw new Error('The Firebase CLI is not logged in.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Could not get an access token (${r.status}).`);
  return (await r.json()).access_token;
}

// 1. The link, generated server side. Only the email address goes in; the response is used in memory and never printed.
const token = await accessToken();
const gen = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:sendOobCode`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ requestType: 'VERIFY_EMAIL', email: to, returnOobLink: true }),
});
if (!gen.ok) { console.error(`Could not generate the link (${gen.status}). The account may not exist yet.`); process.exit(4); }
const link = (await gen.json()).oobLink;
const mail = renderVerification({ displayName: name, verifyUrl: link, project });

// 2. The send. Plain and HTML parts, no tracking.
const send = provider === 'resend'
  ? await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject: mail.subject, html: mail.html, text: mail.text }) })
  : await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ sender: { email: from.replace(/^.*<|>$/g, ''), name: 'AgentOnTrack' }, to: [{ email: to }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text }) });
if (!send.ok) { console.error(`The provider refused the message (${send.status}).`); process.exit(5); }
console.log(`Sent "${mail.subject}" to ${to.replace(/^(.).*(@.*)$/, '$1***$2')} through ${provider}. Check Inbox and Spam, then open the link.`);
