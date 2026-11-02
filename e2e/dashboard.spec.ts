import AxeBuilder from '@axe-core/playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmDialog, expect, go, test } from './fixtures';

const SCREENS = ['Overview', 'Projects', 'Goals', 'Agents', 'Usage', 'Comparisons', 'Evidence', 'Safety', 'Approvals', 'Evaluations', 'Environment', 'Feedback', 'Settings'];
const seed = (env: any) => env.project((p: any) => {
  p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['src/**'] }, prohibit: ['deploy'] });
  p.human.createTask({ id: 't1', title: 'Parser fix', criteria: [{ id: 'c', description: 'fixed file exists', kind: 'artifact', path: 'src/a.txt' }] });
});

test('pairing: refuses a wrong code, then pairs, and survives a reload', async ({ page, env }) => {
  await page.goto(env.c.url);
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  env.c.newPairingCode();
  await page.getByLabel('Pairing code').fill('WRONGCOD');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong pairing code');
  await page.getByLabel('Pairing code').fill(env.c.newPairingCode());
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects');
  await expect(page.getByTestId('project-card')).toContainText('repo');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects');
});

test('every screen renders from real data, with no console errors', async ({ page, env }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  seed(env);
  await env.pair(page);
  for (const s of SCREENS) {
    await go(page, s);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('main [role=alert].bad')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('empty states explain what to do', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Overview');
  await expect(page.getByText('No approved goal.')).toBeVisible();
  await go(page, 'Usage');
  await expect(page.getByText('No usage recorded yet')).toBeVisible();
  await go(page, 'Approvals');
  await expect(page.getByText('Nothing here.')).toBeVisible();
});

test('comparisons show the recorded benchmark with its limits, and never call it savings', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Comparisons');
  await expect(page.getByText('Controlled benchmark').first()).toBeVisible();
  await expect(page.locator('main')).toContainText('Not independent');
  await expect(page.locator('main')).toContainText('A-doc');
  await expect(page.locator('main')).not.toContainText(/tokens saved/i);
});

test('goal and task through the UI, recorded by the engine', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Goals');
  await page.getByLabel('Goal', { exact: true }).fill('Ship the parser');
  await page.getByLabel(/In scope/).fill('src/**');
  await page.getByRole('button', { name: 'Review and approve' }).click();
  await confirmDialog(page);
  await expect(page.getByText('Goal v1')).toBeVisible();
  await page.getByLabel('Task', { exact: true }).fill('Add parser');
  await page.getByLabel(/Acceptance check/).fill('node -e "process.exit(0+0)"');
  await page.getByRole('button', { name: 'Review and create' }).click();
  await expect(page.getByRole('dialog')).toContainText('node -e "process.exit(0+0)"');
  await confirmDialog(page);
  await page.getByRole('button', { name: 'Verify now' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Add parser' }).getByText('VERIFIED')).toBeVisible();
  const st = env.project((p) => p.state());
  expect(st.goal?.statement).toBe('Ship the parser');
  expect(st.receipts[0]).toMatchObject({ passed: true, source: 'independent-run' });
  await go(page, 'Evidence');
  await expect(page.getByTestId('receipt')).toHaveCount(1);
  await page.getByRole('button', { name: 'source' }).click();
  await expect(page.getByRole('dialog')).toContainText('evidence.recorded');
});

test('a wrong confirmation code grants nothing, and the dialog issues a new one', async ({ page, env }) => {
  seed(env);
  const id = /agentontrack approve (apr_\w+)/.exec(env.hook('git push'))![1]!;
  await env.pair(page);
  await go(page, 'Approvals');
  await page.getByTestId('approval').getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('challenge-code')).toHaveText(/^[0-9a-f]{4}$/);
  await dialog.getByLabel(/to confirm/).fill('zzzz');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toContainText('wrong or expired');
  expect(env.project((p) => p.state().approvals.get(id)?.status)).toBe('pending');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('approval: a real blocked hook is approved in the browser, and then the real hook allows it once', async ({ page, env }) => {
  seed(env);
  expect(env.hook('git push')).toContain('needs human approval');
  await env.pair(page);
  await go(page, 'Overview');
  await expect(page.getByRole('button', { name: /1 approval waiting/ })).toBeVisible();
  await go(page, 'Approvals');
  const row = page.getByTestId('approval');
  await expect(row).toHaveAttribute('data-view', 'pending');
  await row.getByRole('button', { name: 'Approve' }).click();
  await confirmDialog(page);
  await expect(row).toHaveAttribute('data-view', 'approved');
  expect(env.hook('git push')).toBe('');
  await expect(page.getByTestId('approval').first()).toHaveAttribute('data-view', 'consumed');
  expect(env.hook('git push')).toContain('needs human approval');
});

test('denial: denied in the browser, the hook stays blocked', async ({ page, env }) => {
  seed(env);
  env.hook('npm publish');
  await env.pair(page);
  await go(page, 'Approvals');
  await page.getByTestId('approval').getByRole('button', { name: 'Deny' }).click();
  await confirmDialog(page);
  await expect(page.getByTestId('approval')).toHaveAttribute('data-view', 'denied');
  expect(env.hook('npm publish')).toContain('needs human approval');
});

test('revocation stops an unused approval', async ({ page, env }) => {
  seed(env);
  env.hook('git push');
  await env.pair(page);
  await go(page, 'Approvals');
  await page.getByTestId('approval').getByRole('button', { name: 'Approve' }).click();
  await confirmDialog(page);
  await page.getByTestId('approval').getByRole('button', { name: 'Revoke' }).click();
  await confirmDialog(page);
  await expect(page.getByTestId('approval').first()).toHaveAttribute('data-view', /revoked|pending/);
  expect(env.hook('git push')).toContain('needs human approval');
});

test('an enrolled approver needs the passphrase in the browser too', async ({ page, env }) => {
  seed(env);
  env.project((p) => p.enrollApprover('correct horse battery'));
  env.hook('git push');
  await env.pair(page);
  await go(page, 'Approvals');
  await page.getByTestId('approval').getByRole('button', { name: 'Approve' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('challenge-code')).toHaveText(/^[0-9a-f]{4}$/);
  await dialog.getByLabel(/to confirm/).fill((await dialog.getByTestId('challenge-code').textContent())!);
  await dialog.getByLabel('Approver passphrase').fill('wrong wrong wrong');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Wrong approver passphrase');
  await expect(dialog.getByTestId('challenge-code')).toHaveText(/^[0-9a-f]{4}$/);
  await page.waitForTimeout(150);
  await confirmDialog(page, 'correct horse battery');
  await expect(page.getByTestId('approval')).toHaveAttribute('data-view', 'approved');
});

test('goal proposal from an agent: accept in the browser changes the goal version', async ({ page, env }) => {
  seed(env);
  env.project((p) => p.propose('goal', { statement: 'Also fix docs', rationale: 'docs are wrong' }, { kind: 'agent', runtime: 'claude-code' }));
  env.project((p) => p.propose('goal', { statement: 'Delete everything' }, { kind: 'agent', runtime: 'claude-code' }));
  await env.pair(page);
  await go(page, 'Goals');
  await page.getByRole('listitem').filter({ hasText: 'Delete everything' }).getByRole('button', { name: 'Reject' }).click();
  await confirmDialog(page);
  await page.getByRole('listitem').filter({ hasText: 'Also fix docs' }).getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('dialog')).toContainText('Earlier approvals stop matching');
  await confirmDialog(page);
  await expect(page.getByText('Goal v2')).toBeVisible();
  expect(env.project((p) => p.state().goal)).toMatchObject({ statement: 'Also fix docs', version: 2 });
});

test('effects: an out-of-scope change is shown as detected, not prevented, and blocks VERIFIED until reviewed', async ({ page, env }) => {
  seed(env);
  env.project((p) => {
    p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: [{ kind: 'exec.opaque', target: 'python x.py' }], opaque: true, coverage: 'enforced', rawInput: 'python x.py' });
    writeFileSync(join(env.root, 'prod.conf'), 'x');
    p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] });
  });
  await env.pair(page);
  await go(page, 'Safety');
  await expect(page.getByTestId('mismatch')).toContainText('prod.conf');
  await expect(page.getByTestId('action')).toHaveAttribute('data-decision', 'allow');
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await confirmDialog(page);
  await expect(page.getByTestId('mismatch')).toContainText('reviewed');
});

test('live feed: an event written by another process updates the page with no reload', async ({ page, env }) => {
  seed(env);
  await env.pair(page);
  await go(page, 'Approvals');
  await expect(page.getByText('Nothing here.')).toBeVisible();
  env.hook('git push');
  await expect(page.getByTestId('approval')).toBeVisible({ timeout: 10_000 });
});

test('runtimes say what is installed here and how they were tested, with no fake connection', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Agents');
  for (const id of ['codex', 'hermes']) {
    const card = page.getByTestId(`agent-${id}`);
    await expect(card).toContainText('Not installed on this machine');
  }
  await expect(page.getByTestId('agent-codex')).toContainText('small local model');
  await expect(page.getByTestId('agent-hermes')).toContainText('scripted model');
  await expect(page.getByTestId('agent-codex').getByRole('button', { name: 'Connect' })).toBeDisabled();
});

test('environment shows Unavailable instead of invented figures', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Environment');
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(3);
  await expect(page.getByTestId('env-calc')).toContainText('Enter a value');
  await page.getByLabel(/grid intensity/).fill('400');
  await expect(page.getByTestId('env-calc')).toContainText('400 gCO₂e');
  await expect(page.getByTestId('env-calc')).toContainText('Estimated');
});

test('settings: theme switches, no cloud sync is offered, export works, and delete removes the record', async ({ page, env }) => {
  seed(env);
  await env.pair(page);
  await go(page, 'Settings');
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'dark', exact: true }).click();
  await expect(page.getByText(/cloud sync/i)).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click()]);
  const events = JSON.parse(readFileSync(await dl.path(), 'utf8')).events;
  expect(events[0].type).toBe('project.attached');
  await page.getByRole('button', { name: 'Delete record' }).click();
  await confirmDialog(page);
  await expect(page.getByText('No project attached')).toBeVisible();
});

test('labels: data from the local record is never presented as provider-reported', async ({ page, env }) => {
  seed(env);
  env.hook('git push');
  await env.pair(page);
  await go(page, 'Safety');
  await expect(page.getByText('Actual: local record').first()).toBeVisible();
  await expect(page.getByText('Actual: provider-reported')).toHaveCount(0);
});

test('feedback is optional and stays local', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Feedback');
  await page.getByRole('button', { name: 'Not helpful' }).click();
  await expect(page.getByLabel('What should we improve?')).toBeVisible();
  await page.getByRole('button', { name: 'Save feedback' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Nothing was sent' })).toBeVisible();
});

test('disconnect ends the session, and reconnecting needs a new code', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Settings');
  await page.getByRole('button', { name: 'Disconnect this browser' }).click();
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
});

test('keyboard: skip link, navigation and a dialog work with no mouse', async ({ page, env, browserName, isMobile }) => {
  test.skip(isMobile || browserName === 'webkit', 'Mobile has no Tab key; Safari tabs past buttons by default.');
  seed(env);
  env.hook('git push');
  await env.pair(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Approvals' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
  await page.getByTestId('approval').getByRole('button', { name: 'Deny' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByLabel(/to confirm/)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('mobile layout: no horizontal page overflow on any screen', async ({ page, env }) => {
  test.skip(test.info().project.name !== 'mobile', 'Mobile viewport only.');
  seed(env);
  await env.pair(page);
  for (const s of SCREENS) {
    await go(page, s);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, s).toBeLessThanOrEqual(1);
  }
});

for (const theme of ['dark', 'light']) {
  test(`accessibility: no serious axe violations on any screen (${theme})`, async ({ page, env }) => {
    test.skip(test.info().project.name !== 'chromium', 'Axe runs once, in Chromium.');
    seed(env);
    env.hook('git push');
    await env.pair(page);
    await page.evaluate((t) => localStorage.setItem('bl-theme', t), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const s of SCREENS) {
      await go(page, s);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(150);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${s}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
    }
  });
}

test('weak checks hold back VERIFIED until a human accepts them, with a note in the record', async ({ page, env }) => {
  env.project((p) => {
    p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['src/**'] }, prohibit: ['deploy'] });
    p.human.createTask({ id: 't1', title: 'Parser fix', criteria: [{ id: 'c', description: 'file exists', kind: 'artifact', path: 'src/a.txt' }] });
    p.verifyTask('t1');
  });
  await env.pair(page);
  await go(page, 'Goals');
  const weak = page.getByTestId('weak-checks');
  await expect(weak).toContainText('only checks that a file exists');
  expect(env.project((p) => p.evaluate('t1').status)).not.toBe('VERIFIED');
  await weak.getByLabel(/Why they are acceptable/).fill('Generated file, reviewed by hand');
  await weak.getByRole('button', { name: 'Accept weak checks' }).click();
  await confirmDialog(page);
  await expect(page.getByTestId('weak-checks')).toHaveCount(0);
  await expect(page.getByText('Weak check (accepted by a human)', { exact: false })).toBeVisible();
  expect(env.project((p) => p.evaluate('t1').status)).toBe('VERIFIED');
  expect(env.project((p) => p.store.all().find((e) => e.type === 'weak.accepted')?.payload.note)).toBe('Generated file, reviewed by hand');
});

test('the Agents screen says in plain words what each runtime does if its hook cannot run', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Agents');
  await expect(page.getByTestId('agent-claude-code').getByTestId('host-fail-mode')).toContainText('The action is blocked. Observed');
  await expect(page.getByTestId('agent-codex').getByTestId('host-fail-mode')).toContainText('The action runs anyway. Observed');
  await expect(page.getByTestId('agent-hermes').getByTestId('host-fail-mode')).toContainText('The action is blocked');
  await expect(page.getByTestId('agent-hermes').getByTestId('containment')).toContainText('Nothing');
  await expect(page.getByTestId('agent-codex').getByTestId('containment')).toContainText('sandbox');
});
