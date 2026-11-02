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

test.skip(!process.env.AOT_CONFIGURED_BUILD, 'Needs a site built with a config, and AOT_CONFIGURED_BUILD=1.');

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

test('offers sign-in, but a visitor loads no Firebase code and sends nothing outside until asking', async ({ page }) => {
  const seen = await watch(page);
  for (const p of ['/', '/account/', '/feedback/', '/privacy/', '/install/', '/dashboard/?demo=1#project/demo/overview']) await page.goto(`${SITE}${p}`);
  expect(seen.outside).toEqual([]);
  expect(seen.firebaseCode).toEqual([]);

  await page.goto(`${SITE}/`);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account', includeHidden: true })).toHaveCount(1);
  await page.goto(`${SITE}/account/`);
  await expect(page.getByTestId('signed-out')).toContainText('Google and Firebase become third parties');
  await page.getByTestId('sign-in').click();
  await expect.poll(() => seen.firebaseCode.length).toBeGreaterThan(0);
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

test('privacy and security say what accounts store, and that they are optional', async ({ page }) => {
  await page.goto(`${SITE}/privacy/`);
  const main = page.locator('main');
  for (const text of ['You never need an account', 'Google and Firebase become third parties', 'never sent', 'Export or delete']) await expect(main).toContainText(text);
  await page.goto(`${SITE}/security/`);
  await expect(page.locator('main')).toContainText('Optional accounts');
});

test('the project summary is off by default, and its preview holds only counts and the typed label', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'aot-acct-'));
  const root = join(dir, 'private-folder-name');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  const p = new Project(root);
  p.human.setGoal({ statement: 'A private goal', scope: { include: ['src/**'] }, prohibit: ['deploy'] });
  p.human.createTask({ id: 't1', title: 'A private task', criteria: [{ id: 'c', description: 'npm run private-check', kind: 'artifact', path: 'src/a.txt' }] });
  p.verifyTask('t1');
  p.recordUsage({ runtime: 'claude-code', model: 'test-model', source: 'provider-reported', sessionId: 's', inputTokens: 100, outputTokens: 420 });
  p.close();
  const c = await startCompanion({ root, allowedOrigins: [ORIGIN] });
  try {
    const seen = await watch(page);
    await page.goto(`${SITE}/dashboard/`);
    await page.getByLabel('Companion port').fill(String(c.port));
    await page.getByLabel('Pairing code').fill(c.newPairingCode());
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.getByTestId('project-card').getByRole('button').click();
    const saver = page.getByTestId('summary-saver');
    await expect(saver).toContainText('Sign in on the account page');
    await expect(saver.getByRole('link')).toHaveAttribute('rel', 'noopener');

    await page.evaluate(() => localStorage.setItem('aot-signed-in', '1'));
    await page.reload();
    const toggle = page.getByTestId('summary-toggle');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('summary-preview')).toHaveCount(0);
    await toggle.check();
    await expect(saver.getByRole('button', { name: 'Save summary' })).toBeDisabled();
    await page.getByTestId('summary-label').fill('my label');
    const preview = JSON.parse((await page.getByTestId('summary-preview').textContent())!);
    expect(preview).toEqual({
      label: 'my label',
      totals: { inputTokens: 100, outputTokens: 420, sessions: 1, tasks: 1, tasksVerified: expect.any(Number), actions: 0 },
      rates: { criteriaPassing: 1, verificationRunsPassing: 1 },
    });
    expect(JSON.stringify(preview)).not.toMatch(/private|src|npm/);
    // Nothing outside yet, and no Firebase code in the page that holds the companion session.
    expect(seen.outside).toEqual([]);
    expect(seen.firebaseCode).toEqual([]);
    await saver.getByRole('button', { name: 'Save summary' }).click();
    await expect.poll(() => seen.firebaseCode.length).toBeGreaterThan(0);
    // Google's sign-in script is never asked for from this page.
    expect(seen.outside.filter((u) => /apis\.google\.com|gstatic/.test(u))).toEqual([]);
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
