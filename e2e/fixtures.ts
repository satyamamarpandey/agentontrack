import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';

const CLI = resolve('packages/cli/dist/index.js');

const FAKE_AGENT = `
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
if (/Make the change/.test(prompt)) { await new Promise((ok) => setTimeout(ok, Number(process.env.AOT_FAKE_DELAY_MS ?? 0))); writeFileSync('done.txt', 'ok'); }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. All tests pass, everything is verified.' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, duration_api_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;

export interface Env {
  c: Companion;
  root: string;
  dir: string;
  home: string;
  project: <T>(fn: (p: Project) => T) => T;
  hook: (command: string, tool?: string) => string;
  pair: (page: Page) => Promise<void>;
}

/** The real companion and engine in a disposable folder. No API is mocked. */
export const test = base.extend<{ env: Env; fakeAgent: boolean }>({
  fakeAgent: [false, { option: true }],
  env: async ({ fakeAgent }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'bl-e2e-'));
    const home = join(dir, 'home');
    const root = join(dir, 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.txt'), 'a');
    process.env.AGENTONTRACK_HOME = home;
    if (fakeAgent) writeFileSync(join(dir, 'fake-claude.mjs'), FAKE_AGENT);
    const c = await startCompanion({ root, ...(fakeAgent ? { claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] } : {}) });
    const env: Env = {
      c, root, dir, home,
      project: (fn) => { const p = new Project(root); try { return fn(p); } finally { p.close(); } },
      hook: (command, tool = 'Bash') => spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, AGENTONTRACK_HOME: home, AGENTONTRACK_ROOT: root },
        input: JSON.stringify({ session_id: 'e2e', cwd: root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }),
      }).stdout,
      pair: async (page) => {
        await page.goto(c.url);
        await page.getByLabel('Pairing code').fill(c.newPairingCode());
        await page.getByRole('button', { name: 'Pair', exact: true }).click();
        await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('button', { name: 'Menu' })).first()).toBeVisible();
      },
    };
    await use(env);
    await c.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  },
});

/** The six places in the main navigation, and which of them hold tabs. A screen name here is the old, specific one. */
const SECTION: Record<string, string> = { Projects: 'Projects', Goals: 'Projects', Workspace: 'Workspace', Agents: 'Agents', Approvals: 'Activity', Safety: 'Activity', Evidence: 'Activity', Overview: 'Analytics', Usage: 'Analytics', Results: 'Analytics', Comparisons: 'Analytics', Evaluations: 'Analytics', Environment: 'Analytics', Settings: 'Settings', Feedback: 'Settings' };
const TAB: Record<string, string> = { Projects: 'My projects', Goals: 'Goals and tasks', Evidence: 'Records', Results: 'Results and evidence' };
const HAS_TABS = new Set(['Projects', 'Activity', 'Analytics', 'Settings']);

/** Goes to a screen on any viewport; on mobile the nav sits behind the menu button. */
export async function go(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible() && (await menu.getAttribute('aria-expanded')) === 'false') await menu.click();
  const section = SECTION[name] ?? name;
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: section, exact: true }).click();
  if (HAS_TABS.has(section)) await page.getByRole('tablist', { name: 'Section' }).getByRole('tab', { name: TAB[name] ?? name, exact: true }).click();
}

/** Completes the confirmation dialog the way a person does: reads the code and types it back. */
export async function confirmDialog(page: Page, passphrase?: string) {
  const dialog = page.getByRole('dialog');
  const code = dialog.getByTestId('challenge-code');
  await expect(code).toHaveText(/^[0-9a-f]{4}$/);
  await dialog.getByLabel(/to confirm/).fill((await code.textContent())!);
  if (passphrase) await dialog.getByLabel('Approver passphrase').fill(passphrase);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

/** The same dialog on a page from an outside origin: it shows no code, and confirming then asks for the one in the terminal. Pair with a locator handler for that. */
export async function confirmOutsideOrigin(page: Page) {
  const dialog = page.locator('[role=dialog]:not([data-testid=terminal-code-dialog])');
  await expect(dialog.getByTestId('challenge-code')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

export { expect };
