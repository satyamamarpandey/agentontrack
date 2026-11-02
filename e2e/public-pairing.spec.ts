// Pairing the published dashboard with a REAL local companion, in each browser.
// No model and no agent are involved: nothing here runs Claude Code, Codex or Hermes, and it spends no inference. It tests the browser, the page and the companion only.
// LIMIT: the page is served from a local http origin (dist-pages on 127.0.0.1), which is NOT the real https public page. A browser treats loopback-to-loopback
// differently from https-to-loopback, so "paired" here does not show that browser pairs from the deployed site. Safari in particular blocks a secure page from a local
// address, and that cannot show up here. e2e/live-public.spec.ts is the test against the deployed site, in Chromium.
// What each browser did is written to test-results/public-pairing/<project>.jsonl. A browser that blocks is a result, not a failure.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, type Page, type TestInfo } from '@playwright/test';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { confirmDialog, confirmOutsideOrigin, expect, go } from './fixtures';

const ORIGIN = 'http://127.0.0.1:4199';
const DASHBOARD = `${ORIGIN}/agentontrack/dashboard/?connect=1`;
const FALLBACK = /address the helper prints in your terminal, such as http:\/\/127\.0\.0\.1:\d+\//;

function record(info: TestInfo, step: string, outcome: string) {
  const dir = join('test-results', 'public-pairing');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${info.project.name}.jsonl`), `${JSON.stringify({ browser: info.project.name, step, outcome })}\n`);
  info.annotations.push({ type: 'outcome', description: `${step}: ${outcome}` });
}

interface Env { c: Companion; root: string; home: string; codes: { code: string; action: string }[]; start: (port?: number) => Promise<Companion>; goal: () => unknown; events: () => number }

const test = base.extend<{ env: Env }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring here.
  env: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'aot-pair-'));
    const root = join(dir, 'repo');
    const home = join(dir, 'home');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.txt'), 'a');
    process.env.AGENTONTRACK_HOME = home;
    const codes: Env['codes'] = [];
    const start = (port?: number) => startCompanion({ root, ...(port ? { port } : {}), allowedOrigins: [ORIGIN], onTerminalChallenge: (code, action) => { codes.push({ code, action }); } });
    const read = <T>(fn: (p: Project) => T) => { const p = new Project(root); try { return fn(p); } finally { p.close(); } };
    const env: Env = { c: await start(), root, home, codes, start, goal: () => read((p) => p.state().goal), events: () => read((p) => p.store.head()?.seq ?? 0) };
    await use(env);
    await env.c.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  },
});

/** Pairs through the form, as a person would. Returns whether the browser let the page reach the companion. */
async function pair(page: Page, port: number, code: string): Promise<'paired' | 'refused' | 'blocked'> {
  if (!(await page.getByLabel('Companion port').isVisible())) await page.getByText('This computer uses a different port').click();
  await page.getByLabel('Companion port').fill(String(port));
  await page.getByTestId('retry').click();
  // The page looks for the companion by itself. A browser that will not let it, or finds nothing, shows that instead of a code box.
  const status = page.getByTestId('probe-status');
  await expect(status).not.toContainText('Looking', { timeout: 20_000 });
  if (!(await status.textContent())?.includes('Found')) return 'blocked';
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  const shell = page.getByTestId('live-status');
  const alert = page.getByRole('alert');
  await expect(shell.or(alert).first()).toBeVisible({ timeout: 20_000 });
  if (await shell.isVisible()) return 'paired';
  const text = await alert.textContent({ timeout: 2000 }).catch(() => null);
  if (text === null) { await expect(shell).toBeVisible(); return 'paired'; }
  return /Could not reach|denied this page/.test(text) ? 'blocked' : 'refused';
}

/** Every test needs a paired page. A browser that blocks gets its message checked, is recorded, and the rest of that test cannot apply. */
async function pairOrRecordBlock(page: Page, env: Env, info: TestInfo) {
  await page.goto(DASHBOARD);
  const out = await pair(page, env.c.port, env.c.newPairingCode());
  if (out === 'blocked') {
    await expect(page.locator('main')).toContainText(FALLBACK);
    record(info, info.title, 'BLOCKED by the browser: message and local fallback shown');
    test.skip(true, 'This browser blocked the page from reaching the companion, so this step cannot run. The block is the recorded result.');
  }
  expect(out).toBe('paired');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My projects');
}

const openGoalDialog = async (page: Page, statement: string) => {
  await go(page, 'Goals');
  await page.getByLabel('Goal', { exact: true }).fill(statement);
  await page.getByRole('button', { name: 'Review and approve' }).click();
};

test('pairing succeeds with the code from the terminal', async ({ page, env }, info) => {
  await pairOrRecordBlock(page, env, info);
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  await expect(page.getByTestId('live-status')).toContainText('Live');
  record(info, 'pair with the right code', 'paired');
});

test('a wrong pairing code is refused, and the right one still works', async ({ page, env }, info) => {
  await page.goto(DASHBOARD);
  const code = env.c.newPairingCode();
  const out = await pair(page, env.c.port, 'WRONGCOD');
  if (out === 'blocked') {
    await expect(page.locator('main')).toContainText(FALLBACK);
    record(info, 'wrong pairing code', 'BLOCKED by the browser: message and local fallback shown');
    test.skip(true, 'This browser blocked the request, so the companion never saw the code.');
  }
  expect(out).toBe('refused');
  await expect(page.getByRole('alert')).toContainText('Wrong pairing code');
  expect(await pair(page, env.c.port, code)).toBe('paired');
  record(info, 'wrong pairing code', 'refused; right code then paired');
});

test('a change needs the code shown in the terminal, and no code reaches the page', async ({ page, env }, info) => {
  await pairOrRecordBlock(page, env, info);
  await page.addLocatorHandler(page.getByTestId('terminal-code-dialog'), async (d) => {
    await expect(d).toContainText('goal');
    await d.getByLabel('Code from your terminal').fill(env.codes.at(-1)!.code);
    await d.getByRole('button', { name: 'Confirm' }).click();
  });
  await openGoalDialog(page, 'Fix the parser');
  await confirmOutsideOrigin(page);
  await expect.poll(() => env.goal()).toMatchObject({ statement: 'Fix the parser', version: 1 });
  expect(env.codes).toHaveLength(1);
  expect(await page.locator('body').innerText()).not.toContain(env.codes[0]!.code);
  record(info, 'change with terminal code', 'applied after the terminal code; code never shown on the page');
});

test('a wrong terminal code changes nothing', async ({ page, env }, info) => {
  await pairOrRecordBlock(page, env, info);
  const before = env.events();
  await openGoalDialog(page, 'Must not happen');
  const human = page.locator('[role=dialog]:not([data-testid=terminal-code-dialog])');
  await human.getByRole('button', { name: 'Confirm' }).click();
  const prompt = page.getByTestId('terminal-code-dialog');
  await prompt.getByLabel('Code from your terminal').fill('000000');
  await prompt.getByRole('button', { name: 'Confirm' }).click();
  await expect(human.getByRole('alert')).toContainText('wrong, expired or for a different request');
  expect(env.goal()).toBeFalsy();
  expect(env.events()).toBe(before);
  expect(env.codes).toHaveLength(1);
  record(info, 'wrong terminal code', 'refused; record unchanged');
});

test('when the browser stops the connection, the page says so and gives the local address', async ({ page, browser, env }, info) => {
  const name = info.project.name;
  if (name === 'chromium' || name === 'edge') {
    // A loopback page is not restricted, so this makes Chromium treat this origin as public, as the deployed site is. It is still http, which is not the real https page.
    const channel = (info.project.use as { channel?: string }).channel;
    const strict = await browser.browserType().launch({ ...(channel ? { channel } : {}), args: ['--ip-address-space-overrides=127.0.0.1:4199=public'] });
    try {
      const ctx = await strict.newContext();
      const p = await ctx.newPage();
      await p.goto(DASHBOARD);
      const cdp = await ctx.newCDPSession(p);
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      const set = await strict.newBrowserCDPSession();
      await set.send('Browser.setPermission', { permission: { name: 'local-network-access' }, setting: 'denied', origin: ORIGIN, browserContextId: targetInfo.browserContextId });
      const state = await p.evaluate(async () => (await navigator.permissions.query({ name: 'local-network-access' as PermissionName })).state);
      expect(await pair(p, env.c.port, env.c.newPairingCode())).toBe('blocked');
      const alert = p.locator('main');
      await expect(alert).toContainText(FALLBACK);
      if (state === 'denied') await expect(p.getByTestId('probe-blocked')).toContainText('local network access');
      record(info, 'local network access denied', `real block; permission state read as ${state}; message and local fallback shown`);
    } finally {
      await strict.close();
    }
    return;
  }
  // Firefox and WebKit have no such permission to deny, so this is a different path: nothing answers on the port. Recorded as what it is.
  await page.goto(DASHBOARD);
  await env.c.close();
  expect(await pair(page, env.c.port, 'ABCDEFGH')).toBe('blocked');
  await expect(page.locator('main')).toContainText(FALLBACK);
  env.c = await env.start();
  record(info, 'local network access denied', 'NOT APPLICABLE: no such permission in this browser. Tested an unreachable companion instead: message and local fallback shown');
});

test('companion stopped shows reconnecting; restarted, it asks to pair again and works', async ({ page, env }, info) => {
  await pairOrRecordBlock(page, env, info);
  const port = env.c.port;
  await expect(page.getByTestId('live-status')).toContainText('Live');
  await env.c.close();
  await expect(page.getByTestId('live-status')).toContainText('Reconnecting', { timeout: 15_000 });
  env.c = await env.start(port);
  await expect(page.getByTestId('pair-notice')).toContainText('companion restarted', { timeout: 15_000 });
  expect(await pair(page, port, env.c.newPairingCode())).toBe('paired');
  await expect(page.getByTestId('live-status')).toContainText('Live');
  record(info, 'companion stopped and restarted', 'showed Reconnecting, then asked to pair again, then paired');
});

test('the local dashboard address still works as the fallback, with no terminal code', async ({ page, env }, info) => {
  await page.goto(env.c.url);
  await page.getByLabel('Pairing code').fill(env.c.newPairingCode());
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My projects');
  await openGoalDialog(page, 'Local fix');
  await confirmDialog(page);
  await expect.poll(() => env.goal()).toMatchObject({ statement: 'Local fix' });
  expect(env.codes).toHaveLength(0);
  record(info, 'local address fallback', 'paired and changed a goal, with its on-screen code');
});

test('welcome: the choices are clear, sign-in is honest when it is off, and nothing is asked before a choice', async ({ page, env }) => {
  await page.goto(`${ORIGIN}/agentontrack/dashboard/`);
  await expect(page.getByRole('heading', { name: 'Keep your AI coding agents on track' })).toBeVisible();
  await expect(page.getByTestId('continue-local')).toBeVisible();
  await expect(page.getByTestId('explore-demo')).toBeVisible();
  for (const id of ['continue-google', 'continue-github', 'continue-email']) await expect(page.getByTestId(id)).toBeDisabled();
  await expect(page.getByTestId('signin-off')).toContainText('not switched on');
  // No pairing code box, no port and no terminal talk on the first screen.
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  expect(env.codes).toEqual([]);
});

test('connect: not found shows what to do, found shows the one-time code, and the demo is labelled', async ({ page, env }, info) => {
  await page.goto(`${ORIGIN}/agentontrack/dashboard/`);
  await page.getByTestId('continue-local').click();
  await page.getByText('This computer uses a different port').click();
  // A port nothing listens on: the page says so, and offers the way forward.
  await page.getByLabel('Companion port').fill('47999');
  await page.getByTestId('retry').click();
  await expect(page.getByTestId('probe-status')).toContainText('not found', { timeout: 20_000 });
  await expect(page.getByTestId('probe-steps')).toContainText('agentontrack dashboard --allow-public-site');
  await expect(page.getByTestId('download-link')).toBeVisible();
  await expect(page.getByTestId('open-local')).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toHaveCount(0);
  // The real companion: found, then the code box appears.
  await page.getByLabel('Companion port').fill(String(new URL(env.c.url).port));
  await page.getByTestId('retry').click();
  const status = page.getByTestId('probe-status');
  await expect(status).not.toContainText('Looking', { timeout: 20_000 });
  if (!(await status.textContent())?.includes('Found')) { record(info, 'probe', 'blocked by this browser'); return; }
  await expect(page.getByLabel('Pairing code')).toBeVisible();
  record(info, 'probe', 'found');
  // The demo says it is a demo.
  await page.goto(`${ORIGIN}/agentontrack/dashboard/`);
  await page.getByTestId('explore-demo').click();
  await expect(page.getByTestId('demo-banner')).toBeVisible();
});

test('from the public site, source files stay closed until the terminal allows them, for a short time', async ({ page, env }, info) => {
  await page.addLocatorHandler(page.getByTestId('terminal-code-dialog'), async (d) => {
    await d.getByLabel('Code from your terminal').fill(env.codes.at(-1)!.code);
    await d.getByRole('button', { name: 'Confirm' }).click();
  });
  await pairOrRecordBlock(page, env, info);
  await go(page, 'Workspace');
  // Nothing about the project's files is shown, and the page says why and how to allow it.
  const ask = page.getByTestId('grant-files');
  await expect(ask).toContainText('Allow this page to read the files in this project?');
  await expect(page.getByRole('button', { name: 'src', exact: true })).toHaveCount(0);
  expect(env.codes).toEqual([]);
  await ask.getByRole('button', { name: 'Allow for 30 minutes' }).click();
  await expect(page.getByRole('button', { name: 'src', exact: true })).toBeVisible({ timeout: 20_000 });
  expect(env.codes.at(-1)!.action).toMatch(/files\/grant/);
  await expect(ask).toHaveCount(0);
  record(info, 'file access grant', 'asked in the terminal, then allowed');
});
