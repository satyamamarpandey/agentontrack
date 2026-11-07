// The privacy page must not claim more than is true. These run on the default build, which has no Firebase config (as the CI browser jobs build it); the
// accounts-configured spec covers the other variant, and the Firebase-emulator job does not run this file.
import { expect, test } from '@playwright/test';

const SITE = 'http://127.0.0.1:4199/agentontrack';

test('the privacy page no longer says nothing leaves the machine, or that there are no accounts or telemetry', async ({ page }) => {
  await page.goto(`${SITE}/privacy/`);
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const claim of ['Nothing leaves your machine', 'no accounts, no analytics, no telemetry', 'no server of ours to send anything to']) expect(text).not.toContain(claim);
});

test('the privacy page says what stays local and what the agents send to their providers', async ({ page }) => {
  await page.goto(`${SITE}/privacy/`);
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const part of [
    'No AgentOnTrack account is required for local use',
    'does not upload your local project records',
    'unless you choose to send them',
    'When you use Claude Code or Codex, what the agent reads, writes and runs is processed by that provider',
    'under its own login and terms',
    'does not see, proxy or store that login',
  ]) expect(text).toContain(part);
});

test('the privacy page says this build has no optional cloud features', async ({ page }) => {
  await page.goto(`${SITE}/privacy/`);
  await expect(page.locator('main')).toContainText('This build of the site has no optional cloud features');
});

test('the privacy page keeps what it said about hosting, downloads, pairing, anchors and feedback', async ({ page }) => {
  await page.goto(`${SITE}/privacy/`);
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const part of [
    'download release files from GitHub',
    'sends the log\'s latest hash, sequence number and time to the git remote you chose',
    'calls the model address you give it',
    'served by GitHub Pages',
    'sets no cookies and runs no analytics',
    'GitHub, which hosts it, may keep its own server logs',
    'it talks only to the companion on your own computer',
    'Feedback opens a prefilled GitHub issue',
  ]) expect(text).toContain(part);
});
