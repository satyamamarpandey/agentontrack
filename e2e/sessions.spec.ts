// The Workspace "Sessions" pane and the "Default project for mobile sessions" card, against a REAL companion with a fake agent process
// (a script that speaks Claude Code's stream format). Nothing is mocked: the status, the Resume rules and the drafts are what the page does with the companion's own answers.
// NOT covered here: a real Claude Code or Codex session, fork (the pane shows it disabled), and phone behaviour (see phone.spec.ts and the companion tests).
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installHooks } from '../packages/adapters/dist/index.js';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { confirmDialog, go } from './fixtures';

// quick-x finishes; fail-x exits non-zero after saying something; slow-x waits for the gate file. Every one reports a provider session id, so it can be continued.
const FAKE = `
import { existsSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
const name = /(slow|quick|fail)-\\w+/.exec(prompt)?.[0] ?? 'quick-run';
const sid = 'fake-session-' + name.replace(/\\W/g, '');
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', session_id: sid }));
if (name.startsWith('slow')) { while (!existsSync('release')) await new Promise((ok) => setTimeout(ok, 20)); }
if (name.startsWith('fail')) { console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The build broke: 2 tests failed' }] } })); process.exit(3); }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done ' + name }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;

const SHOTS = join(tmpdir(), 'aot-sessions-shots');
let dir = ''; let root = ''; let c: Companion; let errors: string[] = [];

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, 'The Workspace is laid out differently on a phone; narrow widths are checked on the desktop projects below.');
  mkdirSync(SHOTS, { recursive: true });
  dir = mkdtempSync(join(tmpdir(), 'aot-sess-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  installHooks('claude-code', root, 'agentontrack');
  c = await startCompanion({ root, claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(c.url);
  await page.getByLabel('Pairing code').fill(c.newPairingCode());
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('button', { name: 'Menu' })).first()).toBeVisible();
});
test.afterEach(async () => {
  // When beforeEach skipped the test (phone layout), root is still '' and join('', 'release') would land in the repo folder.
  if (root) { try { writeFileSync(join(root, 'release'), '1'); } catch { /* gone */ } }
  await c?.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* a just-killed process can hold its folder for a moment; it is a throwaway in the OS temp directory */ }
});

const openSessions = async (page: Page) => { await go(page, 'Workspace'); await page.getByRole('tab', { name: 'Sessions', exact: true }).click(); await expect(page.getByTestId('sessions-pane')).toBeVisible(); };
const item = (page: Page, title: string) => page.getByTestId('sess-item').filter({ hasText: title });
/** Start a NEW session from the pane's own form. */
async function startSession(page: Page, word: string, title: string) {
  await page.getByTestId('sess-new').click();
  const form = page.getByTestId('sess-new-form');
  await form.getByLabel('Title (optional)').fill(title);
  await form.getByLabel('Prompt').fill(`go ${word}`);
  await form.getByTestId('sess-start').click();
  await expect(page.getByTestId('sess-detail')).toBeVisible();
  await expect(page.getByTestId('sess-detail').getByRole('heading', { name: title })).toBeVisible();
}
const status = (page: Page, title: string) => item(page, title).getByTestId('sess-status');
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

test('sessions: each status is shown as the companion reports it, and a failed one is never shown as fine', async ({ page }) => {
  await openSessions(page);
  await expect(page.getByText('No sessions yet')).toBeVisible();
  await startSession(page, 'quick-a', 'Quick one');
  await expect(status(page, 'Quick one')).toHaveAttribute('data-status', 'idle', { timeout: 20_000 });
  await startSession(page, 'fail-a', 'Breaks');
  await expect(status(page, 'Breaks')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
  await startSession(page, 'slow-a', 'Waits');
  await expect(status(page, 'Waits')).toHaveAttribute('data-status', 'running', { timeout: 20_000 });

  await expect(page.getByTestId('sess-section-active').getByTestId('sess-item')).toHaveCount(1);
  await expect(page.getByTestId('sess-section-recent').getByTestId('sess-item')).toHaveCount(2);

  // The failed session: the badge, the words, and what the agent last said. Not a success.
  await item(page, 'Breaks').click();
  const detail = page.getByTestId('sess-detail');
  await expect(detail.getByTestId('sess-status')).toHaveText('failed');
  await expect(detail.getByTestId('sess-status-text')).toContainText('failed');
  await expect(detail.getByTestId('sess-status-text')).not.toContainText(/success|passed|verified/i);
  await expect(detail.getByTestId('sess-output')).toContainText('2 tests failed', { timeout: 10_000 });

  // The running one cannot be continued, and the page says why.
  await item(page, 'Waits').click();
  await expect(page.getByTestId('sess-resume')).toBeDisabled();
  await expect(page.getByTestId('sess-resume-why')).toContainText('in progress');
  await shot(page, 'sessions-desktop-dark');
  expect(errors).toEqual([]);
});

test('sessions: Resume continues the same session, with Ctrl+Enter, and the draft is cleared only once it was sent', async ({ page }) => {
  await openSessions(page);
  await startSession(page, 'quick-a', 'Resumable');
  await expect(status(page, 'Resumable')).toHaveAttribute('data-status', 'idle', { timeout: 20_000 });
  const detail = page.getByTestId('sess-detail');
  await expect(page.getByTestId('sess-resume')).toBeDisabled(); // nothing typed yet
  const box = detail.getByLabel('Next prompt');
  await box.fill('go quick-a again');
  await expect(page.getByTestId('sess-resume')).toBeEnabled();
  await box.press('Control+Enter');
  await expect(detail.getByRole('status').filter({ hasText: 'Continuing' })).toBeVisible();
  await expect(box).toHaveValue('');
  await expect(detail.getByText('Runs', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('2', { timeout: 10_000 });
  await expect(page.getByTestId('sess-item')).toHaveCount(1); // the same session, not a second one
  expect(errors).toEqual([]);
});

/** Click a session and wait until its own detail pane is showing, so nothing is typed into the pane of the session that was open before. */
const choose = async (page: Page, title: string) => { await item(page, title).click(); await expect(page.getByTestId('sess-detail')).toHaveAttribute('aria-label', `Session ${title}`); };
test('sessions: unsent text is kept per session when switching, and across a reload', async ({ page }) => {
  await openSessions(page);
  await startSession(page, 'quick-a', 'Alpha');
  await startSession(page, 'quick-b', 'Beta');
  await choose(page, 'Alpha');
  await page.getByLabel('Next prompt').fill('half-written for alpha');
  await choose(page, 'Beta');
  await expect(page.getByLabel('Next prompt')).toHaveValue('');
  await page.getByLabel('Next prompt').fill('half-written for beta');
  await choose(page, 'Alpha');
  await expect(page.getByLabel('Next prompt')).toHaveValue('half-written for alpha');
  await page.reload();
  await openSessions(page);
  await choose(page, 'Beta');
  await expect(page.getByLabel('Next prompt')).toHaveValue('half-written for beta');
  expect(errors).toEqual([]);
});

test('sessions: rename, pin and archive are recorded by the companion; archived cannot be continued; fork is disabled with a reason', async ({ page }) => {
  await openSessions(page);
  await startSession(page, 'quick-a', 'First');
  await startSession(page, 'quick-b', 'Second');
  await item(page, 'First').click();
  const detail = page.getByTestId('sess-detail');
  // No Fork control is offered, because this build cannot fork: a sentence says so instead of a dead button.
  await expect(detail.getByTestId('sess-fork')).toHaveCount(0);
  await expect(detail.getByTestId('sess-fork-why')).toContainText('Not supported');

  await detail.getByTestId('sess-rename').click();
  const name = detail.getByLabel('Session name');
  await name.fill('Renamed one');
  await name.press('Enter');
  await expect(detail.getByRole('heading', { name: 'Renamed one' })).toBeVisible();

  await detail.getByTestId('sess-pin').click();
  await expect(detail.getByTestId('sess-pin')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sess-section-recent').getByTestId('sess-item').first()).toContainText('Renamed one'); // pinned goes first

  await detail.getByTestId('sess-archive').click();
  await expect(page.getByTestId('sess-section-archived').getByTestId('sess-item')).toHaveCount(1);
  await expect(page.getByTestId('sess-resume')).toBeDisabled();
  await expect(page.getByTestId('sess-resume-why')).toContainText('Unarchive');
  // the same change, read back from the companion without the page's help
  const row = await page.evaluate(async () => ((await (await fetch('/api/agent-sessions?archived=1')).json()).sessions as any[]).find((s) => s.title === 'Renamed one'));
  expect(row).toMatchObject({ archived: true, pinned: true, titleSource: 'user' });
  expect(errors).toEqual([]);
});

test('sessions: search narrows the list, and says so when nothing matches', async ({ page }) => {
  await openSessions(page);
  await startSession(page, 'quick-a', 'Parser work');
  await startSession(page, 'quick-b', 'Docs pass');
  await page.getByTestId('sess-search').fill('parser');
  await expect(page.getByTestId('sess-item')).toHaveCount(1);
  await expect(page.getByTestId('sess-item')).toContainText('Parser work');
  await page.getByTestId('sess-search').fill('zzz-nothing');
  await expect(page.getByText('No session matches')).toBeVisible();
  await expect(page.getByTestId('sess-item')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('sessions: Esc closes the New session form and keeps what was typed; the form shows the project read-only', async ({ page }) => {
  await openSessions(page);
  await page.getByTestId('sess-new').click();
  const form = page.getByTestId('sess-new-form');
  await expect(form.getByLabel('Project')).toHaveAttribute('readonly', '');
  await form.getByLabel('Prompt').fill('go quick-a, kept');
  await form.getByLabel('Prompt').press('Escape');
  await expect(form).toBeHidden();
  await page.getByTestId('sess-new').click();
  await expect(page.getByTestId('sess-new-form').getByLabel('Prompt')).toHaveValue('go quick-a, kept');
  // read-only mode is an option, and says what it does
  await page.getByTestId('sess-new-form').locator('select[name=sess-mode]').selectOption('read-only');
  await expect(page.getByTestId('sess-new-form')).toContainText('look but not change files');
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`sessions: ${theme} theme, narrow pane, no accessibility violations in the pane`, async ({ page }) => {
    await page.evaluate((t) => localStorage.setItem('bl-theme', t), theme);
    await page.reload();
    await page.setViewportSize({ width: 900, height: 800 });
    await openSessions(page);
    await startSession(page, 'fail-a', 'Breaks');
    await startSession(page, 'quick-a', 'Fine');
    await expect(status(page, 'Breaks')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
    await item(page, 'Breaks').click();
    await shot(page, `sessions-900-${theme}`);
    const r = await new AxeBuilder({ page }).include('[data-testid=sessions-pane]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    // keyboard: the list, then the detail, are reachable by Tab with visible order; every control has a name
    const unnamed = await page.getByTestId('sessions-pane').locator('button, input, select, textarea').evaluateAll((els) => els.filter((e) => !(e.getAttribute('aria-label') || (e as HTMLInputElement).labels?.length || e.textContent?.trim() || e.getAttribute('title'))).length);
    expect(unnamed).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('sessions: a 380px wide window has no sideways scrolling inside the pane', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await openSessions(page);
  await startSession(page, 'fail-a', 'A rather long session title that must not push the page sideways');
  await expect(page.getByTestId('sess-detail')).toBeVisible();
  const over = await page.getByTestId('sessions-pane').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
  await shot(page, 'sessions-380');
  expect(errors).toEqual([]);
});

test.describe('default project for mobile sessions', () => {
  const card = (page: Page) => page.getByTestId('default-project');
  const openSettings = async (page: Page) => { await go(page, 'Settings'); await expect(card(page)).toBeVisible(); };

  test('set, change availability, and clear, each behind the terminal proof; the path shown is the real folder', async ({ page }) => {
    await openSettings(page);
    await expect(card(page).getByRole('heading', { name: 'Default project for mobile sessions' })).toBeVisible();
    await expect(card(page)).toContainText('never chooses a folder');
    await expect(card(page)).toContainText('approved on this computer');
    await page.getByTestId('dp-setup').click(); // this computer has no phone identity yet
    await expect(card(page).getByTestId('dp-current')).toContainText('No default project is set');
    await expect(page.getByTestId('dp-save')).toBeDisabled();
    await shot(page, 'default-project-empty');

    await page.getByTestId('dp-select').selectOption({ index: 1 });
    await page.getByTestId('dp-save').click();
    await expect(page.getByRole('dialog')).toContainText('and nowhere else');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(card(page).getByTestId('dp-current')).toContainText('No default project is set'); // cancelling changed nothing

    await page.getByTestId('dp-save').click();
    await confirmDialog(page);
    await expect(card(page).getByTestId('dp-valid')).toHaveText('available');
    const shown = (await card(page).getByTestId('dp-path').textContent())!;
    const real = await page.evaluate(async () => (await (await fetch('/api/remote/status')).json()).defaultProject);
    expect(real).toMatchObject({ valid: true, path: shown });
    expect(shown.toLowerCase()).toContain('repo');
    await shot(page, 'default-project-set');

    await page.getByTestId('dp-clear').click();
    await confirmDialog(page);
    await expect(card(page).getByTestId('dp-current')).toContainText('No default project is set');
    expect(await page.evaluate(async () => (await (await fetch('/api/remote/status')).json()).defaultProject)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('a wrong code is refused and nothing is set', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('dp-setup').click();
    await page.getByTestId('dp-select').selectOption({ index: 1 });
    await page.getByTestId('dp-save').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('challenge-code')).toHaveText(/^[0-9a-f]{4}$/);
    await dialog.getByLabel(/to confirm/).fill('zzzz');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(async () => (await (await fetch('/api/remote/status')).json()).defaultProject ?? null)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('if the folder is removed after it was chosen, the card says it is not available', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('dp-setup').click();
    await page.getByTestId('dp-select').selectOption({ index: 1 });
    await page.getByTestId('dp-save').click();
    await confirmDialog(page);
    await expect(card(page).getByTestId('dp-valid')).toHaveText('available');
    // archive the project through the companion's own route, as the Projects screen does
    const id = await page.evaluate(async () => (await (await fetch('/api/remote/status')).json()).defaultProject.projectId as string);
    expect(id).toMatch(/^[a-f0-9]{24}$/);
    const archived = await page.evaluate(async (pid) => {
      const csrf = (await (await fetch('/api/session')).json()).csrf as string;
      return (await fetch('/api/projects/update', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentontrack-csrf': csrf }, body: JSON.stringify({ id: pid, archived: true }) })).status;
    }, id);
    test.skip(archived !== 200, `archiving needs a proof on this build (answered ${archived}); the unavailable wording is covered by the companion's tests`);
    await page.reload();
    await openSettings(page);
    await expect(card(page).getByTestId('dp-valid')).toHaveText('not available');
    expect(existsSync(root)).toBe(true);
  });
});

test('sessions: wide window, list beside the detail, for the failed session', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await openSessions(page);
  await startSession(page, 'fail-a', 'Breaks');
  await startSession(page, 'quick-a', 'Fine');
  await expect(status(page, 'Breaks')).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
  await item(page, 'Breaks').click();
  await expect(page.getByTestId('sess-output')).toContainText('2 tests failed', { timeout: 10_000 });
  // list and detail sit side by side when the pane is wide enough
  const [a, b] = await Promise.all([page.locator('.sess-side').boundingBox(), page.locator('.sess-main').boundingBox()]);
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 2);
  expect(Math.abs(b!.y - a!.y)).toBeLessThan(2);
  await shot(page, 'sessions-1800-dark');
  expect(errors).toEqual([]);
});
