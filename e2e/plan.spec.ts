// The phase plan in a real browser, against the real companion and engine. The agent is a small stand-in that prints what Claude Code prints
// and writes a file (see `fakeAgent` in fixtures.ts). These tests are about planning, limits, approval and evidence, not about any model.
// The real agent runs are in live-plan.spec.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installHooks } from '../packages/adapters/dist/index.js';
import { confirmDialog, expect, go, test, type Env } from './fixtures';

test.use({ fakeAgent: true });
const CHECK = `node -e "process.exit(require('fs').existsSync('done.txt')?0:1)"`;

test.beforeEach(({ env }) => {
  env.project((p) => { p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } }); });
  installHooks('claude-code', env.root, 'agentontrack');
});

async function openPlan(page: import('@playwright/test').Page, env: Env) {
  await env.pair(page);
  await go(page, 'Workspace');
  await expect(page.getByTestId('plan-empty')).toBeVisible();
}
/** Opens a phase's editor only if it is closed, so a second call cannot close it again. */
async function edit(li: import('@playwright/test').Locator) {
  if (!(await li.getByLabel('Title').isVisible())) await li.getByText('Edit this phase').click();
}
/** Makes the phase's first check a command, as a person would choose from the list. */
async function commandCheck(li: import('@playwright/test').Locator, command: string) {
  await edit(li);
  await li.getByLabel('Check 1 kind').selectOption('command');
  await li.getByLabel('Check 1 command').fill(command);
}
async function create(page: import('@playwright/test').Page, goal = 'Fix the crash when the date is empty') {
  await page.getByLabel('The goal').fill(goal);
  await page.getByTestId('plan-create').click();
  await expect(page.getByTestId('plan')).toBeVisible();
}

test('a goal becomes a plan with only the phases it needs, and nothing can start until it is approved', async ({ page, env }) => {
  await openPlan(page, env);
  await create(page);
  await expect(page.getByTestId('phases').locator('li[data-testid^="phase-"]')).toHaveCount(4);
  await expect(page.getByTestId('plan-approval')).toHaveText('Not approved');
  await expect(page.getByRole('button', { name: /^Start$/ })).toHaveCount(0);
  await expect(page.getByTestId('plan-approve')).toBeVisible();
  // The goal is kept in the record as plan version 1, with the project's own test command found, or its absence said.
  expect(env.project((p) => p.state().plan?.version)).toBe(1);
});

test('editing: titles, checks, budgets and order are changed, saved, and discarded, and saving withdraws nothing it should not', async ({ page, env }) => {
  await openPlan(page, env);
  await create(page);
  const first = page.getByTestId('phases').locator('li').first();
  await edit(first);
  await first.getByLabel('Title').fill('Read the date code first');
  await expect(page.getByTestId('plan-save')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(first).toContainText('Understand the code and the problem');
  await edit(first);
  await first.getByLabel('Title').fill('Read the date code first');
  await first.getByRole('button', { name: 'Add a check' }).click();
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('phases').locator('li').first()).toContainText('Read the date code first');
  expect(env.project((p) => p.state().plan?.doc.phases[0].title)).toBe('Read the date code first');
  expect(env.project((p) => p.state().plan?.version)).toBe(2);
  // Move the second phase up, which keeps a linear plan linear.
  await page.getByRole('button', { name: /Move .* up/ }).nth(1).click();
  await page.getByTestId('plan-save').click();
  await expect.poll(() => env.project((p) => p.state().plan?.doc.phases[0].kind)).toBe('implement');
});

test('approval is a person\'s decision on exactly this plan, and changing who runs what withdraws it, while pausing does not', async ({ page, env }) => {
  await openPlan(page, env);
  await create(page);
  await page.getByTestId('plan-approve').click();
  await expect(page.getByRole('dialog')).toContainText('exactly these agents, models, checks and limits');
  await confirmDialog(page);
  await expect(page.getByTestId('plan-approval')).toHaveText('Approved');
  expect(env.project((p) => p.state().plan?.approvedSha)).toBeTruthy();
  // Pausing and resuming change nothing that was approved.
  const second = page.getByTestId('phases').locator('li').nth(1);
  await second.getByRole('button', { name: 'Pause' }).click();
  await expect(second).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('plan-approval')).toHaveText('Approved');
  await second.getByRole('button', { name: 'Resume' }).click();
  // Choosing another model does.
  await edit(second);
  await second.getByLabel('Model').fill('opus');
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-approval')).toHaveText('Not approved');
  await expect(page.getByRole('button', { name: /^Start$/ })).toHaveCount(0);
});

test('running phases in order: an agent that claims success is not believed until the check passes', async ({ page, env }) => {
  await openPlan(page, env);
  await create(page);
  // Point the test phase's check at something the stand-in agent can really satisfy, then approve.
  const test = page.getByTestId('phases').locator('li[data-testid^="phase-test-"]');
  await commandCheck(test, CHECK);
  await page.getByTestId('plan-save').click();
  await page.getByTestId('plan-approve').click();
  await confirmDialog(page);
  const li = (k: string) => page.getByTestId('phases').locator(`li[data-testid^="phase-${k}-"]`);
  await expect(li('understand')).toHaveAttribute('data-status', 'ready');
  await expect(li('implement')).toHaveAttribute('data-status', 'blocked');
  await li('understand').getByRole('button', { name: /^Start$/ }).click();
  await expect(li('understand')).toHaveAttribute('data-status', 'done-unchecked', { timeout: 30_000 });
  await expect(li('understand')).toContainText("agent's word only");
  await li('implement').getByRole('button', { name: /^Start$/ }).click();
  await expect(li('implement')).toHaveAttribute('data-status', 'done-unchecked', { timeout: 30_000 });
  await li('test').getByRole('button', { name: /^Start$/ }).click();
  await expect(li('test')).toHaveAttribute('data-status', 'needs-evidence', { timeout: 30_000 });
  await expect(page.locator('[data-status=verified]')).toHaveCount(0);
  expect(existsSync(join(env.root, 'done.txt'))).toBe(true);
  await li('test').getByRole('button', { name: 'Run the checks' }).click();
  await expect(li('test')).toHaveAttribute('data-status', 'verified', { timeout: 30_000 });
  await expect(li('test')).toContainText('recorded as a receipt');
});

test('a phase assigned to an agent that cannot be started gives a prompt to copy, and no fake Start button', async ({ page, env }) => {
  await openPlan(page, env);
  await create(page, 'Review the auth code');
  const review = page.getByTestId('phases').locator('li[data-testid^="phase-review-"]');
  await edit(review);
  await review.getByLabel('Agent').selectOption('codex');
  await page.getByTestId('plan-save').click();
  await page.getByTestId('plan-approve').click();
  await confirmDialog(page);
  const understand = page.getByTestId('phases').locator('li[data-testid^="phase-understand-"]');
  await understand.getByRole('button', { name: /^Start$/ }).click();
  await expect(understand).toHaveAttribute('data-status', 'done-unchecked', { timeout: 30_000 });
  await expect(review.getByRole('button', { name: /^Start$/ })).toHaveCount(0);
  await review.getByRole('button', { name: /Copy the prompt for Codex/ }).click();
  await expect(review.getByTestId('phase-prompt')).toContainText('Goal: Review the auth code');
  await expect(review.getByTestId('phase-prompt')).toContainText('Do not publish, deploy or push');
});

test('bounded autonomous: runs ready phases in turn, checks them itself, never approves, and stops before a release', async ({ page, env }) => {
  await openPlan(page, env);
  await create(page, 'Fix the crash and release it');
  const test = page.getByTestId('phases').locator('li[data-testid^="phase-test-"]');
  await commandCheck(test, CHECK);
  await page.getByLabel('Bounded autonomous').check();
  await expect(page.getByTestId('mode-help')).toContainText('never approves anything or releases for you');
  await page.getByTestId('plan-save').click();
  await page.getByTestId('plan-approve').click();
  await confirmDialog(page);
  await page.getByTestId('plan-run').click();
  await expect(page.getByTestId('plan-auto')).toContainText('release', { timeout: 90_000 });
  await expect(page.getByTestId('plan-auto')).toContainText('always your decision');
  await expect(page.getByTestId('phases').locator('li[data-testid^="phase-test-"]')).toHaveAttribute('data-status', 'verified');
  await expect(page.getByTestId('phases').locator('li[data-testid^="phase-release-"]')).toHaveAttribute('data-status', 'ready');
  expect(env.project((p) => p.state().plan?.approvedSha)).toBeTruthy();
});

/** Approves a bounded plan and leaves it ready to run. */
async function readyBounded(page: import('@playwright/test').Page, env: Env, goal = 'Fix the crash') {
  await openPlan(page, env);
  await create(page, goal);
  await page.getByLabel('Bounded autonomous').check();
  await page.getByTestId('plan-save').click();
  await page.getByTestId('plan-approve').click();
  await confirmDialog(page);
}

test('bounded autonomous pauses when an action is held for a person, and never approves it', async ({ page, env }) => {
  process.env.AOT_FAKE_DELAY_MS = '5000';
  try {
    await readyBounded(page, env);
    await page.getByTestId('plan-run').click();
    const implement = page.getByTestId('phases').locator('li[data-testid^="phase-implement-"]');
    await expect(implement).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    // While the agent works on this phase, something it does needs a person. It is bound to this phase's task, and held.
    const out = env.hook('git push origin main');
    expect(out).toContain('AgentOnTrack needs human approval');
    await expect(page.getByTestId('plan-auto')).toContainText('waiting for your approval', { timeout: 60_000 });
    expect(env.project((p) => [...p.state().approvals.values()].filter((a) => a.status === 'pending').length)).toBe(1);
    expect(env.project((p) => [...p.state().approvals.values()].filter((a) => a.status === 'granted').length)).toBe(0);
    await expect(page.getByTestId('plan-run')).toBeVisible();
  } finally { delete process.env.AOT_FAKE_DELAY_MS; }
});

test('a person can stop a running plan, and the agent that is running is stopped too', async ({ page, env }) => {
  process.env.AOT_FAKE_DELAY_MS = '20000';
  try {
    await readyBounded(page, env);
    await page.getByTestId('plan-run').click();
    const implement = page.getByTestId('phases').locator('li[data-testid^="phase-implement-"]');
    await expect(implement).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    await page.getByTestId('plan-stop').click();
    await expect(page.getByTestId('plan-auto')).toContainText('Stopped by you, and the running agent was stopped', { timeout: 30_000 });
    await expect.poll(() => env.project((p) => p.planRuns().some((r) => r.status === 'stopped')), { timeout: 30_000 }).toBe(true);
    await expect(implement).not.toHaveAttribute('data-status', 'running');
    await expect(page.locator('[data-status=verified]')).toHaveCount(0);
  } finally { delete process.env.AOT_FAKE_DELAY_MS; }
});
