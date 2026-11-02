// The agent catalog, against the real companion. What is "installed" is whatever this machine really has, so these tests
// check what must hold either way: every platform listed, official install links, honest support levels, and no Run control without a real runtime.
import { expect, go, test } from './fixtures';

const EXPECTED = ['Claude Code', 'Codex', 'Hermes', 'Cursor', 'GitHub Copilot CLI', 'Gemini CLI', 'Antigravity', 'OpenCode', 'Cline', 'Kiro', 'Continue', 'Devin for Terminal', 'VS Code and compatible editors', 'Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'Perplexity'];

test('the catalog lists every platform, each with an official link and an honest support level', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Agents');
  const cards = page.locator('[data-testid^=agent-]:is(article)');
  await expect(cards).toHaveCount(EXPECTED.length);
  for (const name of EXPECTED) await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${name.replaceAll('.', '[.]').replaceAll('+', '[+]')}`) })).toBeVisible();
  // Every link out is the maker's own https page, opened in a new tab without handing over the opener.
  for (const a of await page.locator('[data-testid^=agent-] a[href^=http]').all()) {
    await expect(a).toHaveAttribute('href', /^https:\/\//);
    await expect(a).toHaveAttribute('target', '_blank');
    await expect(a).toHaveAttribute('rel', /noopener/);
  }
  // Support levels come from the test record and are never upgraded.
  await expect(page.getByTestId('agent-claude-code').getByTestId('agent-support')).toHaveText('Native hooks, verified');
  await expect(page.getByTestId('agent-cursor').getByTestId('agent-support')).toHaveText('Not tested');
  await expect(page.getByTestId('agent-continue').getByTestId('agent-support')).toHaveText('MCP only');
  await expect(page.getByTestId('agent-antigravity').getByTestId('agent-support')).toHaveText('Not supported');
  await expect(page.getByTestId('agent-antigravity')).toContainText('no adapter');
  await expect(page.getByTestId('agent-antigravity').getByRole('button', { name: 'Connect' })).toHaveCount(0);
});

test('search and groups narrow the list, and an agent that is not here offers Install, not a fake Connect', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Agents');
  await page.getByTestId('agent-search').fill('gem');
  await expect(page.getByTestId('agent-gemini')).toBeVisible();
  await expect(page.getByTestId('agent-codex')).toHaveCount(0);
  await page.getByTestId('agent-search').fill('');
  await page.getByRole('button', { name: 'Local models' }).click();
  for (const id of ['ollama', 'lmstudio', 'llamacpp', 'vllm']) await expect(page.getByTestId(`agent-${id}`)).toBeVisible();
  await expect(page.getByTestId('agent-codex')).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  // Hermes is not installed on the test machine: Install links to its maker, and Connect is unavailable.
  const hermes = page.getByTestId('agent-hermes');
  await expect(hermes).toHaveAttribute('data-state', 'missing');
  await expect(hermes.getByTestId('agent-install')).toHaveAttribute('href', 'https://github.com/NousResearch/hermes-agent');
  await expect(hermes.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await expect(hermes).toContainText('was not found on this computer');
  await expect(hermes).toContainText('Starts in its own terminal');
});

test('a model server is configured by testing its address, and is never called an agent', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Agents');
  const card = page.getByTestId('agent-ollama');
  await expect(card).toContainText('A model server is not an agent');
  await card.getByRole('button', { name: 'Configure' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Address it listens on')).toHaveValue('http://127.0.0.1:11434');
  await dialog.getByLabel('Address it listens on').fill('http://127.0.0.1:1');
  await dialog.getByRole('button', { name: 'Test the address' }).click();
  await expect(dialog.getByTestId('probe')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
});

test('the workspace offers no Run control for an agent that cannot start, and says why', async ({ page, env }) => {
  await env.pair(page);
  await go(page, 'Workspace');
  await page.getByRole('tab', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('ws-run')).toBeDisabled();
  await expect(page.getByTestId('run-note')).toContainText(/Claude Code|No agent can be started/);
  // Codex is listed, but only as unavailable: it cannot be chosen.
  await expect.poll(() => page.locator('select[name=runtime] option[value=codex]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
});
