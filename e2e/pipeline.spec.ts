// Plan → Build → Review → Verify in a real browser against the real companion. The agent is a script, so this tests AgentOnTrack's gates,
// not a provider. A real Claude run of the stages is recorded separately in docs/PRODUCT_READINESS.md.
import { installHooks } from '../packages/adapters/dist/index.js';
import { expect, go, test } from './fixtures';

test.use({ fakeAgent: true });
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Desktop Chromium covers the gates; other browsers run the shared Workspace suite.');

test('each stage needs its own authorization, and Fable needs consent', async ({ page, env }) => {
  env.project((p) => p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['**'] } }));
  installHooks('claude-code', env.root, 'agentontrack');
  await env.pair(page);
  await go(page, 'Workspace');
  await page.getByRole('tab', { name: 'Pipeline' }).click();
  await page.getByTestId('pipe-new').getByLabel('Goal').fill('Fix the parser');
  await page.getByRole('button', { name: 'Start pipeline' }).click();

  // Later stages cannot be authorized early.
  await expect(page.getByTestId('pipe-auth-build')).toHaveCount(0);

  // Fable: the authorize button stays disabled until usage credits are accepted for this stage.
  const plan = page.getByTestId('pipe-plan');
  await expect(plan.getByLabel('Agent for plan')).toHaveValue('claude-code');
  await plan.getByLabel('Agent for plan').selectOption('codex');
  await expect(plan.getByRole('combobox', { name: 'Model' })).toHaveValue('');
  await plan.getByLabel('Agent for plan').selectOption('claude-code');
  await plan.getByRole('combobox', { name: 'Model' }).fill('claude-fable-5-2');
  await expect(plan.getByTestId('credit-consent')).toBeVisible();
  await expect(page.getByTestId('pipe-auth-plan')).toBeDisabled();
  await plan.getByRole('combobox', { name: 'Model' }).fill('haiku');
  await expect(plan.getByTestId('credit-consent')).toHaveCount(0);
  await page.getByTestId('pipe-auth-plan').click();

  await page.getByLabel('Prompt for this stage').fill('Make the change');
  await page.getByTestId('pipe-run-plan').click();
  await expect(plan.getByText('done', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pipe-actual-plan')).toContainText(/fake|not reported/);
  await expect(page.getByTestId('pipe-auth-build')).toBeVisible();
  await expect(page.getByTestId('pipe-unattended')).toContainText('off');
});
