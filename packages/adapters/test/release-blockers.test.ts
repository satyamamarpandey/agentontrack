import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { coverageFor, handleHook, hookSelfTest, installHooks, uninstallHooks } from '../src/index.js';

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-ad-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const cli = () => `"${process.execPath}" "${resolve('packages/cli/dist/index.js')}"`;

describe('a host that fails open cannot be advertised as a hard gate', () => {
  it('coverage says what each host does when the hook is missing', () => {
    expect(coverageFor('codex').hostFailMode).toBe('open');
    expect(coverageFor('claude-code').hostFailMode).toBe('closed');
    expect(coverageFor('hermes').hostFailMode).toBe('closed');
    expect(coverageFor('codex').notes.join()).toMatch(/cannot be a hard boundary/);
  });

  it('self-test fails on a missing hook program, which is what agentontrack run refuses on', () => {
    installHooks('codex', root, `"${process.execPath}" "${join(dir, 'gone.js')}"`);
    const r = hookSelfTest('codex', root);
    expect(r.ok).toBe(false);
    expect(r.fix).toMatch(/install codex/);
    expect(hookSelfTest('claude-code', root).ok).toBe(false);
  });

  it('self-test passes when the real program refuses a request, and leaves nothing in the analytics', () => {
    installHooks('codex', root, cli());
    expect(hookSelfTest('codex', root)).toMatchObject({ ok: true });
    const p = new Project(root);
    expect(p.store.byType(['action.requested'])).toHaveLength(0);
    p.close();
  });

  it('codex install turns on its OS sandbox with no network, and uninstall removes only that', () => {
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), 'model = "x"\n');
    installHooks('codex', root, cli());
    const on = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
    expect(on).toMatch(/sandbox_mode = "workspace-write"/);
    expect(on).toMatch(/network_access = false/);
    expect(on).toMatch(/model = "x"/);
    uninstallHooks('codex', root);
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe('model = "x"\n');
  });

  it('leaves a sandbox setting the user chose alone', () => {
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), 'sandbox_mode = "read-only"\n');
    installHooks('codex', root, cli());
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe('sandbox_mode = "read-only"\n');
  });
});

describe('overhead', () => {
  it('read tools start no hook process, and unknown tools still reach the gate', () => {
    const cfg = JSON.parse(installHooks('claude-code', root, cli()).after);
    const re = new RegExp(cfg.hooks.PreToolUse[0].matcher);
    for (const t of ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite']) expect(re.test(t), t).toBe(false);
    for (const t of ['Bash', 'PowerShell', 'Write', 'mcp__x__y', 'SomeNewTool', 'ReadSecrets']) expect(re.test(t), t).toBe(true);
  });

  it('a premature claim reports to the human by default, costing no model turn, and blocks when asked', () => {
    const p = new Project(root);
    p.human.setGoal({ statement: 'g' });
    p.human.createTask({ id: 't', title: 't', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(1+0)"' }] });
    const stop = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'The task is done.' });
    expect(JSON.parse(handleHook(p, 'claude-code', stop).stdout!)).toHaveProperty('systemMessage');
    p.human.setPolicy({ ...p.state().policy, stopCheck: 'block' });
    expect(JSON.parse(handleHook(p, 'claude-code', stop).stdout!).decision).toBe('block');
    p.close();
  });
});
