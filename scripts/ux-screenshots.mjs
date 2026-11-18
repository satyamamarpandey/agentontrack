// Before/after screenshots of the early-access and navigation changes, from two static builds served under the same base path.
//   node scripts/ux-screenshots.mjs <beforeDir> <afterDir> <outDir>
// Needs PLAYWRIGHT_BROWSERS_PATH=.pw-browsers. Uses the real built site; nothing is mocked.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [before, after, out] = process.argv.slice(2).map((p) => resolve(p));
mkdirSync(out, { recursive: true });
const serve = (root, port) => spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, SITE_ROOT: root, SITE_PORT: String(port) }, stdio: 'ignore' });
const servers = [serve(before, 4301), serve(after, 4302)];
await new Promise((ok) => setTimeout(ok, 2500));
const browser = await chromium.launch();
try {
  for (const [label, port] of [['before', 4301], ['after', 4302]]) {
    for (const [device, viewport] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 800 }]]) {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      const base = `http://127.0.0.1:${port}/agentontrack`;
      await page.goto(`${base}/`);
      await page.waitForTimeout(6500); // long enough for the old automatic popup, if there is one
      await page.screenshot({ path: join(out, `${label}-${device}-home-after-6s.png`) });
      if ((await page.getByTestId('early-access-dialog').count()) > 0) await page.keyboard.press('Escape');
      if (device === 'mobile') {
        await page.getByRole('button', { name: 'Menu' }).click();
        await page.screenshot({ path: join(out, `${label}-mobile-menu-open.png`) });
        await page.keyboard.press('Escape');
        await page.screenshot({ path: join(out, `${label}-mobile-menu-after-escape.png`) });
        console.log(label, 'menu expanded after Escape:', await page.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded'));
      } else {
        await page.getByTestId('hero-early-access').click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(out, `${label}-desktop-form-opened-by-button.png`) });
      }
      console.log(label, device, 'dialog on arrival (after dismissal step) done');
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
}
