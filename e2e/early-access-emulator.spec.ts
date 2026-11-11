// Early access end to end, against the Firebase EMULATORS and a REAL companion: a visitor applies, the administrator reviews and makes an invitation,
// the applicant uses it, becomes a tester, uses the gated pages and the dashboard, and is then revoked. Alongside, direct requests from people who were
// not invited, who hold someone else's link, or whose link expired, are made straight at the database to show the rules refuse them.
// Runs in the `accounts` CI job under `firebase emulators:exec`, on a site built with the demo config and AOT_FIREBASE_EMULATORS=1 (installs gated).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { clearEmulators, commit, DOCS, followVerificationLink, googlePopupSignIn, markVerified, ownerList, ownerRead, ownerWrite, readDoc, signInRest, signUpRest, str, uidOf } from './emulator-helpers';

const ORIGIN = 'http://127.0.0.1:4199';
const SITE = `${ORIGIN}/agentontrack`;
const APPLICANT = 'tester.one@example.com';
const APPLICANT_ID = createHash('sha256').update(APPLICANT).digest('hex');
const ADMIN = 'owner@example.com';

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators, and a site built for them.');
test.describe.configure({ mode: 'serial' });

let admin: BrowserContext; let apage: Page;      // the administrator's browser
let tester: BrowserContext; let tpage: Page;     // the applicant's browser
let inviteLink = '';
let inviteHash = '';
let testerUid = '';

test.beforeAll(async ({ browser }) => {
  await clearEmulators(); // this file is serial: a retry must not meet the application and accounts its first attempt left behind
  admin = await browser.newContext(); apage = await admin.newPage();
  tester = await browser.newContext(); tpage = await tester.newPage();
});
test.afterAll(async () => { await admin.close(); await tester.close(); });

const fullApplication = async (page: Page, email: string, name: string) => {
  const d = page.getByTestId('early-access-dialog');
  await d.getByLabel('Full name').fill(name);
  await d.getByLabel('Email address').fill(email);
  await d.getByLabel('Organization or company').fill('Example Labs');
  await d.getByTestId('ea-next').click();
  await d.getByLabel('Windows', { exact: true }).check();
  await d.getByLabel('Claude Code', { exact: true }).check();
  await d.getByLabel('How frequently do you use AI coding agents?').selectOption('daily');
  await d.getByTestId('ea-next').click();
  await d.getByLabel('Human approval workflows').check();
  await d.getByLabel('Monitoring agent executions').check();
  await d.getByLabel('What is your biggest challenge when managing AI agents?').fill('Knowing what actually ran');
  await d.getByLabel(/I have read the privacy notice/).check();
  await d.getByTestId('ea-submit').click();
};

test('a visitor applies from the home page popup, and the application is stored as pending under the hash of the address', async () => {
  await tpage.goto(`${SITE}/`);
  // The popup arrives by itself about five seconds after the page is ready.
  await expect(tpage.locator('html')).toHaveAttribute('data-ea-popup', 'armed');
  const armedAt = Date.now();
  await expect(tpage.getByTestId('early-access-dialog')).toBeVisible({ timeout: 12_000 });
  expect(Date.now() - armedAt).toBeGreaterThan(4000);
  await fullApplication(tpage, APPLICANT.toUpperCase(), 'Tester One');
  const sent = tpage.getByTestId('early-access-sent');
  await expect(sent).toBeVisible({ timeout: 20_000 });
  await expect(tpage.getByTestId('application-reference')).toHaveText(`AOT-${APPLICANT_ID.slice(0, 6).toUpperCase()}`);
  const doc = await ownerRead(`applications/${APPLICANT_ID}`);
  expect(doc).toMatchObject({ name: 'Tester One', email: APPLICANT, os: ['windows'], tools: ['claude-code'], useCases: ['approvals', 'monitoring'], frequency: 'daily', status: 'pending', source: 'popup', privacyAccepted: true, marketingConsent: false, schema: 1 });
  expect(doc!.createdAt).toBeTruthy();
  // Reopening the form says it already has the application, and the popup does not come back.
  await tpage.reload();
  await tpage.getByTestId('nav-early-access').click();
  await expect(tpage.getByTestId('early-access-earlier')).toContainText(`AOT-${APPLICANT_ID.slice(0, 6).toUpperCase()}`);
  await tpage.keyboard.press('Escape');
});

test('black box: applications cannot be read, listed, duplicated, forged or pre-approved from outside', async () => {
  expect((await fetch(`${DOCS}/applications`)).status, 'list').toBe(403);
  expect((await readDoc(null, `applications/${APPLICANT_ID}`)).status, 'read').toBe(403);
  const body = (over: Record<string, unknown> = {}) => ({ name: str('Mallory'), email: str(APPLICANT), os: { arrayValue: { values: [str('linux')] } }, tools: { arrayValue: { values: [str('codex')] } }, useCases: { arrayValue: { values: [str('other')] } }, frequency: str('weekly'), privacyAccepted: { booleanValue: true }, marketingConsent: { booleanValue: false }, source: str('page'), status: str('pending'), schema: { integerValue: '1' }, ...over });
  expect((await commit(null, `applications/${APPLICANT_ID}`, body(), ['createdAt'])).status, 'a second application for the same address').toBe(403);
  const otherId = createHash('sha256').update('second@example.com').digest('hex');
  expect((await commit(null, `applications/${otherId}`, body({ email: str('second@example.com'), status: str('approved') }), ['createdAt'])).status, 'born approved').toBe(403);
  expect((await commit(null, `applications/${otherId}`, body({ email: str('second@example.com'), code: str('rm -rf /') }), ['createdAt'])).status, 'an extra field').toBe(403);
  expect((await commit(null, `applications/wrong-id`, body({ email: str('second@example.com') }), ['createdAt'])).status, 'an id that is not the hash of the address').toBe(403);
  expect((await commit(null, `applications/${otherId}`, body({ email: str('second@example.com'), os: { arrayValue: { values: [str('amiga')] } } }), ['createdAt'])).status, 'an option that does not exist').toBe(403);
  expect((await commit(null, `applications/${otherId}`, body({ email: str('second@example.com') }), ['createdAt'])).status, 'a valid one').toBe(200);
  // A signed-in person who is not the administrator fares no better.
  const nobody = await signUpRest('nobody@example.com');
  expect((await fetch(`${DOCS}/applications`, { headers: { authorization: `Bearer ${nobody.idToken}` } })).status).toBe(403);
  expect((await readDoc(nobody.idToken, `applications/${APPLICANT_ID}`)).status).toBe(403);
  expect((await commit(nobody.idToken, `applications/${APPLICANT_ID}`, { status: str('approved') }, [], ['status'])).status, 'approving someone').toBe(403);
});

test('before approval, the applicant can reach nothing restricted: the install page, the public-site dashboard and the database all refuse', async () => {
  await tpage.goto(`${SITE}/install/`);
  await expect(tpage.getByTestId('install-gate')).toBeVisible();
  await expect(tpage.getByTestId('install-steps')).toHaveCount(0);
  await expect(tpage.locator('main')).not.toContainText('curl -fsSL');
  await tpage.goto(`${SITE}/dashboard/`);
  await expect(tpage.getByTestId('gate-signed-out')).toBeVisible();
  await expect(tpage.getByTestId('continue-local')).toHaveCount(0);
  await expect(tpage.getByTestId('explore-demo')).toBeVisible();
  // Straight at the database, as an account that merely signed up: no membership, no account documents, no invitations.
  const sneaky = await signUpRest('sneaky@example.com');
  expect((await commit(sneaky.idToken, `members/${sneaky.localId}`, { email: str('sneaky@example.com'), inviteId: str('x'), applicationId: str('y'), status: str('active') }, ['joinedAt'])).status, 'making oneself a member').toBe(403);
  expect((await commit(sneaky.idToken, `users/${sneaky.localId}`, { profile: { mapValue: { fields: { name: str('S'), email: str('sneaky@example.com') } } } }, ['updatedAt'])).status, 'an account document without membership').toBe(403);
  expect((await fetch(`${DOCS}/invites`, { headers: { authorization: `Bearer ${sneaky.idToken}` } })).status, 'listing invitations').toBe(403);
  expect((await commit(sneaky.idToken, `admins/${sneaky.localId}`, { note: str('me') }, ['addedAt'])).status, 'making oneself the administrator').toBe(403);
});

test('the administrator signs in, is recognised only once listed as administrator, finds the application by filters, approves it and makes an invitation link', async () => {
  await apage.goto(`${SITE}/sign-in/?next=admin`);
  await googlePopupSignIn(apage, ADMIN, 'The Owner');
  // Not an administrator yet: the review page says so and shows nothing.
  await apage.waitForURL(/\/admin\//, { timeout: 30_000 });
  await expect(apage.getByTestId('admin-denied')).toBeVisible({ timeout: 20_000 });
  const adminUid = await uidOf(ADMIN);
  expect((await ownerWrite(`admins/${adminUid}`, { note: 'the owner' }, ['addedAt'])).status).toBe(200);
  await apage.reload();
  await expect(apage.getByTestId('admin')).toBeVisible({ timeout: 20_000 });
  // Other specs in the same emulator session may have applied too: the tiles must agree with the database, whatever it holds.
  const all = await ownerList('applications');
  await expect(apage.getByTestId('admin-stats').locator('[data-stat="Applications"]')).toHaveText(String(all.length));
  await expect(apage.getByTestId('admin-stats').locator('[data-stat="Pending"]')).toHaveText(String(all.filter((a) => a.data.status === 'pending').length));
  await apage.getByTestId('filter-os').selectOption('windows');
  await apage.getByTestId('filter-tool').selectOption('claude-code');
  await expect(apage.getByTestId('application-row')).toHaveCount(1);
  await expect(apage.getByTestId('application-row')).toContainText('Tester One');
  await apage.getByTestId('application-row').click();
  const drawer = apage.getByTestId('application-drawer');
  await expect(drawer).toContainText('Knowing what actually ran');
  await drawer.getByTestId('approve').click();
  await expect(drawer.locator('.badge', { hasText: /^approved$/ })).toBeVisible({ timeout: 15_000 });
  await drawer.getByTestId('admin-notes').fill('Met at the meetup; Windows + Claude Code, a good fit.');
  await drawer.getByTestId('save-notes').click();
  await drawer.getByTestId('create-invite').click();
  const linkBox = apage.getByTestId('invite-link');
  await expect(linkBox).toBeVisible({ timeout: 15_000 });
  inviteLink = await linkBox.inputValue();
  expect(inviteLink).toMatch(new RegExp(`^${SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/join/#t=[A-Za-z0-9_-]{40,}$`));
  const token = inviteLink.split('#t=')[1]!;
  inviteHash = createHash('sha256').update(token).digest('hex');
  // Stored by its hash, addressed to the applicant, open, with an expiry; the token itself is nowhere in the database.
  const inv = await ownerRead(`invites/${inviteHash}`);
  expect(inv).toMatchObject({ email: APPLICANT, applicationId: APPLICANT_ID, status: 'sent', createdBy: adminUid });
  expect(JSON.stringify(await ownerList('invites'))).not.toContain(token);
  expect((await ownerRead(`applications/${APPLICANT_ID}`))!.status).toBe('approved');
  const audit = await ownerList('audit');
  expect(audit.map((a) => a.data.action).sort()).toEqual(['approve', 'invite', 'note']);
  await apage.getByRole('button', { name: 'Done' }).click();
});

test('black box: the invitation cannot be used by another account, read without the right address, or redeemed twice; an expired one is dead', async () => {
  // Someone else, even with a confirmed address and the whole link, cannot see or take it.
  const other = await signUpRest('someone.else@example.com');
  await markVerified(other.localId);
  const otherToken = await signInRest('someone.else@example.com');
  expect((await readDoc(otherToken, `invites/${inviteHash}`)).status, 'read with another address').toBe(403);
  expect((await commit(otherToken, `invites/${inviteHash}`, { status: str('redeemed'), redeemedBy: str(other.localId) }, ['redeemedAt'], ['status', 'redeemedBy', 'redeemedAt'])).status, 'take with another address').toBe(403);
  expect((await commit(otherToken, `members/${other.localId}`, { email: str('someone.else@example.com'), inviteId: str(inviteHash), applicationId: str(APPLICANT_ID), status: str('active') }, ['joinedAt'])).status, 'membership from someone else\'s invitation').toBe(403);
  // The right address, but not confirmed: still nothing.
  const unverified = await signUpRest(APPLICANT, 'applicant-password-1');
  expect((await readDoc(unverified.idToken, `invites/${inviteHash}`)).status, 'right address, not confirmed').toBe(403);
  // An expired invitation for a confirmed address is refused outright.
  const late = await signUpRest('late@example.com');
  await markVerified(late.localId);
  const lateToken = await signInRest('late@example.com');
  const lateHash = createHash('sha256').update('late-token').digest('hex');
  expect((await ownerWrite(`invites/${lateHash}`, { email: 'late@example.com', applicationId: 'app-late', status: 'sent', createdBy: 'owner', createdAt: new Date(Date.now() - 20 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) })).status).toBe(200);
  expect((await readDoc(lateToken, `invites/${lateHash}`)).status, 'expired').toBe(403);
  expect((await commit(lateToken, `invites/${lateHash}`, { status: str('redeemed'), redeemedBy: str(late.localId) }, ['redeemedAt'], ['status', 'redeemedBy', 'redeemedAt'])).status, 'redeeming an expired invitation').toBe(403);
});

test('the applicant opens the link, creates the account with the invited address, confirms it, and becomes an active tester', async () => {
  await tpage.goto(inviteLink);
  // The account made by the previous test (same address, from the database) is signed into here: the rules only care about the address and its confirmation.
  await expect(tpage.getByTestId('signed-out')).toBeVisible();
  await tpage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await tpage.getByLabel('Email', { exact: true }).fill(APPLICANT);
  await tpage.getByLabel('Password', { exact: true }).fill('applicant-password-1');
  await tpage.getByTestId('toggle-password').click();
  await expect(tpage.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await tpage.getByTestId('email-submit').click();
  await expect(tpage.getByTestId('join-verify')).toBeVisible({ timeout: 20_000 });
  await tpage.getByTestId('send-verification').click();
  await expect(tpage.getByRole('status')).toContainText('Sent', { timeout: 15_000 });
  // Pressing "confirmed" before following the link is refused honestly.
  await tpage.getByTestId('verified-continue').click();
  await expect(tpage.getByRole('status')).toContainText('Not confirmed yet');
  await followVerificationLink(APPLICANT);
  await tpage.getByTestId('verified-continue').click();
  await expect(tpage.getByTestId('join-done')).toBeVisible({ timeout: 30_000 });
  testerUid = await uidOf(APPLICANT);
  expect(await ownerRead(`members/${testerUid}`)).toMatchObject({ email: APPLICANT, inviteId: inviteHash, applicationId: APPLICANT_ID, status: 'active' });
  const inv = await ownerRead(`invites/${inviteHash}`);
  expect(inv).toMatchObject({ status: 'redeemed', redeemedBy: testerUid });
  // Used once: the same link again lands on "already have access", and the database refuses a second redemption.
  await tpage.goto(`${SITE}/features/`);
  await tpage.goto(inviteLink);
  await expect(tpage.getByTestId('join-member')).toBeVisible({ timeout: 20_000 });
  const token = await signInRest(APPLICANT, 'applicant-password-1');
  expect((await commit(token, `invites/${inviteHash}`, { status: str('redeemed'), redeemedBy: str(testerUid) }, ['redeemedAt'], ['status', 'redeemedBy', 'redeemedAt'])).status).toBe(403);
});

test('as a tester: the install steps, the account page, structured feedback, and the public-site dashboard with a saved summary', async () => {
  await tpage.goto(`${SITE}/install/`);
  await expect(tpage.getByTestId('install-steps')).toBeVisible({ timeout: 20_000 });
  await expect(tpage.locator('main')).toContainText('curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh');
  await tpage.goto(`${SITE}/account/`);
  await expect(tpage.getByTestId('access-status')).toContainText('Active tester', { timeout: 20_000 });
  await expect(tpage.getByTestId('profile-email')).toHaveText(APPLICANT);
  await tpage.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' }).click();
  await expect(tpage.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await tpage.goto(`${SITE}/feedback/`);
  const form = tpage.getByTestId('tester-feedback-form');
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel('Connector compatibility').check();
  await form.getByLabel('Your message').fill('Codex hooks were not picked up until I ran setup twice.');
  await form.getByLabel('AgentOnTrack version').fill('1.0.0-rc.7');
  await form.getByLabel('Operating system').selectOption('windows');
  await form.getByLabel('Connector or agent involved').selectOption('Codex');
  await form.getByRole('button', { name: 'Send feedback' }).click();
  await expect(tpage.getByTestId('feedback-sent')).toBeVisible({ timeout: 20_000 });
  const fb = await ownerList('testerFeedback');
  expect(fb.some((f) => f.data.kind === 'connector' && f.data.connector === 'Codex' && f.data.uid === testerUid && f.data.email === APPLICANT)).toBe(true);

  // The public-site dashboard now lets the tester connect their own computer, and save a counts-only summary to the account.
  const dir = mkdtempSync(join(tmpdir(), 'aot-ea-'));
  const root = join(dir, 'private-folder-name');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  const p = new Project(root);
  p.human.setGoal({ statement: 'A private goal', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't1', title: 'A private task', criteria: [{ id: 'c', description: 'npm run private-check', kind: 'artifact', path: 'src/a.txt' }] });
  p.verifyTask('t1');
  p.close();
  let c: Companion | null = null;
  try {
    c = await startCompanion({ root, allowedOrigins: [ORIGIN] });
    await tpage.goto(`${SITE}/dashboard/`);
    await expect(tpage.getByTestId('continue-local')).toBeVisible({ timeout: 20_000 });
    await expect(tpage.getByTestId('gate-signed-out')).toHaveCount(0);
    await tpage.getByTestId('continue-local').click();
    await tpage.getByText('This computer uses a different port').click();
    await tpage.getByLabel('Companion port').fill(String(c.port));
    await tpage.getByTestId('retry').click();
    await expect(tpage.getByTestId('probe-status')).toContainText('Found AgentOnTrack on this computer', { timeout: 30_000 });
    await tpage.getByLabel('Pairing code').fill(c.newPairingCode());
    await tpage.getByRole('button', { name: 'Pair', exact: true }).click();
    await tpage.getByTestId('project-card').locator('.project-open').click();
    const saver = tpage.getByTestId('summary-saver');
    await saver.getByTestId('summary-toggle').check();
    await tpage.getByTestId('summary-label').fill('first week');
    await saver.getByRole('button', { name: 'Save summary' }).click();
    await expect(saver).toContainText(/saved/i, { timeout: 20_000 });
    const summaries = await ownerList(`users/${testerUid}/summaries`);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.data.label).toBe('first week');
    expect(JSON.stringify(summaries[0]!.data)).not.toMatch(/private|src|npm/);
  } finally {
    await c?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the administrator revokes access: the tester is shut out on the next request, everywhere, and reinstating restores it', async () => {
  await apage.goto(`${SITE}/admin/`);
  await apage.getByRole('tab', { name: 'Testers' }).click();
  const row = apage.getByTestId('member-row').filter({ hasText: APPLICANT });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByTestId('revoke-member').click();
  await apage.getByTestId('confirm-yes').click();
  await expect(row.locator('.badge', { hasText: 'revoked' })).toBeVisible({ timeout: 15_000 });
  // The tester's next requests are refused: pages, and the database itself.
  await tpage.goto(`${SITE}/install/`);
  await expect(tpage.getByTestId('install-not-approved')).toContainText('not an approved tester any more', { timeout: 20_000 });
  await tpage.goto(`${SITE}/dashboard/`);
  await expect(tpage.getByTestId('gate-revoked')).toBeVisible({ timeout: 20_000 });
  const token = await signInRest(APPLICANT, 'applicant-password-1');
  expect((await readDoc(token, `users/${testerUid}`)).status, 'reading their own account').toBe(403);
  expect((await commit(token, `users/${testerUid}/summaries/x`, { label: str('again'), totals: { mapValue: { fields: Object.fromEntries(['inputTokens', 'outputTokens', 'sessions', 'tasks', 'tasksVerified', 'actions'].map((k) => [k, { integerValue: '1' }])) } }, rates: { mapValue: { fields: { criteriaPassing: { nullValue: null }, verificationRunsPassing: { nullValue: null } } } } }, ['savedAt'])).status, 'saving').toBe(403);
  expect((await commit(token, 'testerFeedback/x', { kind: str('bug'), message: str('still here?'), uid: str(testerUid) }, ['createdAt'])).status, 'tester feedback').toBe(403);
  expect((await commit(token, `members/${testerUid}`, { status: str('active') }, [], ['status'])).status, 'reinstating oneself').toBe(403);
  // The audit log has it all, and the review page is still closed to the tester.
  const audit = await ownerList('audit');
  expect(audit.map((a) => a.data.action)).toContain('revoke-member');
  await tpage.goto(`${SITE}/admin/`);
  await expect(tpage.getByTestId('admin-denied')).toBeVisible({ timeout: 20_000 });
  await row.getByTestId('reinstate-member').click();
  await expect(row.locator('.badge', { hasText: 'active' })).toBeVisible({ timeout: 15_000 });
  await tpage.goto(`${SITE}/install/`);
  await expect(tpage.getByTestId('install-steps')).toBeVisible({ timeout: 20_000 });
});

test('the administrator exports the applications, and a tester can withdraw their own application', async () => {
  await apage.goto(`${SITE}/admin/`);
  await expect(apage.getByTestId('admin')).toBeVisible({ timeout: 20_000 });
  const [dl] = await Promise.all([apage.waitForEvent('download'), apage.getByRole('button', { name: 'JSON' }).click()]);
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8')) as { email: string }[];
  expect(exported.map((e) => e.email)).toEqual(expect.arrayContaining([APPLICANT, 'second@example.com']));
  expect(exported.length).toBe((await ownerList('applications')).length);
  // The audit entry is written after the file is handed to the browser, so it can land a moment after the download event.
  await expect.poll(async () => (await ownerList('audit')).some((a) => a.data.action === 'export'), { timeout: 15_000, message: 'an export audit entry' }).toBe(true);
  await apage.getByRole('tab', { name: 'Insights' }).click();
  await expect(apage.getByTestId('insights')).toContainText('Windows');
  // The applicant deletes their own application; the membership record stays, as the privacy page says.
  const token = await signInRest(APPLICANT, 'applicant-password-1');
  expect((await fetch(`${DOCS}/applications/${APPLICANT_ID}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  expect(await ownerRead(`applications/${APPLICANT_ID}`)).toBeNull();
  expect((await ownerRead(`members/${testerUid}`))!.status).toBe('active');
});
