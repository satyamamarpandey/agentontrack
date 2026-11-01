import { expect, test } from '@playwright/test';

// BASE is the local test server before deployment, and the real public URL afterwards.
const BASE = (process.env.SITE_URL ?? 'http://127.0.0.1:4173/agentontrack').replace(/\/$/, '');
const PAGES = ['', 'features', 'how-it-works', 'integrations', 'benchmarks', 'security', 'pricing', 'docs', 'community', 'roadmap', 'changelog', 'feedback', 'privacy', 'terms'];
const SCREENS = ['Overview', 'Projects', 'Goals', 'Agents', 'Usage', 'Comparisons', 'Evidence', 'Safety', 'Approvals', 'Evaluations', 'Environment', 'Feedback', 'Settings'];

async function go(page, name) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible() && (await menu.getAttribute('aria-expanded')) === 'false') await menu.click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();
}

test('every page loads with its assets, with no errors and no page overflow', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  for (const p of PAGES) {
    const r = await page.goto(`${BASE}/${p}${p ? '/' : ''}`);
    expect(r.status(), p).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('body')).toContainText('AgentOnTrack');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), p).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('navigation works under the base path', async ({ page, isMobile }) => {
  await page.goto(`${BASE}/`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' }).click();
  await expect(page).toHaveURL(/\/agentontrack\/docs\/$/);
  await expect(page.getByRole('heading', { name: 'Install' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/agentontrack\/privacy\/$/);
  await page.getByRole('link', { name: 'AgentOnTrack', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('right task');
  expect(isMobile === true || isMobile === false).toBe(true);
});

test('sends nothing to any third party, and sets no cookies', async ({ page, context }) => {
  const host = new URL(BASE).host;
  const foreign = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.host !== host) foreign.push(r.url()); });
  for (const p of PAGES) await page.goto(`${BASE}/${p}${p ? '/' : ''}`);
  expect(foreign).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

test('makes no unsupported claims', async ({ page }) => {
  let text = '';
  for (const p of PAGES) { await page.goto(`${BASE}/${p}${p ? '/' : ''}`); text += ` ${await page.locator('body').textContent()}`; }
  const t = text.toLowerCase();
  for (const banned of ['testimonial', 'trusted by', 'zero hallucination', 'tamper-proof', 'guaranteed savings', 'saves tokens', 'open source under', 'bindline', 'independently validated']) expect(t, banned).not.toContain(banned);
  expect(t).toContain('free');
  expect(t).toContain('is private during the preview');
});

test('the demo dashboard shows all screens, always labelled as demo', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/dashboard/?demo=1`);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  for (const s of SCREENS) {
    await go(page, s);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), s).toBeLessThanOrEqual(1);
  }
  await go(page, 'Usage');
  await expect(page.getByText('Actual: provider-reported')).toHaveCount(0);
  await expect(page.getByText('Demo data', { exact: true }).first()).toBeVisible();
  await go(page, 'Environment');
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('demo buttons explain themselves, and change nothing', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/?demo=1`);
  await go(page, 'Agents');
  await page.getByRole('button', { name: 'Disconnect' }).first().click();
  await expect(page.getByRole('alert')).toContainText('This is the demo');
  await go(page, 'Comparisons');
  await expect(page.getByText('Controlled benchmark').first()).toBeVisible();
});

test('the dashboard offers pairing, says plainly when no companion answers, and has a demo way in', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/`);
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  await page.getByLabel('Companion port').fill('1');
  await page.getByLabel('Pairing code').fill('ABCDEFGH');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'View the demo instead' }).click();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
});

test('feedback builds a GitHub issue link rather than pretending to submit', async ({ page }) => {
  await page.goto(`${BASE}/feedback/`);
  await page.getByRole('button', { name: 'Not helpful' }).click();
  await page.getByLabel('What should we improve?').fill('A test message');
  await expect(page.locator('main')).toContainText('public GitHub issue');
  const [nav] = await Promise.all([page.waitForRequest((r) => r.url().includes('github.com')), page.getByRole('button', { name: 'Send' }).click()]);
  expect(nav.url()).toContain('/satyamamarpandey/agentontrack/issues/new');
  expect(nav.url()).toContain('A%20test%20message');
});

test('installation instructions are present and honest about access', async ({ page }) => {
  await page.goto(`${BASE}/docs/`);
  await expect(page.locator('main')).toContainText('agentontrack install claude-code');
  await expect(page.locator('main')).toContainText('Preview access');
  await expect(page.locator('main')).toContainText('--allow-public-site');
});
