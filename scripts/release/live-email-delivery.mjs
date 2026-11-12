// Genuine verification-email delivery, on the LIVE site and LIVE Firebase project, to an inbox the owner controls (a plus-address of their own Gmail).
// Two phases, because a person has to open the message:
//   send    creates a disposable account through the live join page's own form and presses its own "Send confirmation email" button, so Firebase
//           sends the real message. No admin-generated link, no owner credential in the sending path. Writes a small state file under .local/.
//   finish  after the person clicked the link (optionally pasting it with --link): reads verification status three ways, replays the used link and a
//           damaged one, checks what a confirmed but un-invited account may and may not do, then removes every trace.
//   node scripts/release/live-email-delivery.mjs send   --project <id> --inbox <local-part@gmail.com> [--site <url>]
//   node scripts/release/live-email-delivery.mjs finish --project <id> [--link '<the link from the email>'] [--out <file>]
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';

const argv = process.argv.slice(2);
const MODE = argv[0];
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PROJECT = opt('--project');
const SITE = opt('--site', 'https://pandeysatyam.com/agentontrack').replace(/\/$/, '');
const STATE = join('.local', 'live-walkthrough', 'email-test.json');
const OUT = opt('--out', join('.local', 'live-walkthrough', 'email-result.json'));
if (!['send', 'finish'].includes(MODE) || !PROJECT) { console.error('Usage: live-email-delivery.mjs send|finish --project <id> ...'); process.exit(2); }
const KEY = JSON.parse(readFileSync(join('.local', 'firebase-web-config.json'), 'utf8')).apiKey;
const ORIGIN = new URL(SITE).origin;
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const pub = { 'content-type': 'application/json', referer: `${ORIGIN}/` };
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

async function ownerToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  const refresh = JSON.parse(readFileSync(store, 'utf8')).tokens?.refresh_token;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return (await r.json()).access_token;
}
const OWNER = await ownerToken();
const owner = async (url, init = {}) => { const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json', 'x-goog-user-project': PROJECT, ...init.headers } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };
const lookup = async (uid) => (await owner(`${IDT}/projects/${PROJECT}/accounts:lookup`, { method: 'POST', body: JSON.stringify({ localId: [uid] }) })).data.users?.[0] ?? null;
const signIn = async (email, password) => { const r = await fetch(`${IDT}/accounts:signInWithPassword?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ email, password, returnSecureToken: true }) }); const b = await r.json(); if (r.status !== 200) throw new Error(`sign in ${b.error?.message}`); return { idToken: b.idToken, uid: b.localId }; };
const status = async (t, p) => (await fetch(`${DOCS}/${p}`, { headers: { authorization: `Bearer ${t}` } })).status;

if (MODE === 'send') {
  const inbox = opt('--inbox');
  if (!inbox || !/^[^@+\s]+@gmail\.com$/.test(inbox)) { console.error('--inbox must be the owner\'s own Gmail address (local-part@gmail.com); a plus-tag is added here.'); process.exit(2); }
  const stamp = Date.now().toString(36);
  const email = inbox.replace('@', `+aotmail${stamp}@`);
  const password = randomBytes(18).toString('base64url') + 'aA1!';
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    // The page asks for an invitation code in its address; any non-empty code opens the account steps. It is never redeemed here.
    await page.goto(`${SITE}/join/#t=${randomBytes(32).toString('base64url')}`, { waitUntil: 'load' });
    await expect(page.getByTestId('signed-out')).toBeVisible({ timeout: 20_000 });
    const form = page.getByTestId('email-form');
    await form.locator('input[name="name"]').fill('Mail Delivery Test');
    await form.locator('input[name="email"]').fill(email);
    await form.locator('input[name="password"]').fill(password);
    await page.getByTestId('email-submit').click();
    await expect(page.getByTestId('join-verify')).toBeVisible({ timeout: 40_000 });
    const before = await page.getByTestId('join-verify').innerText();
    await page.getByTestId('send-verification').click();
    await expect(page.getByRole('status')).toContainText('Sent', { timeout: 30_000 });
    const sentAt = new Date().toISOString();
    const { uid } = await signIn(email, password);
    const u = await lookup(uid);
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify({ email, uid, password, sentAt, site: SITE, page: before.replace(/\s+/g, ' ').slice(0, 200), verifiedAtSend: !!u?.emailVerified }, null, 2));
    log(`account ${uid} created through the live join page for ${email}`);
    log(`the page's own button sent the confirmation email at ${sentAt}; verified now: ${!!u?.emailVerified}`);
  } finally { await browser.close(); }
  process.exit(0);
}

/* ---------------- finish ---------------- */
if (!existsSync(STATE)) { console.error('No state file: run the send phase first.'); process.exit(2); }
const st = JSON.parse(readFileSync(STATE, 'utf8'));
let skipCleanup = false;
const checks = []; const record = { site: st.site, inboxAddress: st.email, uid: st.uid, sentAt: st.sentAt, checks, notes: [] };
const check = (name, got, want, via) => { const pass = Array.isArray(want) ? want.includes(got) : got === want; checks.push({ name, via, want, got, pass }); log(`${pass ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${pass ? '' : ` (wanted ${JSON.stringify(want)})`}`); };
try {
  const u = await lookup(st.uid);
  if (!u) throw new Error('the account is gone');
  // Whether the address was already confirmed when this phase began is a fact about the person's timing, not a defect: the send phase recorded
  // that it was NOT confirmed at send time (verifiedAtSend), and a person who clicked before running finish makes this true. Note it, never fail on it.
  record.verifiedBeforeFinish = !!u.emailVerified;
  record.verifiedAtSend = st.verifiedAtSend;
  check('the address was not confirmed when the message was sent (so the link, not the sign-up, did it)', !!st.verifiedAtSend, false, 'send phase record');
  // Phase "finish" is run after the person clicked; if the status is still false, say so and stop: nothing was confirmed.
  if (!u.emailVerified) { skipCleanup = true; log('The link has not been used yet: nothing was changed or removed. Click the link in the email, then run finish again.'); }
  else {
    record.verifiedAt = u.lastRefreshAt ?? null;
    const t = await signIn(st.email, st.password);
    // The account's own token: does it carry the confirmation? Firebase puts email_verified in the token; the rules read it.
    const claims = JSON.parse(Buffer.from(t.idToken.split('.')[1], 'base64url').toString());
    check('a token issued after the click carries email_verified = true', claims.email_verified, true, 'the account\'s own token');
    check('the provider is password and the address is the plus-address', `${claims.firebase?.sign_in_provider}/${claims.email === st.email.toLowerCase()}`, 'password/true', 'the account\'s own token');
    // A confirmed address is still only a person: nothing restricted opens.
    check('confirmed but not invited: cannot list applications', await status(t.idToken, 'applications'), 403, 'rules');
    check('confirmed but not invited: cannot list invitations', await status(t.idToken, 'invites'), 403, 'rules');
    check('confirmed but not invited: cannot read an account document', await status(t.idToken, `users/${t.uid}`), 403, 'rules');
    check('confirmed but not invited: cannot read the administrator records', await status(t.idToken, 'admins'), 403, 'rules');
    check('confirmed but not invited: own administrator record is absent', await status(t.idToken, `admins/${t.uid}`), 404, 'rules');
    const link = opt('--link');
    if (link) {
      const code = new URL(link).searchParams.get('oobCode');
      record.linkHost = new URL(link).host; record.linkMode = new URL(link).searchParams.get('mode'); { const c = new URL(link).searchParams.get('continueUrl'); record.continueUrl = c ? new URL(c).origin + new URL(c).pathname : null; }
      const replay = await fetch(`${IDT}/accounts:update?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ oobCode: code }) });
      const rb = await replay.json();
      check('replaying the same link after it was used is refused', `${replay.status}/${rb.error?.message}`, ['400/INVALID_OOB_CODE', '400/EXPIRED_OOB_CODE'], 'public endpoint');
      const damaged = await fetch(`${IDT}/accounts:update?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ oobCode: code.slice(0, -4) + 'AAAA' }) });
      check('a damaged code is refused', `${damaged.status}/${(await damaged.json()).error?.message}`, '400/INVALID_OOB_CODE', 'public endpoint');
      const info = await fetch(`${IDT}/accounts:resetPassword?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ oobCode: code }) });
      check('a used code cannot be looked up either', `${info.status}`, '400', 'public endpoint');
    } else record.notes.push('No link was supplied, so replay of the used link was not tested.');
  }
} catch (e) { checks.push({ name: 'finish ran to its end', pass: false, got: String(e?.message ?? e) }); log(`ABORTED: ${e?.message ?? e}`); }
finally {
  if (skipCleanup) process.exit(3);
  const cleanup = { accountDeleted: false, problems: [] };
  try {
    const r = await owner(`${IDT}/projects/${PROJECT}/accounts:delete`, { method: 'POST', body: JSON.stringify({ localId: st.uid }) });
    cleanup.accountDeleted = r.status === 200;
    if (r.status !== 200) cleanup.problems.push(`delete ${r.status}`);
    for (const c of ['users', 'members', 'applications', 'invites', 'testerFeedback']) { const l = await owner(`${DOCS}/${c}?pageSize=50`); for (const d of l.data.documents ?? []) { const s = JSON.stringify(d.fields); if (s.includes(st.uid) || s.includes(st.email)) { await owner(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE' }); cleanup.problems.push(`removed ${d.name.split('/documents/')[1]}`); } } }
    const left = (await owner(`${IDT}/projects/${PROJECT}/accounts:query`, { method: 'POST', body: JSON.stringify({ returnUserInfo: true, limit: 100 }) })).data.userInfo ?? [];
    check('the disposable account is gone and only the owner\'s account remains', `${left.length}/${left.some((x) => x.localId === st.uid)}`, '1/false', 'owner read');
    rmSync(STATE, { force: true });
  } catch (e) { cleanup.problems.push(String(e?.message ?? e)); }
  record.cleanup = cleanup;
  const failed = checks.filter((c) => !c.pass);
  record.summary = { checks: checks.length, passed: checks.length - failed.length, failed: failed.length };
  mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(record, null, 2));
  log(`${record.summary.passed}/${record.summary.checks} checks passed; record ${OUT}; cleanup ${JSON.stringify(cleanup)}`);
  process.exit(failed.length ? 1 : 0);
}
