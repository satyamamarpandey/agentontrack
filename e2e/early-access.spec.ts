// The early-access application on the public site, as a visitor meets it. Runs on every build: with no backend it validates and then says plainly
// that this copy of the site cannot store applications; the emulator spec covers what happens when it can.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SITE = 'http://127.0.0.1:4199/agentontrack';
const dialog = (page: Page) => page.getByTestId('early-access-dialog');

test('the application opens by itself about five seconds after arriving on the home page, once per session, and can be dismissed', async ({ page, browser }) => {
  await page.clock.install();
  await page.goto(`${SITE}/`);
  await expect(page.locator('html')).toHaveAttribute('data-ea-popup', 'armed'); // the page has hydrated and the timer is set
  await expect(dialog(page)).toHaveCount(0);
  await page.clock.fastForward(4500);
  await expect(dialog(page)).toHaveCount(0);
  await page.clock.fastForward(800);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('heading', { name: 'Get early access to AgentOnTrack' })).toBeVisible();
  // Focus is inside it, and the page behind cannot be used.
  await expect(dialog(page).locator(':focus')).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  // Dismissed once, it stays away for the session, even on a later visit to the home page.
  await page.goto(`${SITE}/features/`);
  await page.goto(`${SITE}/`);
  await expect(page.locator('html')).toHaveAttribute('data-ea-popup', 'off');
  await page.clock.fastForward(8000);
  await expect(dialog(page)).toHaveCount(0);
  // A new session sees it again.
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.clock.install();
  await p2.goto(`${SITE}/`);
  await expect(p2.locator('html')).toHaveAttribute('data-ea-popup', 'armed');
  await p2.clock.fastForward(5500);
  await expect(dialog(p2)).toBeVisible();
  await fresh.close();
});

test('it never interrupts someone who already applied here, is signed in, or is typing', async ({ page }) => {
  await page.clock.install();
  await page.goto(`${SITE}/features/`);
  await page.evaluate(() => localStorage.setItem('aot-ea-applied', 'AOT-TEST01'));
  await page.goto(`${SITE}/`);
  await expect(page.locator('html')).toHaveAttribute('data-ea-popup', 'off');
  await page.clock.fastForward(7000);
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(() => { localStorage.removeItem('aot-ea-applied'); localStorage.setItem('aot-signed-in', '1'); });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ea-popup', 'off');
  await page.clock.fastForward(7000);
  await expect(dialog(page)).toHaveCount(0);
  // Someone with a field focused is left alone.
  await page.evaluate(() => { localStorage.removeItem('aot-signed-in'); sessionStorage.removeItem('aot-ea-seen'); });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-ea-popup', 'armed');
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'busy'; document.body.append(i); i.focus(); });
  await page.clock.fastForward(7000);
  await expect(dialog(page)).toHaveCount(0);
});

test('the navigation and the hero open the same form; each step is checked; a copy with no backend says so instead of pretending', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1'));
  await page.goto(`${SITE}/`);
  await page.getByTestId('nav-early-access').click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByTestId('hero-early-access').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole('list', { name: 'Steps' }).locator('[aria-current="step"]')).toContainText('About you');

  // Step 1: nothing filled in.
  await d.getByTestId('ea-next').click();
  await expect(d.getByRole('alert').filter({ hasText: 'Enter your name.' })).toBeVisible();
  await expect(d.getByRole('alert').filter({ hasText: 'Enter your email address.' })).toBeVisible();
  await expect(d.getByLabel('Full name')).toBeFocused();
  await expect(d.getByLabel('Full name')).toHaveAttribute('aria-invalid', 'true');
  await d.getByLabel('Full name').fill('Test Person');
  await d.getByLabel('Email address').fill('not-an-address');
  await d.getByTestId('ea-next').click();
  await expect(d.getByRole('alert').filter({ hasText: 'does not look like an email address' })).toBeVisible();
  await d.getByLabel('Email address').fill('test.person@example.com');
  await d.getByTestId('ea-next').click();

  // Step 2: choices are required.
  await expect(d.getByRole('list', { name: 'Steps' }).locator('[aria-current="step"]')).toContainText('Your setup');
  await d.getByTestId('ea-next').click();
  await expect(d.getByRole('alert').filter({ hasText: 'Choose at least one operating system.' })).toBeVisible();
  await d.getByLabel('Windows', { exact: true }).check();
  await d.getByLabel('Claude Code', { exact: true }).check();
  await d.getByLabel('Other agentic AI tools').check();
  await d.getByTestId('ea-next').click();
  await expect(d.getByRole('alert').filter({ hasText: 'Name the other tools.' })).toBeVisible();
  await d.getByLabel('Which other tools?').fill('A home-grown runner');
  await d.getByLabel('How frequently do you use AI coding agents?').selectOption('daily');
  await d.getByTestId('ea-next').click();

  // Step 3: the privacy tick is required, the marketing tick is not and starts unticked.
  await expect(d.getByRole('list', { name: 'Steps' }).locator('[aria-current="step"]')).toContainText('Your goals');
  await expect(d.getByLabel(/occasional updates/)).not.toBeChecked();
  await d.getByTestId('ea-submit').click();
  await expect(d.getByRole('alert').filter({ hasText: 'Choose at least one.' })).toBeVisible();
  await expect(d.getByRole('alert').filter({ hasText: 'tick the box to apply' })).toBeVisible();
  await d.getByLabel('Human approval workflows').check();
  await d.getByLabel(/I have read the privacy notice/).check();
  // Back keeps what was typed.
  await d.getByTestId('ea-back').click();
  await expect(d.getByLabel('Which other tools?')).toHaveValue('A home-grown runner');
  await d.getByTestId('ea-next').click();
  await d.getByTestId('ea-submit').click();
  if (process.env.NEXT_PUBLIC_FIREBASE_CONFIG) {
    // A configured build with nothing listening fails honestly rather than claiming success; the emulator spec covers the real send.
    await expect(d.getByTestId('early-access-error').or(d.getByTestId('early-access-sent'))).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(d.getByTestId('early-access-error')).toContainText('cannot receive applications');
    await expect(d.getByTestId('early-access-sent')).toHaveCount(0);
  }
});

test('the dedicated page carries the same form, and the words never promise more than the product does', async ({ page }) => {
  await page.goto(`${SITE}/early-access/`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Test AgentOnTrack before it opens to everyone');
  await expect(page.getByTestId('early-access-form')).toBeVisible();
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const banned of ['be among the first', 'the first ', 'only platform', 'guaranteed', 'tamper-proof', 'testimonial', 'trusted by']) expect(text, banned).not.toContain(banned);
  await expect(page.locator('main')).toContainText('works once, for their address, and expires');
});

test('reduced motion is honoured: the dialog opens and closes without waiting for an animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1'));
  await page.goto(`${SITE}/`);
  await page.getByTestId('nav-early-access').click();
  await expect(dialog(page)).toBeVisible();
  const t0 = Date.now();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(Date.now() - t0).toBeLessThan(1500);
  // Focus returns to what opened it.
  await expect(page.getByTestId('nav-early-access')).toBeFocused();
});

test('the dialog fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1'));
  await page.goto(`${SITE}/`);
  await page.getByTestId('nav-early-access').click();
  await expect(dialog(page)).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
  const box = await dialog(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(360);
});

for (const theme of ['dark', 'light']) {
  test(`accessibility: the open application dialog has no serious axe violations (${theme})`, async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium', 'Axe runs once, in Chromium.');
    await page.addInitScript((t) => { localStorage.setItem('bl-theme', t); sessionStorage.setItem('aot-ea-seen', '1'); }, theme);
    await page.goto(`${SITE}/`);
    await page.getByTestId('nav-early-access').click();
    await expect(dialog(page)).toBeVisible();
    for (let step = 1; step <= 3; step++) {
      const r = await new AxeBuilder({ page }).include('[data-testid="early-access-dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `step ${step}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
      if (step === 1) { await dialog(page).getByLabel('Full name').fill('A'); await dialog(page).getByLabel('Email address').fill('a@b.cc'); }
      if (step === 2) { await dialog(page).getByLabel('Linux', { exact: true }).check(); await dialog(page).getByLabel('OpenAI Codex', { exact: true }).check(); await dialog(page).getByLabel('How frequently do you use AI coding agents?').selectOption('weekly'); }
      if (step < 3) await dialog(page).getByTestId('ea-next').click();
    }
  });
}
