// REAL INFERENCE through the NEW web workspace prompt composer. Nothing is mocked.
// Add project -> connect Claude Code -> task -> prompt -> real file change -> held push -> deny -> approve -> real push
// -> Verify -> receipt -> VERIFIED -> dashboard. Also cancel, reconnect, a second window, a stale file, and an unauthorized caller.
// Costs a little of the owner's Claude usage, so it only runs with AGENTONTRACK_LIVE=1.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Project } from '../packages/core/dist/index.js';
import { confirmDialog, expect, go, test } from './fixtures';

test.skip(!process.env.AGENTONTRACK_LIVE, 'Set AGENTONTRACK_LIVE=1 to spend real inference.');
test.setTimeout(480_000);

async function run(page: any, prompt: string) {
  const before = await page.getByTestId('ws-run-item').count();
  await page.getByRole('tab', { name: 'Agent', exact: true }).click();
  await page.getByLabel('Prompt').fill(prompt);
  await page.getByLabel('Model').fill('haiku');
  await page.getByTestId('ws-run').click();
  await expect(page.getByTestId('ws-run-item')).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(page.getByTestId('ws-run-item').first()).not.toHaveAttribute('data-status', 'running', { timeout: 200_000 });
  return page.getByTestId('ws-run-item').first().getAttribute('data-status');
}

test('real Claude Code through the web workspace composer, end to end', async ({ page, browser, env }) => {
  const log: Record<string, unknown> = {};
  await env.pair(page);

  // 1. Create a project in the interface.
  const proj = join(env.dir, 'live-proj');
  await go(page, 'Projects');
  await page.getByRole('button', { name: 'Add project' }).click();
  await page.getByRole('button', { name: 'Create a new folder' }).click();
  await page.getByLabel('Absolute folder path').fill(proj);
  await page.getByRole('button', { name: 'Attach' }).click();
  await expect(page.getByTestId('project-card').filter({ hasText: 'live-proj' })).toBeVisible();
  // A git repository and a disposable remote, made by the harness: the product does not create repositories.
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.txt'), 'a');
  const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  git(proj, 'init', '-q', '-b', 'main'); git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'init');
  const bare = join(env.dir, 'remote.git');
  mkdirSync(bare);
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  git(proj, 'remote', 'add', 'origin', bare);
  const inProj = <T,>(fn: (p: Project) => T): T => { const p = new Project(proj); try { return fn(p); } finally { p.close(); } };
  const pushed = () => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'main']).status === 0;
  await page.getByTestId('project-card').filter({ hasText: 'live-proj' }).getByRole('button', { name: 'live-proj' }).click();
  await page.getByTestId('open-workspace').click();
  await expect(page.getByTestId('workspace')).toBeVisible();

  // 2. Agent selection and connection, in the workspace.
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const claude = page.getByTestId('ws-agent-claude-code');
  await expect(claude).toContainText('Claude Code');
  log.claudeVersion = await claude.locator('.muted').first().textContent();
  await claude.getByRole('button', { name: 'Connect' }).click();
  await expect(claude.getByRole('button', { name: 'Disconnect' })).toBeVisible({ timeout: 15_000 });
  expect(existsSync(join(proj, '.claude', 'settings.local.json'))).toBe(true);

  // 3. Goal (Goals page) and a task with a real check (Tasks pane).
  await go(page, 'Goals');
  await page.getByLabel('Goal', { exact: true }).fill('Create the done file in src');
  await page.getByLabel(/In scope/).fill('src/**');
  await page.getByRole('button', { name: 'Review and approve' }).click();
  await confirmDialog(page);
  await go(page, 'Workspace');
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await page.getByLabel('Task', { exact: true }).fill('Create done file');
  await page.getByLabel(/Acceptance check/).fill(`node -e "process.exit(require('fs').existsSync('src/done.txt')?0:1)"`);
  await page.getByRole('button', { name: 'Review and create…' }).click();
  await confirmDialog(page);
  await expect(page.getByTestId('ws-tasks')).toContainText('Create done file');

  // 4. Prompt: a real file change, then a push that must be held.
  const first = await run(page, 'Use the Write tool to create src/done.txt containing "ok". Then run exactly this Bash command: git push origin HEAD:main . If it is refused, do not try another way. Report the refusal and stop.');
  log.firstRun = first;
  expect(readFileSync(join(proj, 'src', 'done.txt'), 'utf8')).toContain('ok');
  expect(pushed(), 'the push must be held').toBe(false);

  // 5. The held push is in the workspace. Deny it.
  await page.getByTestId('ws-pending').click();
  await expect(page.getByTestId('ws-approval')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('ws-approval')).toContainText('vcs.push');

  // A second window, paired on its own, sees the same held request.
  const second = await browser.newPage();
  await env.pair(second);
  await second.getByTestId('project-card').filter({ hasText: 'live-proj' }).getByRole('button', { name: 'live-proj' }).click();
  await go(second, 'Approvals');
  await expect(second.locator('[data-testid=approval][data-view=pending]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Deny…' }).click();
  await confirmDialog(page);
  await expect(page.getByTestId('ws-approval')).toHaveCount(0);
  await expect(second.locator('[data-testid=approval][data-view=denied]')).toHaveCount(1, { timeout: 15_000 });
  expect(pushed(), 'denied, so still not pushed').toBe(false);

  // 6. Ask again, approve it, and the real push reaches the remote.
  await run(page, 'Run exactly this Bash command: git push origin HEAD:main . If it is refused, do not try another way. Report the refusal and stop.');
  expect(pushed()).toBe(false);
  await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
  await expect(page.getByTestId('ws-approval')).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Approve…' }).click();
  await confirmDialog(page);
  await run(page, 'The user has now approved it. Run exactly this Bash command: git push origin HEAD:main . Then stop.');
  expect(pushed(), 'the approved push reached the remote').toBe(true);

  // 7. Cancellation: a long run is stopped, and says so.
  await page.getByRole('tab', { name: 'Agent', exact: true }).click();
  await page.getByLabel('Prompt').fill('Run exactly this Bash command: node -e "setTimeout(()=>{},120000)" . Then stop.');
  await page.getByTestId('ws-run').click();
  const running = page.getByTestId('ws-run-item').first();
  await expect(running).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
  await running.getByRole('button', { name: 'Stop' }).click();
  await expect(running).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });

  // 8. Stale file: the agent's file changes on disk while it is open in the editor.
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'done.txt' }).click();
  await expect(page.getByTestId('ws-editor')).toHaveValue('ok');
  writeFileSync(join(proj, 'src', 'done.txt'), 'changed by something else');
  await page.getByTestId('ws-editor').fill('ok, edited in the browser');
  await page.getByTestId('ws-save').click();
  await expect(page.getByTestId('ws-conflict')).toBeVisible();
  await page.getByRole('button', { name: 'Discard mine and reload' }).click();
  // Put the file back so the real check can pass.
  await page.getByTestId('ws-editor').fill('ok');
  await page.getByTestId('ws-save').click();
  await expect.poll(() => readFileSync(join(proj, 'src', 'done.txt'), 'utf8')).toBe('ok');

  // 9. Verify, in the Verification tab: a real check, a receipt, VERIFIED.
  await page.getByRole('tab', { name: 'Verification', exact: true }).click();
  await page.getByTestId('ws-verify').click();
  await expect(page.locator('.ws-bottom').getByText('VERIFIED', { exact: true })).toBeVisible({ timeout: 30_000 });

  // 10. The dashboard agrees with the record.
  await go(page, 'Evidence');
  await expect(page.getByTestId('receipt').first()).toContainText('independent-run');
  await go(page, 'Overview');
  await expect(page.locator('main')).toContainText('1 / 1');
  await go(page, 'Usage');
  await expect(page.getByText('Actual: provider-reported').first()).toBeVisible();

  // 11. Unauthorized caller: no session, no data, no change.
  const anon = await fetch(`${env.c.url}api/state`);
  expect(anon.status).toBe(401);
  const anonWrite = await fetch(`${env.c.url}api/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'src/x', content: 'x', baseHash: null }) });
  expect([401, 403]).toContain(anonWrite.status);

  // 12. Reconnect: disconnect this browser, pair again, and the record is intact.
  const head = inProj((p) => p.store.head()!.seq);
  await go(page, 'Settings');
  await page.getByRole('button', { name: 'Disconnect this browser' }).click();
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  await page.getByLabel('Pairing code').fill(env.c.newPairingCode());
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await go(page, 'Evidence');
  await expect(page.getByText(/events, \d+ witnessed/)).toBeVisible();
  const integrity = inProj((p) => p.verifyIntegrity());
  expect(integrity.ok).toBe(true);
  expect(inProj((p) => p.store.head()!.seq)).toBeGreaterThanOrEqual(head);

  const events = inProj((p) => p.store.all());
  const summary = {
    ranAt: new Date().toISOString(), claude: log.claudeVersion, model: 'haiku', surface: 'web workspace composer (new)', browser: 'chromium',
    runs: events.filter((e) => e.type === 'run.finished').map((e) => ({ status: e.payload.status, wallClockMs: e.payload.wallClockMs, costUsd: e.payload.totalCostUsd, numTurns: e.payload.numTurns })),
    totalListCostUsd: events.filter((e) => e.type === 'run.finished').reduce((n, e) => n + (e.payload.totalCostUsd ?? 0), 0),
    actions: events.filter((e) => e.type === 'action.requested').map((e) => ({ tool: e.payload.tool, decision: e.payload.decision, assurance: e.payload.assurance })),
    approvals: [...inProj((p) => p.state()).approvals.values()].map((a) => ({ kind: a.effect.kind, status: a.status })),
    pushReachedRemoteOnlyAfterApproval: true, integrity: { ok: integrity.ok, events: integrity.chain.events },
  };
  writeFileSync('benchmarks/results/live-web-workspace.json', JSON.stringify(summary, null, 2));
});
