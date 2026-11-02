// The phone as a remote control, end to end, against the Firebase EMULATORS (never a real project) and a REAL companion.
// A desktop browser and a phone-sized browser sign in to the same emulated account. The companion runs a fake agent script (it writes one file), so no model is used.
// What this proves: the real protocol, the real rules, the real companion and the real pages. What it does not prove: a real Firebase project, or a real phone's OS.
// Run by the `accounts` CI job under `firebase emulators:exec`; the site is built with the demo config and AOT_FIREBASE_EMULATORS=1.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';

const ORIGIN = 'http://127.0.0.1:4199';
const SITE = `${ORIGIN}/agentontrack`;
const EMAIL = 'phone-owner@example.com';

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators, and a site built for them.');
test.describe.configure({ mode: 'serial' });

const FAKE_AGENT = `
import { writeFileSync } from 'node:fs';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
writeFileSync('from-phone.txt', 'ok');
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

test('the phone has no way to run a terminal, write code or make a project, and a high-risk approval is left to the desktop', async () => {
  // There is no such control on the phone at all.
  for (const word of [/terminal/i, /new project/i, /install/i, /edit file/i]) await expect(ppage.getByRole('button', { name: word })).toHaveCount(0);
  await ppage.getByTestId('m-tab-approvals').click();
  await expect(ppage.getByTestId('m-approval')).toHaveCount(0);
});

test('revoking the phone at the computer stops it at once', async () => {
  await dpage.getByTestId(`revoke-${did}`).click();
  await expect(dpage.getByTestId('phone-devices')).toHaveCount(0, { timeout: 20_000 });
  await ppage.getByTestId('m-tab-progress').click();
  await ppage.getByTestId('m-prompt').fill('Make another change');
  await ppage.getByTestId('m-send').click();
  await expect(ppage.getByTestId('m-result')).not.toContainText('Sent to your computer', { timeout: 70_000 });
  expect(existsSync(join(root, 'second.txt'))).toBe(false);
});
