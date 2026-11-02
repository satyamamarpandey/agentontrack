// Screenshots of every dashboard screen and every public page, for before/after review.
// AGENTONTRACK_SHOTS=docs/ui/before pnpm exec playwright test audit --project=chromium
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, go, test } from './fixtures';

const OUT = process.env.AGENTONTRACK_SHOTS;
test.skip(!OUT, 'Set AGENTONTRACK_SHOTS to an output folder.');

const SCREENS = ['Projects', 'Overview', 'Goals', 'Agents', 'Usage', 'Comparisons', 'Evidence', 'Safety', 'Approvals', 'Evaluations', 'Environment', 'Feedback', 'Settings'];
const PAGES = ['', 'features', 'how-it-works', 'install', 'integrations', 'docs', 'security', 'pricing', 'benchmarks', 'roadmap', 'changelog', 'community', 'feedback', 'privacy', 'terms', 'account'];
const SIZES = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1100 }, mobile: { width: 390, height: 844 } } as const;

test('dashboard screens against the real companion', async ({ page, env }) => {
  mkdirSync(OUT!, { recursive: true });
  env.project((p) => {
    p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['src/**'] }, prohibit: ['deploy'] });
    p.human.createTask({ id: 't1', title: 'Parser fix', criteria: [{ id: 'c', description: 'fixed file exists', kind: 'artifact', path: 'src/a.txt' }] });
    p.verifyTask('t1');
    p.recordUsage({ runtime: 'claude-code', model: 'test-model', source: 'provider-reported', sessionId: 's', inputTokens: 100, outputTokens: 420, cacheReadTokens: 5000, cacheCreationTokens: 900 });
  });
  env.hook('git status');
  env.hook('git push origin main');
  await page.setViewportSize(SIZES.desktop);
  await env.pair(page);
  for (const [name, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    for (const s of SCREENS) {
      await go(page, s);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT!, `dash-${s.toLowerCase()}-${name}.png`), fullPage: true });
    }
  }
});

test('public pages', async ({ page }) => {
  mkdirSync(OUT!, { recursive: true });
  const overflow: string[] = [];
  for (const [name, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    for (const route of PAGES) {
      await page.goto(`http://127.0.0.1:4199/agentontrack/${route}${route ? '/' : ''}`);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: join(OUT!, `site-${route || 'home'}-${name}.png`), fullPage: true });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (wide) overflow.push(`${route || 'home'} at ${name}`);
    }
  }
  writeFileSync(join(OUT!, 'overflow.txt'), overflow.length ? overflow.join('\n') : 'none');
});

test('workspace in both themes and on mobile', async ({ page, env }) => {
  mkdirSync(OUT!, { recursive: true });
  writeFileSync(join(env.root, 'README.md'), '# Parser\n\nNotes for the agents.\n\n- keep changes in src\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: env.root });
  env.project((p) => {
    p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['src/**', 'README.md'] }, prohibit: ['deploy'] });
    p.human.createTask({ id: 't1', title: 'Parser fix', criteria: [{ id: 'c', description: 'fixed file exists', kind: 'artifact', path: 'src/a.txt' }] });
    p.verifyTask('t1');
    p.human.setTeam([{ agent: 'claude-code', role: 'implement' }, { agent: 'codex', role: 'review' }]);
  });
  env.hook('git push origin main');
  await page.setViewportSize(SIZES.desktop);
  await env.pair(page);
  await go(page, 'Workspace');
  await page.getByRole('button', { name: 'README.md' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT!, 'workspace-desktop-dark.png') });
  await page.getByRole('tab', { name: 'Team' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT!, 'workspace-team-dark.png') });
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT!, 'workspace-desktop-light.png') });
  await page.setViewportSize(SIZES.tablet);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT!, 'workspace-tablet-light.png') });
  await page.setViewportSize(SIZES.mobile);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT!, 'workspace-mobile-editor.png') });
  await page.getByRole('button', { name: /Agents/ }).last().click();
  await page.screenshot({ path: join(OUT!, 'workspace-mobile-agents.png') });
});
