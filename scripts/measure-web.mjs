// Measures the built site the way a visitor on a mid-range machine would meet it: the pages' loading marks, layout shift, main-thread blocking,
// transferred bytes, and the frame rate of the early-access dialog's entrance. Real numbers from a real browser (Playwright's Chromium with 4x CPU
// slow-down), written to .local/perf/<date>.json and printed as a table. Budgets are checked and reported; nothing here is a claim about other machines.
// Main-thread numbers swing from run to run, so `--runs 3` measures three times and reports the median of each cell (every run is kept in the file).
//   pnpm build:pages && node scripts/measure-web.mjs [--runs 3] [--pages / /early-access/] [--no-throttle]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const argv = process.argv.slice(2);
const PORT = 4310;
// --base <url> measures a deployed site (the live one, for instance) instead of serving dist-pages locally; network time then joins the loading marks.
const baseArg = argv.indexOf('--base');
const BASE = baseArg >= 0 ? String(argv[baseArg + 1]).replace(/\/$/, '') : `http://127.0.0.1:${PORT}/agentontrack`;
const THROTTLE = argv.includes('--no-throttle') ? 1 : 4;
const pagesArg = argv.indexOf('--pages');
const PAGES = pagesArg >= 0 ? argv.slice(pagesArg + 1).filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !/^https?:/.test(a)) : ['/', '/early-access/', '/install/', '/sign-in/', '/dashboard/?demo=1'];
const runsArg = argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Math.max(1, Number(argv[runsArg + 1]) || 1) : 1;
const BUDGET = { lcpMs: 2500, cls: 0.1, tbtMs: 300, bytesKb: 900, fps: 50 };

const server = baseArg >= 0 ? null : spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, SITE_ROOT: 'dist-pages', SITE_PORT: String(PORT) }, stdio: 'ignore' });
if (server) await new Promise((ok) => setTimeout(ok, 800));

const browser = await chromium.launch();
const runs = [];
try {
  for (let i = 0; i < RUNS; i++) runs.push(await measureOnce());
} finally {
  await browser.close();
  server?.kill();
}

async function measureOnce() {
  const results = [];
  for (const profile of [{ name: 'desktop', opts: { viewport: { width: 1366, height: 800 } } }, { name: 'phone', opts: { ...devices['Pixel 7'] } }]) {
    const context = await browser.newContext(profile.opts);
    for (const path of PAGES) {
      const page = await context.newPage();
      await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1'));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      let bytes = 0; let requests = 0;
      // Transfer sizes as the browser reports them once each request has finished (reading bodies misses responses that are still streaming when the page closes).
      page.on('requestfinished', async (req) => { requests++; try { const s = await req.sizes(); bytes += s.responseBodySize + s.responseHeadersSize; } catch { /* no sizes for a request the page abandoned */ } });
      await page.addInitScript(() => {
        window.__m = { lcp: 0, cls: 0, long: [] };
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.long.push(e.duration); }).observe({ type: 'longtask', buffered: true });
      });
      const t0 = Date.now();
      await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500); // let late paints, fonts and the counters settle
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
        const tbt = window.__m.long.reduce((s, d) => s + Math.max(0, d - 50), 0);
        return { ttfb: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, fcp, lcp: window.__m.lcp, cls: window.__m.cls, tbt, longTasks: window.__m.long.length, fontsLoaded: document.fonts.status === 'loaded' && [...document.fonts].some((f) => /inter/i.test(f.family) && !/fallback/i.test(f.family) && f.status === 'loaded') }; // Next names the site's face after the file; the dashboard declares 'Inter'
      });
      const row = { profile: profile.name, path, throttle: THROTTLE, ttfbMs: r(m.ttfb), fcpMs: r(m.fcp), lcpMs: r(m.lcp), dclMs: r(m.dcl), loadMs: r(m.load), cls: Number(m.cls.toFixed(3)), tbtMs: r(m.tbt), longTasks: m.longTasks, requests, bytesKb: r(bytes / 1024), fontsLoaded: m.fontsLoaded, wallMs: Date.now() - t0 };
      results.push(row);
      await page.close();
    }
    // The dialog's entrance: frame times while it animates (reduced motion off), on the home page.
    const page = await context.newPage();
    await page.addInitScript(() => sessionStorage.setItem('aot-ea-seen', '1'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const frames = await page.evaluate(async () => {
      const times = [];
      let last = performance.now();
      let on = true;
      const tick = (now) => { times.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      document.querySelector('[data-testid="nav-early-access"]').click();
      await new Promise((ok) => setTimeout(ok, 700));
      on = false;
      return times.slice(1);
    });
    const fps = frames.length ? r(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)) : 0;
    const dropped = frames.filter((d) => d > 1000 / 30).length;
    results.push({ profile: profile.name, path: 'dialog entrance', throttle: THROTTLE, fps, frames: frames.length, droppedOver33ms: dropped, worstFrameMs: r(Math.max(...frames, 0)) });
    await page.close();
    await context.close();
  }
  return results;
}

function r(n) { return Math.round(n); }
function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
// Rows line up across runs (same pages, same order); numbers take the median, flags hold only if every run had them.
const results = runs[0].map((row, i) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
  if (typeof v === 'number') return [k, Number(median(runs.map((run) => run[i][k])).toFixed(3))];
  if (typeof v === 'boolean') return [k, runs.every((run) => run[i][k])];
  return [k, v];
})));
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
mkdirSync('.local/perf', { recursive: true });
writeFileSync(`.local/perf/web-${stamp}.json`, JSON.stringify({ measuredAt: new Date().toISOString(), cpuThrottle: THROTTLE, runs: RUNS, budget: BUDGET, results, perRun: runs }, null, 2));
console.log(`CPU slow-down ${THROTTLE}x, Chromium, ${server ? 'served from dist-pages' : `measured at ${BASE}`}${RUNS > 1 ? `, median of ${RUNS} runs` : ''}. Budgets: LCP<${BUDGET.lcpMs}ms CLS<${BUDGET.cls} TBT<${BUDGET.tbtMs}ms bytes<${BUDGET.bytesKb}KB dialog>=${BUDGET.fps}fps`);
console.table(results);
const over = results.filter((x) => (x.lcpMs > BUDGET.lcpMs) || (x.cls > BUDGET.cls) || (x.tbtMs > BUDGET.tbtMs) || (x.bytesKb > BUDGET.bytesKb) || (x.fps !== undefined && x.fps < BUDGET.fps));
console.log(over.length ? `Over budget: ${over.map((x) => `${x.profile} ${x.path}`).join('; ')}` : 'All within budget.');
console.log(`Written: .local/perf/web-${stamp}.json`);
