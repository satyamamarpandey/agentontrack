// Names the elements that make a page wider than the screen. A debugging aid for the UAT sweep (e2e/uat-sweep.spec.ts).
//   node scripts/uat/find-overflow.mjs <path under /agentontrack, e.g. "/dashboard/?demo=1#evaluations"> [width=320] [siteRoot=dist-pages]
// Needs PLAYWRIGHT_BROWSERS_PATH=.pw-browsers and a built site.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const [path = '/', width = '320', root = 'dist-pages'] = process.argv.slice(2);
const server = spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, SITE_ROOT: root, SITE_PORT: '4305' }, stdio: 'ignore' });
await new Promise((ok) => setTimeout(ok, 2000));
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: Number(width), height: 900 } })).newPage();
  await page.goto(`http://127.0.0.1:4305/agentontrack${path}`);
  await page.waitForTimeout(1200);
  const found = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.right <= vw + 1) continue;
      // Only the outermost offenders: a child of something already too wide is a consequence, not a cause.
      const up = el.parentElement?.getBoundingClientRect();
      if (up && up.right > vw + 1 && el.parentElement !== document.body) continue;
      out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} right=${Math.round(b.right)} width=${Math.round(b.width)} "${(el.textContent ?? '').trim().slice(0, 50)}"`);
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, offenders: out.slice(0, 25) };
  });
  console.log(JSON.stringify(found, null, 1));
} finally { await browser.close(); server.kill(); }
