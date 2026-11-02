// The phone page and PWA files, on the published build WITHOUT accounts, in Android Chromium (Pixel) and iPhone WebKit profiles.
// These are Playwright DEVICE PROFILES (screen size, touch, user agent), not physical phones: a real Android or iPhone is recorded separately.
// The signed-in phone flow needs the Firebase emulators and is in phone.spec.ts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SITE = 'http://127.0.0.1:4199/agentontrack/dashboard';
test.skip(!!process.env.AOT_CONFIGURED_BUILD, 'This is about the build with no accounts.');

test('the phone address shows an honest "not switched on" page, not the desktop app, and never contacts Firebase', async ({ page }) => {
  const outside: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1')) outside.push(r.url()); });
  await page.goto(`${SITE}/?m=1`);
  await expect(page.getByRole('heading', { level: 2, name: 'Phone access is not switched on' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  expect(outside).toEqual([]);
});

test('it fits the screen in portrait and landscape, with no sideways scroll, and passes the accessibility check', async ({ page }) => {
  await page.goto(`${SITE}/?m=1`);
  for (const size of [{ width: 390, height: 800 }, { width: 800, height: 390 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(size);
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, `${size.width}x${size.height}`).toBeLessThanOrEqual(0);
  }
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')), JSON.stringify(r.violations.map((v) => v.id))).toEqual([]);
});

test('it can be installed: a manifest that points at real icons and starts on the phone page, and the tags iOS reads', async ({ page, request }) => {
  await page.goto(`${SITE}/?m=1`);
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(href).toBeTruthy();
  const m = await (await request.get(new URL(href!, page.url()).href)).json();
  expect(m).toMatchObject({ display: 'standalone', start_url: './?m=1', scope: './' });
  expect(m.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
  for (const icon of m.icons) {
    const res = await request.get(new URL(icon.src, new URL(href!, page.url())).href);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
  await expect(page.locator('link[rel=apple-touch-icon]')).toHaveCount(1);
  await expect(page.locator('meta[name=theme-color]')).toHaveCount(1);
  await expect(page.locator('meta[name=apple-mobile-web-app-capable]')).toHaveAttribute('content', 'yes');
});

test('the desktop app is unchanged at the usual address', async ({ page }) => {
  await page.goto(`${SITE}/?demo=1`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
});
