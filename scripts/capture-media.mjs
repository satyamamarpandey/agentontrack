// Captures the real product for the website and the launch report: screenshots of the built dashboard in demo mode (invented data, and the page
// says so), the early-access dialog, and a short screen recording of a walk through the dashboard. Everything comes from dist-pages served
// locally; nothing is drawn by hand. Output: apps/web/public/shots (served by the site) and .local/shots (report only).
//   pnpm build:pages && node scripts/capture-media.mjs
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 4320;
const BASE = `http://127.0.0.1:${PORT}/agentontrack`;
const OUT = 'apps/web/public/shots';
const LOCAL = '.local/shots';
mkdirSync(OUT, { recursive: true });
mkdirSync(LOCAL, { recursive: true });

const server = spawn(process.execPath, ['e2e/serve.mjs'], { env: { ...process.env, SITE_ROOT: process.env.SITE_ROOT ?? 'dist-pages', SITE_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((ok) => setTimeout(ok, 800));
const browser = await chromium.launch();
const settle = (ms = 900) => new Promise((ok) => setTimeout(ok, ms));

async function fresh(theme, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: theme, reducedMotion: 'reduce', ...opts });
  await context.addInitScript((t) => { localStorage.setItem('bl-theme', t); sessionStorage.setItem('aot-ea-seen', '1'); }, theme);
  return context;
}
/** A fresh document each time: the dashboard reads its screen from the hash when it starts, and a same-document hash change would leave the old screen. */
async function demo(page, hash) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/dashboard/?demo=1${hash}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="demo-banner"]');
  await settle();
}
/** In the recording, move the way a person does: the rail, then the section tab. */
async function go(page, section, tab) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible() && (await menu.getAttribute('aria-expanded')) === 'false') await menu.click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: section, exact: true }).click();
  if (tab) await page.getByRole('tablist', { name: 'Section' }).getByRole('tab', { name: tab, exact: true }).click();
}
const shots = [];
async function shoot(page, name, dir = OUT, opts = {}) {
  const file = join(dir, `${name}.png`);
  if (opts.fullPage) await scrollThrough(page); // a full-page capture does not scroll, so lazily loaded images below the fold would stay empty
  await page.screenshot({ path: file, ...opts });
  shots.push({ name, file, bytes: statSync(file).size });
}
/** Walks down the page a viewport at a time, as a reader would, so every lazy image has been asked for, then returns to the top. */
async function scrollThrough(page) {
  const steps = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight / Math.max(1, window.innerHeight)));
  for (let i = 1; i <= steps; i++) { await page.evaluate((y) => window.scrollTo(0, y), i * 900); await settle(120); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: 15_000 }).catch(() => undefined);
  await settle(300);
}

try {
  const dark = await fresh('dark');
  let page = await dark.newPage();
  await demo(page, '#projects'); await shoot(page, 'projects');
  await demo(page, '#project/demo/workflow'); await shoot(page, 'project-workflow');
  await demo(page, '#workspace'); await shoot(page, 'workspace');
  await demo(page, '#approvals'); await shoot(page, 'approvals');
  await demo(page, '#safety'); await shoot(page, 'safety', LOCAL);
  await page.goto(`${BASE}/`, { waitUntil: 'load' }); await settle();
  await page.click('[data-testid="nav-early-access"]'); await page.waitForSelector('[data-testid="early-access-dialog"]'); await settle(400);
  await shoot(page, 'early-access-dialog', LOCAL);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/early-access/`, { waitUntil: 'load' }); await settle(); await shoot(page, 'early-access-page', LOCAL, { fullPage: true });
  await page.goto(`${BASE}/sign-in/`, { waitUntil: 'load' }); await settle(); await shoot(page, 'sign-in', LOCAL);
  await page.goto(`${BASE}/install/`, { waitUntil: 'load' }); await settle(); await shoot(page, 'install', LOCAL);
  await page.goto(`${BASE}/`, { waitUntil: 'load' }); await settle(); await shoot(page, 'home', LOCAL, { fullPage: true });
  await page.close();
  await dark.close();

  const light = await fresh('light');
  page = await light.newPage();
  await demo(page, '#projects'); await shoot(page, 'projects-light', LOCAL);
  await page.goto(`${BASE}/`, { waitUntil: 'load' }); await settle(); await shoot(page, 'home-light', LOCAL);
  await page.close();
  await light.close();

  // A phone-sized view of the site and the dashboard's one-pane workspace.
  const phone = await fresh('dark', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page = await phone.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' }); await settle(); await shoot(page, 'home-phone', LOCAL);
  await demo(page, '#workspace'); await shoot(page, 'workspace-phone', LOCAL);
  await page.close();
  await phone.close();

  // The recording: a short walk through the dashboard, at the pace a person would click.
  const videoDir = join(LOCAL, 'video-tmp');
  rmSync(videoDir, { recursive: true, force: true });
  const rec = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark', recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
  await rec.addInitScript(() => { localStorage.setItem('bl-theme', 'dark'); sessionStorage.setItem('aot-ea-seen', '1'); });
  page = await rec.newPage();
  await demo(page, '#projects'); await settle(2400);
  await page.getByTestId('project-card').first().locator('.project-open').click(); await settle(2400);
  await page.getByRole('tab', { name: 'Workflow' }).click(); await settle(2600);
  await go(page, 'Workspace'); await settle(3200);
  await go(page, 'Activity', 'Approvals'); await settle(2400);
  await go(page, 'Activity', 'Safety'); await settle(2400);
  await page.keyboard.press('Control+k'); await settle(1600);
  await page.keyboard.type('usage', { delay: 120 }); await settle(900);
  await page.keyboard.press('Enter'); await settle(2200);
  await page.close();
  await rec.close();
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  copyFileSync(join(videoDir, webm), join(OUT, 'tour.webm'));
  rmSync(videoDir, { recursive: true, force: true });
  shots.push({ name: 'tour.webm', file: join(OUT, 'tour.webm'), bytes: statSync(join(OUT, 'tour.webm')).size });
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(join(OUT, 'README.md'), `These are captures of the built site and the dashboard in demo mode (invented data; the page says so), made by scripts/capture-media.mjs on ${new Date().toISOString().slice(0, 10)}. Nothing is drawn by hand.\n`);
console.table(shots.map((s) => ({ name: s.name, kb: Math.round(s.bytes / 1024) })));
