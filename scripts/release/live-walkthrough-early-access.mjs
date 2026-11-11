// Early access on the LIVE site and the LIVE Firebase project, with disposable accounts: apply, invitation, join, the gated pages, revocation,
// isolation between accounts, export and deletion, and dead invitations. Nothing here uses the emulators. Every refusal is a real request the
// production rules answered; every page is the deployed one.
//
// Two kinds of credential are used, and the record says which one each step used:
//   visitor / disposable accounts   the public web key and the accounts' own sign-ins: exactly what a browser has. The rules decide.
//   owner (Firebase CLI login)      only to read back what was stored, to make a verification link without waiting for an inbox, to stand in
//                                   for the administrator where --admin-standin is given, and to remove what this run created.
// It never makes an administrator, never prints a token or a password, and deletes only the accounts and documents it created itself.
//
//   PLAYWRIGHT_BROWSERS_PATH=.pw-browsers node scripts/release/live-walkthrough-early-access.mjs --project agentontrack-early-access --admin-standin \
//     [--site https://pandeysatyam.com/agentontrack] [--out benchmarks/results/live-early-access-<date>.json] [--no-companion]
//
// --admin-standin: approve, invite, revoke and reinstate are written with the owner's credential instead of from the review page. That proves the
// tester's side and the rules; it does NOT prove the review page or the rules' administrator branch, which need the administrator's own sign-in.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);
const PROJECT = opt('--project');
const SITE = opt('--site', 'https://pandeysatyam.com/agentontrack').replace(/\/$/, '');
const OUT = opt('--out', join('.local', 'live-walkthrough', 'result.json'));
const SHOTS = join('.local', 'live-walkthrough', 'shots');
if (!PROJECT || !flag('--admin-standin')) { console.error('Usage: live-walkthrough-early-access.mjs --project <id> --admin-standin [--site <url>] [--out <file>] [--no-companion]'); process.exit(2); }
const KEY = JSON.parse(readFileSync(join('.local', 'firebase-web-config.json'), 'utf8')).apiKey;
const ORIGIN = new URL(SITE).origin;
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const DOCS = `https://firestore.googleapis.com/v1/${DB}`;
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const stamp = Date.now().toString(36);
const A = `aot-walk-a-${stamp}@example.com`; // the applicant who is invited
const B = `aot-walk-b-${stamp}@example.com`; // a stranger with an account
const A_ID = sha(A); const B_ID = sha(B);
const secret = () => randomBytes(18).toString('base64url') + 'aA1!'; // held in memory only
const PW = { [A]: secret(), [B]: secret() };

/* ---------------- record ---------------- */
const started = new Date();
const checks = [];
const notes = [];
const log = (m) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${m}`);
const check = (phase, name, got, want, via = 'rules') => { const pass = Array.isArray(want) ? want.includes(got) : got === want; checks.push({ phase, name, via, want, got, pass }); log(`${pass ? 'ok  ' : 'FAIL'} [${phase}] ${name}: ${JSON.stringify(got)}${pass ? '' : ` (wanted ${JSON.stringify(want)})`}`); return pass; };
const ui = async (phase, name, fn) => { try { await fn(); checks.push({ phase, name, via: 'live site', want: 'shown', got: 'shown', pass: true }); log(`ok   [${phase}] ${name}`); return true; } catch (e) { const msg = String(e?.message ?? e).split('\n')[0].slice(0, 240); checks.push({ phase, name, via: 'live site', want: 'shown', got: msg, pass: false }); log(`FAIL [${phase}] ${name}: ${msg}`); return false; } };

/* ---------------- owner credential (reads back, verification links, stand-in, clean-up) ---------------- */
async function ownerToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(store)) throw new Error('No Firebase CLI login found. Run: pnpm dlx firebase-tools@15 login');
  const refresh = JSON.parse(readFileSync(store, 'utf8')).tokens?.refresh_token;
  if (!refresh) throw new Error('The Firebase CLI is not logged in.');
  // The CLI's public OAuth client, embedded in every copy of firebase-tools; not a secret of this project.
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Could not get an access token from the CLI login (${r.status}).`);
  return (await r.json()).access_token;
}
const OWNER = await ownerToken();
const owner = async (url, init = {}) => {
  const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json', 'x-goog-user-project': PROJECT, ...init.headers } });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: fieldsOf(v) } };
const fieldsOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(dec) : 'mapValue' in v ? plain(v.mapValue.fields) : v;
const plain = (fields) => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, dec(v)]));
const oGet = async (path) => { const r = await owner(`${DOCS}/${path}`); if (r.status === 404) return null; if (r.status !== 200) throw new Error(`owner read ${path}: ${r.status}`); return plain(r.data.fields); };
const oList = async (coll) => { const r = await owner(`${DOCS}/${coll}?pageSize=200`); if (r.status !== 200) throw new Error(`owner list ${coll}: ${r.status}`); return (r.data.documents ?? []).map((d) => ({ id: d.name.split('/').pop(), path: d.name.split('/documents/')[1], data: plain(d.fields) })); };
const oSet = async (path, obj) => { const r = await owner(`${DOCS}/${path}`, { method: 'PATCH', body: JSON.stringify({ fields: fieldsOf(obj) }) }); if (r.status !== 200) throw new Error(`owner write ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); };
const oPatch = async (path, obj) => { const q = Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&'); const r = await owner(`${DOCS}/${path}?${q}`, { method: 'PATCH', body: JSON.stringify({ fields: fieldsOf(obj) }) }); if (r.status !== 200) throw new Error(`owner update ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); };
const oDel = async (path) => (await owner(`${DOCS}/${path}`, { method: 'DELETE' })).status;
const accounts = async () => { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:query`, { method: 'POST', body: JSON.stringify({ returnUserInfo: true, limit: 500 }) }); if (r.status !== 200) throw new Error(`accounts query: ${r.status}`); return r.data.userInfo ?? []; };
const accountExists = async (uid) => { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:lookup`, { method: 'POST', body: JSON.stringify({ localId: [uid] }) }); return (r.data.users ?? []).length > 0; };
const accountVerified = async (uid) => { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:lookup`, { method: 'POST', body: JSON.stringify({ localId: [uid] }) }); return !!r.data.users?.[0]?.emailVerified; };
/** The link Firebase would email, made without sending anything; following it is the same act as clicking it in an inbox. */
const verificationLink = async (email) => {
  // Firebase allows one verification message per address in a short window; right after the page's own "send" the answer is TOO_MANY_ATTEMPTS, so wait it out.
  for (let i = 0; ; i++) {
    const r = await owner(`${IDT}/projects/${PROJECT}/accounts:sendOobCode`, { method: 'POST', body: JSON.stringify({ requestType: 'VERIFY_EMAIL', email, returnOobLink: true, continueUrl: `${SITE}/join/` }) });
    if (r.status === 200 && r.data.oobLink) return r.data.oobLink;
    if (i >= 9 || !JSON.stringify(r.data).includes('TOO_MANY_ATTEMPTS')) throw new Error(`verification link: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    log(`verification link: asked to wait (attempt ${i + 1}); retrying in 20 s`);
    await new Promise((ok) => setTimeout(ok, 20_000));
  }
};

/* ---------------- what a browser has: the public key, an account's own token, and the rules ---------------- */
const pub = { 'content-type': 'application/json', referer: `${ORIGIN}/` };
const asUser = (token) => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });
const signUp = async (email) => { const r = await fetch(`${IDT}/accounts:signUp?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ email, password: PW[email], returnSecureToken: true }) }); const b = await r.json(); if (r.status !== 200) throw new Error(`sign up: ${r.status} ${b.error?.message}`); return { idToken: b.idToken, uid: b.localId }; };
const signIn = async (email) => { const r = await fetch(`${IDT}/accounts:signInWithPassword?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ email, password: PW[email], returnSecureToken: true }) }); const b = await r.json(); if (r.status !== 200) throw new Error(`sign in: ${r.status} ${b.error?.message}`); return { idToken: b.idToken, uid: b.localId }; };
const applyCode = async (link) => (await fetch(`${IDT}/accounts:update?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ oobCode: new URL(link).searchParams.get('oobCode') }) })).status;
const get = async (token, path) => (await fetch(`${DOCS}/${path}`, { headers: asUser(token) })).status;
const del = async (token, path) => (await fetch(`${DOCS}/${path}`, { method: 'DELETE', headers: asUser(token) })).status;
const commit = async (token, path, data, serverTime = [], mask) => (await fetch(`${DOCS}:commit`, { method: 'POST', headers: asUser(token), body: JSON.stringify({ writes: [{ update: { name: `${DB}/${path}`, fields: fieldsOf(data) }, ...(mask ? { updateMask: { fieldPaths: mask } } : {}), updateTransforms: serverTime.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }] }) })).status;
const application = (email, over = {}) => ({ name: 'Walk Through', email, os: ['linux'], tools: ['codex'], useCases: ['other'], frequency: 'weekly', privacyAccepted: true, marketingConsent: false, source: 'page', status: 'pending', schema: 1, ...over });
const redeem = (token, hash, uid) => commit(token, `invites/${hash}`, { status: 'redeemed', redeemedBy: uid }, ['redeemedAt'], ['status', 'redeemedBy', 'redeemedAt']);
const counts = { inputTokens: 1, outputTokens: 1, sessions: 1, tasks: 1, tasksVerified: 1, actions: 1 };

/* ---------------- what this run created, so that only that is removed ---------------- */
const made = { uids: new Set(), docs: new Set() };
const record = { site: SITE, project: PROJECT, started: started.toISOString(), adminSteps: 'owner credential stand-in (the review page and the rules\' administrator branch are NOT exercised by this run)', accounts: { applicant: A, stranger: B }, uids: {}, baseline: null, rules: null, findings: [], checks, notes, cleanup: null, final: null };
const COLLECTIONS = ['applications', 'invites', 'members', 'admins', 'audit', 'testerFeedback', 'users', 'feedback'];
const snapshot = async () => ({ accounts: (await accounts()).length, ...Object.fromEntries(await Promise.all(COLLECTIONS.map(async (c) => [c, (await oList(c)).length]))) });

let browser; let companion = null; let tmp = null;
try {
  /* ===== 0. Before anything: what is there, and which rules are released ===== */
  record.baseline = await snapshot();
  log(`baseline ${JSON.stringify(record.baseline)}`);
  const release = await owner(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
  const ruleset = release.status === 200 ? await owner(`https://firebaserules.googleapis.com/v1/${release.data.rulesetName}`) : null;
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const deployed = ruleset?.data?.source?.files?.[0]?.content ?? '';
  const local = readFileSync('firestore.rules', 'utf8');
  record.rules = { release: release.data?.name ?? null, ruleset: release.data?.rulesetName?.split('/').pop() ?? null, releasedAt: release.data?.updateTime ?? null, deployedSha256: sha(norm(deployed)), repositorySha256: sha(norm(local)) };
  check('rules', 'the released ruleset is byte-for-byte the repository\'s firestore.rules', record.rules.deployedSha256 === record.rules.repositorySha256, true, 'owner read');
  record.administrators = (await oList('admins')).map((d) => d.id); // read, never written: this script makes no administrator

  browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pa = await ctxA.newPage(); const pb = await ctxB.newPage();
  const consoleErrors = [];
  for (const [who, p] of [['applicant', pa], ['stranger', pb]]) p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${who}: ${m.text().slice(0, 200)}`); });
  mkdirSync(SHOTS, { recursive: true });
  const shot = (p, name) => p.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => undefined);

  /* ===== 1. A visitor applies through the live form ===== */
  made.docs.add(`applications/${A_ID}`);
  await ui('apply', 'the live form stores the application and shows its reference', async () => {
    await pa.goto(`${SITE}/early-access/`, { waitUntil: 'load' });
    await pa.getByLabel('Full name').fill('Walk Through');
    await pa.getByLabel('Email address').fill(A.toUpperCase());
    await pa.getByTestId('ea-next').click();
    await pa.getByLabel('Windows', { exact: true }).check();
    await pa.getByLabel('Claude Code', { exact: true }).check();
    await pa.getByLabel('How frequently do you use AI coding agents?').selectOption('daily');
    await pa.getByTestId('ea-next').click();
    await pa.getByLabel('Monitoring agent executions').check();
    await pa.getByLabel(/I have read the privacy notice/).check();
    await pa.getByTestId('ea-submit').click();
    await expect(pa.getByTestId('early-access-sent')).toBeVisible({ timeout: 40_000 });
    await expect(pa.getByTestId('application-reference')).toHaveText(`AOT-${A_ID.slice(0, 6).toUpperCase()}`);
  });
  const stored = await oGet(`applications/${A_ID}`);
  check('apply', 'stored as pending, under the hash of the lower-cased address', stored ? `${stored.status}/${stored.email === A}/${stored.source}` : 'missing', 'pending/true/page', 'owner read');

  /* ===== 2. Before approval: nothing restricted is reachable, by anyone ===== */
  for (const c of ['applications', 'invites', 'members', 'admins', 'audit', 'testerFeedback', 'users', 'feedback']) check('outside', `no sign-in: list ${c}`, await get(null, c), 403);
  check('outside', 'no sign-in: read the application', await get(null, `applications/${A_ID}`), 403);
  check('outside', 'no sign-in: a second application for the same address', await commit(null, `applications/${A_ID}`, application(A), ['createdAt']), 403);
  check('outside', 'no sign-in: an application born approved', await commit(null, `applications/${sha('x' + B)}`, application('x' + B, { status: 'approved' }), ['createdAt']), 403);
  check('outside', 'no sign-in: an application with an extra field', await commit(null, `applications/${sha('x' + B)}`, application('x' + B, { code: 'rm -rf /' }), ['createdAt']), 403);
  check('outside', 'no sign-in: an id that is not the hash of the address', await commit(null, 'applications/wrong-id', application('x' + B), ['createdAt']), 403);
  check('outside', 'no sign-in: making an administrator', await commit(null, 'admins/someone', { note: 'me' }, ['addedAt']), 403);
  check('outside', 'no sign-in: making a membership', await commit(null, 'members/someone', { email: A, inviteId: 'x', applicationId: 'y', status: 'active' }, ['joinedAt']), 403);

  const b0 = await signUp(B); made.uids.add(b0.uid); record.uids.stranger = b0.uid;
  log(`stranger account ${b0.uid} (password sign-up through the public endpoint)`);
  check('outside', 'signed in, not confirmed: list applications', await get(b0.idToken, 'applications'), 403);
  check('outside', 'signed in: read someone else\'s application', await get(b0.idToken, `applications/${A_ID}`), 403);
  check('outside', 'signed in: approve someone', await commit(b0.idToken, `applications/${A_ID}`, { status: 'approved' }, [], ['status']), 403);
  check('outside', 'signed in: make oneself a member', await commit(b0.idToken, `members/${b0.uid}`, { email: B, inviteId: 'x', applicationId: 'y', status: 'active' }, ['joinedAt']), 403);
  check('outside', 'signed in: an account document without membership', await commit(b0.idToken, `users/${b0.uid}`, { profile: { name: 'S', email: B } }, ['updatedAt']), 403);
  check('outside', 'signed in: list invitations', await get(b0.idToken, 'invites'), 403);
  check('outside', 'signed in: make oneself the administrator', await commit(b0.idToken, `admins/${b0.uid}`, { note: 'me' }, ['addedAt']), 403);
  check('outside', 'signed in: read another account\'s administrator record', await get(b0.idToken, 'admins/someone-else'), 403);
  check('outside', 'signed in: one\'s own administrator record can be asked for, and is not there', await get(b0.idToken, `admins/${b0.uid}`), 404);
  check('outside', 'signed in: read the audit log', await get(b0.idToken, 'audit'), 403);
  await ui('outside', 'signed out, the install page shows the gate and no install command', async () => {
    await pb.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('install-gate')).toBeVisible({ timeout: 20_000 });
    await expect(pb.getByTestId('install-steps')).toHaveCount(0);
    await expect(pb.locator('main')).not.toContainText('curl -fsSL');
  });
  await ui('outside', 'signed out, the site\'s dashboard offers no connection step', async () => {
    await pb.goto(`${SITE}/dashboard/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('gate-signed-out')).toBeVisible({ timeout: 30_000 });
    await expect(pb.getByTestId('continue-local')).toHaveCount(0);
  });
  await ui('outside', 'signed out, the review page shows nothing', async () => {
    await pb.goto(`${SITE}/admin/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('admin')).toHaveCount(0);
    await expect(pb.getByTestId('application-row')).toHaveCount(0);
  });

  /* ===== 3. Review, approval and invitation: owner credential stand-in ===== */
  await oPatch(`applications/${A_ID}`, { status: 'approved', reviewedAt: new Date(), reviewedBy: 'owner-credential-walkthrough' });
  const token = randomBytes(32).toString('base64url'); // the same shape the review page makes: 32 random bytes, stored only as their hash
  const hash = sha(token);
  const inviteLink = `${SITE}/join/#t=${token}`;
  made.docs.add(`invites/${hash}`);
  await oSet(`invites/${hash}`, { email: A, applicationId: A_ID, status: 'sent', createdAt: new Date(), createdBy: 'owner-credential-walkthrough', expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  notes.push('Approve and invite were written with the owner credential (no administrator account exists in the project). The invitation document has the shape the review page writes; the token exists only in this process.');
  check('invite', 'the stored invitation holds a hash, never the token', JSON.stringify(await oList('invites')).includes(token), false, 'owner read');

  /* ===== 4. The invitation, attacked ===== */
  // The stranger confirms their own address (the real verification code, applied the way the emailed link applies it), and holds the applicant's whole link.
  check('invite', 'the stranger\'s verification code is accepted by the live project', await applyCode(await verificationLink(B)), 200, 'public endpoint');
  const b = await signIn(B);
  check('invite', 'another confirmed account: read the invitation', await get(b.idToken, `invites/${hash}`), 403);
  check('invite', 'another confirmed account: redeem the invitation', await redeem(b.idToken, hash, b.uid), 403);
  check('invite', 'another confirmed account: membership from someone else\'s invitation', await commit(b.idToken, `members/${b.uid}`, { email: B, inviteId: hash, applicationId: A_ID, status: 'active' }, ['joinedAt']), 403);
  check('invite', 'another confirmed account: membership claiming the invited address', await commit(b.idToken, `members/${b.uid}`, { email: A, inviteId: hash, applicationId: A_ID, status: 'active' }, ['joinedAt']), 403);
  // An expired and a revoked invitation, both addressed to the stranger, both with the right address confirmed: dead.
  const lateToken = randomBytes(32).toString('base64url'); const lateHash = sha(lateToken);
  const goneToken = randomBytes(32).toString('base64url'); const goneHash = sha(goneToken);
  made.docs.add(`invites/${lateHash}`); made.docs.add(`invites/${goneHash}`);
  await oSet(`invites/${lateHash}`, { email: B, applicationId: B_ID, status: 'sent', createdAt: new Date(Date.now() - 20 * 86_400_000), createdBy: 'owner-credential-walkthrough', expiresAt: new Date(Date.now() - 60_000) });
  await oSet(`invites/${goneHash}`, { email: B, applicationId: B_ID, status: 'revoked', createdAt: new Date(), createdBy: 'owner-credential-walkthrough', expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  check('expiry', 'an expired invitation, right address, confirmed: read', await get(b.idToken, `invites/${lateHash}`), 403);
  check('expiry', 'an expired invitation: redeem', await redeem(b.idToken, lateHash, b.uid), 403);
  check('expiry', 'an expired invitation: membership from it', await commit(b.idToken, `members/${b.uid}`, { email: B, inviteId: lateHash, applicationId: B_ID, status: 'active' }, ['joinedAt']), 403);
  check('expiry', 'a revoked invitation: read', await get(b.idToken, `invites/${goneHash}`), 403);
  check('expiry', 'a revoked invitation: redeem', await redeem(b.idToken, goneHash, b.uid), 403);
  await ui('expiry', 'the join page refuses the expired link for the signed-in, confirmed stranger, in plain words', async () => {
    await pb.goto(`${SITE}/join/#t=${lateToken}`, { waitUntil: 'load' });
    await expect(pb.getByTestId('signed-out')).toBeVisible({ timeout: 20_000 });
    await pb.getByRole('group', { name: 'How to use email' }).getByRole('button', { name: 'Sign in', exact: true }).click();
    await pb.getByLabel('Email', { exact: true }).fill(B);
    await pb.getByLabel('Password', { exact: true }).fill(PW[B]);
    await pb.getByTestId('email-submit').click();
    await expect(pb.getByTestId('join-error')).toBeVisible({ timeout: 40_000 });
    await expect(pb.getByTestId('join-error')).toContainText(/expired|not valid/);
    await shot(pb, 'join-expired');
  });
  check('expiry', 'the stranger is still not a member afterwards', await oGet(`members/${b.uid}`), null, 'owner read');
  await ui('invite', 'a join address without a code says the link is incomplete', async () => {
    await pb.goto(`${SITE}/features/`, { waitUntil: 'load' });
    await pb.goto(`${SITE}/join/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('join-no-code')).toBeVisible({ timeout: 20_000 });
  });

  /* ===== 5. The applicant joins, on the live site ===== */
  let a = null;
  await ui('join', 'the invitation link offers account creation; the account is created with the invited address', async () => {
    await pa.goto(inviteLink, { waitUntil: 'load' });
    await expect(pa.getByTestId('signed-out')).toBeVisible({ timeout: 20_000 });
    // In "Create account" the password label also carries its hint, so the fields are found by name.
    const form = pa.getByTestId('email-form');
    await expect(form.getByRole('button', { name: 'Create account', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
    await form.locator('input[name="name"]').fill('Walk Through');
    await form.locator('input[name="email"]').fill(A);
    await form.locator('input[name="password"]').fill(PW[A]);
    await pa.getByTestId('email-submit').click();
    await expect(pa.getByTestId('join-verify')).toBeVisible({ timeout: 40_000 });
  });
  a = await signIn(A); made.uids.add(a.uid); record.uids.applicant = a.uid;
  made.docs.add(`members/${a.uid}`); made.docs.add(`users/${a.uid}`);
  log(`applicant account ${a.uid} (created on the live join page)`);
  check('join', 'right address, not confirmed yet: read the invitation', await get(a.idToken, `invites/${hash}`), 403);
  check('join', 'right address, not confirmed yet: redeem', await redeem(a.idToken, hash, a.uid), 403);
  await ui('join', 'the page sends the confirmation email through the live project', async () => {
    await pa.getByTestId('send-verification').click();
    await expect(pa.getByRole('status')).toContainText('Sent', { timeout: 30_000 });
  });
  await ui('join', 'pressing "I have confirmed it" before confirming is refused honestly', async () => {
    await pa.getByTestId('verified-continue').click();
    await expect(pa.getByRole('status')).toContainText('Not confirmed yet', { timeout: 30_000 });
  });
  // The address is example.com (no inbox by design), so the link Firebase would email is made with the owner credential and opened in the applicant's own browser.
  const link = await verificationLink(A);
  let handler = 'firebase action page';
  const vp = await ctxA.newPage();
  try {
    await vp.goto(link, { waitUntil: 'load' });
    await expect.poll(() => accountVerified(a.uid), { timeout: 40_000, intervals: [1000] }).toBe(true);
  } catch { handler = `public endpoint (the hosted page did not confirm in time; code applied directly: ${await applyCode(link)})`; }
  await shot(vp, 'verification-handler');
  await vp.close();
  check('join', 'the account is confirmed after following the verification link', await accountVerified(a.uid), true, handler);
  await ui('join', 'after confirming, the invitation is used and the page says "You are in"', async () => {
    await pa.getByTestId('verified-continue').click();
    await expect(pa.getByTestId('join-done')).toBeVisible({ timeout: 60_000 });
    await shot(pa, 'join-done');
  });
  const member = await oGet(`members/${a.uid}`);
  check('join', 'the membership record is active and names this invitation and application', member ? `${member.status}/${member.email === A}/${member.inviteId === hash}/${member.applicationId === A_ID}` : 'missing', 'active/true/true/true', 'owner read');
  const used = await oGet(`invites/${hash}`);
  check('join', 'the invitation is redeemed by this account', used ? `${used.status}/${used.redeemedBy === a.uid}` : 'missing', 'redeemed/true', 'owner read');
  a = await signIn(A);
  check('join', 'the same invitation cannot be redeemed a second time', await redeem(a.idToken, hash, a.uid), 403);
  check('join', 'the stranger cannot use it after redemption either', await redeem(b.idToken, hash, b.uid), 403);
  await ui('join', 'opening the link again says the account already has access', async () => {
    await pa.goto(`${SITE}/features/`, { waitUntil: 'load' });
    await pa.goto(inviteLink, { waitUntil: 'load' });
    await expect(pa.getByTestId('join-member')).toBeVisible({ timeout: 30_000 });
  });

  /* ===== 6. As an approved tester: the gated pages, and isolation ===== */
  await ui('tester', 'the install page shows the install steps and the command', async () => {
    await pa.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('install-steps')).toBeVisible({ timeout: 30_000 });
    await expect(pa.locator('main')).toContainText('curl -fsSL');
    await shot(pa, 'install-open');
  });
  await ui('tester', 'the account page says Active tester, shows the address, and saves a preference', async () => {
    await pa.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('access-status')).toContainText('Active tester', { timeout: 30_000 });
    await expect(pa.getByTestId('profile-email')).toHaveText(A);
    await expect(pa.getByTestId('account-uid')).toHaveText(a.uid);
    await pa.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' }).click();
    await expect(pa.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  });
  await ui('tester', 'the tester feedback form sends, and the report reaches the database', async () => {
    await pa.goto(`${SITE}/feedback/`, { waitUntil: 'load' });
    const form = pa.getByTestId('tester-feedback-form');
    await expect(form).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Connector compatibility').check();
    await form.getByLabel('Your message').fill('Live walk-through: a report from a disposable tester account.');
    await form.getByLabel('AgentOnTrack version').fill('1.0.0-rc.7');
    await form.getByLabel('Operating system').selectOption('windows');
    await form.getByLabel('Connector or agent involved').selectOption('Codex');
    await form.getByRole('button', { name: 'Send feedback' }).click();
    await expect(pa.getByTestId('feedback-sent')).toBeVisible({ timeout: 30_000 });
  });
  const fb = (await oList('testerFeedback')).filter((f) => f.data.uid === a.uid);
  for (const f of fb) made.docs.add(f.path);
  check('tester', 'the feedback is stored under this account, with its address', fb.length === 1 && fb[0].data.email === A && fb[0].data.kind === 'connector', true, 'owner read');
  await ui('tester', 'the site\'s dashboard now offers "Continue on this computer"', async () => {
    await pa.goto(`${SITE}/dashboard/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('continue-local')).toBeVisible({ timeout: 30_000 });
    await expect(pa.getByTestId('gate-signed-out')).toHaveCount(0);
  });
  if (!flag('--no-companion')) {
    // A real companion on this machine, reached from the live site through the welcome path a tester takes, and a counts-only summary saved to the account.
    await ui('tester', 'welcome path: the live dashboard finds a real companion, pairs with its code, and saves a counts-only summary to the account', async () => {
      const { startCompanion } = await import('../../packages/companion/dist/index.js');
      const { Project } = await import('../../packages/core/dist/index.js');
      tmp = mkdtempSync(join(tmpdir(), 'aot-walk-'));
      const root = join(tmp, 'private-folder-name');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.txt'), 'a');
      process.env.AGENTONTRACK_HOME = join(tmp, 'home');
      const p = new Project(root);
      p.human.setGoal({ statement: 'A private goal', scope: { include: ['src/**'] } });
      p.human.createTask({ id: 't1', title: 'A private task', criteria: [{ id: 'c', description: 'npm run private-check', kind: 'artifact', path: 'src/a.txt' }] });
      p.verifyTask('t1');
      p.close();
      companion = await startCompanion({ root, allowedOrigins: [ORIGIN] });
      // Chromium asks before a public https page may reach 127.0.0.1; a person answers "Allow" on that prompt. Granting it is that answer.
      await ctxA.grantPermissions(['local-network-access'], { origin: ORIGIN });
      notes.push('The tester\'s browser was granted Chromium\'s local-network-access permission for the site, as a person does by pressing Allow on its prompt; without it Chromium blocks the companion probe (seen in the first run).');
      await pa.getByTestId('continue-local').click();
      await pa.getByText('This computer uses a different port').click();
      await pa.getByLabel('Companion port').fill(String(companion.port));
      await pa.getByTestId('retry').click();
      await expect(pa.getByTestId('probe-status')).toContainText('Found AgentOnTrack on this computer', { timeout: 40_000 });
      await pa.getByLabel('Pairing code').fill(companion.newPairingCode());
      await pa.getByRole('button', { name: 'Pair', exact: true }).click();
      await pa.getByTestId('project-card').locator('.project-open').click();
      const saver = pa.getByTestId('summary-saver');
      await saver.getByTestId('summary-toggle').check();
      await pa.getByTestId('summary-label').fill('walk-through');
      await saver.getByRole('button', { name: 'Save summary' }).click();
      await expect(saver).toContainText(/saved/i, { timeout: 30_000 });
      await shot(pa, 'dashboard-summary');
    });
    const summaries = await oList(`users/${a.uid}/summaries`);
    for (const s of summaries) made.docs.add(s.path);
    check('tester', 'one summary is stored, and it holds counts only (no path, goal, task or command)', summaries.length === 1 && summaries[0].data.label === 'walk-through' && !/private|src|npm/.test(JSON.stringify(summaries[0].data)), true, 'owner read');
    await companion?.close().catch(() => undefined); companion = null;
  }
  // Isolation, both ways, with each account's own fresh token.
  a = await signIn(A);
  const b2 = await signIn(B);
  check('isolation', 'tester: read own account document', await get(a.idToken, `users/${a.uid}`), 200);
  check('isolation', 'tester: read own membership', await get(a.idToken, `members/${a.uid}`), 200);
  check('isolation', 'tester: read another account\'s document', await get(a.idToken, `users/${b.uid}`), 403);
  check('isolation', 'tester: write into another account\'s tree', await commit(a.idToken, `users/${b.uid}/summaries/x`, { label: 'planted', totals: counts, rates: { criteriaPassing: null, verificationRunsPassing: null } }, ['savedAt']), 403);
  check('isolation', 'tester: read another account\'s membership', await get(a.idToken, `members/${b.uid}`), 403);
  check('isolation', 'tester: list members', await get(a.idToken, 'members'), 403);
  check('isolation', 'tester: list accounts', await get(a.idToken, 'users'), 403);
  check('isolation', 'tester: list applications', await get(a.idToken, 'applications'), 403);
  check('isolation', 'tester: list invitations', await get(a.idToken, 'invites'), 403);
  check('isolation', 'tester: read tester feedback (the administrator\'s)', await get(a.idToken, 'testerFeedback'), 403);
  check('isolation', 'tester: read the audit log', await get(a.idToken, 'audit'), 403);
  check('isolation', 'tester: write an audit entry', await commit(a.idToken, 'audit/x', { action: 'approve', target: 'application:x', by: a.uid }, ['at']), 403);
  check('isolation', 'tester: make oneself the administrator', await commit(a.idToken, `admins/${a.uid}`, { note: 'me' }, ['addedAt']), 403);
  check('isolation', 'tester: change one\'s own membership', await commit(a.idToken, `members/${a.uid}`, { note: 'x' }, [], ['note']), 403);
  check('isolation', 'tester: tester feedback in someone else\'s name', await commit(a.idToken, 'testerFeedback/forged', { kind: 'bug', message: 'x', uid: b.uid }, ['createdAt']), 403);
  check('isolation', 'tester: make an invitation', await commit(a.idToken, `invites/${sha('t')}`, { email: B, applicationId: B_ID, status: 'sent', createdBy: a.uid, expiresAt: new Date(Date.now() + 86_400_000) }, ['createdAt']), 403);
  check('isolation', 'stranger: read the tester\'s account document', await get(b2.idToken, `users/${a.uid}`), 403);
  check('isolation', 'stranger: list the tester\'s summaries', await get(b2.idToken, `users/${a.uid}/summaries`), 403);
  check('isolation', 'stranger: read the tester\'s membership', await get(b2.idToken, `members/${a.uid}`), 403);
  check('isolation', 'stranger: read the tester\'s application', await get(b2.idToken, `applications/${A_ID}`), 403);
  check('isolation', 'stranger: delete the tester\'s application', await del(b2.idToken, `applications/${A_ID}`), 403);
  check('isolation', 'stranger: send tester feedback without membership', await commit(b2.idToken, 'testerFeedback/x', { kind: 'bug', message: 'x', uid: b.uid }, ['createdAt']), 403);
  check('isolation', 'stranger: revoke the tester', await commit(b2.idToken, `members/${a.uid}`, { status: 'revoked', statusBy: b.uid }, ['statusAt'], ['status', 'statusBy', 'statusAt']), 403);
  await ui('isolation', 'the review page is closed to the tester', async () => {
    await pa.goto(`${SITE}/admin/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('admin-denied')).toBeVisible({ timeout: 30_000 });
  });
  await ui('isolation', 'the stranger, signed in, sees "not approved yet" on the install page and the dashboard', async () => {
    await pb.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('install-not-approved')).toContainText('not an approved tester yet', { timeout: 30_000 });
    await expect(pb.getByTestId('install-steps')).toHaveCount(0);
    await pb.goto(`${SITE}/dashboard/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('gate-not-approved')).toBeVisible({ timeout: 30_000 });
    await expect(pb.getByTestId('continue-local')).toHaveCount(0);
  });

  /* ===== 7. Revocation, and reinstating: owner credential stand-in ===== */
  await oPatch(`members/${a.uid}`, { status: 'revoked', statusAt: new Date(), statusBy: 'owner-credential-walkthrough' });
  await ui('revoke', 'after revocation the install page refuses the tester on the next load', async () => {
    await pa.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('install-not-approved')).toContainText('not an approved tester any more', { timeout: 30_000 });
    await expect(pa.getByTestId('install-steps')).toHaveCount(0);
    await shot(pa, 'install-revoked');
  });
  await ui('revoke', 'the site\'s dashboard says access was revoked and offers no connection step', async () => {
    await pa.goto(`${SITE}/dashboard/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('gate-revoked')).toBeVisible({ timeout: 30_000 });
    await expect(pa.getByTestId('continue-local')).toHaveCount(0);
  });
  await ui('revoke', 'the account page says Access revoked', async () => {
    await pa.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('access-status')).toContainText('Access revoked', { timeout: 30_000 });
  });
  check('revoke', 'the SAME token as before the revocation: read own account document', await get(a.idToken, `users/${a.uid}`), 403);
  check('revoke', 'revoked: save a summary', await commit(a.idToken, `users/${a.uid}/summaries/x`, { label: 'again', totals: counts, rates: { criteriaPassing: null, verificationRunsPassing: null } }, ['savedAt']), 403);
  check('revoke', 'revoked: send tester feedback', await commit(a.idToken, 'testerFeedback/x', { kind: 'bug', message: 'still here?', uid: a.uid }, ['createdAt']), 403);
  check('revoke', 'revoked: reinstate oneself', await commit(a.idToken, `members/${a.uid}`, { status: 'active' }, [], ['status']), 403);
  check('revoke', 'revoked: rejoin with the old invitation', await redeem(a.idToken, hash, a.uid), 403);
  await oPatch(`members/${a.uid}`, { status: 'active', statusAt: new Date(), statusBy: 'owner-credential-walkthrough' });
  await ui('revoke', 'reinstated: the install steps are back on the next load', async () => {
    await pa.goto(`${SITE}/install/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('install-steps')).toBeVisible({ timeout: 30_000 });
  });

  /* ===== 8. Export and deletion ===== */
  await ui('export', 'the tester exports their data from the account page, and the file holds only their own', async () => {
    await pa.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('export-data')).toBeEnabled({ timeout: 30_000 });
    const [dl] = await Promise.all([pa.waitForEvent('download'), pa.getByTestId('export-data').click()]);
    const data = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    record.export = { file: dl.suggestedFilename(), keys: Object.keys(data), profileEmailIsOwn: data.profile?.email === A, theme: data.preferences?.theme ?? null, summaries: data.summaries?.length ?? 0, mentionsStranger: JSON.stringify(data).includes(B) };
    expect(record.export.profileEmailIsOwn).toBe(true);
    expect(record.export.theme).toBe('light');
    expect(record.export.mentionsStranger).toBe(false);
    if (!flag('--no-companion')) expect(record.export.summaries).toBe(1);
  });
  check('delete', 'the tester deletes their own application with their own sign-in', await del(a.idToken, `applications/${A_ID}`), 200);
  check('delete', 'the application is gone', await oGet(`applications/${A_ID}`), null, 'owner read');
  // The stranger has an application too, withdraws it from the account page, then removes the account through the public endpoint.
  made.docs.add(`applications/${B_ID}`);
  check('delete', 'a well-formed application for the stranger\'s address is accepted', await commit(null, `applications/${B_ID}`, application(B), ['createdAt']), 200);
  await ui('delete', 'the stranger sees their pending application on the account page and withdraws it', async () => {
    await pb.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pb.getByTestId('access-status')).toContainText(`AOT-${B_ID.slice(0, 6).toUpperCase()}`, { timeout: 30_000 });
    await expect(pb.getByTestId('access-status')).toContainText('pending');
    await pb.getByRole('button', { name: 'Withdraw and delete my application' }).click();
    await expect(pb.getByTestId('account-note')).toContainText('withdrawn', { timeout: 30_000 });
  });
  check('delete', 'the withdrawn application is gone', await oGet(`applications/${B_ID}`), null, 'owner read');
  const staleToken = a.idToken;
  await ui('delete', 'the tester deletes the account and its data from the account page, confirming with the password', async () => {
    await pa.goto(`${SITE}/account/`, { waitUntil: 'load' });
    await expect(pa.getByTestId('delete-account')).toBeEnabled({ timeout: 30_000 });
    await pa.getByTestId('delete-account').click();
    await pa.locator('input[name="delete-password"]').fill(PW[A]);
    await pa.getByTestId('delete-confirm').click();
    await expect(pa.getByTestId('signed-out')).toBeVisible({ timeout: 60_000 });
  });
  check('delete', 'the sign-in is gone from Authentication', await accountExists(a.uid), false, 'owner read');
  check('delete', 'the account document is gone', await oGet(`users/${a.uid}`), null, 'owner read');
  check('delete', 'the saved summaries are gone', (await oList(`users/${a.uid}/summaries`)).length, 0, 'owner read');
  check('delete', 'signing in with the deleted account is refused', await (async () => { try { await signIn(A); return 'signed in'; } catch { return 'refused'; } })(), 'refused', 'public endpoint');
  // What self-deletion leaves for the administrator, stated rather than assumed.
  const leftMember = await oGet(`members/${a.uid}`);
  const leftFeedback = (await oList('testerFeedback')).filter((f) => f.data.uid === a.uid).length;
  const leftInvite = await oGet(`invites/${hash}`);
  record.afterSelfDeletion = { membershipRecord: leftMember ? leftMember.status : null, testerFeedback: leftFeedback, invitationRecord: leftInvite ? leftInvite.status : null };
  const staleRead = await get(staleToken, `members/${a.uid}`);
  const staleWrite = await commit(staleToken, 'testerFeedback/stale-token-probe', { kind: 'bug', message: 'probe with a token issued before the account was deleted', uid: a.uid }, ['createdAt']);
  if (staleWrite === 200) made.docs.add('testerFeedback/stale-token-probe');
  record.afterSelfDeletion.tokenIssuedBeforeDeletion = { readOwnMembership: staleRead, sendTesterFeedback: staleWrite };
  if (leftMember) record.findings.push({ severity: 'low', what: 'Deleting an account from the account page removes the sign-in, the account document and its summaries, but leaves the membership record (address, invitation id), the tester feedback and the redeemed invitation (address) for the administrator to remove, as the runbook describes. The rules give a person no way to delete their own membership record.' });
  if (staleWrite === 200) record.findings.push({ severity: 'low', what: 'A sign-in token issued before the account was deleted keeps working until it expires (Firebase tokens live up to one hour), and because the membership record is still active the rules accept it: the probe stored a tester feedback entry after deletion. Revoking or deleting the membership record closes it at once.' });
  const bDeleted = await fetch(`${IDT}/accounts:delete?key=${KEY}`, { method: 'POST', headers: pub, body: JSON.stringify({ idToken: (await signIn(B)).idToken }) });
  check('delete', 'the stranger deletes their own sign-in through the public endpoint', bDeleted.status, 200, 'public endpoint');
  check('delete', 'the stranger\'s sign-in is gone', await accountExists(b.uid), false, 'owner read');
  record.consoleErrors = [...new Set(consoleErrors)].slice(0, 20);
} catch (e) {
  checks.push({ phase: 'run', name: 'the walk-through ran to its end', via: 'script', want: 'completed', got: String(e?.stack ?? e).slice(0, 600), pass: false });
  log(`ABORTED: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  /* ===== 9. Remove everything this run made, and only that ===== */
  await companion?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  const cleanup = { accountsDeleted: 0, documentsDeleted: 0, problems: [] };
  try {
    for (const uid of made.uids) {
      for (const sub of ['summaries', 'feedback', 'computers']) for (const d of await oList(`users/${uid}/${sub}`).catch(() => [])) made.docs.add(d.path);
      for (const f of (await oList('testerFeedback')).filter((x) => x.data.uid === uid)) made.docs.add(f.path);
      made.docs.add(`users/${uid}`); made.docs.add(`members/${uid}`);
    }
    for (const path of made.docs) { if (await oGet(path).catch(() => null)) { const s = await oDel(path); if (s === 200) cleanup.documentsDeleted++; else cleanup.problems.push(`${path}: ${s}`); } }
    for (const uid of made.uids) { if (await accountExists(uid)) { const r = await owner(`${IDT}/projects/${PROJECT}/accounts:delete`, { method: 'POST', body: JSON.stringify({ localId: uid }) }); if (r.status === 200) cleanup.accountsDeleted++; else cleanup.problems.push(`account ${uid}: ${r.status}`); } }
    record.final = await snapshot();
    const left = (await accounts()).filter((u) => made.uids.has(u.localId)).length;
    check('cleanup', 'no account this run created is left', left, 0, 'owner read');
    check('cleanup', 'every collection is back to what it held before the run', JSON.stringify(Object.fromEntries(COLLECTIONS.map((c) => [c, record.final[c]]))), JSON.stringify(Object.fromEntries(COLLECTIONS.map((c) => [c, record.baseline?.[c]]))), 'owner read');
  } catch (e) { cleanup.problems.push(String(e?.message ?? e).slice(0, 300)); }
  record.cleanup = cleanup;
  record.finished = new Date().toISOString();
  const failed = checks.filter((c) => !c.pass);
  record.summary = { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, byPhase: Object.fromEntries([...new Set(checks.map((c) => c.phase))].map((p) => [p, `${checks.filter((c) => c.phase === p && c.pass).length}/${checks.filter((c) => c.phase === p).length}`])) };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, null, 2));
  log(`\n${record.summary.passed}/${record.summary.checks} checks passed; record written to ${OUT}; cleanup ${JSON.stringify(cleanup)}`);
  for (const f of failed) log(`  failed: [${f.phase}] ${f.name}: ${JSON.stringify(f.got).slice(0, 200)}`);
  process.exit(failed.length || cleanup.problems.length ? 1 : 0);
}
