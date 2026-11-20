// Screenshots of the first-run path on the built site: homepage, welcome, connect (before and after the check, nothing running), and the phone page.
//   node scripts/uat/first-run.mjs <outDir> <label>      needs PLAYWRIGHT_BROWSERS_PATH=.pw-browsers and dist-pages
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const out = resolve(process.argv[2] ?? 'docs/uat/ux-pr4');
const label = process.argv[3] ?? 'after';
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, SITE_ROOT: resolve('dist-pages'), SITE_PORT: '4307' }, stdio: 'ignore' });
await new Promise((ok) => setTimeout(ok, 2500));
const base = 'http://127.0.0.1:4307/agentontrack';
const browser = await chromium.launch();
try {
  for (const [device, width, height] of [['desktop', 1280, 800], ['phone', 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: join(out, `${label}-${device}-${name}.png`), fullPage: true }); };
    await page.goto(`${base}/`); await page.waitForTimeout(1500); await shot('1-homepage');
    await page.goto(`${base}/dashboard/`); await page.waitForLoadState('networkidle').catch(() => undefined); await shot('2-welcome');
    await page.goto(`${base}/dashboard/?connect`); await page.waitForLoadState('networkidle').catch(() => undefined); await shot('3-connect-before-check');
    await page.getByTestId('retry').click().catch(() => undefined);
    await page.waitForTimeout(9000); await shot('4-connect-not-found');
    await page.goto(`${base}/dashboard/?m=1`); await page.waitForLoadState('networkidle').catch(() => undefined); await shot('5-phone-page');
    await ctx.close();
  }
  console.log('done');
} finally { await browser.close(); server.kill(); }
