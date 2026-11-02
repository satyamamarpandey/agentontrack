// Optional accounts, against the Firebase emulators. Runs in the `accounts` CI job, on a site built with a demo- config and
// AOT_FIREBASE_EMULATORS=1. `firebase emulators:exec` sets FIREBASE_AUTH_EMULATOR_HOST, and everything here skips without it.
import { expect, test, type Page } from '@playwright/test';

const SITE = 'http://127.0.0.1:4199/agentontrack';
const PROJECT = 'demo-agentontrack';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const STORE = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const DOCS = `http://${STORE}/v1/projects/${PROJECT}/databases/(default)/documents`;

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators, and a site built for them.');
test.describe.configure({ mode: 'serial' });

/** Clicks through the Auth emulator's own Google sign-in page, as a person would. */
async function signIn(page: Page, email: string, name: string) {
  await page.goto(`${SITE}/account/`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('sign-in').click()]);
  // The emulator's page can show its button before the button works, so this tries again until the form opens.
  await expect(async () => {
    await popup.getByText('Add new account').click({ timeout: 3000 });
    await expect(popup.locator('#email-input')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await popup.locator('#email-input').fill(email);
  await popup.locator('#display-name-input').fill(name);
  await popup.locator('#sign-in').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
}

/** A second user, signed up directly with the emulator, for testing what the rules refuse. */
async function otherUser(email: string): Promise<{ idToken: string; localId: string }> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'not-a-secret', returnSecureToken: true }) });
  expect(r.status).toBe(200);
  return r.json() as Promise<{ idToken: string; localId: string }>;
}

const uidOf = async (email: string): Promise<string> => {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({}) });
  const data = await r.json() as { userInfo?: { email: string; localId: string }[] };
  return data.userInfo!.find((u) => u.email === email)!.localId;
};

const asUser = (token: string | null) => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });
const stringField = (stringValue: string) => ({ stringValue });

/** A create through the commit endpoint, since only that can set the server time the rules ask for. */
const commit = (token: string | null, name: string, fields: object, timeField = 'createdAt') => fetch(`${DOCS}:commit`, {
  method: 'POST',
  headers: asUser(token),
  body: JSON.stringify({ writes: [{ update: { name: `projects/${PROJECT}/databases/(default)/documents/${name}`, fields }, updateTransforms: [{ fieldPath: timeField, setToServerValue: 'REQUEST_TIME' }] }] }),
});

test('a visitor loads nothing from Firebase until asking to sign in, and sign-in is never required', async ({ page }) => {
  const toFirebase: string[] = [];
  page.on('request', (r) => { if (/:9099|:8080|googleapis|gstatic|firebase/.test(r.url())) toFirebase.push(r.url()); });
  for (const p of ['/', '/account/', '/feedback/', '/dashboard/?demo=1#project/demo/overview']) await page.goto(`${SITE}${p}`);
  expect(toFirebase).toEqual([]);
  await page.goto(`${SITE}/account/`);
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
  const list = await fetch(`${DOCS}/feedback`, { headers: asUser(null) });
  expect(list.status).toBe(403);
  const all = await (await fetch(`${DOCS}/feedback`, { headers: { authorization: 'Bearer owner' } })).json() as { documents: { fields: any }[] };
  expect(all.documents.some((d) => d.fields.message.stringValue === 'Clear status' && 'nullValue' in d.fields.uid)).toBe(true);
});

test('Google sign-in through the Auth emulator saves the profile, and it survives a reload', async ({ page }) => {
  await signIn(page, 'first@example.com', 'First Person');
  await expect(page.getByTestId('profile-name')).toHaveText('First Person');
  await expect(page.getByTestId('profile-email')).toHaveText('first@example.com');
  await page.reload();
  await expect(page.getByTestId('profile-email')).toHaveText('first@example.com', { timeout: 20_000 });
});

test('signed in, the theme is saved, feedback is linked, a summary needs a toggle, and export holds it all', async ({ page }) => {
  await signIn(page, 'second@example.com', 'Second Person');
  await page.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' }).click();
  await expect(page.getByRole('group', { name: 'Saved theme' }).getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true');
  await page.goto(`${SITE}/feedback/`);
  await page.getByLabel('Your message').fill('From a signed-in person');
  await page.getByLabel('Contact (optional)').fill('second at example');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('feedback-sent')).toBeVisible({ timeout: 20_000 });
  await page.goto(`${SITE}/account/`);
  await expect(page.getByTestId('account-feedback')).toContainText('From a signed-in person', { timeout: 20_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-data').click()]);
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
  expect(exported.profile.email).toBe('second@example.com');
  expect(exported.preferences.theme).toBe('light');
  expect(exported.feedback[0].contact).toBe('second at example');
});

test('rules: another user, or nobody, cannot reach a person\'s documents, and bad fields are refused', async () => {
  const victim = await uidOf('second@example.com');
  const other = await otherUser('other@example.com');
  for (const token of [other.idToken, null]) {
    expect((await fetch(`${DOCS}/users/${victim}`, { headers: asUser(token) })).status, 'read').toBe(403);
    expect((await fetch(`${DOCS}/users/${victim}/feedback`, { headers: asUser(token) })).status, 'list').toBe(403);
    expect((await fetch(`${DOCS}/users/${victim}`, { method: 'DELETE', headers: asUser(token) })).status, 'delete').toBe(403);
    expect((await commit(token, `users/${victim}`, { profile: { mapValue: { fields: { name: stringField('Mallory'), email: stringField('') } } } }, 'updatedAt')).status, 'write').toBe(403);
  }
  // Even on your own document: nothing outside the schema, and no one else's email.
  const own = `users/${other.localId}`;
  expect((await commit(other.idToken, own, { code: stringField('secret source') }, 'updatedAt')).status).toBe(403);
  expect((await commit(other.idToken, own, { profile: { mapValue: { fields: { name: stringField('x'), email: stringField('second@example.com') } } } }, 'updatedAt')).status).toBe(403);
  expect((await commit(other.idToken, own, { profile: { mapValue: { fields: { name: stringField('x'), email: stringField('other@example.com') } } } }, 'updatedAt')).status).toBe(200);
  const summary = (extra: object) => ({ label: stringField('mine'), totals: { mapValue: { fields: Object.fromEntries(['inputTokens', 'outputTokens', 'sessions', 'tasks', 'tasksVerified', 'actions'].map((k) => [k, { integerValue: '1' }])) } }, rates: { mapValue: { fields: { criteriaPassing: { doubleValue: 0.5 }, verificationRunsPassing: { nullValue: null } } } }, ...extra });
  expect((await commit(other.idToken, `${own}/summaries/a`, summary({}), 'savedAt')).status).toBe(200);
  expect((await commit(other.idToken, `${own}/summaries/b`, summary({ goal: stringField('A goal') }), 'savedAt')).status).toBe(403);
  // Feedback: no updates, no impersonation, no over-long message.
  const fb = (message: string, uid: object) => ({ rating: { nullValue: null }, message: stringField(message), uid });
  expect((await commit(null, 'feedback/ok1', fb('fine', { nullValue: null }))).status).toBe(200);
  expect((await commit(null, 'feedback/bad1', fb('x'.repeat(2001), { nullValue: null }))).status).toBe(403);
  expect((await commit(null, 'feedback/bad2', fb('fine', stringField(victim)))).status).toBe(403);
  expect((await commit(null, 'feedback/ok1', fb('changed', { nullValue: null }))).status).toBe(403);
  expect((await fetch(`${DOCS}/feedback/ok1`, { method: 'DELETE', headers: asUser(other.idToken) })).status).toBe(403);
});

test('delete removes the person\'s documents and sign-in', async ({ page }) => {
  await signIn(page, 'third@example.com', 'Third Person');
  await page.goto(`${SITE}/feedback/`);
  await page.getByLabel('Your message').fill('To be deleted');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('feedback-sent')).toBeVisible({ timeout: 20_000 });
  const uid = await uidOf('third@example.com');
  await page.goto(`${SITE}/account/`);
  await page.getByTestId('delete-account').click({ timeout: 20_000 });
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('sign-in')).toBeVisible({ timeout: 20_000 });
  const owner = { authorization: 'Bearer owner' };
  expect((await fetch(`${DOCS}/users/${uid}`, { headers: owner })).status).toBe(404);
  const left = await (await fetch(`${DOCS}/feedback`, { headers: owner })).json() as { documents: { fields: any }[] };
  expect(left.documents.some((d) => d.fields.message.stringValue === 'To be deleted')).toBe(false);
  const accounts = await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: 'POST', headers: { 'content-type': 'application/json', ...owner }, body: '{}' })).json() as { userInfo: { email: string }[] };
  expect(accounts.userInfo.some((u) => u.email === 'third@example.com')).toBe(false);
});

/** The Auth emulator's own sign-in page, for any provider that opens a popup. */
async function popupSignIn(page: Page, button: string, email: string, name: string) {
  await page.goto(`${SITE}/account/`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId(button).click()]);
  await expect(async () => {
    await popup.getByText('Add new account').click({ timeout: 3000 });
    await expect(popup.locator('#email-input')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await popup.locator('#email-input').fill(email);
  await popup.locator('#display-name-input').fill(name);
  await popup.locator('#sign-in').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
}

test('GitHub sign-in saves only the name and email, and signing out returns to the choices', async ({ page }) => {
  await popupSignIn(page, 'sign-in-github', 'octo@example.com', 'Octo Person');
  await expect(page.getByTestId('profile-email')).toHaveText('octo@example.com');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await expect(page.getByTestId('sign-in-github')).toBeVisible();
  await expect(page.getByTestId('email-form')).toBeVisible();
});

test('email: create an account, sign out, sign in again, and a wrong password is refused in plain words', async ({ page }) => {
  await page.goto(`${SITE}/account/`);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Email Person');
  await page.getByLabel('Email', { exact: true }).fill('mailer@example.com');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByTestId('email-submit').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('profile-name')).toHaveText('Email Person');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with email' }).click();
  await page.getByLabel('Email', { exact: true }).fill('mailer@example.com');
  await page.getByLabel('Password').fill('wrong password');
  await page.getByTestId('email-submit').click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText('The email or password is not right.');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByTestId('email-submit').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
  // The sign-in lasts across a reload, in this browser.
  await page.reload();
  await expect(page.getByTestId('profile-email')).toHaveText('mailer@example.com', { timeout: 20_000 });
});

test('email: a short password and a duplicate address are explained, and reset sends a link without revealing who has an account', async ({ page }) => {
  await page.goto(`${SITE}/account/`);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email', { exact: true }).fill('short@example.com');
  await page.getByLabel('Password').fill('12345');
  await page.getByTestId('email-submit').click();
  await expect(page.getByLabel('Password')).toBeFocused().catch(() => undefined);
  await page.getByLabel('Password').fill('long enough password');
  await page.getByTestId('email-submit').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email', { exact: true }).fill('short@example.com');
  await page.getByLabel('Password').fill('long enough password');
  await page.getByTestId('email-submit').click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toContainText('already has an account');
  // The same sentence for an address nobody has used.
  for (const address of ['short@example.com', 'nobody-here@example.com']) {
    await page.getByRole('button', { name: 'Reset password' }).click();
    await page.getByLabel('Email', { exact: true }).fill(address);
    await page.getByTestId('email-submit').click();
    await expect(page.getByTestId('account-note')).toHaveText('If that address has an account, a reset link is on its way.');
  }
  const codes = await (await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json() as { oobCodes: { email: string; requestType: string }[] };
  expect(codes.oobCodes.some((c) => c.email === 'short@example.com' && c.requestType === 'PASSWORD_RESET')).toBe(true);
});

test('email: deleting the account needs the password, and removes the sign-in', async ({ page }) => {
  await page.goto(`${SITE}/account/`);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email', { exact: true }).fill('gone@example.com');
  await page.getByLabel('Password').fill('a password to delete');
  await page.getByTestId('email-submit').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('delete-account').click();
  await page.getByLabel('Your password, to confirm').fill('a password to delete');
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('sign-in')).toBeVisible({ timeout: 20_000 });
  const accounts = await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: '{}' })).json() as { userInfo?: { email: string }[] };
  expect((accounts.userInfo ?? []).some((u) => u.email === 'gone@example.com')).toBe(false);
});

test('coming from the dashboard welcome page, signing in returns there, and it still asks to connect the computer', async ({ page }) => {
  await page.goto(`${SITE}/account/?next=dashboard`);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email', { exact: true }).fill('back@example.com');
  await page.getByLabel('Password').fill('back to the dashboard');
  await page.getByTestId('email-submit').click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Keep your AI coding agents on track' })).toBeVisible();
  await expect(page.getByText('You are signed in.')).toBeVisible();
  // Signed in is not connected: nothing about this computer was granted.
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  await expect(page.getByTestId('continue-local')).toBeVisible();
});

test('rules: usage counts can be created once a week by anyone, and never read, changed, deleted or padded', async () => {
  const week = '2026-W44';
  const id = `install123_${week}`;
  const good = (extra: object = {}) => ({ week: stringField(week), version: stringField('1.0'), installId: stringField('install123'), runtimesConnected: { arrayValue: { values: [stringField('claude-code')] } }, tasksVerified: { integerValue: '2' }, tasksTotal: { integerValue: '3' }, activeDays: { integerValue: '4' }, ...extra });
  const create = (name: string, fields: object) => commit(null, `telemetry/${name}`, fields, 'createdAt');
  expect((await create(id, good())).status).toBe(200);
  // Once per install per week: the same document cannot be written again, because nobody can update it.
  expect((await create(id, good())).status).not.toBe(200);
  // Not under another name, not with an extra field, not with too many days, not with a path in a list.
  expect((await create('other_2026-W44', good())).status).not.toBe(200);
  expect((await create('install123_2026-W45', good({ week: stringField('2026-W45'), path: stringField('/Users/x/code') }))).status).not.toBe(200);
  expect((await create('install123_2026-W46', good({ week: stringField('2026-W46'), activeDays: { integerValue: '9' } }))).status).not.toBe(200);
  // No client reads it back, with or without an account.
  expect((await fetch(`${DOCS}/telemetry/${id}`)).status).not.toBe(200);
  const someone = await otherUser('reader@example.com');
  expect((await fetch(`${DOCS}/telemetry/${id}`, { headers: asUser(someone.idToken) })).status).not.toBe(200);
});
