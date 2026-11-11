// The early-access flow on the LIVE site with an ADMINISTRATOR working through the real review page, and disposable accounts using their own tokens.
//   apply -> review -> approve -> invite -> join -> gated install -> revoke -> reinstate -> export -> leave (account deletion), with isolation and
//   administrator-record checks on the way. Production only: no emulator. The previous 113-check run (live-walkthrough-early-access.mjs) is not repeated;
//   this one adds what it could not do, because it had no administrator.
//
// The owner's own Google account cannot be driven from a script, so a DISPOSABLE administrator is made for the run: a password account created through
// the public endpoint, listed in admins/ with the owner's credential, and removed again at the end. That is the only administrator record this script
// writes, and it says so in its record. It never touches the owner's own admins/ document.
//
//   PLAYWRIGHT_BROWSERS_PATH=.pw-browsers node scripts/release/live-admin-walkthrough.mjs --project agentontrack-early-access \
//     [--site https://pandeysatyam.com/agentontrack] [--out benchmarks/results/live-admin-2026-11-11.json] [--owner-uid <uid>]
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PROJECT = opt('--project');
const SITE = opt('--site', 'https://pandeysatyam.com/agentontrack').replace(/\/$/, '');
const OUT = opt('--out', join('.local', 'live-walkthrough', 'admin-result.json'));
const OWNER_UID = opt('--owner-uid', null);
if (!PROJECT) { console.error('Usage: live-admin-walkthrough.mjs --project <id> [--site <url>] [--out <file>] [--owner-uid <uid>]'); process.exit(2); }
const KEY = JSON.parse(readFileSync(join('.local', 'firebase-web-config.json'), 'utf8')).apiKey;
const ORIGIN = new URL(SITE).origin;
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const DOCS = `https://firestore.googleapis.com/v1/${DB}`;
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stamp = Date.now().toString(36);
const ADMIN_EMAIL = `aot-walk-admin-${stamp}@example.com`;
const A = `aot-walk-a-${stamp}@example.com`;
const B = `aot-walk-b-${stamp}@example.com`;
const A_ID = sha(A);
const pw = () => randomBytes(18).toString('base64url') + 'aA1!';
const PW = { [ADMIN_EMAIL]: pw(), [A]: pw(), [B]: pw() };

const started = new Date(); const checks = []; const notes = [];
const log = (m) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${m}`);
const check = (phase, name, got, want, via = 'rules') => { const pass = Array.isArray(want) ? want.includes(got) : got === want; checks.push({ phase, name, via, want, got, pass }); log(`${pass ? 'ok  ' : 'FAIL'} [${phase}] ${name}: ${JSON.stringify(got)}${pass ? '' : ` (wanted ${JSON.stringify(want)})`}`); return pass; };
const ui = async (phase, name, fn) => { try { await fn(); checks.push({ phase, name, via: 'live site', want: 'shown', got: 'shown', pass: true }); log(`ok   [${phase}] ${name}`); return true; } catch (e) { const msg = String(e?.message ?? e).split('\n')[0].slice(0, 240); checks.push({ phase, name, via: 'live site', want: 'shown', got: msg, pass: false }); log(`FAIL [${phase}] ${name}: ${msg}`); return false; } };

/* ---- owner credential: read back, verification links, the disposable administrator, clean-up ---- */
async function ownerToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(store)) throw new Error('No Firebase CLI login found.');
  const refresh = JSON.parse(readFileSync(store, 'utf8')).tokens?.refresh_token;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return (await r.json()).access_token;
}
const OWNER = await ownerToken();
const owner = async (url, init = {}) => { const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json', 'x-goog-user-project': PROJECT, ...init.headers } }); const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: r.status, data }; };
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: fieldsOf(v) } };
const fieldsOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(dec) : 'mapValue' in v ? plain(v.mapValue.fields) : v;
const plain = (f) => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, dec(v)]));
const oGet = async (p) => { const r = await owner(`${DOCS}/${p}`); if (r.status === 404) return null; if (r.status !== 200) throw new Error(`owner read ${p}: ${r.status}`); return plain(r.data.fields); };
const oList = async (c) => { const r = await owner(`${DOCS}/${c}?pageSize=300`); if (r.status !== 200) throw new Error(`owner list ${c}: ${r.status}`); return (r.data.documents ?? []).map((d) => ({ id: d.name.split('/').pop(), path: d.name.split('/documents/')[1], data: plain(d.fields) })); };
const oSet = async (p, o) => { const r = await owner(`${DOCS}/${p}`, { method: 'PATCH', body: JSON.stringify({ fields: fieldsOf(o) }) }); if (r.status !== 200) throw new Error(`owner write ${p}: ${r.status}`); };
const oDel = async (p) => (await owner(`${DOCS}/${p}`, { method: 'DELETE' })).status;
const accounts = async () => { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:query`, { method: 'POST', body: JSON.stringify({ returnUserInfo: true, limit: 500 }) }); if (r.status !== 200) throw new Error(`accounts ${r.status}`); return r.data.userInfo ?? []; };
const lookup = async (uid) => (await owner(`${IDT}/projects/${PROJECT}/accounts:lookup`, { method: 'POST', body: JSON.stringify({ localId: [uid] }) })).data.users?.[0] ?? null;
const verificationLink = async (email) => { for (let i = 0; ; i++) { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:sendOobCode`, { method: 'POST', body: JSON.stringify({ requestType: 'VERIFY_EMAIL', email, returnOobLink: true, continueUrl: `${SITE}/join/` }) }); if (r.status === 200 && r.data.oobLink) return r.data.oobLink; if (i >= 9 || !JSON.stringify(r.data).includes('TOO_MANY_ATTEMPTS')) throw new Error(`verification link ${r.status}`); log('verification link: asked to wait; retrying in 20 s'); await new Promise((ok) => setTimeout(ok, 20_000)); } };
const snapshot = async () => ({ accounts: (await accounts()).length, ...Object.fromEntries(await Promise.all(['applications', 'invites', 'members', 'admins', 'audit', 'testerFeedback', 'users', 'feedback'].map(async (c) => [c, (await oList(c)).length]))) });

/* ---- what a browser has ---- */
const pub = { 'content-type': 'application/json', referer: `${ORIGIN}/` };
const asUser = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) });
const signUp = async (email) => { const r = await fetch(`${IDT}/accounts:signUp?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ email, password: PW[email], returnSecureToken: true }) }); const b = await r.json(); if (r.status !== 200) throw new Error(`sign up ${b.error?.message}`); return { idToken: b.idToken, uid: b.localId }; };
const signIn = async (email) => { const r = await fetch(`${IDT}/accounts:signInWithPassword?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ email, password: PW[email], returnSecureToken: true }) }); const b = await r.json(); if (r.status !== 200) throw new Error(`sign in ${b.error?.message}`); return { idToken: b.idToken, uid: b.localId }; };
const applyCode = async (link) => (await fetch(`${IDT}/accounts:update?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ oobCode: new URL(link).searchParams.get('oobCode') }) })).status;
const get = async (t, p) => (await fetch(`${DOCS}/${p}`, { headers: asUser(t) })).status;
const del = async (t, p) => (await fetch(`${DOCS}/${p}`, { method: 'DELETE', headers: asUser(t) })).status;
const commit = async (t, p, data, st = [], mask) => (await fetch(`${DOCS}:commit`, { method: 'POST', headers: asUser(t), body: JSON.stringify({ writes: [{ update: { name: `${DB}/${p}`, fields: fieldsOf(data) }, ...(mask ? { updateMask: { fieldPaths: mask } } : {}), updateTransforms: st.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }] }) })).status;

const made = { uids: new Set(), docs: new Set() };
const record = { site: SITE, project: PROJECT, started: started.toISOString(), disposableAdministrator: 'a password account created for this run, listed in admins/ with the owner credential, removed at the end; the owner\'s own admins/ document is only read', checks, notes, findings: [] };
let browser;
try {
  record.baseline = await snapshot();
  record.administratorsAtStart = (await oList('admins')).map((d) => d.id);
  log(`baseline ${JSON.stringify(record.baseline)}; administrators at start: ${record.administratorsAtStart.length}`);
  if (OWNER_UID) {
    const o = await lookup(OWNER_UID);
    check('owner', 'the owner\'s Authentication record: Google provider, confirmed address', o ? `${(o.providerUserInfo ?? []).map((p) => p.providerId).join('+')}/${!!o.emailVerified}` : 'missing', 'google.com/true', 'owner read');
    check('owner', 'admins/<owner uid> exists, written by the provisioning script', !!(await oGet(`admins/${OWNER_UID}`)), true, 'owner read');
    check('owner', 'the owner\'s administrator document is the only one at the start', record.administratorsAtStart.join(','), OWNER_UID, 'owner read');
  }

  /* ===== administrator records cannot be made, changed, read or impersonated from a browser ===== */
  const adm = await signUp(ADMIN_EMAIL); made.uids.add(adm.uid);
  check('admin-records', 'the disposable administrator\'s confirmation code is accepted by the live project', await applyCode(await verificationLink(ADMIN_EMAIL)), 200, 'public endpoint');
  let admToken = (await signIn(ADMIN_EMAIL)).idToken;
  check('admin-records', 'before being listed: the account cannot list applications', await get(admToken, 'applications'), 403);
  check('admin-records', 'before being listed: the account cannot make itself an administrator', await commit(admToken, `admins/${adm.uid}`, { note: 'me' }, ['addedAt']), 403);
  made.docs.add(`admins/${adm.uid}`);
  await oSet(`admins/${adm.uid}`, { addedAt: new Date(), note: 'DISPOSABLE test administrator for the live walk-through; removed at the end of the run' });
  admToken = (await signIn(ADMIN_EMAIL)).idToken;
  check('admin-records', 'listed: the account can list applications', await get(admToken, 'applications'), 200);
  check('admin-records', 'listed: can read its own administrator record', await get(admToken, `admins/${adm.uid}`), 200);
  check('admin-records', 'even an administrator cannot create another administrator from a browser', await commit(admToken, `admins/someone-else`, { note: 'x' }, ['addedAt']), 403);
  check('admin-records', 'even an administrator cannot change an administrator record', await commit(admToken, `admins/${adm.uid}`, { note: 'changed' }, [], ['note']), 403);
  check('admin-records', 'even an administrator cannot delete an administrator record', await del(admToken, `admins/${adm.uid}`), 403);
  check('admin-records', 'an administrator cannot list the administrators', await get(admToken, 'admins'), 403);
  if (OWNER_UID) check('admin-records', 'an administrator cannot read the owner\'s administrator record', await get(admToken, `admins/${OWNER_UID}`), 403);
  check('admin-records', 'an administrator cannot write an audit entry in another person\'s name', await commit(admToken, 'audit/forged', { action: 'approve', target: 'application:x', by: 'someone-else' }, ['at']), 403);
  const stranger = await signUp(B); made.uids.add(stranger.uid);
  check('admin-records', 'an ordinary account cannot create an administrator record', await commit(stranger.idToken, `admins/${stranger.uid}`, { note: 'me' }, ['addedAt']), 403);
  check('admin-records', 'an ordinary account cannot create one for the disposable administrator\'s uid', await commit(stranger.idToken, `admins/${adm.uid}`, { note: 'me' }, ['addedAt']), 403);
  check('admin-records', 'an ordinary account cannot read the administrator record of another account', await get(stranger.idToken, `admins/${adm.uid}`), 403);
  if (OWNER_UID) { check('admin-records', 'an ordinary account cannot read the owner\'s administrator record', await get(stranger.idToken, `admins/${OWNER_UID}`), 403); check('admin-records', 'no sign-in: cannot read the owner\'s administrator record', await get(null, `admins/${OWNER_UID}`), 403); }
  check('admin-records', 'an ordinary account cannot delete an administrator record', await del(stranger.idToken, `admins/${adm.uid}`), 403);

  browser = await chromium.launch();
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const p = await c.newPage(); return { c, p }; };
  const { p: pAdmin } = await mk(); const { p: pApp } = await mk();
  const SHOTS = join('.local', 'live-walkthrough', 'shots-admin'); mkdirSync(SHOTS, { recursive: true });
  const shot = (p, n) => p.screenshot({ path: join(SHOTS, `${n}.png`) }).catch(() => undefined);

  /* ===== apply (a visitor), then the administrator signs in and reviews ===== */
  made.docs.add(`applications/${A_ID}`);
  await ui('apply', 'a visitor applies through the live form', async () => {
    await pApp.goto(`${SITE}/early-access/`, { waitUntil: 'load' });
    await pApp.getByLabel('Full name').fill('Walk Applicant');
    await pApp.getByLabel('Email address').fill(A);
    await pApp.getByTestId('ea-next').click();
    await pApp.getByLabel('Windows', { exact: true }).check();
    await pApp.getByLabel('Claude Code', { exact: true }).check();
    await pApp.getByLabel('How frequently do you use AI coding agents?').selectOption('daily');
    await pApp.getByTestId('ea-next').click();
    await pApp.getByLabel('Monitoring agent executions').check();
    await pApp.getByLabel('What is your biggest challenge when managing AI agents?').fill('Knowing what actually ran');
    await pApp.getByLabel(/I have read the privacy notice/).check();
    await pApp.getByTestId('ea-submit').click();
    await expect(pApp.getByTestId('early-access-sent')).toBeVisible({ timeout: 40_000 });
  });
  await ui('review', 'a signed-out visitor sees no review page', async () => { const { p } = await mk(); await p.goto(`${SITE}/admin/`, { waitUntil: 'load' }); await expect(p.getByTestId('admin')).toHaveCount(0); });
  await ui('review', 'the administrator signs in with email on the live sign-in page and lands on the review page, which recognises the account', async () => {
    await pAdmin.goto(`${SITE}/sign-in/?next=admin`, { waitUntil: 'load' });
    await pAdmin.getByLabel('Email', { exact: true }).fill(ADMIN_EMAIL);
    await pAdmin.getByLabel('Password', { exact: true }).fill(PW[ADMIN_EMAIL]);
    await pAdmin.getByTestId('email-submit').click();
    await pAdmin.waitForURL(/\/admin\//, { timeout: 40_000 });
    await expect(pAdmin.getByTestId('admin')).toBeVisible({ timeout: 40_000 });
    await expect(pAdmin.getByTestId('admin-denied')).toHaveCount(0);
  });
  await ui('review', 'the header of a signed-in browser offers Account, not Sign in', async () => {
    await expect(pAdmin.getByTestId('nav-signin')).toHaveCount(0, { timeout: 10_000 });
    await expect(pAdmin.getByTestId('nav-account-action')).toBeVisible();
  });
  await ui('review', 'the tiles agree with the database and the filters find the application', async () => {
    const all = await oList('applications');
    await expect(pAdmin.getByTestId('admin-stats').locator('[data-stat="Applications"]')).toHaveText(String(all.length));
    await pAdmin.getByTestId('filter-os').selectOption('windows');
    await pAdmin.getByTestId('filter-tool').selectOption('claude-code');
    await expect(pAdmin.getByTestId('application-row').filter({ hasText: 'Walk Applicant' })).toHaveCount(1);
  });
  const drawer = pAdmin.getByTestId('application-drawer');
  await ui('approve', 'open the application, read the answers, approve it, add a private note', async () => {
    await pAdmin.getByTestId('application-row').filter({ hasText: 'Walk Applicant' }).click();
    await expect(drawer).toContainText('Knowing what actually ran');
    await drawer.getByTestId('approve').click();
    await expect(drawer.locator('.badge', { hasText: /^approved$/ })).toBeVisible({ timeout: 30_000 });
    await drawer.getByTestId('admin-notes').fill('Live walk-through note.');
    await drawer.getByTestId('save-notes').click();
    await shot(pAdmin, 'review-drawer');
  });
  check('approve', 'the stored application is approved, reviewed by the administrator\'s uid, with the note', (await oGet(`applications/${A_ID}`)) ? (({ status, reviewedBy, notes: n }) => `${status}/${reviewedBy === adm.uid}/${n}`)(await oGet(`applications/${A_ID}`)) : 'missing', 'approved/true/Live walk-through note.', 'owner read');
  let inviteLink = ''; let inviteHash = '';
  await ui('invite', 'create an invitation link on the review page; it is shown once', async () => {
    await drawer.getByTestId('create-invite').click();
    const box = pAdmin.getByTestId('invite-link');
    await expect(box).toBeVisible({ timeout: 30_000 });
    inviteLink = await box.inputValue();
    expect(inviteLink).toMatch(/\/join\/#t=[A-Za-z0-9_-]{40,}$/);
    inviteHash = sha(inviteLink.split('#t=')[1]);
    await pAdmin.getByRole('button', { name: 'Done' }).click();
  });
  const inv = inviteHash ? await oGet(`invites/${inviteHash}`) : null;
  if (inviteHash) made.docs.add(`invites/${inviteHash}`);
  check('invite', 'the invitation is stored by its hash, addressed to the applicant, open, created by the administrator, expiring in the future', inv ? `${inv.status}/${inv.email === A}/${inv.createdBy === adm.uid}/${Date.parse(inv.expiresAt) > Date.now()}` : 'missing', 'sent/true/true/true', 'owner read');
  check('invite', 'the token is nowhere in the database', JSON.stringify(await oList('invites')).includes(inviteLink.split('#t=')[1] ?? 'x'), false, 'owner read');

  /* ===== join (the applicant, with their own account), gated install ===== */
  const aRec = { uid: null };
  await ui('join', 'the applicant opens the link, creates the account with the invited address', async () => {
    await pApp.goto(inviteLink, { waitUntil: 'load' });
    await expect(pApp.getByTestId('signed-out')).toBeVisible({ timeout: 20_000 });
    const form = pApp.getByTestId('email-form');
    await form.locator('input[name="name"]').fill('Walk Applicant');
    await form.locator('input[name="email"]').fill(A);
    await form.locator('input[name="password"]').fill(PW[A]);
    await pApp.getByTestId('email-submit').click();
    await expect(pApp.getByTestId('join-verify')).toBeVisible({ timeout: 40_000 });
  });
  const a0 = await signIn(A); aRec.uid = a0.uid; made.uids.add(a0.uid); made.docs.add(`members/${a0.uid}`); made.docs.add(`users/${a0.uid}`);
  check('join', 'before confirming the address the invitation cannot be redeemed', await commit(a0.idToken, `invites/${inviteHash}`, { status: 'redeemed', redeemedBy: a0.uid }, ['redeemedAt'], ['status', 'redeemedBy', 'redeemedAt']), 403);
  await ui('join', 'the page sends the confirmation email through the live project', async () => { await pApp.getByTestId('send-verification').click(); await expect(pApp.getByRole('status')).toContainText('Sent', { timeout: 30_000 }); });
  check('join', 'the address is confirmed with the link Firebase would email (generated here: example.com has no inbox; real delivery is tested separately)', await applyCode(await verificationLink(A)), 200, 'public endpoint');
  await ui('join', 'after confirming, the invitation is used and the page says "You are in"', async () => { await pApp.getByTestId('verified-continue').click(); await expect(pApp.getByTestId('join-done')).toBeVisible({ timeout: 60_000 }); });
  const mem = await oGet(`members/${a0.uid}`);
  check('join', 'the membership is active and names this invitation', mem ? `${mem.status}/${mem.inviteId === inviteHash}` : 'missing', 'active/true', 'owner read');
  await ui('gated-install', 'the install steps and the command are shown to the new tester', async () => { await pApp.goto(`${SITE}/install/`, { waitUntil: 'load' }); await expect(pApp.getByTestId('install-steps')).toBeVisible({ timeout: 30_000 }); await expect(pApp.locator('main')).toContainText('curl -fsSL'); });
  await ui('tester', 'the tester sends feedback, and the administrator sees it on the review page', async () => {
    await pApp.goto(`${SITE}/feedback/`, { waitUntil: 'load' });
    const f = pApp.getByTestId('tester-feedback-form');
    await expect(f).toBeVisible({ timeout: 30_000 });
    await f.getByLabel('Connector compatibility').check();
    await f.getByLabel('Your message').fill('Admin walk-through: a report to be seen on the review page.');
    await f.getByRole('button', { name: 'Send feedback' }).click();
    await expect(pApp.getByTestId('feedback-sent')).toBeVisible({ timeout: 30_000 });
    await pAdmin.goto(`${SITE}/admin/`, { waitUntil: 'load' });
    await pAdmin.getByRole('tab', { name: /Tester feedback|Feedback/ }).click();
    await expect(pAdmin.getByTestId('tester-feedback')).toContainText('Admin walk-through', { timeout: 30_000 });
  });
  const tokenBefore = (await signIn(A)).idToken; // issued while the membership is active
  check('isolation', 'the tester cannot reach the review data', [await get(tokenBefore, 'applications'), await get(tokenBefore, 'audit'), await get(tokenBefore, 'members'), await get(tokenBefore, 'invites')].join(','), '403,403,403,403');
  check('isolation', 'the stranger cannot read the tester\'s account, membership or application', [await get(stranger.idToken, `users/${a0.uid}`), await get(stranger.idToken, `members/${a0.uid}`), await get(stranger.idToken, `applications/${A_ID}`)].join(','), '403,403,403');

  /* ===== revoke, reinstate, export, audit: all from the review page ===== */
  await ui('revoke', 'the administrator revokes the tester from the Testers tab', async () => {
    await pAdmin.goto(`${SITE}/admin/`, { waitUntil: 'load' });
    await pAdmin.getByRole('tab', { name: 'Testers' }).click();
    const row = pAdmin.getByTestId('member-row').filter({ hasText: A });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByTestId('revoke-member').click();
    await pAdmin.getByTestId('confirm-yes').click();
    await expect(row.locator('.badge', { hasText: 'revoked' })).toBeVisible({ timeout: 30_000 });
  });
  await ui('revoke', 'the tester is refused on the next page load: install, dashboard and account', async () => {
    await pApp.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pApp.getByTestId('install-not-approved')).toContainText('not an approved tester any more', { timeout: 30_000 });
    await pApp.goto(`${SITE}/dashboard/`, { waitUntil: 'load' });
    await expect(pApp.getByTestId('gate-revoked')).toBeVisible({ timeout: 30_000 });
    await pApp.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pApp.getByTestId('access-status')).toContainText('Access revoked', { timeout: 30_000 });
  });
  check('revoke', 'the token issued before the revocation is refused at once for the account tree and tester feedback', [await get(tokenBefore, `users/${a0.uid}`), await commit(tokenBefore, 'testerFeedback/late', { kind: 'bug', message: 'x', uid: a0.uid }, ['createdAt'])].join(','), '403,403');
  await ui('reinstate', 'the administrator reinstates the tester; the install steps are back', async () => {
    const row = pAdmin.getByTestId('member-row').filter({ hasText: A });
    await row.getByTestId('reinstate-member').click();
    await expect(row.locator('.badge', { hasText: 'active' })).toBeVisible({ timeout: 30_000 });
    await pApp.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pApp.getByTestId('install-steps')).toBeVisible({ timeout: 30_000 });
  });
  await ui('export', 'the administrator exports the applications as JSON from the review page', async () => {
    await pAdmin.getByRole('tab', { name: 'Applications' }).click();
    const [dl] = await Promise.all([pAdmin.waitForEvent('download'), pAdmin.getByRole('button', { name: 'JSON' }).click()]);
    const rows = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    expect(rows.some((r) => r.email === A)).toBe(true);
    expect(rows.length).toBe((await oList('applications')).length);
  });
  const auditActions = []; for (let i = 0; i < 15; i++) { const a = (await oList('audit')).filter((x) => x.data.by === adm.uid).map((x) => x.data.action); auditActions.splice(0, auditActions.length, ...a); if (a.includes('export')) break; await new Promise((ok) => setTimeout(ok, 1000)); }
  for (const x of (await oList('audit')).filter((x) => x.data.by === adm.uid)) made.docs.add(x.path);
  check('audit', 'the audit log holds approve, note, invite, revoke-member, reinstate and export, each by the administrator\'s uid', ['approve', 'note', 'invite', 'revoke-member', 'reinstate', 'export'].every((x) => auditActions.includes(x)), true, 'owner read');
  check('audit', 'no audit entry can be changed or removed by the administrator from a browser', [await commit(admToken, `audit/${(await oList('audit'))[0]?.id ?? 'x'}`, { note: 'edited' }, [], ['note']), await del(admToken, `audit/${(await oList('audit'))[0]?.id ?? 'x'}`)].join(','), '403,403');

  /* ===== leaving: the account page deletes everything this person left, and old tokens stop at once ===== */
  const fbBefore = (await oList('testerFeedback')).filter((f) => f.data.uid === a0.uid).length;
  const tokenLive = (await signIn(A)).idToken;
  await ui('leave', 'the tester deletes the account and its data from the account page', async () => {
    await pApp.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pApp.getByTestId('delete-account')).toBeEnabled({ timeout: 30_000 });
    await pApp.getByTestId('delete-account').click();
    await pApp.locator('input[name="delete-password"]').fill(PW[A]);
    await pApp.getByTestId('delete-confirm').click();
    await expect(pApp.getByTestId('signed-out')).toBeVisible({ timeout: 60_000 });
  });
  check('leave', 'the tester had at least one report to remove', fbBefore >= 1, true, 'owner read');
  const gone = { membership: await oGet(`members/${a0.uid}`), account: await oGet(`users/${a0.uid}`), invitation: await oGet(`invites/${inviteHash}`), application: await oGet(`applications/${A_ID}`), reports: (await oList('testerFeedback')).filter((f) => f.data.uid === a0.uid).length };
  check('leave', 'membership, account document, redeemed invitation, application and tester reports are all gone', JSON.stringify([gone.membership, gone.account, gone.invitation, gone.application, gone.reports]), JSON.stringify([null, null, null, null, 0]), 'owner read');
  check('leave', 'the sign-in is gone from Authentication', !!(await lookup(a0.uid)), false, 'owner read');
  check('leave', 'a token issued before the deletion no longer reaches member data (account tree, tester feedback, a new membership)', [await get(tokenLive, `users/${a0.uid}`), await commit(tokenLive, 'testerFeedback/after-deletion', { kind: 'bug', message: 'after', uid: a0.uid }, ['createdAt']), await commit(tokenLive, `members/${a0.uid}`, { email: A, inviteId: inviteHash, applicationId: A_ID, status: 'active' }, ['joinedAt'])].join(','), '403,403,403');
  made.docs.add('testerFeedback/after-deletion');
  check('leave', 'the redeemed invitation cannot bring the membership back (it is deleted, and a redemption needs the same batch)', await commit(tokenLive, `invites/${inviteHash}`, { status: 'redeemed', redeemedBy: a0.uid }, ['redeemedAt'], ['status', 'redeemedBy', 'redeemedAt']), [403, 404]);
} catch (e) {
  checks.push({ phase: 'run', name: 'the walk-through ran to its end', via: 'script', want: 'completed', got: String(e?.stack ?? e).slice(0, 600), pass: false });
  log(`ABORTED: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  await browser?.close().catch(() => undefined);
  const cleanup = { accountsDeleted: 0, documentsDeleted: 0, problems: [] };
  try {
    for (const uid of made.uids) { made.docs.add(`users/${uid}`); made.docs.add(`members/${uid}`); for (const f of (await oList('testerFeedback')).filter((x) => x.data.uid === uid)) made.docs.add(f.path); }
    made.docs.add(`applications/${sha(B)}`);
    for (const p of made.docs) if (await oGet(p).catch(() => null)) { const s = await oDel(p); if (s === 200) cleanup.documentsDeleted++; else cleanup.problems.push(`${p}: ${s}`); }
    for (const uid of made.uids) if (await lookup(uid)) { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:delete`, { method: 'POST', body: JSON.stringify({ localId: uid }) }); if (r.status === 200) cleanup.accountsDeleted++; else cleanup.problems.push(`account ${uid}: ${r.status}`); }
    record.final = await snapshot();
    record.administratorsAtEnd = (await oList('admins')).map((d) => d.id);
    check('cleanup', 'the disposable administrator is gone: the administrators are exactly those at the start', JSON.stringify(record.administratorsAtEnd), JSON.stringify(record.administratorsAtStart), 'owner read');
    check('cleanup', 'every collection is back to what it held before the run', JSON.stringify({ ...record.final, audit: undefined }), JSON.stringify({ ...record.baseline, audit: undefined }), 'owner read');
  } catch (e) { cleanup.problems.push(String(e?.message ?? e).slice(0, 300)); }
  record.cleanup = cleanup; record.finished = new Date().toISOString();
  const failed = checks.filter((c) => !c.pass);
  record.summary = { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, byPhase: Object.fromEntries([...new Set(checks.map((c) => c.phase))].map((p) => [p, `${checks.filter((c) => c.phase === p && c.pass).length}/${checks.filter((c) => c.phase === p).length}`])) };
  mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(record, null, 2));
  log(`\n${record.summary.passed}/${record.summary.checks} checks passed; record ${OUT}; cleanup ${JSON.stringify(cleanup)}`);
  for (const f of failed) log(`  failed: [${f.phase}] ${f.name}: ${JSON.stringify(f.got).slice(0, 220)}`);
  process.exit(failed.length || cleanup.problems.length ? 1 : 0);
}
