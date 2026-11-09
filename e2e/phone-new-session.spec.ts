// The phone's NEW SESSION screen, end to end, against the Firebase EMULATORS (never a real project) and a REAL companion, as phone.spec.ts does.
// The agent is a fake script that records how it was started, so no model is used. What this proves: the real phone page, protocol, rules and companion for starting a session from the
// phone. What it does not prove: a real Firebase project, a real phone's OS, or a real agent.
// Run like phone.spec.ts: under `firebase emulators:exec`, on a site built with the demo config and AOT_FIREBASE_EMULATORS=1.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { installHooks } from '../packages/adapters/dist/index.js';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { Project, registerProject } from '../packages/core/dist/index.js';

const ORIGIN = 'http://127.0.0.1:4199';
const SITE = `${ORIGIN}/agentontrack`;
const EMAIL = 'new-session-owner@example.com';

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators, and a site built for them.');
test.describe.configure({ mode: 'serial' });

// Records every start (the prompt and the exact arguments) in the project folder it runs in, then writes a file and finishes.
const FAKE_AGENT = `
import { appendFileSync, writeFileSync } from 'node:fs';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
appendFileSync('starts.log', JSON.stringify({ prompt, argv: process.argv.slice(2) }) + '\\n');
writeFileSync('started-' + prompt.replace(/\\W+/g, '-') + '.txt', 'ok');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }));
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
  await popup.locator('#display-name-input').fill('New Session Owner');
  await popup.locator('#sign-in').click();
  await expect(page.getByTestId('signed-in')).toBeVisible({ timeout: 20_000 });
}

let dir = ''; let rootA = ''; let rootB = ''; let idA = ''; let idB = '';
let c: Companion; let closed = false;
const codes: string[] = [];
let desktop: BrowserContext; let phone: BrowserContext; let dpage: Page; let ppage: Page;
let phoneFingerprint = ''; let did = '';
const phoneUrl = `${SITE}/dashboard/?m=1`;

const starts = (root: string): Array<{ prompt: string; argv: string[] }> => {
  const f = join(root, 'starts.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** Answers the terminal-code prompt the way a person at the terminal would. */
async function handleCodes(page: Page) {
  await page.addLocatorHandler(page.getByTestId('terminal-code-dialog'), async (d) => {
    await d.getByLabel('Code from your terminal').fill(codes.at(-1)!);
    await d.getByRole('button', { name: 'Confirm' }).click();
  });
}

/** The owner's choice of default project, made on the computer with the terminal code, through the companion's own route (the same one the desktop settings card calls). */
async function setDefaultProject(projectId: string | null) {
  const origin = c.url.slice(0, -1);
  const pair = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  const cookie = pair.headers.get('set-cookie')!.split(';')[0]!; const csrf = ((await pair.json()) as { csrf: string }).csrf;
  const h = { cookie, 'x-agentontrack-csrf': csrf, 'content-type': 'application/json' };
  const ch = (await (await fetch(`${origin}/api/challenge`, { method: 'POST', headers: h, body: '{}' })).json()) as { challengeId: string; code: string };
  const r = await fetch(`${origin}/api/remote/settings`, { method: 'POST', headers: h, body: JSON.stringify({ defaultProjectId: projectId, challengeId: ch.challengeId, confirm: ch.code }) });
  expect(r.status, await r.clone().text()).toBe(200);
}

async function openNewSession() {
  await ppage.goto(phoneUrl);
  await ppage.getByTestId('m-open').click();
  await expect(ppage.getByTestId('m-new-session')).toBeEnabled({ timeout: 40_000 });
  await ppage.getByTestId('m-new-session').click();
  await expect(ppage.getByTestId('m-new-project')).toBeVisible({ timeout: 40_000 });
}

/** Fills the prompt and waits until the form is actually ready (an agent and a model have been offered by the computer). */
async function fillPrompt(text: string) {
  await ppage.getByTestId('m-new-prompt').fill(text);
  await expect(ppage.getByTestId('m-new-send')).toBeEnabled({ timeout: 40_000 });
  await ppage.screenshot({ path: 'test-results/phone-screens/new-session.png', fullPage: true });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-newsess-'));
  rootA = join(dir, 'project-a'); rootB = join(dir, 'project-b');
  for (const r of [rootA, rootB]) mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE_AGENT);
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  for (const r of [rootA, rootB]) { const seed = new Project(r); seed.human.setGoal({ statement: 'Keep the phone link honest', scope: { include: ['**'] } }); seed.close(); }
  idA = registerProject(rootA).id; idB = registerProject(rootB).id;
  // Starting an agent from a phone is off until the owner allows it at the computer (a setting that needs the terminal code through the API); the owner's own settings file is the same thing.
  writeFileSync(join(dir, 'home', 'settings.json'), JSON.stringify({ allowMobileExecution: true }));
  installHooks('claude-code', rootA, 'agentontrack'); installHooks('claude-code', rootB, 'agentontrack');
  c = await startCompanion({
    root: rootA, allowedOrigins: [ORIGIN], claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')],
    onTerminalChallenge: (code) => { codes.push(code); },
    remote: { emulators: { auth: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080 }, snapshotEveryMs: 1000, heartbeatEveryMs: 2000 },
  });
  desktop = await browser.newContext({ ...devices['Desktop Chrome'] });
  phone = await browser.newContext({ ...devices['Pixel 7'] });
  dpage = await desktop.newPage(); ppage = await phone.newPage();
});
test.afterAll(async () => {
  await desktop?.close(); await phone?.close(); if (!closed) await c?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('setup: the computer is linked, and a phone is approved to CONTROL it, at the computer', async () => {
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

  await signIn(ppage);
  await ppage.goto(phoneUrl);
  const card = ppage.locator('[data-testid^=m-computer-]').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId('m-connect').click();
  await card.getByTestId('m-match').click();
  await expect(card.getByTestId('m-waiting')).toBeVisible({ timeout: 20_000 });
  phoneFingerprint = (await card.getByTestId('m-phone-fp').textContent())!.trim();
  await expect(dpage.getByTestId('phone-pending')).toContainText(phoneFingerprint, { timeout: 30_000 });
  const approve = dpage.locator('[data-testid^=trust-]').first();
  did = ((await approve.getAttribute('data-testid')) ?? '').replace('trust-', '');
  await dpage.locator(`select[name="level-${did}"]`).selectOption('control');
  await approve.click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dpage.getByTestId('phone-devices')).toContainText(phoneFingerprint.slice(0, 4), { timeout: 20_000 });
  await expect(ppage.getByTestId('m-open')).toBeVisible({ timeout: 30_000 });
});

test('no default project: the phone says so, offers no "default" choice, and the person picks a project', async () => {
  await openNewSession();
  await expect(ppage.getByTestId('m-new-nodefault')).toBeVisible({ timeout: 40_000 });
  await expect(ppage.getByTestId('m-new-project').locator('option[value="default"]')).toHaveCount(0);
  // Nothing can be started without a prompt, and a project is chosen for the person (never a folder).
  await expect(ppage.getByTestId('m-new-send')).toBeDisabled();
  expect(starts(rootA)).toHaveLength(0); expect(starts(rootB)).toHaveLength(0);
});

test('the default project, chosen on the computer, is what "Default project" starts in', async () => {
  await setDefaultProject(idA);
  await openNewSession();
  await expect(ppage.getByTestId('m-new-project').locator('option[value="default"]')).toHaveCount(1, { timeout: 40_000 });
  await expect(ppage.getByTestId('m-new-nodefault')).toHaveCount(0);
  await expect(ppage.getByTestId('m-new-project')).toHaveValue('default');
  await fillPrompt('default project job');
  await ppage.getByTestId('m-new-send').click();
  await expect(ppage.getByTestId('m-new-started')).toContainText('(the default project)', { timeout: 60_000 });
  await expect(ppage.getByTestId('m-new-started')).toContainText('project-a');
  await expect(ppage.getByTestId('m-new-id')).not.toHaveText('');
  await expect.poll(() => starts(rootA).filter((s) => s.prompt === 'default project job').length, { timeout: 60_000 }).toBe(1);
  expect(starts(rootB)).toHaveLength(0);
  await expect.poll(() => existsSync(join(rootA, 'started-default-project-job.txt'))).toBe(true);
});

test('a chosen project (not the default) starts there, and only there', async () => {
  await openNewSession();
  await ppage.getByTestId('m-new-project').selectOption(idB);
  await fillPrompt('chosen project job');
  await ppage.getByTestId('m-new-send').click();
  await expect(ppage.getByTestId('m-new-started')).toContainText('project-b', { timeout: 60_000 });
  await expect(ppage.getByTestId('m-new-started')).not.toContainText('(the default project)');
  await expect.poll(() => starts(rootB).filter((s) => s.prompt === 'chosen project job').length, { timeout: 60_000 }).toBe(1);
  expect(starts(rootA).filter((s) => s.prompt === 'chosen project job')).toHaveLength(0);
});

test('sending twice quickly creates ONE session, not two', async () => {
  await openNewSession();
  await fillPrompt('double tap job');
  const send = ppage.getByTestId('m-new-send');
  // Two real taps in the same instant, the way a nervous thumb does it.
  await send.dblclick({ force: true });
  await expect(ppage.getByTestId('m-new-started')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => starts(rootA).filter((s) => s.prompt === 'double tap job').length, { timeout: 60_000 }).toBe(1);
  // Give any second, wrongly-accepted request time to start something, then count again.
  await ppage.waitForTimeout(4000);
  expect(starts(rootA).filter((s) => s.prompt === 'double tap job')).toHaveLength(1);
  expect(starts(rootB).filter((s) => s.prompt === 'double tap job')).toHaveLength(0);
});

test('read-only: the agent is started without write tools, and a standard session is not', async () => {
  await openNewSession();
  await ppage.getByTestId('m-new-policy').selectOption('read-only');
  await fillPrompt('read only job');
  await ppage.getByTestId('m-new-send').click();
  await expect(ppage.getByTestId('m-new-started')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => starts(rootA).filter((s) => s.prompt === 'read only job').length, { timeout: 60_000 }).toBe(1);
  const ro = starts(rootA).find((s) => s.prompt === 'read only job')!.argv;
  const std = starts(rootA).find((s) => s.prompt === 'default project job')!.argv;
  expect(ro).toContain('--disallowedTools');
  expect(ro[ro.indexOf('--disallowedTools') + 1]).toMatch(/Write/);
  expect(ro).not.toContain('acceptEdits');
  expect(std).toContain('acceptEdits');
  expect(std).not.toContain('--disallowedTools');
});

test('the computer is offline: the phone says so and cannot start anything', async () => {
  // The phone calls a computer offline only after its last heartbeat is 3 minutes old (STALE_AFTER_MS in mobile.tsx), so this waits for real time instead of faking a clock.
  test.setTimeout(330_000);
  await openNewSession();
  await fillPrompt('offline job');
  await c.close(); closed = true;
  await expect(ppage.getByTestId('m-new-offline')).toContainText('Your computer is not reachable', { timeout: 270_000 });
  await expect(ppage.getByTestId('m-new-send')).toBeDisabled();
  expect(starts(rootA).filter((s) => s.prompt === 'offline job')).toHaveLength(0);
});
