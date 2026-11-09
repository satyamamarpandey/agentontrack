import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { coverageFor, handleHook, handleHookSafely, hooksInstalled, installHooks, mapCodexTool, parseApplyPatch, uninstallHooks } from '../src/index.js';

let dir: string;
let root: string;
let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl-a-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 't' });
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true }); });

const pre = (tool_name: string, tool_input: unknown, extra = {}) => JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u', ...extra });
const denial = (out: { stdout?: string }) => JSON.parse(out.stdout ?? '{}').hookSpecificOutput;

describe.each(['claude-code', 'codex'] as const)('%s hook contract', (runtime) => {
  it('denies with the documented JSON shape and exit 0', () => {
    const out = handleHook(p, runtime, pre('Bash', { command: 'git push' }));
    expect(out.exitCode).toBe(0);
    expect(denial(out)).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denial(out).permissionDecisionReason).toMatch(/agentontrack approve apr_/);
  });

  it('never uses "ask", which Codex treats as a failure and runs the tool', () => {
    const out = handleHook(p, runtime, pre('Bash', { command: 'git push' }));
    expect(out.stdout).not.toContain('"ask"');
  });

  it('allows with empty output', () => {
    expect(handleHook(p, runtime, pre('Bash', { command: 'git status' }))).toEqual({ exitCode: 0 });
  });

  it('fails closed on PreToolUse when the project cannot open', () => {
    const out = handleHookSafely(() => { throw new Error('db locked'); }, runtime, pre('Bash', { command: 'ls' }));
    expect(denial(out).permissionDecision).toBe('deny');
    expect(denial(out).permissionDecisionReason).toMatch(/db locked/);
  });

  it('injects record-based context at session start', () => {
    const out = handleHook(p, runtime, JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'compact' }));
    expect(JSON.parse(out.stdout!).hookSpecificOutput.additionalContext).toContain('Goal v1 (active): g');
  });

  it('reports observed out-of-scope effects after the action', () => {
    handleHook(p, runtime, pre('Bash', { command: 'python x.py' }));
    writeFileSync(join(root, 'prod.conf'), 'x');
    const out = handleHook(p, runtime, JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'python x.py' }, tool_response: 'ok' }));
    expect(JSON.parse(out.stdout!).hookSpecificOutput.additionalContext).toContain('prod.conf');
  });

  it('does not interrupt an ordinary answer on an unverified task', () => {
    p.human.createTask({ id: 'v', title: 'v', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
    handleHook(p, runtime, JSON.stringify({ session_id: 'new', hook_event_name: 'SessionStart' }));
    expect(handleHook(p, runtime, JSON.stringify({ session_id: 'new', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'The goal is to fix the parser.' })).stdout).toBeUndefined();
  });

  it('blocks Stop once on an unverified task, then lets go', () => {
    p.human.createTask({ id: 'v', title: 'v', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
    const stop = (active: boolean) => handleHook(p, runtime, JSON.stringify({ session_id: 'new', hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: 'The task is complete.' }));
    handleHook(p, runtime, JSON.stringify({ session_id: 'new', hook_event_name: 'SessionStart' }));
    p.human.setPolicy({ ...p.state().policy, stopCheck: 'block' });
    expect(JSON.parse(stop(false).stdout!).decision).toBe('block');
    expect(stop(true).stdout).toBeUndefined();
  });

  it('install preserves other settings and uninstall removes only ours', () => {
    const cfgPath = runtime === 'claude-code' ? join(root, '.claude', 'settings.local.json') : join(root, '.codex', 'hooks.json');
    mkdirSync(join(cfgPath, '..'), { recursive: true });
    const other = { hooks: [{ type: 'command', command: 'my-lint' }] };
    writeFileSync(cfgPath, JSON.stringify({ model: 'keep', hooks: { PreToolUse: [other] } }));
    installHooks(runtime, root, 'bl');
    installHooks(runtime, root, 'bl');
    expect(hooksInstalled(runtime, root)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(cfg.model).toBe('keep');
    expect(cfg.hooks.PreToolUse).toHaveLength(2);
    uninstallHooks(runtime, root);
    expect(hooksInstalled(runtime, root)).toBe(false);
    expect(JSON.parse(readFileSync(cfgPath, 'utf8'))).toEqual({ model: 'keep', hooks: { PreToolUse: [other] } });
  });
});

describe('Claude Code specifics', () => {
  it('catches file writes through both Write and PowerShell', () => {
    expect(denial(handleHook(p, 'claude-code', pre('Write', { file_path: join(root, '.env'), content: 'x' }))).permissionDecision).toBe('deny');
    expect(denial(handleHook(p, 'claude-code', pre('PowerShell', { command: 'Set-Content -Path .env -Value x' }))).permissionDecision).toBe('deny');
  });

  it('handles Windows backslash paths', () => {
    expect(handleHook(p, 'claude-code', pre('Write', { file_path: join(root, 'src', 'ok.ts'), content: '' }))).toEqual({ exitCode: 0 });
  });

  it('requests fail-closed behaviour in the installed hook', () => {
    installHooks('claude-code', root, 'bl');
    const cfg = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    expect(cfg.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
    expect(new RegExp(cfg.hooks.PreToolUse[0].matcher).test('Bash')).toBe(true);
  });
});

describe('Codex specifics', () => {
  it('parses paths out of apply_patch text', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: docs/n.md\n+x\n*** Delete File: src/old.ts\n*** End Patch';
    expect(parseApplyPatch(patch)).toEqual([
      { kind: 'fs.write', target: 'src/a.ts' }, { kind: 'fs.write', target: 'docs/n.md' }, { kind: 'fs.delete', target: 'src/old.ts' },
    ]);
  });

  it('treats an unparseable patch as opaque', () => {
    expect(mapCodexTool('apply_patch', { command: 'garbage' })).toMatchObject({ opaque: true });
  });

  it('gates out-of-scope apply_patch', () => {
    const out = handleHook(p, 'codex', pre('apply_patch', { command: '*** Begin Patch\n*** Update File: prod.conf\n*** End Patch' }));
    expect(denial(out).permissionDecision).toBe('deny');
  });

  it('says exactly how it was tested, and that a missing hook fails open', () => {
    expect(coverageFor('codex').evidence).toBe('live-local-model');
    expect(coverageFor('codex').notes.join(' ')).toMatch(/FAIL-OPEN/);
  });
});

it('does not leave stray files when uninstalling a missing config', () => {
  expect(uninstallHooks('codex', root)).toBe(false);
  expect(existsSync(join(root, '.codex'))).toBe(false);
});

describe('Git Bash paths on Windows', () => {
  it('reads /tmp and /d/ the way Git Bash does, and leaves other paths alone', async () => {
    const { msysToWindows } = await import('../src/index.js');
    expect(msysToWindows('/tmp/proj/a.txt', 'C:/Users/u/AppData/Local/Temp')).toBe('C:/Users/u/AppData/Local/Temp/proj/a.txt');
    expect(msysToWindows('/tmp', 'C:/T')).toBe('C:/T');
    expect(msysToWindows('/d/work/x', 'C:/T')).toBe('D:/work/x');
    expect(msysToWindows('/cygdrive/c/Users', 'C:/T')).toBe('C:/Users');
    expect(msysToWindows('/c', 'C:/T')).toBe('C:/');
    for (const same of ['/etc/passwd', '/tmpfoo/x', 'relative/a.txt', 'C:/x', '/usr/bin', '/dev/null']) expect(msysToWindows(same, 'C:/T'), same).toBe(same);
  });
});
