// Full-page screenshots of the main dashboard screens (demo mode, the built site) at desktop, tablet and phone widths.
//   node scripts/uat/screens.mjs <outDir> [label]
// Needs PLAYWRIGHT_BROWSERS_PATH=.pw-browsers and dist-pages built. One browser, one page at a time (low memory).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const out = resolve(process.argv[2] ?? 'docs/uat/ux-pr3');
const label = process.argv[3] ?? 'after';
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, SITE_ROOT: resolve('dist-pages'), SITE_PORT: '4303' }, stdio: 'ignore' });
await new Promise((ok) => setTimeout(ok, 2500));
const SCREENS = ['home', 'projects', 'sessions', 'workspace', 'agents', 'approvals', 'overview', 'settings'];
const SIZES = [['desktop', 1440, 900], ['tablet', 820, 1100], ['phone', 390, 844]];
const browser = await chromium.launch();
try {
  for (const theme of ['dark', 'light']) {
    for (const [device, width, height] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
      await ctx.addInitScript((t) => { try { localStorage.setItem('bl-theme', t); } catch { /* blocked */ } }, theme);
      const page = await ctx.newPage();
      for (const s of SCREENS) {
        await page.goto('about:blank');
        await page.goto(`http://127.0.0.1:4303/agentontrack/dashboard/?demo=1#${s}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(250);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        await page.screenshot({ path: join(out, `${label}-${s}-${device}-${theme}.png`), fullPage: true });
        if (over > 0) console.log('OVERFLOW', s, device, theme, over);
      }
      await ctx.close();
    }
  }
  console.log('done');
} finally { await browser.close(); server.kill(); }
