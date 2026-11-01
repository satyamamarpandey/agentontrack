// REAL: the deployed public website -> companion on this machine -> real Claude Code -> approval -> evidence -> dashboard.
// Costs a little Claude usage, so it only runs with AGENTONTRACK_LIVE=1. Nothing is mocked.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCompanion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { confirmOutsideOrigin, go } from './fixtures';

test.skip(!process.env.AGENTONTRACK_LIVE, 'Set AGENTONTRACK_LIVE=1 to spend real inference.');
test.setTimeout(420_000);
const SITE = process.env.SITE_URL ?? 'https://pandeysatyam.com/agentontrack';
const PORT = 47631;

test('deployed site: pair, connect, goal, denied and approved actions, evidence, usage, reconnect', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'aot-public-'));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const bare = join(dir, 'remote.git');
  mkdirSync(bare);
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: bare });
  git('remote', 'add', 'origin', bare);
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  // An outside origin gets no confirmation codes: each change shows one in the terminal. This stands in for reading it there.
  const terminalCodes: string[] = [];
  await page.addLocatorHandler(page.getByTestId('terminal-code-dialog'), async (d) => {
    await d.getByLabel('Code from your terminal').fill(terminalCodes.at(-1)!);
    await d.getByRole('button', { name: 'Confirm' }).click();
  });
  // AOT_INSTALLED names an installed agentontrack command: then this is the released program, in a real terminal, as a user runs it.
  let c: { newPairingCode(): string | Promise<string>; close(): Promise<void> };
  if (process.env.AOT_INSTALLED) {
    const { spawn: ptySpawn } = await import('@lydell/node-pty');
    const win = process.platform === 'win32';
    const term = ptySpawn(win ? 'cmd.exe' : 'sh', win ? ['/c', process.env.AOT_INSTALLED, 'dashboard', '--allow-public-site'] : [process.env.AOT_INSTALLED, 'dashboard', '--allow-public-site'], { cwd: root, env: { ...process.env, AGENTONTRACK_ROOT: root } as Record<string, string>, cols: 220, rows: 50 });
    let screen = '';
    term.onData((d) => { screen += d; for (const m of screen.matchAll(/type this code there: ([0-9a-f]{6})/g)) if (!terminalCodes.includes(m[1]!)) terminalCodes.push(m[1]!); });
    const lastCode = () => [...screen.matchAll(/airing code[^:]*: ([A-Z0-9]{6,})/g)].at(-1)?.[1];
    await expect.poll(lastCode, { timeout: 30_000 }).toBeTruthy();
    c = {
      newPairingCode: async () => { const before = lastCode(); term.write('\r'); await expect.poll(lastCode, { timeout: 10_000 }).not.toBe(before); return lastCode()!; },
      close: async () => { term.write('\x03'); await new Promise((ok) => setTimeout(ok, 1000)); if (win) term.write('y\r'); else term.kill(); await new Promise((ok) => setTimeout(ok, 1500)); },
    };
  } else {
    c = await startCompanion({ root, port: PORT, allowedOrigins: [new URL(SITE).origin], onTerminalChallenge: (code) => { terminalCodes.push(code); } });
  }
  const pushed = () => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'main']).status === 0;
  // The list can take seconds to load, so the test keeps its own count.
  let started = 0;
  const run = async (prompt: string) => {
    await go(page, 'Agents');
    await page.getByLabel('Prompt').fill(prompt);
    await page.getByLabel('Model').fill('haiku');
    await page.getByLabel(/Budget cap/).fill('0.25');
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByTestId('run')).toHaveCount(++started, { timeout: 30_000 });
    await expect(page.getByTestId('run').first()).not.toHaveAttribute('data-status', 'running', { timeout: 180_000 });
  };
  try {
    // Chromium asks the user before a public page may reach a local address. This stands in for clicking Allow.
    await page.context().grantPermissions(['local-network-access'], { origin: new URL(SITE).origin });
    await page.goto(`${SITE}/dashboard/`);
    if (!process.env.SITE_URL) expect(new URL(page.url()).protocol).toBe('https:');
    await page.getByLabel('Companion port').fill(String(PORT));
    await page.getByLabel('Pairing code').fill('WRONGCOD');
    await c.newPairingCode();
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong pairing code');
    await page.getByLabel('Pairing code').fill(await c.newPairingCode());
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('repo');
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);

    await go(page, 'Agents');
    const card = page.getByTestId('agent-claude-code');
    await expect(card).toContainText(/Yes \(/);
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 15_000 });

    await go(page, 'Goals');
    await page.getByLabel('Goal', { exact: true }).fill('Create the done file in src');
    await page.getByLabel(/In scope/).fill('src/**');
    await page.getByRole('button', { name: 'Review and approve' }).click();
    await confirmOutsideOrigin(page);
    await page.getByLabel('Task', { exact: true }).fill('Create done file');
    await page.getByLabel(/Acceptance check/).fill(`node -e "process.exit(require('fs').existsSync('src/done.txt')?0:1)"`);
    await page.getByRole('button', { name: 'Review and create' }).click();
    await confirmOutsideOrigin(page);

    const pushPrompt = 'Run exactly this Bash command: git push origin HEAD:main . If it is refused, do not try another way. Report the refusal and stop.';
    await run(`Use the Write tool to create src/done.txt containing "ok". Then: ${pushPrompt}`);
    expect(readFileSync(join(root, 'src', 'done.txt'), 'utf8')).toContain('ok');
    expect(pushed(), 'held before any decision').toBe(false);

    await go(page, 'Approvals');
    const pending = page.locator('[data-testid=approval][data-view=pending]');
    await expect(pending).toHaveCount(1, { timeout: 15_000 });
    await pending.getByRole('button', { name: 'Deny' }).click();
    await confirmOutsideOrigin(page);
    await expect(page.locator('[data-testid=approval][data-view=denied]')).toHaveCount(1);

    await run(pushPrompt);
    expect(pushed(), 'held after denial').toBe(false);
    await go(page, 'Approvals');
    const again = page.locator('[data-testid=approval][data-view=pending]');
    await expect(again).toHaveCount(1, { timeout: 15_000 });
    await again.getByRole('button', { name: 'Approve' }).click();
    await confirmOutsideOrigin(page);
    await run('The user has now approved it. Run exactly this Bash command: git push origin HEAD:main . Then stop.');
    expect(pushed(), 'reached the remote only after approval').toBe(true);

    await go(page, 'Goals');
    await page.getByRole('button', { name: 'Verify now' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Create done file' }).getByText('VERIFIED', { exact: true })).toBeVisible({ timeout: 30_000 });
    await go(page, 'Evidence');
    await expect(page.getByTestId('receipt').first()).toContainText('independent-run');
    await go(page, 'Usage');
    await expect(page.getByText('Actual: provider-reported').first()).toBeVisible();
    await go(page, 'Safety');
    await expect(page.locator('[data-testid=action][data-decision=request_approval]').first()).toBeVisible();

    // A reload keeps the tab's session. A new companion would need a new code.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Safety');
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);
    await go(page, 'Settings');
    await page.getByRole('button', { name: 'Disconnect this browser' }).click();
    await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();

    const p = new Project(root);
    const events = p.store.all();
    const integrity = p.verifyIntegrity();
    const runs = events.filter((e) => e.type === 'run.finished');
    const summary = {
      ranAt: new Date().toISOString(), viaSite: SITE, product: process.env.AOT_INSTALLED ? 'installed release archive' : 'dev build', browser: 'chromium', origin: new URL(SITE).origin,
      claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(), model: 'haiku',
      runs: runs.map((e) => ({ status: e.payload.status, wallClockMs: e.payload.wallClockMs, costUsd: e.payload.totalCostUsd })),
      totalListCostUsd: runs.reduce((n, e) => n + (e.payload.totalCostUsd ?? 0), 0),
      actions: events.filter((e) => e.type === 'action.requested').map((e) => ({ tool: e.payload.tool, decision: e.payload.decision, assurance: e.payload.assurance, kinds: e.payload.effects.map((x: any) => x.kind) })),
      approvals: [...p.state().approvals.values()].map((a) => ({ kind: a.effect.kind, status: a.status, method: (a.approver as any)?.method })),
      taskStatus: p.evaluate([...p.state().tasks.keys()][0]!).status, integrityOk: integrity.ok, events: integrity.chain.events,
    };
    p.close();
    writeFileSync(`benchmarks/results/${process.env.AOT_RESULT ?? 'live-public-site-to-claude'}.json`, JSON.stringify(summary, null, 2));
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(true);
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
