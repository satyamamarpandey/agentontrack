// The public site exactly as it would be published: run `pnpm build:pages`, and this serves dist-pages under the same base path.
import AxeBuilder from '@axe-core/playwright';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const SITE = 'http://127.0.0.1:4199/agentontrack';
const PAGES = ['/', '/install/', '/features/', '/how-it-works/', '/integrations/', '/benchmarks/', '/security/', '/pricing/', '/docs/', '/community/', '/roadmap/', '/changelog/', '/feedback/', '/privacy/', '/terms/', '/account/', '/dashboard/'];

test('all pages load, with working navigation and no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  for (const p of PAGES) {
    const r = await page.goto(`${SITE}${p}`);
    expect(r?.status(), p).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, p).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
  await page.goto(`${SITE}/`);
  await page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/privacy/);
});

test('home shows the real recorded benchmark, its misses, and no invented adoption numbers', async ({ page }) => {
  const held = JSON.parse(readFileSync('benchmarks/results/heldout.json', 'utf8'));
  const full = held.results['C agentontrack full'];
  await page.goto(`${SITE}/`);
  await expect(page.locator('main')).toContainText(`${full.prevented} prevented, ${full.detectedAfter} detected afterwards, ${full.missed} missed`);
  await expect(page.locator('main')).toContainText('what has really been run');
  const text = (await page.locator('body').textContent())!.toLowerCase();
  for (const banned of ['testimonial', 'trusted by', 'zero hallucination', 'tamper-proof', 'guaranteed savings', 'stars on github']) expect(text).not.toContain(banned);
});

test('sends no third-party requests and sets no cookie for visitors', async ({ page, context }) => {
  const foreign: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:4199/') && !r.url().startsWith('data:')) foreign.push(r.url()); });
  for (const p of PAGES) await page.goto(`${SITE}${p}`);
  expect(foreign).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

test('with no config, the published build holds no Firebase code at all', async () => {
  test.skip(!!process.env.NEXT_PUBLIC_FIREBASE_CONFIG, 'This build has accounts.');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(name) && /identitytoolkit|firestore\.googleapis|firebaseapp/.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk('dist-pages');
  expect(hits).toEqual([]);
});

test('the home page has a clear way into projects, and the demo one is labelled', async ({ page }) => {
  await page.goto(`${SITE}/`);
  await expect(page.getByTestId('projects-entry')).toContainText('invented data');
  await page.getByTestId('demo-projects').click();
  await expect(page).toHaveURL(/dashboard\/\?demo=1#projects$/);
  await expect(page.getByTestId('demo-banner')).toContainText('Demo data');
  await expect(page.getByTestId('card-demo-label').first()).toHaveText('Demo data');
  await page.goto(`${SITE}/`);
  await page.getByTestId('open-projects').click();
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
});

test('the main menu opens on a small screen, and every link in it is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${SITE}/`);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Security' })).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await nav.getByRole('link', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/security\/$/);
});

test('with no config, there is no sign-in UI on any page', async ({ page }) => {
  test.skip(!!process.env.NEXT_PUBLIC_FIREBASE_CONFIG, 'This build has accounts.');
  await page.goto(`${SITE}/account/`);
  await expect(page.locator('main')).toContainText('no accounts');
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  await expect(page.getByTestId('nav-account')).toHaveCount(0);
  await page.goto(`${SITE}/dashboard/?demo=1#project/demo/overview`);
  await expect(page.getByTestId('project-panel-overview')).toBeVisible();
  await expect(page.getByTestId('summary-saver')).toHaveCount(0);
  await page.goto(`${SITE}/feedback/`);
  await expect(page.locator('main')).toContainText('public GitHub issue');
});

test('feedback refuses an empty or over-long message, and a contact goes in the issue only if given', async ({ page }) => {
  await page.goto(`${SITE}/feedback/`);
  await page.getByLabel('Your message').fill('   ');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('Write a message');
  await expect(page.getByLabel('Your message')).toHaveAttribute('maxlength', '2000');
  await expect(page.getByLabel('Contact (optional)')).toHaveAttribute('maxlength', '200');
  await page.getByLabel('Your message').fill('Fine');
  await page.getByLabel('Contact (optional)').fill('me at example');
  const [nav] = await Promise.all([page.waitForRequest((r) => r.url().includes('github.com')), page.getByRole('button', { name: 'Send' }).click()]);
  expect(decodeURIComponent(nav.url())).toContain('Contact: me at example');
});

test('theme toggle persists', async ({ page }) => {
  await page.goto(`${SITE}/`);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('no page offers accounts, sign-in or sync', async ({ page }) => {
  for (const p of PAGES.filter((x) => x !== '/dashboard/')) {
    await page.goto(`${SITE}${p}`);
    const t = (await page.locator('main').innerText()).toLowerCase();
    for (const banned of ['sign in', 'sign-in', 'create an account', 'if you turn on sync', 'accounts and sync are optional']) expect(t, `${p}: ${banned}`).not.toContain(banned);
  }
});

test('a published release links to its real files', async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_RELEASE_PUBLISHED !== '1', 'This build has no published release.');
  await page.goto(`${SITE}/install/`);
  await expect(page.getByTestId('release-state')).toHaveAttribute('data-published', 'true');
  await expect(page.getByTestId('download-unavailable')).toHaveCount(0);
  const hrefs = await page.getByTestId('download').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  expect(hrefs.length).toBeGreaterThanOrEqual(5);
  for (const h of hrefs) expect(h).toContain(`/releases/download/v${process.env.NEXT_PUBLIC_RELEASE_VERSION}/`);
});

test('an unpublished release is never presented as working', async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_RELEASE_PUBLISHED === '1', 'This build has a published release.');
  await page.goto(`${SITE}/install/`);
  const main = page.locator('main');
  await expect(page.getByTestId('release-state')).toHaveAttribute('data-published', 'false');
  await expect(page.getByTestId('release-state')).toContainText('awaiting publication, these will not work yet');
  await expect(main).toContainText('curl -fsSL https://pandeysatyam.com/agentontrack/install.sh | sh');
  await expect(main).toContainText('irm https://pandeysatyam.com/agentontrack/install.ps1 | iex');
  await expect(page.getByTestId('download-unavailable')).toHaveCount(6);
  await expect(page.getByTestId('download')).toHaveCount(0);
  const hrefs = await page.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  for (const p of ['/', '/install/', '/docs/', '/pricing/']) {
    await page.goto(`${SITE}${p}`);
    hrefs.push(...await page.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')));
  }
  expect(hrefs.filter((h) => /releases|\.tar\.gz|\.zip|SHA256SUMS/.test(h))).toEqual([]);

  await page.goto(`${SITE}/`);
  await expect(page.getByTestId('release-state')).toContainText('these will not work yet');
  await expect(page.getByTestId('home-download')).toHaveText('Download: not published yet');
  await page.getByRole('link', { name: 'Install', exact: true }).first().click();
  await expect(page).toHaveURL(/\/install\/$/);
  await page.goto(`${SITE}/`);
  await page.getByTestId('home-download').click();
  await expect(page).toHaveURL(/\/install\/#download$/);
  await expect(page.getByTestId('download-unavailable').first()).toBeVisible();
});

test('the install page covers every step, and the scripts are served as published', async ({ page, request }) => {
  await page.goto(`${SITE}/install/`);
  const main = page.locator('main');
  for (const text of ['sha256sum -c', 'Get-FileHash', 'agentontrack self upgrade', 'agentontrack self rollback', 'agentontrack self uninstall --purge', 'Troubleshooting', 'agentontrack setup', 'agentontrack goal set', 'agentontrack run codex', 'agentontrack approve', 'agentontrack verify', 'agentontrack dashboard']) await expect(main, text).toContainText(text);
  for (const name of ['install.sh', 'install.ps1']) {
    const r = await request.get(`${SITE}/${name}`);
    expect(r.status(), name).toBe(200);
    const got = await r.text();
    expect(got.replace(/\r\n/g, '\n')).toBe(readFileSync(`scripts/release/${name}`, 'utf8').replace(/\r\n/g, '\n'));
    if (name === 'install.sh') expect(got).not.toContain('\r');
  }
});

test('security states each runtime\'s failure mode and the limits', async ({ page }) => {
  await page.goto(`${SITE}/security/`);
  const fail = page.getByTestId('failure-table');
  await expect(fail.getByRole('row', { name: /Claude Code/ })).toContainText('Fails closed');
  await expect(fail.getByRole('row', { name: /Claude Code/ })).toContainText('Observed');
  await expect(fail.getByRole('row', { name: /Codex/ })).toContainText('FAILS OPEN');
  await expect(fail.getByRole('row', { name: /Hermes/ })).toContainText('Blocks');
  await expect(fail.getByRole('row', { name: /Hermes/ })).toContainText('scripted model');
  const all = page.getByTestId('coverage-table');
  for (const outcome of ['Protected', 'Detected', 'Not covered']) await expect(all.getByRole('cell', { name: outcome, exact: true }).first()).toBeVisible();
  await expect(all.getByRole('row', { name: /Network and process effects/ })).toContainText('Not covered');
  const main = page.locator('main');
  for (const text of ['External anchor', 'withhold VERIFIED', 'shows a code in your terminal']) await expect(main).toContainText(text);
});

test('integrations are searchable, and never call a blocked or MCP-only platform enforced', async ({ page }) => {
  await page.goto(`${SITE}/integrations/`);
  const rt = page.getByTestId('runtime-table');
  await expect(page.getByTestId('integration-cursor')).toHaveAttribute('data-status', 'BLOCKED');
  await expect(page.getByTestId('integration-kiro')).toHaveAttribute('data-status', 'BLOCKED');
  await expect(page.getByTestId('integration-continue')).toHaveAttribute('data-status', 'MCP_VERIFIED');
  await expect(page.getByTestId('integration-codex')).toContainText('RUNS THE ACTION');
  await expect(rt).not.toContainText('Fully Supported');
  await page.getByTestId('integration-search').fill('gemini');
  await expect(page.getByTestId('integration-gemini')).toBeVisible();
  await expect(page.getByTestId('integration-cursor')).toHaveCount(0);
  const models = page.getByTestId('model-table');
  await expect(models.getByRole('row', { name: /OpenAI/ })).toContainText('Not tested');
  await expect(models.getByRole('row', { name: /vLLM/ })).toContainText('Not tested');
});

test('benchmarks keep the negative results as recorded, claim no savings, and mark v4', async ({ page }) => {
  const m = JSON.parse(readFileSync('benchmarks/results/matched-v3.json', 'utf8'));
  await page.goto(`${SITE}/benchmarks/`);
  const t = page.getByTestId('matched-v3');
  for (const c of m.summary) {
    const row = t.getByRole('row', { name: new RegExp(`^${c.condition} `) });
    await expect(row).toContainText(`${Math.round(c.meanTokens)} ± ${Math.round(c.sdTokens)}`);
    await expect(row).toContainText(`${Math.round(c.passRate * 100)}%`);
  }
  await expect(page.locator('main')).toContainText('AgentOnTrack costs more, clearly');
  await expect(page.locator('main')).toContainText('No savings are claimed');
  const v4 = page.getByTestId('matched-v4');
  await expect(v4.getByRole('heading', { name: /v4/ })).toBeVisible();
  if (existsSync('benchmarks/results/matched-v4.json')) await expect(v4).toContainText('matched-v4.json');
  else await expect(v4).toContainText('Unavailable');
});

test('feedback builds a prefilled GitHub issue and does not pretend to submit', async ({ page }) => {
  await page.goto(`${SITE}/feedback/`);
  await page.getByRole('button', { name: 'Helpful', exact: true }).click();
  await page.getByLabel('What worked well?').fill('Clear status');
  await expect(page.locator('main')).toContainText('public GitHub issue');
  const [nav] = await Promise.all([page.waitForRequest((r) => r.url().includes('github.com')), page.getByRole('button', { name: 'Send' }).click()]);
  expect(nav.url()).toContain('/satyamamarpandey/agentontrack/issues/new');
  expect(decodeURIComponent(nav.url())).toContain('Clear status');
  expect(decodeURIComponent(nav.url())).toContain('Rating: helpful');
});

test('the demo shows weak checks and each runtime\'s failure mode, and changes nothing', async ({ page }) => {
  await page.goto(`${SITE}/dashboard/?demo=1#agents`);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Menu' });
  const go = async (name: string) => {
    if (await menu.isVisible() && (await menu.getAttribute('aria-expanded')) === 'false') await menu.click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true }).click();
  };
  await go('Agents');
  await expect(page.getByTestId('agent-codex').getByTestId('host-fail-mode')).toContainText('The action runs anyway');
  await expect(page.getByTestId('agent-hermes').getByTestId('host-fail-mode')).toContainText('The action is blocked');
  await expect(page.getByTestId('agent-hermes').getByTestId('containment')).toContainText('Nothing');
  await go('Goals');
  await page.getByRole('button', { name: 'Accept weak checks' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('This is the demo');
});

for (const theme of ['dark', 'light']) {
  test(`accessibility: no serious axe violations on any page (${theme})`, async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'Axe runs once, in Chromium.');
    await page.addInitScript((t) => localStorage.setItem('bl-theme', t), theme);
    for (const p of PAGES) {
      await page.goto(`${SITE}${p}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${p}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
    }
  });
}
