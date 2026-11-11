// Optional accounts, against the Firebase emulators. Runs in the `accounts` CI job, on a site built with a demo- config and
// AOT_FIREBASE_EMULATORS=1. `firebase emulators:exec` sets FIREBASE_AUTH_EMULATOR_HOST, and everything here skips without it.
// Early access makes accounts invitation-only: a sign-in on its own is a person with no documents. The invitation itself is covered by
// early-access-emulator.spec; here membership is granted outright where a test is about something else.
import { expect, test, type Page } from '@playwright/test';
import { AUTH, commit, DOCS, grantMembership, googlePopupSignIn, OWNER, PROJECT, readDoc, signUpRest, str, uidOf } from './emulator-helpers';

const SITE = 'http://127.0.0.1:4199/agentontrack';

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators, and a site built for them.');
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1')); });

async function signIn(page: Page, email: string, name: string) {
  await page.goto(`${SITE}/account/`);
  await googlePopupSignIn(page, email, name);
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
}
const summary = (extra: object) => ({ label: str('mine'), totals: { mapValue: { fields: Object.fromEntries(['inputTokens', 'outputTokens', 'sessions', 'tasks', 'tasksVerified', 'actions'].map((k) => [k, { integerValue: '1' }])) } }, rates: { mapValue: { fields: { criteriaPassing: { doubleValue: 0.5 }, verificationRunsPassing: { nullValue: null } } } }, ...extra });

test('a visitor loads nothing from Firebase until asking to sign in, and sign-in is never required', async ({ page }) => {
  const toFirebase: string[] = [];
  page.on('request', (r) => { if (/:9099|:8080|googleapis|gstatic|firebase/.test(r.url())) toFirebase.push(r.url()); });
  for (const p of ['/', '/account/', '/sign-in/', '/early-access/', '/feedback/', '/dashboard/?demo=1#project/demo/overview']) await page.goto(`${SITE}${p}`);
  expect(toFirebase).toEqual([]);
  await page.goto(`${SITE}/sign-in/`);
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await expect(page.getByTestId('signed-out')).toContainText('Google and Firebase become third parties');
  await page.goto(`${SITE}/privacy/`);
  await expect(page.locator('main')).toContainText('You never need an account');
});

test('feedback with no sign-in is stored, and cannot be read back', async ({ page }) => {
  await page.goto(`${SITE}/feedback/`);
  await page.getByRole('button', { name: 'Helpful', exact: true }).click();
  await page.getByLabel('What worked well?').fill('Clear status');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('feedback-sent')).toBeVisible({ timeout: 20_000 });
  expect((await fetch(`${DOCS}/feedback`)).status).toBe(403);
  const all = await (await fetch(`${DOCS}/feedback`, { headers: OWNER })).json() as { documents: { fields: any }[] };
  expect(all.documents.some((d) => d.fields.message.stringValue === 'Clear status' && 'nullValue' in d.fields.uid)).toBe(true);
});

test('a Google sign-in that was not invited is a person with no documents: the page says so, and the rules refuse its account writes', async ({ page }) => {
  await signIn(page, 'first@example.com', 'First Person');
  await expect(page.getByTestId('access-status')).toContainText('Not approved yet');
  await expect(page.getByTestId('profile-email')).toHaveText('first@example.com');
  const uid = await uidOf('first@example.com');
  expect((await fetch(`${DOCS}/users/${uid}`, { headers: OWNER })).status, 'no profile was written').toBe(404);
  // Its own token cannot write where only members may.
  const nobody = await signUpRest('nobody-yet@example.com');
  const token = nobody.idToken;
  const nobodyUid = nobody.localId;
  expect((await commit(token, `users/${nobodyUid}`, { profile: { mapValue: { fields: { name: str('x'), email: str('nobody-yet@example.com') } } } }, ['updatedAt'])).status).toBe(403);
  expect((await commit(token, `users/${nobodyUid}/summaries/a`, summary({}), ['savedAt'])).status).toBe(403);
  expect((await commit(token, `members/${nobodyUid}`, { email: str('nobody-yet@example.com'), inviteId: str('x'), applicationId: str('y'), status: str('active') }, ['joinedAt'])).status).toBe(403);
  // The sign-out returns to the choices.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('signed-out')).toBeVisible();
});

test('made a member, the same person\'s profile is saved, the theme persists, feedback is linked, and export holds it all', async ({ page }) => {
  await grantMembership('first@example.com');
  await signIn(page, 'first@example.com', 'First Person');
  await expect(page.getByTestId('access-status')).toContainText('Active tester', { timeout: 20_000 });
  await expect(page.getByTestId('profile-name')).toHaveText('First Person');
  await page.reload();
  await expect(page.getByTestId('profile-email')).toHaveText('first@example.com', { timeout: 20_000 });
  await page.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' }).click();
  await expect(page.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  // Feedback from a member goes to the tester form; the plain form still works for everyone else. Send a plain one from a signed-out tab.
  const uid = await uidOf('first@example.com');
  expect((await fetch(`${DOCS}/users/${uid}`, { headers: OWNER })).status).toBe(200);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-data').click()]);
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
  expect(exported.profile.email).toBe('first@example.com');
  expect(exported.preferences.theme).toBe('light');
});

test('rules: another user, or nobody, cannot reach a member\'s documents, and bad fields are refused', async () => {
  const victim = await uidOf('first@example.com');
  const other = await signUpRest('other@example.com');
  await grantMembership('other@example.com');
  for (const token of [other.idToken, null]) {
    expect((await readDoc(token, `users/${victim}`)).status, 'read').toBe(403);
    expect((await fetch(`${DOCS}/users/${victim}/feedback`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status, 'list').toBe(403);
    expect((await fetch(`${DOCS}/users/${victim}`, { method: 'DELETE', headers: token ? { authorization: `Bearer ${token}` } : {} })).status, 'delete').toBe(403);
    expect((await commit(token, `users/${victim}`, { profile: { mapValue: { fields: { name: str('Mallory'), email: str('') } } } }, ['updatedAt'])).status, 'write').toBe(403);
  }
  // Even on your own document: nothing outside the schema, and no one else's email.
  const own = `users/${other.localId}`;
  expect((await commit(other.idToken, own, { code: str('secret source') }, ['updatedAt'])).status).toBe(403);
  expect((await commit(other.idToken, own, { profile: { mapValue: { fields: { name: str('x'), email: str('first@example.com') } } } }, ['updatedAt'])).status).toBe(403);
  expect((await commit(other.idToken, own, { profile: { mapValue: { fields: { name: str('x'), email: str('other@example.com') } } } }, ['updatedAt'])).status).toBe(200);
  expect((await commit(other.idToken, `${own}/summaries/a`, summary({}), ['savedAt'])).status).toBe(200);
  expect((await commit(other.idToken, `${own}/summaries/b`, summary({ goal: str('A goal') }), ['savedAt'])).status).toBe(403);
  // Feedback: no updates, no impersonation, no over-long message.
  const fb = (message: string, uid: object) => ({ rating: { nullValue: null }, message: str(message), uid });
  expect((await commit(null, 'feedback/ok1', fb('fine', { nullValue: null }), ['createdAt'])).status).toBe(200);
  expect((await commit(null, 'feedback/bad1', fb('x'.repeat(2001), { nullValue: null }), ['createdAt'])).status).toBe(403);
  expect((await commit(null, 'feedback/bad2', fb('fine', str(victim)), ['createdAt'])).status).toBe(403);
  expect((await commit(null, 'feedback/ok1', fb('changed', { nullValue: null }), ['createdAt'])).status).toBe(403);
  expect((await fetch(`${DOCS}/feedback/ok1`, { method: 'DELETE', headers: { authorization: `Bearer ${other.idToken}` } })).status).toBe(403);
});

test('delete removes a member\'s documents and sign-in', async ({ page }) => {
  await signIn(page, 'third@example.com', 'Third Person');
  await grantMembership('third@example.com');
  await page.reload();
  await expect(page.getByTestId('access-status')).toContainText('Active tester', { timeout: 20_000 });
  const uid = await uidOf('third@example.com');
  expect((await fetch(`${DOCS}/users/${uid}`, { headers: OWNER })).status).toBe(200);
  await page.getByTestId('delete-account').click({ timeout: 20_000 });
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('sign-in')).toBeVisible({ timeout: 20_000 });
  expect((await fetch(`${DOCS}/users/${uid}`, { headers: OWNER })).status).toBe(404);
  const accounts = await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: 'POST', headers: { 'content-type': 'application/json', ...OWNER }, body: '{}' })).json() as { userInfo: { email: string }[] };
  expect(accounts.userInfo.some((u) => u.email === 'third@example.com')).toBe(false);
});

test('email: a wrong password is refused in plain words, the eye shows the password, and reset sends a link without revealing who has an account', async ({ page }) => {
  await signUpRest('mailer@example.com', 'correct horse battery');
  await page.goto(`${SITE}/sign-in/`);
  await page.getByLabel('Email', { exact: true }).fill('mailer@example.com');
  await page.getByLabel('Password', { exact: true }).fill('wrong password');
  await page.getByTestId('email-submit').click();
  await expect(page.getByTestId('signin-error')).toHaveText('The email or password is not right.');
  await page.getByTestId('toggle-password').click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await page.getByTestId('email-submit').click();
  await page.waitForURL(/\/account\//, { timeout: 30_000 });
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('access-status')).toContainText('Not approved yet');
  await page.getByRole('button', { name: 'Sign out' }).click();
  // The same sentence for an address nobody has used.
  for (const address of ['mailer@example.com', 'nobody-here@example.com']) {
    await page.goto(`${SITE}/sign-in/`);
    await page.getByRole('button', { name: 'Reset password' }).click();
    await page.getByLabel('Email', { exact: true }).fill(address);
    await page.getByTestId('email-submit').click();
    await expect(page.getByTestId('account-note')).toHaveText('If that address has an account, a reset link is on its way.');
  }
  const codes = await (await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json() as { oobCodes: { email: string; requestType: string }[] };
  expect(codes.oobCodes.some((c) => c.email === 'mailer@example.com' && c.requestType === 'PASSWORD_RESET')).toBe(true);
  // There is no "create an account" on the sign-in page: accounts come from invitations.
  await page.goto(`${SITE}/sign-in/`);
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Accounts are created from an invitation');
});

test('coming from the dashboard welcome page, signing in returns there; without approval the connection step stays closed and the demo stays open', async ({ page }) => {
  await page.goto(`${SITE}/sign-in/?next=dashboard`);
  await googlePopupSignIn(page, 'back@example.com', 'Back Person');
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Keep your AI coding agents on track' })).toBeVisible();
  await expect(page.getByText('You are signed in.')).toBeVisible();
  await expect(page.getByTestId('gate-not-approved')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  await expect(page.getByTestId('continue-local')).toHaveCount(0);
  await expect(page.getByTestId('explore-demo')).toBeVisible();
  // Approved, the same page offers the connection, and still asks to connect the computer: nothing about this computer was granted by signing in.
  await grantMembership('back@example.com');
  await page.reload();
  await expect(page.getByTestId('continue-local')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('continue-local').click();
  await expect(page.getByRole('heading', { name: 'Connect this computer' })).toBeVisible();
});

test('rules: usage counts can be created once a week by anyone, and never read, changed, deleted or padded', async () => {
  const week = '2026-W44';
  const id = `install123_${week}`;
  const good = (extra: object = {}) => ({ week: str(week), version: str('1.0'), installId: str('install123'), runtimesConnected: { arrayValue: { values: [str('claude-code')] } }, tasksVerified: { integerValue: '2' }, tasksTotal: { integerValue: '3' }, activeDays: { integerValue: '4' }, ...extra });
  const create = (name: string, fields: object) => commit(null, `telemetry/${name}`, fields, ['createdAt']);
  expect((await create(id, good())).status).toBe(200);
  // Once per install per week: the same document cannot be written again, because nobody can update it.
  expect((await create(id, good())).status).not.toBe(200);
  // Not under another name, not with an extra field, not with too many days, not with a path in a list.
  expect((await create('other_2026-W44', good())).status).not.toBe(200);
  expect((await create('install123_2026-W45', good({ week: str('2026-W45'), path: str('/Users/x/code') }))).status).not.toBe(200);
  expect((await create('install123_2026-W46', good({ week: str('2026-W46'), activeDays: { integerValue: '9' } }))).status).not.toBe(200);
  // No client reads it back, with or without an account.
  expect((await fetch(`${DOCS}/telemetry/${id}`)).status).not.toBe(200);
  const someone = await signUpRest('reader@example.com');
  expect((await fetch(`${DOCS}/telemetry/${id}`, { headers: { authorization: `Bearer ${someone.idToken}` } })).status).not.toBe(200);
});
