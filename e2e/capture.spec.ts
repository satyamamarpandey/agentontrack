// Screenshots of real rendered screens for review and the UAT record. Run: AGENTONTRACK_CAPTURE=1 playwright test capture --project=chromium
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, go, test } from './fixtures';

test.skip(!process.env.AGENTONTRACK_CAPTURE, 'Set AGENTONTRACK_CAPTURE=1.');
const OUT = 'docs/uat/screenshots';

test('capture dashboard screens', async ({ page, env }) => {
  mkdirSync(OUT, { recursive: true });
  env.project((p) => {
    p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['src/**'] }, prohibit: ['deploy'] });
    p.human.createTask({ id: 't1', title: 'Parser fix', criteria: [{ id: 'c', description: 'fixed file exists', kind: 'artifact', path: 'src/a.txt' }] });
    p.verifyTask('t1');
    p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: [{ kind: 'exec.opaque', target: 'python x.py' }], opaque: true, coverage: 'enforced', rawInput: 'python x.py' });
    writeFileSync(join(env.root, 'prod.conf'), 'x');
    p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] });
    p.recordUsage({ runtime: 'claude-code', model: 'claude-haiku-5-5', source: 'provider-reported', sessionId: 's', inputTokens: 40, outputTokens: 900, cacheReadTokens: 50000, cacheCreationTokens: 16000, costUsd: 0.004, costBasis: 'list' });
  });
  env.hook('git push origin main');
  await page.setViewportSize({ width: 1280, height: 860 });
  await env.pair(page);
  for (const s of ['Overview', 'Goals', 'Agents', 'Usage', 'Safety', 'Approvals', 'Evaluations', 'Environment', 'Settings']) {
    await go(page, s);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/dash-${s.toLowerCase()}.png`, fullPage: s === 'Safety' });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await go(page, 'Overview');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/dash-overview-light.png` });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/dash-mobile.png` });
});

test('capture site', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('http://127.0.0.1:4199/agentontrack/');
  await page.screenshot({ path: `${OUT}/site-home.png`, fullPage: true });
  await page.goto('http://127.0.0.1:4199/agentontrack/benchmarks/');
  await page.screenshot({ path: `${OUT}/site-benchmarks.png`, fullPage: true });
});
