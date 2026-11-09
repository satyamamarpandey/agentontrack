// The dashboard's Stop button, against a REAL companion and a REAL agent process (a script that waits on a gate file), in the Workspace panel. What it proves:
// a real stop ends the process; a stale click (the list still says running, the run has finished), a repeated click, a failed stop and an unknown or other project's run id
// are each shown to the person with the companion's own words, the page does not throw, and the list is refreshed. The companion's own refusals (404 for another project's
// run, 409 for a run that is not running, 500 when an agent cannot be ended) are proved at its API in packages/companion/test; here the page is shown to cope with each.
// The cancel loop in the plan view is covered by the unit tests of stop-run.ts, not through the plan screen.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installHooks } from '../packages/adapters/dist/index.js';
import { startCompanion, type Companion } from '../packages/companion/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { go } from './fixtures';

// "slow-x" waits for the gate file; "quick-x" finishes at once. Files are relative to the project folder, which is the agent's working directory.
const FAKE = `
import { existsSync, writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
const name = /(slow|quick)-\\w+/.exec(prompt)?.[0] ?? 'run';
writeFileSync(name + '.pid', String(process.pid));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
if (name.startsWith('slow')) { while (!existsSync('release')) await new Promise((ok) => setTimeout(ok, 20)); writeFileSync(name + '.finished', 'ran to the end'); }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done ' + name }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;

let dir = ''; let root = ''; let c: Companion; let errors: string[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const RUNS = /\/api\/runs(\?|$)/;

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, 'The Workspace is laid out differently on a phone; the stop handling is not viewport-specific.');
  dir = mkdtempSync(join(tmpdir(), 'aot-dashstop-'));
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
  try { writeFileSync(join(root, 'release'), '1'); } catch { /* gone */ }
  await c?.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* a just-killed process can hold its folder for a moment; it is a throwaway in the OS temp directory */ }
});

const openAgent = async (page: Page) => { await go(page, 'Workspace'); await page.getByRole('tab', { name: 'Agent', exact: true }).click(); };
async function startRun(page: Page, name: string) {
  const before = await page.getByTestId('ws-run-item').count();
  await openAgent(page);
  await page.getByLabel('Prompt').fill(`go ${name}`);
  await page.getByTestId('ws-run').click();
  await expect(page.getByTestId('ws-run-item')).toHaveCount(before + 1, { timeout: 20_000 });
  await expect.poll(() => existsSync(join(root, `${name}.pid`)), { timeout: 20_000 }).toBe(true);
  return Number(readFileSync(join(root, `${name}.pid`), 'utf8'));
}
/** The page's own list, as the companion has it, read without the page's help. */
const serverRuns = (page: Page) => page.evaluate(async () => (await (await fetch('/api/runs')).json()) as { id: string; status: string }[]);
/** From now on the page is told every run is still running, however long ago it ended: a list that has gone stale. Returns how many times it asked. */
async function goStale(page: Page) {
  const asked = { n: 0 };
  await page.route(RUNS, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    asked.n++;
    const real = await route.fetch();
    const list = (await real.json()) as { status: string }[];
    return route.fulfill({ response: real, json: list.map((r) => ({ ...r, status: 'running' })) });
  });
  return asked;
}
const refreshPage = async (page: Page) => { await go(page, 'Projects'); await openAgent(page); };

test('Stop in the Workspace ends the real agent process, the row says stopped, and nothing is raised', async ({ page }) => {
  const pid = await startRun(page, 'slow-a');
  const row = page.getByTestId('ws-run-item').first();
  await expect(row).toHaveAttribute('data-status', 'running');
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
  expect(alive(pid)).toBe(false);
  await expect(page.getByRole('alert')).toHaveCount(0);
  writeFileSync(join(root, 'release'), '1');
  await page.waitForTimeout(800);
  expect(existsSync(join(root, 'slow-a.finished'))).toBe(false);
  expect(errors).toEqual([]);
});

test('a stale Stop click on a run that has finished shows the companion\'s answer, refreshes the list, and leaves the run finished', async ({ page }) => {
  await startRun(page, 'quick-a');
  await expect(page.getByTestId('ws-run-item').first()).toHaveAttribute('data-status', 'finished', { timeout: 20_000 });
  const asked = await goStale(page);
  await refreshPage(page);
  const row = page.getByTestId('ws-run-item').first();
  await expect(row).toHaveAttribute('data-status', 'running'); // the stale list, with a Stop button the run no longer deserves
  const before = asked.n;
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('alert')).toContainText('That run is not running.');
  await expect.poll(() => asked.n).toBeGreaterThan(before); // the list was asked for again
  await page.unrouteAll({ behavior: 'wait' }); // waits for a handler that is still fetching, so it cannot fulfil a route that was just removed
  expect((await serverRuns(page))[0]!.status).toBe('finished');
  expect(errors).toEqual([]);
});

test('a repeated Stop says the run was already stopped, and does not touch anything else', async ({ page }) => {
  const pid = await startRun(page, 'slow-a');
  const asked = await goStale(page);
  await refreshPage(page);
  const row = page.getByTestId('ws-run-item').first();
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => asked.n).toBeGreaterThan(1);
  await expect(page.getByRole('alert')).toHaveCount(0); // the first stop was a real one
  await expect(row).toHaveAttribute('data-status', 'running'); // the list is still stale, so the button is still there
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('alert')).toContainText(/already stopped/i);
  await page.unrouteAll({ behavior: 'wait' }); // waits for a handler that is still fetching, so it cannot fulfil a route that was just removed
  const runs = await serverRuns(page);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe('stopped');
  expect(errors).toEqual([]);
});

for (const [label, status, error, expected] of [
  ['a stop that fails is shown and not swallowed', 500, 'The agent did not exit after a stop and a forced kill, so it may still be running.', /may still be running/],
  ['a stop for a run that is not found (an unknown id, or another project\'s run) is shown and not swallowed', 404, 'No such run', /No such run/],
] as const) {
  test(label, async ({ page }) => {
    const pid = await startRun(page, 'slow-a');
    let refused = 0;
    await page.route(/\/api\/runs\/run_\w+\/stop/, async (route) => { refused++; await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error }) }); });
    const asked = await goStale(page); // also proves the list is refreshed after a failure
    const before = asked.n;
    const row = page.getByTestId('ws-run-item').first();
    await row.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('alert')).toContainText(expected);
    expect(refused).toBe(1);
    await expect.poll(() => asked.n).toBeGreaterThan(before);
    expect(alive(pid)).toBe(true); // the real request never reached the companion, so the agent is untouched
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: 'wait' }); // waits for a handler that is still fetching, so it cannot fulfil a route that was just removed
    await refreshPage(page);
    await page.getByTestId('ws-run-item').first().getByRole('button', { name: 'Stop' }).click(); // and a real stop afterwards still works
    await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);
  });
}
