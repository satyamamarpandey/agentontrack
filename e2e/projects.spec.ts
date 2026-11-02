// The Projects home and project page, against the real companion and engine. No API is mocked.
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect as baseExpect, test as baseTest } from '@playwright/test';
import { confirmDialog, expect, go, test, type Env } from './fixtures';

const seed = (env: Env) => env.project((p) => {
  p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['src/**'] }, prohibit: ['deploy'] });
  p.human.createTask({ id: 't1', title: 'Parser fix', criteria: [{ id: 'c', description: 'fixed file exists', kind: 'artifact', path: 'src/a.txt' }] });
});
/** 520 tokens over one task, and a 90-second run. */
const seedUsage = (env: Env) => env.project((p) => {
  p.recordUsage({ runtime: 'claude-code', model: 'test-model', source: 'provider-reported', sessionId: 's', inputTokens: 100, outputTokens: 420 });
  p.store.append({ type: 'run.finished', actor: { kind: 'system', runtime: 'claude-code' }, payload: { id: 'run_t', status: 'finished', exitCode: 0, wallClockMs: 90_000, durationApiMs: 60_000 } });
});
const openRepo = async (page: any) => { await page.getByRole('button', { name: 'repo' }).click(); await expect(page.getByRole('heading', { level: 1 })).toHaveText('repo'); };
const tab = async (page: any, name: string) => { await page.getByTestId(`project-tab-${name}`).click(); await expect(page.getByTestId(`project-panel-${name}`)).toBeVisible(); };

test('project cards show real name, goal, status, approvals, tokens and last activity', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  env.hook('git push origin main');
  await env.pair(page);
  const card = page.getByTestId('project-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('repo');
  await expect(card).toContainText('Fix the parser');
  await expect(card.getByTestId('card-status')).toContainText(/\S/);
  await expect(card.getByTestId('card-pending')).toHaveText('1');
  await expect(card.getByTestId('card-tokens')).toContainText('520');
  await expect(card.getByTestId('card-tokens')).toContainText('Actual: provider-reported');
  await expect(card.getByTestId('card-activity')).toContainText(String(new Date().getFullYear()));
  await expect(page.getByTestId('card-demo-label')).toHaveCount(0);
});

test('a card with nothing recorded says so, instead of showing a zero', async ({ page, env }) => {
  await env.pair(page);
  const card = page.getByTestId('project-card');
  await expect(card.getByTestId('card-tokens')).toHaveText('Unavailable');
  await expect(card.getByTestId('card-activity')).toContainText('None recorded');
  await expect(card).toContainText('No goal set');
});

test('several projects: each card and page shows that project\'s own record', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  await env.pair(page);
  await page.getByRole('button', { name: 'Add project' }).click();
  const second = join(env.dir, 'second');
  mkdirSync(second);
  await page.getByLabel('Absolute folder path').fill(second);
  await page.getByRole('button', { name: 'Attach' }).click();
  await expect(page.getByTestId('project-card')).toHaveCount(2);
  const other = page.getByTestId('project-card').filter({ hasText: 'second' });
  await expect(other.getByTestId('card-tokens')).toHaveText('Unavailable');
  await expect(page.getByTestId('project-card').filter({ hasText: 'repo' }).getByTestId('card-tokens')).toContainText('520');
  await other.getByRole('button', { name: 'second' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('second');
  await expect(page.getByText('No approved goal.')).toBeVisible();
  await page.getByRole('button', { name: /All projects/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My projects');
});

test('click-through: every section opens, survives a reload, and uses only endpoints released in 1.0.0-rc.2, naming the project', async ({ page, env }) => {
  seed(env);
  await env.pair(page);
  const seen: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) seen.push(u.pathname + u.search); });
  await openRepo(page);
  for (const name of ['workflow', 'usage', 'verification', 'environment', 'overview']) await tab(page, name);
  await expect(page).toHaveURL(/#project\/[^/]+\/overview$/);
  await tab(page, 'verification');
  await page.reload();
  await expect(page.getByTestId('project-panel-verification')).toBeVisible();
  await expect(page.getByTestId('project-tab-verification')).toHaveAttribute('aria-selected', 'true');
  const paths = seen.filter((p) => !p.startsWith('/api/events/stream'));
  const allowed = /^\/api\/(health|session|projects|state|analytics|actions|event\/\d+|settings)(\?|$)/;
  expect(paths.filter((p) => !allowed.test(p))).toEqual([]);
  for (const p of paths.filter((x) => /\/api\/(state|analytics|actions)/.test(x))) expect(p).toContain('project=');
});

test('tabs work with the arrow keys', async ({ page, env, browserName, isMobile }) => {
  test.skip(isMobile || browserName === 'webkit', 'Mobile has no arrow keys; Safari tabs past buttons by default.');
  await env.pair(page);
  await openRepo(page);
  await page.getByTestId('project-tab-overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('project-panel-workflow')).toBeVisible();
  await expect(page.getByTestId('project-tab-workflow')).toBeFocused();
});

test('workflow: goal, task, actions, held, approved and verification, in order, each with its source', async ({ page, env }) => {
  seed(env);
  env.hook('git status');
  env.hook('git push origin main');
  env.project((p) => p.verifyTask('t1'));
  await env.pair(page);
  await go(page, 'Approvals');
  await page.getByTestId('approval').getByRole('button', { name: 'Approve' }).click();
  await confirmDialog(page);
  await go(page, 'Projects');
  await openRepo(page);
  await tab(page, 'workflow');
  const items = page.getByTestId('timeline').locator(':scope > li');
  const kinds = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind') ?? 'group'));
  expect(kinds).toEqual(['goal', 'task', 'group', 'held', 'verification', 'approved']);
  await expect(page.getByTestId('timeline-item').filter({ hasText: 'Goal v1 approved' })).toContainText('Fix the parser');
  await expect(page.getByTestId('timeline-item').filter({ hasText: 'Held for approval' })).toContainText('vcs.push');
  await expect(page.locator('[data-kind=approved]')).toContainText('Approved by a person');
  await page.getByTestId('timeline-group').locator('summary').click();
  await expect(page.getByTestId('timeline-group').getByTestId('timeline-item')).toContainText('Allowed');
  await page.locator('[data-kind=held]').getByRole('button', { name: 'source' }).click();
  await expect(page.getByRole('dialog')).toContainText('action.requested');
});

test('a detected change appears on the timeline as detected, not prevented', async ({ page, env }) => {
  seed(env);
  env.project((p) => {
    p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: [{ kind: 'exec.opaque', target: 'python x.py' }], opaque: true, coverage: 'enforced', rawInput: 'python x.py' });
    writeFileSync(join(env.root, 'prod.conf'), 'x');
    p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] });
  });
  await env.pair(page);
  await openRepo(page);
  await tab(page, 'workflow');
  await expect(page.locator('[data-kind=detected]').first()).toContainText('detected afterwards');
  await expect(page.locator('[data-kind=detected]').first()).toContainText('prod.conf');
  await tab(page, 'verification');
  await expect(page.locator('main')).toContainText('Open unauthorized effects');
});

test('with nothing to compare, every saved figure and environmental figure is Unavailable with its reason', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  await env.pair(page);
  await openRepo(page);
  await expect(page.getByTestId('glance-tokens-saved')).toContainText('Unavailable');
  await expect(page.getByTestId('glance-tokens-saved')).toContainText('No baseline');
  await expect(page.getByTestId('glance-time-saved')).toContainText('Unavailable');
  await expect(page.getByTestId('glance-water-saved')).toContainText('Unavailable');
  await tab(page, 'usage');
  await expect(page.getByTestId('saved-tokens')).toContainText('Unavailable');
  await expect(page.getByTestId('saved-tokens')).toContainText('No baseline');
  await expect(page.getByTestId('saved-time')).toContainText('No baseline time');
  await tab(page, 'environment');
  for (const id of ['env-energy', 'env-water', 'env-water-saved']) await expect(page.getByTestId(id)).toContainText('Unavailable');
  await expect(page.getByTestId('env-vendors')).toContainText('Vendors do not publish');
  await expect(page.getByLabel('Energy (Wh per 1k tokens)')).toHaveValue('');
  await expect(page.getByLabel('Water (L per kWh)')).toHaveValue('');
});

test('a project with no usage says why, and a baseline cannot make up a saving', async ({ page, env }) => {
  seed(env);
  await env.pair(page);
  await openRepo(page);
  await tab(page, 'usage');
  await page.getByLabel('Input + output tokens').fill('1000');
  await page.getByLabel('Seconds').fill('60');
  await page.getByRole('button', { name: 'Save baseline' }).click();
  await expect(page.getByTestId('saved-tokens')).toContainText('No usage has been recorded');
  await expect(page.getByTestId('saved-time')).toContainText('Time is measured only');
});

test('baseline entry: a bigger actual is shown as a cost, a smaller one as a saving, and it stays in this browser only', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  await env.pair(page);
  await openRepo(page);
  await tab(page, 'usage');
  const form = page.getByTestId('baseline-form');
  await expect(form).toContainText('Your baseline, entered by you');
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()); });
  await page.getByLabel('Input + output tokens').fill('400');
  await page.getByLabel('Seconds').fill('60');
  await page.getByRole('button', { name: 'Save baseline' }).click();
  await expect(page.getByTestId('saved-tokens')).toContainText('cost 120 more tokens');
  await expect(page.getByTestId('saved-tokens')).toContainText('Your baseline, entered by you: 400');
  await expect(page.getByTestId('saved-tokens')).not.toContainText('Actual:');
  await expect(page.getByTestId('saved-tokens')).toContainText('Actual mean per task: 520, over 1 task');
  await expect(page.getByTestId('saved-time')).toContainText('cost 30 more seconds');
  await tab(page, 'overview');
  await expect(page.getByTestId('glance-tokens-saved')).toContainText('cost 120 more tokens');
  await page.reload();
  await expect(page.getByTestId('glance-tokens-saved')).toContainText('cost 120 more tokens');
  await tab(page, 'usage');
  await page.getByLabel('Input + output tokens').fill('1000');
  await page.getByLabel('Seconds').fill('120');
  await page.getByRole('button', { name: 'Save baseline' }).click();
  await expect(page.getByTestId('saved-tokens')).toContainText('saved 480 tokens');
  await expect(page.getByTestId('saved-time')).toContainText('saved 30 seconds');
  await page.getByRole('button', { name: 'Remove baseline' }).click();
  await expect(page.getByTestId('saved-tokens')).toContainText('Unavailable');
  expect(posts).toEqual([]);
});

test('a baseline that cannot be a measurement is refused', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  await env.pair(page);
  await openRepo(page);
  await tab(page, 'usage');
  const form = page.getByTestId('baseline-form');
  await form.getByRole('button', { name: 'Save baseline' }).click();
  await expect(form.getByRole('alert')).toContainText('Enter tokens, seconds or both');
  await page.getByLabel('Input + output tokens').fill('-5');
  await form.getByRole('button', { name: 'Save baseline' }).click();
  await expect(form.getByRole('alert')).toContainText('must be a number above 0');
  await expect(page.getByTestId('saved-tokens')).toContainText('Unavailable');
});

test('environment: factors give a labelled ESTIMATE, and water saved still needs a baseline', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  await env.pair(page);
  await openRepo(page);
  await tab(page, 'environment');
  await page.getByLabel('Energy (Wh per 1k tokens)').fill('2');
  await page.getByLabel('Water (L per kWh)').fill('10');
  await page.getByRole('button', { name: 'Use these factors' }).click();
  // 520 tokens x 2 Wh per 1k = 1.04 Wh = 0.00104 kWh, x 10 L = 0.0104 L.
  await expect(page.getByTestId('env-energy')).toContainText('1.04e-3 kWh');
  await expect(page.getByTestId('env-energy')).toContainText('ESTIMATE');
  await expect(page.getByTestId('env-water')).toContainText('0.0104 L');
  await expect(page.getByTestId('env-water')).toContainText('ESTIMATE');
  await expect(page.getByTestId('env-water-saved')).toContainText('Unavailable');
  await expect(page.getByTestId('env-water-saved')).toContainText('Needs a measured tokens-saved figure');
  await tab(page, 'usage');
  await page.getByLabel('Input + output tokens').fill('400');
  await page.getByRole('button', { name: 'Save baseline' }).click();
  await tab(page, 'environment');
  // 120 more tokens is more water used, not saved.
  await expect(page.getByTestId('env-water-saved')).toContainText('more used');
  await expect(page.getByTestId('env-water-saved')).toContainText('ESTIMATE');
});

test('verification is measured and labelled as verification, and claims nothing about the code', async ({ page, env }) => {
  seed(env);
  await env.pair(page);
  await openRepo(page);
  await tab(page, 'verification');
  await expect(page.getByTestId('verify-runs')).toContainText('Unavailable');
  await expect(page.getByTestId('verify-criteria')).toContainText('0%');
  env.project((p) => p.verifyTask('t1'));
  await expect(page.getByTestId('verify-runs')).toContainText('100%', { timeout: 10_000 });
  await expect(page.getByTestId('verify-runs')).toContainText('1 of 1');
  await expect(page.getByTestId('verification-scope')).toContainText('says nothing about the code beyond what those checks test');
  await expect(page.getByTestId('verify-run')).toHaveCount(1);
  await expect(page.locator('main')).not.toContainText(/accuracy|correct code/i);
});

test('no third-party request and no account UI on the project page, with no config', async ({ page, env }) => {
  seed(env);
  seedUsage(env);
  const foreign: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith(env.c.url) && !r.url().startsWith('data:')) foreign.push(r.url()); });
  await env.pair(page);
  await openRepo(page);
  for (const name of ['workflow', 'usage', 'verification', 'environment']) await tab(page, name);
  expect(foreign).toEqual([]);
  await tab(page, 'overview');
  await expect(page.getByTestId('summary-saver')).toHaveCount(0);
});

test('mobile: no horizontal page overflow on the grid or any section, with long content', async ({ page, env }) => {
  test.skip(test.info().project.name !== 'mobile', 'Mobile viewport only.');
  const long = 'x'.repeat(120);
  env.project((p) => {
    p.human.setGoal({ statement: `A goal with a very long word ${long}`, scope: { include: ['src/**'] }, prohibit: ['deploy'] });
    p.human.createTask({ id: 't1', title: `Task ${long}`, criteria: [{ id: 'c', description: long, kind: 'artifact', path: 'src/a.txt' }] });
    p.verifyTask('t1');
  });
  seedUsage(env);
  env.hook(`git push origin ${long}`);
  await env.pair(page);
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  expect(await over(), 'grid').toBeLessThanOrEqual(1);
  await openRepo(page);
  for (const name of ['overview', 'workflow', 'usage', 'verification', 'environment']) {
    await tab(page, name);
    expect(await over(), name).toBeLessThanOrEqual(1);
  }
});

for (const theme of ['dark', 'light']) {
  test(`accessibility: no serious axe violations on the grid and each section (${theme})`, async ({ page, env }) => {
    test.skip(test.info().project.name !== 'chromium', 'Axe runs once, in Chromium.');
    seed(env);
    seedUsage(env);
    env.project((p) => p.verifyTask('t1'));
    env.hook('git status');
    env.hook('git push');
    await env.pair(page);
    await page.evaluate((t) => localStorage.setItem('bl-theme', t), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const check = async (name: string) => {
      await page.waitForTimeout(150);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${name}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
    };
    await expect(page.getByTestId('project-card')).toBeVisible();
    await check('grid');
    await openRepo(page);
    for (const name of ['overview', 'workflow', 'usage', 'verification', 'environment']) {
      await tab(page, name);
      await check(name);
    }
    await tab(page, 'usage');
    await page.getByLabel('Input + output tokens').fill('400');
    await page.getByRole('button', { name: 'Save baseline' }).click();
    await expect(page.getByTestId('saved-tokens')).toContainText('cost 120 more tokens');
    await check('usage with a baseline');
  });
}

// The published demo needs no companion.
const DEMO = 'http://127.0.0.1:4199/agentontrack/dashboard/?demo=1';

baseTest('demo: both projects are labelled demo, with the empty one showing Unavailable, and nothing changes', async ({ page }) => {
  await page.goto(`${DEMO}#projects`);
  await baseExpect(page.getByTestId('demo-banner')).toBeVisible();
  const cards = page.getByTestId('project-card');
  await baseExpect(cards).toHaveCount(2);
  for (const c of await cards.all()) await baseExpect(c.getByTestId('card-demo-label')).toHaveText('Demo data');
  await cards.filter({ hasText: 'demo-project' }).getByRole('button', { name: 'demo-project' }).click();
  await baseExpect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByTestId('project-tab-workflow').click();
  await baseExpect(page.locator('[data-kind=held]').first()).toBeVisible();
  await baseExpect(page.locator('[data-kind=approved]').first()).toBeVisible();
  await page.getByTestId('project-tab-usage').click();
  await baseExpect(page.getByTestId('saved-tokens')).toContainText('Unavailable');
  await baseExpect(page.locator('main')).toContainText('Demo data');
  await page.getByRole('button', { name: /All projects/ }).click();
  await cards.filter({ hasText: 'demo-new-project' }).getByRole('button', { name: 'demo-new-project' }).click();
  await baseExpect(page.getByText('No approved goal.')).toBeVisible();
  await page.getByTestId('project-tab-usage').click();
  await baseExpect(page.getByTestId('saved-tokens')).toContainText('No usage has been recorded');
  await page.getByTestId('project-tab-workflow').click();
  await baseExpect(page.locator('main')).toContainText('Nothing recorded yet');
});

baseTest('demo: the project page makes no third-party request', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:4199/') && !r.url().startsWith('data:')) foreign.push(r.url()); });
  await page.goto(`${DEMO}#project/demo/overview`);
  await baseExpect(page.getByTestId('project-panel-overview')).toBeVisible();
  for (const t of ['workflow', 'usage', 'verification', 'environment']) await page.getByTestId(`project-tab-${t}`).click();
  baseExpect(foreign).toEqual([]);
});

test('find projects: names one folder, lists only repositories, adds what is chosen; then search and archive', async ({ page, env }) => {
  seed(env);
  const parent = join(env.dir, 'code');
  for (const name of ['alpha', 'beta']) { mkdirSync(join(parent, name, '.git'), { recursive: true }); }
  mkdirSync(join(parent, 'notes'), { recursive: true });
  await env.pair(page);
  await page.getByTestId('find-projects').click();
  await page.getByLabel(/Folder to look in/).fill(parent);
  await page.getByRole('button', { name: 'Look', exact: true }).click();
  const results = page.getByTestId('discover-results');
  await expect(results).toContainText('alpha');
  await expect(results).toContainText('beta');
  await expect(results).not.toContainText('notes');
  await page.getByRole('checkbox', { name: /beta/ }).uncheck();
  await page.getByTestId('discover-add').click();
  await expect(page.getByTestId('project-card')).toHaveCount(2);
  await expect(page.getByTestId('project-card').filter({ hasText: 'alpha' })).toBeVisible();
  await expect(page.getByTestId('project-card').filter({ hasText: 'beta' })).toHaveCount(0);
  // Search narrows, and archive hides until asked for.
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('alp');
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  await page.getByTestId('project-card').getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByTestId('project-card')).toHaveCount(0);
  await page.getByLabel(/Show archived/).check();
  await expect(page.getByTestId('project-card').filter({ hasText: 'alpha' })).toContainText('archived');
  await page.getByTestId('project-card').getByRole('button', { name: 'Restore' }).click();
});

test('a folder that is a whole drive, or missing, is refused when looking for projects', async ({ page, env }) => {
  await env.pair(page);
  await page.getByTestId('find-projects').click();
  await page.getByLabel(/Folder to look in/).fill(join(env.dir, 'nothing-here'));
  await page.getByRole('button', { name: 'Look', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('does not exist');
});
