// Negative regressions from the 2026-11-19 audit. A hook file belongs to the project, so a cloned repository (or an agent whose write was
// approved) can put any command there that merely ends like ours. AgentOnTrack must not run it, and must not call the project connected.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookSelfTest, hooksInstalled, installHooks, mirrorHooksToWorktree, uninstallHooks } from '../src/index.js';

let dir: string; let root: string; let marker: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-hooktrust-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  marker = join(dir, 'ran.txt');
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp */ } });

/** A command that would leave a file behind if anything ran it, and that ends the way an AgentOnTrack hook does. */
const hostile = (runtime: string) => `"${process.execPath.replace(/\\/g, '/')}" -e "require('fs').writeFileSync(process.argv[1],'ran')" "${marker.replace(/\\/g, '/')}" hook ${runtime}`;
const shipHookFile = (runtime: 'claude-code' | 'codex') => {
  const file = runtime === 'claude-code' ? join(root, '.claude', 'settings.local.json') : join(root, '.codex', 'hooks.json');
  mkdirSync(join(file, '..'), { recursive: true });
  const events = runtime === 'claude-code' ? ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'] : ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'];
  writeFileSync(file, JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: 'command', command: hostile(runtime) }] }]])) }));
};

describe.each(['claude-code', 'codex'] as const)('a hook file that came with the project (%s)', (runtime) => {
  it('is not run by the self-test, and is not reported as connected', () => {
    shipHookFile(runtime);
    expect(hooksInstalled(runtime, root)).toBe(false);
    const r = hookSelfTest(runtime, root);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/did not write on this computer/);
    expect(existsSync(marker)).toBe(false);
  });
  it('is replaced by Connect, after which only the real command is there and trusted', () => {
    shipHookFile(runtime);
    installHooks(runtime, root, 'agentontrack');
    expect(hooksInstalled(runtime, root)).toBe(true);
    const file = readFileSync(runtime === 'claude-code' ? join(root, '.claude', 'settings.local.json') : join(root, '.codex', 'hooks.json'), 'utf8');
    expect(file).not.toContain('ran.txt');
    expect(file).toContain(`agentontrack hook ${runtime}`);
  });
  it('a command changed after Connect is no longer trusted, and is not run', () => {
    installHooks(runtime, root, 'agentontrack');
    shipHookFile(runtime);
    expect(hooksInstalled(runtime, root)).toBe(false);
    expect(hookSelfTest(runtime, root).ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
  it('after disconnect, putting the old file back does not restore trust', () => {
    installHooks(runtime, root, 'agentontrack');
    const file = runtime === 'claude-code' ? join(root, '.claude', 'settings.local.json') : join(root, '.codex', 'hooks.json');
    const saved = readFileSync(file, 'utf8');
    uninstallHooks(runtime, root);
    writeFileSync(file, saved);
    expect(hooksInstalled(runtime, root)).toBe(false);
  });
});

it('a project hook that AgentOnTrack did not write is not copied into a worktree or run from it', () => {
  shipHookFile('claude-code');
  const wt = join(dir, 'wt');
  mkdirSync(wt);
  const r = mirrorHooksToWorktree(root, wt);
  expect(r.ok).toBe(false);
  expect(existsSync(join(wt, '.claude', 'settings.local.json'))).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

it('trust is per project: connecting one project does not trust the same command in another', () => {
  installHooks('claude-code', root, 'agentontrack');
  const other = join(dir, 'other');
  mkdirSync(join(other, '.claude'), { recursive: true });
  writeFileSync(join(other, '.claude', 'settings.local.json'), readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
  expect(hooksInstalled('claude-code', root)).toBe(true);
  expect(hooksInstalled('claude-code', other)).toBe(false);
});

describe('a project connected by an earlier version', () => {
  const OWN = '"C:/apps/agentontrack/app/current/node/node.exe" "C:/apps/agentontrack/app/current/lib/cli.mjs"';
  const file = () => join(root, '.claude', 'settings.local.json');
  const write = (commands: string[]) => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    const events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
    writeFileSync(file(), JSON.stringify({ hooks: Object.fromEntries(events.map((e, i) => [e, [{ hooks: [{ type: 'command', command: commands[i % commands.length] }] }]])) }));
  };
  it('is adopted when its hooks are exactly the command this installation writes, so upgrading does not ask to connect again', async () => {
    const { adoptHookTrust } = await import('../src/index.js');
    write([`${OWN} hook claude-code`]);
    expect(hooksInstalled('claude-code', root)).toBe(false);
    expect(adoptHookTrust('claude-code', root, [OWN])).toBe(true);
    expect(hooksInstalled('claude-code', root)).toBe(true);
    expect(adoptHookTrust('claude-code', root, [OWN]), 'already recorded').toBe(false);
  });
  it('is not adopted for a command that is not exactly this installation\'s: a different program, extra text, or a mix', async () => {
    const { adoptHookTrust } = await import('../src/index.js');
    for (const commands of [
      [hostile('claude-code')],
      [`${OWN} hook claude-code`, hostile('claude-code')],
      [`calc.exe & ${OWN} hook claude-code`],
      [`${OWN} --root "C:/elsewhere" hook claude-code`],
      [`${OWN.replace('current', 'versions/1.0.0')} hook claude-code`],
      [`${OWN} hook codex`],
    ]) {
      write(commands);
      expect(adoptHookTrust('claude-code', root, [OWN]), commands.join(' | ')).toBe(false);
      expect(hooksInstalled('claude-code', root)).toBe(false);
    }
    expect(existsSync(marker)).toBe(false);
  });
});
