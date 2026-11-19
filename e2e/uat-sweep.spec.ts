// UAT sweep over the built site and the dashboard in demo mode, exactly as published. It does not judge behaviour (the other specs do);
// it proves breadth: every page and screen at widths from 320 to 1920 in both themes has no sideways scroll, no control cut off by the
// viewport and no script error; every enabled button causes something observable (no dead controls); every internal link resolves.
// Results are written to test-results/uat-sweep.json, which docs/uat/MASTER_MATRIX.md cites. Demo mode means no companion: what a button
// does to real data is NOT tested here.
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:4199';
const SITE = `${ORIGIN}/agentontrack`;
const PAGES = ['/', '/install/', '/features/', '/how-it-works/', '/integrations/', '/benchmarks/', '/security/', '/pricing/', '/docs/', '/community/', '/roadmap/', '/changelog/', '/feedback/', '/privacy/', '/terms/', '/early-access/', '/join/', '/sign-in/', '/account/', '/admin/'];
const SCREENS = ['projects', 'goals', 'workspace', 'agents', 'approvals', 'safety', 'evidence', 'overview', 'usage', 'results', 'comparisons', 'evaluations', 'environment', 'settings', 'feedback', 'project/demo/overview'];
const TARGETS = [...PAGES.map((p) => ({ id: `site${p}`, url: `${SITE}${p}` })), ...SCREENS.map((s) => ({ id: `dashboard#${s}`, url: `${SITE}/dashboard/?demo=1#${s}` })), { id: 'phone-shell', url: `${SITE}/dashboard/?demo=1&m=1` }];
const WIDTHS = [320, 375, 768, 1024, 1440, 1920];
const THEMES = ['dark', 'light'] as const;

const out: Record<string, unknown> = {};
const FILE = 'test-results/uat-sweep.json';
const save = (key: string, value: unknown) => {
  // Merged with what is already there: a failed test restarts the worker, and the results of the tests before it must survive.
  let prior: Record<string, unknown> = {};
  try { prior = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>; } catch { prior = {}; }
  Object.assign(prior, out, { [key]: value });
  out[key] = value;
  mkdirSync('test-results', { recursive: true });
  writeFileSync(FILE, JSON.stringify(prior, null, 1));
};

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'The sweep sets its own widths from 320 to 1920 and runs once, in Chromium; per-browser behaviour is in the other specs.');

/** Loads a target from a blank page, so a change of hash alone still gives a fresh application. */
async function open(page: Page, url: string, fresh = false) {
  await page.goto('about:blank');
  await page.goto(url);
  // The workspace remembers which panels were collapsed. For the button sweep each load starts from the default layout, so the same buttons are there.
  if (fresh) { await page.evaluate(() => { try { const t = localStorage.getItem('bl-theme'); localStorage.clear(); if (t) localStorage.setItem('bl-theme', t); sessionStorage.clear(); } catch { /* storage blocked */ } }); await page.goto('about:blank'); await page.goto(url); }
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(150);
}

for (const theme of THEMES) {
  test(`layout: nothing scrolls sideways, is cut off or throws, at 320 to 1920 (${theme})`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript((t) => { try { localStorage.setItem('bl-theme', t); } catch { /* storage blocked */ } }, theme);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource: net::ERR_(CONNECTION_REFUSED|FAILED)/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
    const problems: string[] = [];
    const rows: { id: string; width: number; overflowPx: number; cut: string[] }[] = [];
    for (const t of TARGETS) {
      await page.setViewportSize({ width: 1440, height: 900 });
      errors.length = 0;
      await open(page, t.url);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(120);
        const r = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const scrollable = (el: Element | null): boolean => { for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const s = getComputedStyle(n); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && n !== document.body) return true; } return false; };
          const cut: string[] = [];
          for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="button"]')) {
            const b = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            if (b.width === 0 || b.height === 0 || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
            if (el.closest('.sr-only, .skip, [aria-hidden="true"], [inert]')) continue;
            if (b.width <= 2 || (s.position === 'absolute' && b.right <= 0)) continue; // visually hidden until focused
            if ((b.right > vw + 1 || b.left < -1) && !scrollable(el.parentElement)) cut.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(b.left)}..${Math.round(b.right)} of ${vw}`);
          }
          return { overflowPx: document.documentElement.scrollWidth - vw, cut };
        });
        rows.push({ id: t.id, width, ...r });
        if (r.overflowPx > 1) problems.push(`${t.id} @${width}: page scrolls sideways by ${r.overflowPx}px`);
        for (const c of r.cut) problems.push(`${t.id} @${width}: cut off: ${c}`);
      }
      for (const e of new Set(errors)) problems.push(`${t.id}: ${e}`);
    }
    save(`layout-${theme}`, { targets: TARGETS.length, widths: WIDTHS, checks: rows.length, problems });
    expect(problems).toEqual([]);
  });
}

test('controls: every enabled button on every page and screen does something observable', async ({ page }) => {
  test.setTimeout(1_500_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const w = window as unknown as { __react: number };
    w.__react = 0;
    const bump = () => { w.__react++; };
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { bump(); }, readText: async () => '' } }); } catch { /* fixed by the browser */ }
    window.open = () => { bump(); return null; };
    window.print = bump;
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (this.download) bump(); else click.call(this); };
    const pick = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function (this: HTMLInputElement) { if (this.type === 'file') bump(); else pick.call(this); };
    for (const ev of ['hashchange', 'popstate', 'focusin', 'toggle', 'submit', 'invalid']) window.addEventListener(ev, bump, true);
    new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
  const dead: string[] = [];
  const perTarget: Record<string, number> = {};
  let total = 0;
  const buttons = () => page.locator('button:visible:not([disabled]), [role="button"]:visible:not([aria-disabled="true"]), summary:visible');
  const names = async () => buttons().evaluateAll((els) => els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)));
  for (const t of TARGETS) {
    await open(page, t.url, true);
    const initial = await names();
    perTarget[t.id] = initial.length;
    for (let i = 0; i < initial.length; i++) {
      if (JSON.stringify(await names()) !== JSON.stringify(initial) || page.url() !== t.url) await open(page, t.url, true);
      const b = buttons().nth(i);
      if (!(await b.count())) { dead.push(`${t.id}: button ${i} "${initial[i]}" is not there after a reload`); continue; }
      total++;
      await page.waitForTimeout(60);
      const before = page.url();
      await page.evaluate(() => { (window as unknown as { __react: number }).__react = 0; });
      try { await b.click({ timeout: 4000 }); } catch (e) { dead.push(`${t.id}: "${initial[i]}" cannot be clicked: ${(e as Error).message.split('\n')[0]!.slice(0, 90)}`); continue; }
      let reacted = false;
      for (let w = 0; w < 12 && !reacted; w++) {
        await page.waitForTimeout(100);
        reacted = page.url() !== before || (await page.evaluate(() => (window as unknown as { __react?: number }).__react ?? 1).catch(() => 1)) > 0;
      }
      if (!reacted) dead.push(`${t.id}: "${initial[i]}" did nothing observable`);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  save('controls', { targets: TARGETS.length, buttonsClicked: total, perTarget, dead });
  expect(dead).toEqual([]);
});

test('links: every internal link on every page resolves, and every in-page anchor exists', async ({ page }) => {
  test.setTimeout(300_000);
  const internal = new Map<string, string>();
  const external = new Set<string>();
  const missingAnchors: string[] = [];
  for (const t of TARGETS) {
    await open(page, t.url);
    const hrefs = await page.locator('a[href]').evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href));
    for (const h of hrefs) {
      if (!/^https?:/.test(h)) continue;
      const u = new URL(h);
      if (u.origin !== ORIGIN) { external.add(u.origin + u.pathname); continue; }
      if (u.pathname === new URL(page.url()).pathname && u.hash && !u.hash.startsWith('#project') && !/dashboard/.test(u.pathname)) {
        if (!(await page.locator(`[id="${u.hash.slice(1)}"]`).count())) missingAnchors.push(`${t.id}: ${u.hash}`);
      }
      u.hash = '';
      if (!internal.has(u.toString())) internal.set(u.toString(), t.id);
    }
  }
  const broken: string[] = [];
  for (const [url, from] of internal) {
    const r = await page.request.get(url);
    if (r.status() !== 200) broken.push(`${url} (${r.status()}) linked from ${from}`);
  }
  save('links', { internalChecked: internal.size, externalNotFetched: [...external].sort(), broken, missingAnchors });
  expect(broken).toEqual([]);
  expect(missingAnchors).toEqual([]);
});

for (const theme of THEMES) {
  test(`accessibility: no serious axe violation on any dashboard screen in demo mode (${theme})`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript((t) => { try { localStorage.setItem('bl-theme', t); } catch { /* storage blocked */ } }, theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    const bad: string[] = [];
    let screens = 0;
    for (const t of TARGETS.filter((x) => !x.id.startsWith('site'))) {
      await open(page, t.url);
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.timeline instanceof DocumentTimeline && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).map((a) => a.finished.catch(() => undefined))));
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      screens++;
      for (const v of r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) bad.push(`${t.id}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
    }
    save(`axe-dashboard-${theme}`, { screens, violations: bad });
    expect(bad).toEqual([]);
  });
}
