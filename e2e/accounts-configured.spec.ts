// A site built WITH a Firebase config, with no Firebase reachable and no emulator: what the page does before anything reaches Firebase.
// Build with a dummy config, then run with AOT_CONFIGURED_BUILD=1. Every request away from this machine is aborted and recorded, so this contacts nothing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startCompanion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';

const ORIGIN = 'http://127.0.0.1:4199';
const SITE = `${ORIGIN}/agentontrack`;
const GATED = process.env.NEXT_PUBLIC_INSTALL_PUBLIC !== '1';

test.skip(!process.env.AOT_CONFIGURED_BUILD, 'Needs a site built with a config, and AOT_CONFIGURED_BUILD=1.');
test.beforeEach(async ({ page }) => { await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1')); });

/** Firebase's module chunks and any request to a Firebase or Google host. */
async function watch(page: Page) {
  const outside: string[] = [];
  const firebaseCode: string[] = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('data:')) return route.continue();
    if (!url.startsWith(ORIGIN) && !url.startsWith('http://127.0.0.1')) { outside.push(url); return route.abort(); }
    if (/\.js(\?|$)/.test(url) && url.startsWith(ORIGIN)) {
      const r = await route.fetch();
      if (/identitytoolkit|firestore\.googleapis/.test(await r.text())) firebaseCode.push(url);
      return route.fulfill({ response: r });
    }
    return route.continue();
  });
  return { outside, firebaseCode };
}

test('offers sign-in and early access, but a visitor loads no Firebase code and sends nothing outside until asking', async ({ page }) => {
  const seen = await watch(page);
  for (const p of ['/', '/account/', '/sign-in/', '/early-access/', '/feedback/', '/privacy/', '/install/', '/dashboard/?demo=1#project/demo/overview']) await page.goto(`${SITE}${p}`);
  expect(seen.outside).toEqual([]);
  expect(seen.firebaseCode).toEqual([]);

  await page.goto(`${SITE}/`);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account', includeHidden: true })).toHaveCount(1);
  await expect(page.getByTestId('nav-signin')).toHaveAttribute('href', /\/sign-in\/$/);
  await expect(page.getByTestId('nav-early-access')).toBeVisible();
  await page.goto(`${SITE}/sign-in/`);
  await expect(page.getByTestId('signed-out')).toContainText('Google and Firebase become third parties');
  await page.getByTestId('sign-in').click();
  await expect.poll(() => seen.firebaseCode.length).toBeGreaterThan(0);
});

test('the header offers Account, not Sign in, to a browser that has signed in, and loads no Firebase code to decide', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`${SITE}/`);
  await expect(page.getByTestId('nav-signin')).toBeVisible();
  await expect(page.getByTestId('nav-account-action')).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('aot-signed-in', '1'));
  await page.goto(`${SITE}/features/`);
  await expect(page.getByTestId('nav-account-action')).toHaveAttribute('href', /\/account\/$/);
  await expect(page.getByTestId('nav-account-action')).toHaveText('Account');
  await expect(page.getByTestId('nav-signin')).toHaveCount(0);
  // Signing out in another tab is picked up without a reload.
  await page.evaluate(() => { localStorage.removeItem('aot-signed-in'); window.dispatchEvent(new StorageEvent('storage', { key: 'aot-signed-in' })); });
  await expect(page.getByTestId('nav-signin')).toBeVisible();
  expect(seen.firebaseCode).toEqual([]);
});

test('the application form loads nothing until it is sent, and a send that cannot reach Firebase fails honestly', async ({ page }) => {
  const seen = await watch(page);
  // In the emulator job Firebase answers on 127.0.0.1; this test is about the case where nothing answers, so those ports are cut as well.
  await page.route(/127\.0\.0\.1:(8080|9099)\//, (route) => route.abort());
  await page.goto(`${SITE}/early-access/`);
  const f = page.getByTestId('early-access-form');
  await f.getByLabel('Full name').fill('Config Person');
  await f.getByLabel('Email address').fill('config@example.com');
  await f.getByTestId('ea-next').click();
  await f.getByLabel('macOS', { exact: true }).check();
  await f.getByLabel('OpenAI Codex', { exact: true }).check();
  await f.getByLabel('How frequently do you use AI coding agents?').selectOption('weekly');
  await f.getByTestId('ea-next').click();
  await f.getByLabel('Sandbox testing').check();
  await f.getByLabel(/I have read the privacy notice/).check();
  expect(seen.firebaseCode).toEqual([]);
  await f.getByTestId('ea-submit').click();
  await expect.poll(() => seen.firebaseCode.length).toBeGreaterThan(0);
  await expect(page.getByTestId('early-access-error')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('early-access-sent')).toHaveCount(0);
});

test('feedback says where it goes, and sends only on Send', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`${SITE}/feedback/`);
  await expect(page.locator('main')).toContainText('Send stores');
  await expect(page.locator('main')).not.toContainText('public GitHub issue');
  await page.getByLabel('Your message').fill('Hello');
  expect(seen.firebaseCode).toEqual([]);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => seen.firebaseCode.length).toBeGreaterThan(0);
});

test('privacy, terms and security say what accounts and early access store, and that the program needs none of it', async ({ page }) => {
  await page.goto(`${SITE}/privacy/`);
  const main = page.locator('main');
  for (const text of ['You never need an account', 'Google and Firebase become third parties', 'never sent', 'Export or delete']) await expect(main).toContainText(text);
  const all = (await main.innerText()).replace(/\s+/g, ' ');
  for (const text of ['optional cloud features that can send data', 'experimental', 'Phone control', 'signed and encrypted with keys Firebase never sees', 'has not been run on a physical phone', 'Anonymous usage counts', 'off unless you turn them on', 'cannot be deleted once sent', 'No AgentOnTrack account is required for local use', 'processed by that provider',
    'Applying.', 'One application is kept per address', 'nothing is pre-ticked', 'Invitations.', 'one-way hash', 'Withdrawing.', 'audit log']) expect(all).toContain(text);
  for (const claim of ['Nothing leaves your machine', 'no telemetry', 'no server of ours to send anything to']) expect(all).not.toContain(claim);
  await page.goto(`${SITE}/security/`);
  await expect(page.locator('main')).toContainText('Optional accounts and early access');
  await expect(page.locator('main')).toContainText('one-way hashes');
  await page.goto(`${SITE}/terms/`);
  await expect(page.locator('main')).toContainText('No hosted execution');
  if (GATED) await expect(page.locator('main')).toContainText('invited testers');
});

test('a visitor meets the early-access gate on the install page and on this site\'s dashboard, and the local address still pairs', async ({ page }) => {
  test.skip(!GATED, 'Installs are public in this build.');
  const seen = await watch(page);
  await page.goto(`${SITE}/install/`);
  await expect(page.getByTestId('install-gate')).toBeVisible();
  await expect(page.getByTestId('install-signin')).toHaveAttribute('href', /\/sign-in\/\?next=install$/);
  await expect(page.locator('main')).not.toContainText('irm https://');
  await expect(page.locator('main')).toContainText('source and releases are public on GitHub');
  await page.goto(`${SITE}/dashboard/`);
  await expect(page.getByRole('heading', { name: 'Keep your AI coding agents on track' })).toBeVisible();
  await expect(page.getByTestId('gate-signed-out')).toBeVisible();
  await expect(page.getByTestId('gate-signin')).toHaveAttribute('href', /\/sign-in\/\?next=dashboard$/);
  await expect(page.getByTestId('continue-local')).toHaveCount(0);
  expect(seen.firebaseCode).toEqual([]);
  // A signed-in person whose status cannot be checked (nothing answers) is treated as signed out, not let through.
  await page.evaluate(() => localStorage.setItem('aot-signed-in', '1'));
  await page.reload();
  await expect(page.getByTestId('gate-signed-out')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('continue-local')).toHaveCount(0);

  // The companion's own address needs no account and no site at all.
  const dir = mkdtempSync(join(tmpdir(), 'aot-acct-'));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  const p = new Project(root);
  p.human.setGoal({ statement: 'A goal', scope: { include: ['src/**'] } });
  p.close();
  const c = await startCompanion({ root, allowedOrigins: [ORIGIN] });
  try {
    await page.goto(c.url);
    await expect(page.getByRole('heading', { name: 'Connect this computer' })).toBeVisible();
    await page.getByLabel('Pairing code').fill(c.newPairingCode());
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByTestId('project-card')).toBeVisible();
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
