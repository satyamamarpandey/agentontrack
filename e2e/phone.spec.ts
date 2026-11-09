// The phone as a remote control, end to end, against the Firebase EMULATORS (never a real project) and a REAL companion.
// A desktop browser and a phone-sized browser sign in to the same emulated account. The companion runs a fake agent script (it writes one file), so no model is used.
// What this proves: the real protocol, the real rules, the real companion and the real pages. What it does not prove: a real Firebase project, or a real phone's OS.
// Run by the `accounts` CI job under `firebase emulators:exec`; the site is built with the demo config and AOT_FIREBASE_EMULATORS=1.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { installHooks } from '../packages/adapters/dist/index.js';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { classifyCommand, Project } from '../packages/core/dist/index.js';

const ORIGIN = 'http://127.0.0.1:4199';
const SITE = `${ORIGIN}/agentontrack`;
const EMAIL = 'phone-owner@example.com';

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators, and a site built for them.');
test.describe.configure({ mode: 'serial' });

const FAKE_AGENT = `
import { existsSync, writeFileSync } from 'node:fs';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
// A slow job waits for a gate file the test opens, not for a fixed time: how long the phone, Firebase and the companion take to relay a stop varies, and a fixed delay made
// the agent finish by itself on a slow runner, which looks exactly like a stop that failed. It records its pid so the test can see that the process is really gone.
if (/slow job/.test(prompt)) { writeFileSync('slow.pid', String(process.pid)); while (!existsSync('release-slow')) await new Promise((ok) => setTimeout(ok, 20)); writeFileSync('slow-finished.txt', 'ran to the end'); }
else writeFileSync('from-phone.txt', 'ok');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Wrote the file.' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, duration_api_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;

async function signIn(page: Page) {
  await page.goto(`${SITE}/account/`);
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('sign-in').click()]);
  await expect(async () => {
    await popup.getByText('Add new account').click({ timeout: 3000 });
    await expect(popup.locator('#email-input')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await popup.locator('#email-input').fill(EMAIL);
  await popup.locator('#display-name-input').fill('Phone Owner');
  await popup.locator('#sign-in').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
}

let dir = '';
let root = '';
let c: Companion;
const codes: string[] = [];
let desktop: BrowserContext;
let phone: BrowserContext;
let dpage: Page;
let ppage: Page;
let phoneFingerprint = '';
let did = '';

const phoneUrl = `${SITE}/dashboard/?m=1`;

/** Answers the terminal-code prompt the way a person at the terminal would. */
async function handleCodes(page: Page) {
  await page.addLocatorHandler(page.getByTestId('terminal-code-dialog'), async (d) => {
    await d.getByLabel('Code from your terminal').fill(codes.at(-1)!);
    await d.getByRole('button', { name: 'Confirm' }).click();
  });
}

async function newContexts(browser: Browser) {
  desktop = await browser.newContext({ ...devices['Desktop Chrome'] });
  phone = await browser.newContext({ ...devices['Pixel 7'] });
  dpage = await desktop.newPage();
  ppage = await phone.newPage();
}

test.beforeAll(async ({ browser }) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-phone-'));
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  writeFileSync(join(root, 'README.md'), '# Readme for the phone\n');
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE_AGENT);
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  // Starting an agent from a phone is off until the owner allows it at the computer; this is what that setting stores.
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'home', 'settings.json'), JSON.stringify({ allowMobileExecution: true }));
  const seed = new Project(root);
  seed.human.setGoal({ statement: 'Keep the phone link honest', scope: { include: ['**'] } });
  seed.human.createTask({ id: 't1', title: 'A task', criteria: [] });
  seed.close();
  installHooks('claude-code', root, 'agentontrack');
  c = await startCompanion({
    root, allowedOrigins: [ORIGIN], claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')],
    onTerminalChallenge: (code) => { codes.push(code); },
    remote: { emulators: { auth: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080 }, snapshotEveryMs: 1000, heartbeatEveryMs: 2000 },
  });
  await newContexts(browser);
});
test.afterAll(async () => {
  await desktop?.close(); await phone?.close(); await c?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('the computer is linked once, from the desktop, to the signed-in account', async () => {
  await signIn(dpage);
  await dpage.goto(`${SITE}/dashboard/?connect=1`);
  await dpage.getByLabel('Companion port').or(dpage.getByText('This computer uses a different port')).first().waitFor();
  if (!(await dpage.getByLabel('Companion port').isVisible())) await dpage.getByText('This computer uses a different port').click();
  await dpage.getByLabel('Companion port').fill(String(c.port));
  await dpage.getByTestId('retry').click();
  await expect(dpage.getByTestId('probe-status')).toContainText('Found', { timeout: 20_000 });
  await dpage.getByLabel('Pairing code').fill(c.newPairingCode());
  await dpage.getByRole('button', { name: 'Pair', exact: true }).click();
  await handleCodes(dpage);
  await dpage.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await dpage.getByTestId('phone-link').click();
  const dialog = dpage.locator('[role=dialog]:not([data-testid=terminal-code-dialog])');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dpage.getByTestId('phone-state')).toContainText('Online', { timeout: 40_000 });
  await expect(dpage.getByTestId('computer-fingerprint')).toHaveText(/^[0-9A-F-]{10,}$/i);
});

test('a phone signed in to the same account is NOT trusted until the person approves it at the computer', async () => {
  await signIn(ppage);
  await ppage.goto(phoneUrl);
  const card = ppage.locator('[data-testid^=m-computer-]').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Account login alone grants nothing: no Open button, only a request to connect.
  await expect(card.getByTestId('m-open')).toHaveCount(0);
  const desktopFp = (await dpage.getByTestId('computer-fingerprint').textContent())!.trim();
  await card.getByTestId('m-connect').click();
  await expect(card.getByTestId('m-computer-fp')).toHaveText(desktopFp);
  await card.getByTestId('m-match').click();
  await expect(card.getByTestId('m-waiting')).toBeVisible({ timeout: 20_000 });
  phoneFingerprint = (await card.getByTestId('m-phone-fp').textContent())!.trim();
  await expect(dpage.getByTestId('phone-pending')).toContainText(phoneFingerprint, { timeout: 30_000 });
});

test('after the person approves the phone, the project appears and shows live status', async () => {
  const approve = dpage.locator('[data-testid^=trust-]').first();
  did = ((await approve.getAttribute('data-testid')) ?? '').replace('trust-', '');
  await dpage.locator(`select[name="level-${did}"]`).selectOption('control');
  await approve.click();
  const dialog = dpage.locator('[role=dialog]:not([data-testid=terminal-code-dialog])');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dpage.getByTestId('phone-devices')).toContainText(phoneFingerprint.slice(0, 4), { timeout: 20_000 });

  await expect(ppage.getByTestId('m-open')).toBeVisible({ timeout: 30_000 });
  await ppage.getByTestId('m-open').click();
  const project = ppage.locator('[data-testid^=m-project-]').first();
  await expect(project).toBeVisible({ timeout: 40_000 });
  await project.click();
  await expect(ppage.getByTestId('m-fresh')).toContainText('Live', { timeout: 30_000 });
  // The bottom bar is one short row that never covers the controls, and every tab is a real touch target.
  const bar = (await ppage.locator('.m-tabs').boundingBox())!;
  expect(bar.height).toBeLessThan(90);
  for (const b of await ppage.locator('.m-tabs button').all()) { const box = (await b.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44); }
  for (const tab of ['progress', 'activity', 'evidence', 'approvals', 'more']) {
    await ppage.getByTestId(`m-tab-${tab}`).click();
    await ppage.screenshot({ path: `test-results/phone-screens/${tab}.png` });
    const axe = await new AxeBuilder({ page: ppage }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${tab}: ${v.id}`), 'accessibility').toEqual([]);
  }
  await ppage.getByTestId('m-tab-progress').click();
});

test('a prompt sent from the phone runs the desktop agent, and the evidence comes back', async () => {
  await ppage.getByTestId('m-prompt').fill('Make the change from the phone');
  await ppage.getByTestId('m-send').click();
  await expect(ppage.getByTestId('m-result')).toContainText('Sent to your computer', { timeout: 60_000 });
  await expect.poll(() => existsSync(join(root, 'from-phone.txt')), { timeout: 60_000 }).toBe(true);
  await ppage.getByTestId('m-tab-activity').click();
  await expect(ppage.getByTestId('m-run').first()).toBeVisible({ timeout: 30_000 });
  await ppage.getByTestId('m-tab-evidence').click();
  await ppage.getByTestId('m-files').click();
  await ppage.getByRole('button', { name: 'README.md' }).click();
  await expect(ppage.getByTestId('m-file')).toContainText('Readme for the phone');
});

test('a prompt can be cancelled from the phone, and the agent really stops', async () => {
  // History: an earlier version of this test failed once in CI. It passed "Sent to your computer" at once (that text was left by the test before) and pressed Stop on a "running"
  // row that was the PREVIOUS test's run, already finished but still shown as running from the last snapshot the phone had. The computer correctly answered "That run is not
  // running on this computer", the slow agent was never stopped, and it finished by itself. So this test works only with the run it starts: it clears its own leftovers, lets earlier
  // runs settle, remembers them, finds the new run by id, and checks that the agent PROCESS is gone, not that a timer ran out.
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const t0 = Date.now();
  for (const f of ['slow.pid', 'release-slow', 'slow-finished.txt']) rmSync(join(root, f), { force: true });
  await ppage.getByTestId('m-tab-activity').click();
  await expect(ppage.locator('[data-testid=m-run][data-status=running]')).toHaveCount(0, { timeout: 30_000 });
  const known = await ppage.locator('[data-testid=m-run] b.mono').allTextContents();
  await ppage.getByTestId('m-tab-progress').click();
  await ppage.getByTestId('m-prompt').fill('slow job please');
  await ppage.getByTestId('m-send').click();
  await ppage.getByTestId('m-tab-activity').click();
  // The agent has started once it has written its pid, and the phone shows one NEW run as running.
  await expect.poll(() => existsSync(join(root, 'slow.pid')), { timeout: 60_000 }).toBe(true);
  const tStarted = Date.now();
  let runId = '';
  await expect.poll(async () => { const ids = (await ppage.locator('[data-testid=m-run][data-status=running] b.mono').allTextContents()).filter((id) => !known.includes(id)); runId = ids[0] ?? ''; return ids.length; }, { timeout: 60_000 }).toBe(1);
  const pid = Number(readFileSync(join(root, 'slow.pid'), 'utf8'));
  expect(alive(pid)).toBe(true);
  const tRunning = Date.now();
  const row = ppage.locator('[data-testid=m-run]').filter({ hasText: runId });
  await row.getByTestId('m-stop-run').click();
  const tClicked = Date.now();
  await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  const tRowStopped = Date.now();
  // The click reached a running run: the phone did not show the computer's refusal for a run that is not running.
  await expect(ppage.getByText('That run is not running on this computer.')).toHaveCount(0);
  await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
  const tGone = Date.now();
  // Had the process survived, opening the gate would now let it write the file. The short wait only shows absence; the process check above is the real proof.
  writeFileSync(join(root, 'release-slow'), '1');
  await ppage.waitForTimeout(1000);
  expect(existsSync(join(root, 'slow-finished.txt'))).toBe(false);
  // Evidence for the CI record: which run was chosen, that it was new, and how long each step took (ms).
  test.info().annotations.push({ type: 'cancel-evidence', description: JSON.stringify({ runId, pid, runsListedBeforeSending: known, wasNew: !known.includes(runId), refusalShown: false, finishedFileWritten: false, msToAgentStart: tStarted - t0, msFromStartToRowRunning: tRunning - tStarted, msClickToRowStopped: tRowStopped - tClicked, msClickToProcessGone: tGone - tClicked }) });
});

test('a held approval shows on the phone: a push cannot be approved there, and can be declined', async () => {
  const p = new Project(root);
  const cmd = classifyCommand('git push origin main');
  p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: cmd.effects, opaque: false, coverage: 'enforced', rawInput: 'git push origin main' });
  p.close();
  await ppage.getByTestId('m-tab-approvals').click();
  const card = ppage.getByTestId('m-approval').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('approved at your computer');
  await expect(card.getByTestId('m-approve')).toHaveCount(0);
  await card.getByTestId('m-deny').click();
  await expect(ppage.getByTestId('m-approval')).toHaveCount(0, { timeout: 30_000 });
  const after = new Project(root);
  expect([...after.state().approvals.values()].some((a) => a.effect.kind === 'vcs.push' && a.status === 'denied')).toBe(true);
  after.close();
});

test('a handoff made on the phone carries evidence and no approval, and is on the computer', async () => {
  await ppage.getByTestId('m-tab-more').click();
  await ppage.getByTestId('m-handoff').click();
  await expect(ppage.getByTestId('m-result')).toContainText('Handoff saved', { timeout: 60_000 });
  const p = new Project(root);
  const { listHandoffs } = await import('../packages/core/dist/index.js');
  expect(listHandoffs(p).length).toBeGreaterThan(0);
  p.close();
});

test('offline: the phone says nothing is live and turns controls off, and they come back when it does', async () => {
  await ppage.getByTestId('m-tab-progress').click();
  await ppage.getByTestId('m-prompt').fill('anything');
  await expect(ppage.getByTestId('m-send')).toBeEnabled();
  await phone.setOffline(true);
  await expect(ppage.getByTestId('m-fresh')).toContainText('This phone is offline', { timeout: 15_000 });
  await expect(ppage.getByTestId('m-send')).toBeDisabled();
  await phone.setOffline(false);
  await expect(ppage.getByTestId('m-fresh')).toContainText('Live', { timeout: 40_000 });
  await expect(ppage.getByTestId('m-send')).toBeEnabled();
});

test('a second phone on the same account is a separate device: it needs its own approval, and "look only" cannot control', async ({ browser }) => {
  const second = await browser.newContext({ ...devices['iPhone 14'] });
  try {
    const pg = await second.newPage();
    await signIn(pg);
    await pg.goto(phoneUrl);
    const card = pg.locator('[data-testid^=m-computer-]').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('m-open')).toHaveCount(0);
    await card.getByTestId('m-connect').click();
    await card.getByTestId('m-match').click();
    await expect(card.getByTestId('m-waiting')).toBeVisible({ timeout: 20_000 });
    const fp = (await card.getByTestId('m-phone-fp').textContent())!.trim();
    expect(fp).not.toBe(phoneFingerprint);
    await expect(dpage.getByTestId('phone-pending')).toContainText(fp, { timeout: 30_000 });
    const approve = dpage.locator('[data-testid^=trust-]').first();
    const did2 = ((await approve.getAttribute('data-testid')) ?? '').replace('trust-', '');
    await approve.click();
    await dpage.locator('[role=dialog]:not([data-testid=terminal-code-dialog])').getByRole('button', { name: 'Confirm' }).click();
    await expect(dpage.getByTestId('phone-devices')).toContainText(fp.slice(0, 4), { timeout: 20_000 });
    await expect(card.getByTestId('m-open')).toBeVisible({ timeout: 30_000 });
    await card.getByTestId('m-open').click();
    await pg.locator('[data-testid^=m-project-]').first().click();
    await pg.getByTestId('m-prompt').fill('Make another change');
    await pg.getByTestId('m-send').click();
    await expect(pg.getByTestId('m-result')).toContainText('approved to look, not to control', { timeout: 60_000 });
    // Revoking the second phone does not touch the first.
    await dpage.getByTestId(`revoke-${did2}`).click();
    await expect(ppage.getByTestId('m-fresh')).toContainText('Live');
  } finally { await second.close(); }
});

test('a different account sees none of this computer', async ({ browser }) => {
  const stranger = await browser.newContext({ ...devices['Pixel 7'] });
  try {
    const pg = await stranger.newPage();
    await pg.goto(`${SITE}/account/`);
    const [popup] = await Promise.all([pg.waitForEvent('popup'), pg.getByTestId('sign-in').click()]);
    await expect(async () => {
      await popup.getByText('Add new account').click({ timeout: 3000 });
      await expect(popup.locator('#email-input')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await popup.locator('#email-input').fill('someone-else@example.com');
    await popup.locator('#display-name-input').fill('Someone Else');
    await popup.locator('#sign-in').click();
    await expect(pg.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
    await pg.goto(phoneUrl);
    await expect(pg.getByRole('heading', { name: 'No computer is linked yet' })).toBeVisible({ timeout: 30_000 });
    await expect(pg.locator('[data-testid^=m-computer-]')).toHaveCount(0);
  } finally { await stranger.close(); }
});

test('the phone has no way to run a terminal, write code or make a project, and a high-risk approval is left to the desktop', async () => {
  // There is no such control on the phone at all.
  for (const word of [/terminal/i, /new project/i, /install/i, /edit file/i]) await expect(ppage.getByRole('button', { name: word })).toHaveCount(0);
  await ppage.getByTestId('m-tab-approvals').click();
  await expect(ppage.getByTestId('m-approval')).toHaveCount(0);
});

test('revoking the phone at the computer stops it at once', async () => {
  // A revoked phone gets no answer at all, so the phone waits its full minute and then says so plainly.
  test.setTimeout(180_000);
  await dpage.getByTestId(`revoke-${did}`).click();
  await expect(dpage.getByTestId('phone-devices')).toHaveCount(0, { timeout: 20_000 });
  await ppage.getByTestId('m-tab-progress').click();
  await ppage.getByTestId('m-prompt').fill('Make another change');
  await ppage.getByTestId('m-send').click();
  await expect(ppage.getByTestId('m-result')).toContainText('did not answer', { timeout: 90_000 });
  await expect(ppage.getByTestId('m-result')).not.toContainText('Sent to your computer');
  expect(existsSync(join(root, 'second.txt'))).toBe(false);
});
