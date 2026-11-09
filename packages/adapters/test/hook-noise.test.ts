// What the hooks say to the model. Text the agent cannot act on costs it time and tokens on every call (benchmarks/results/bench-components.json),
// so it stays in the record and is not sent. Text it can act on is still sent.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { handleHook } from '../src/index.js';

let dir: string; let root: string; let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-noise-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  delete process.env.AGENTONTRACK_BRIEF;
  root = join(dir, 'repo');
  mkdirSync(root);
  p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['**'] } });
});
afterEach(() => { delete process.env.AGENTONTRACK_BRIEF; p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const ev = (hook_event_name: string, tool_name = 'Write', tool_input: unknown = { file_path: join(root, 'a.txt'), content: 'x' }) => JSON.stringify({ session_id: 's', cwd: root, hook_event_name, tool_name, tool_input, tool_use_id: 'u' });

describe('PreToolUse', () => {
  it('says nothing to the model about a missing task, and still records the warning', () => {
    const out = handleHook(p, 'claude-code', ev('PreToolUse'));
    expect(out).toEqual({ exitCode: 0 });
    const recorded = p.store.all().filter((e: any) => e.type === 'action.requested').flatMap((e: any) => e.payload.warnings ?? []);
    expect(recorded.some((w: string) => /No active task/.test(w))).toBe(true);
  });

  it('still tells the model a warning it can act on', () => {
    p.human.createTask({ id: 't', title: 't' });
    p.bindSession('s');
    let said = '';
    for (let i = 0; i < 8 && !said; i++) said = handleHook(p, 'claude-code', ev('PreToolUse', 'Bash', { command: 'node -e "0"' })).stdout ?? '';
    expect(said).toMatch(/repeated/);
  });
});

describe('SessionStart brief', () => {
  const start = () => handleHook(p, 'claude-code', ev('SessionStart')).stdout ?? '';

  it('is not injected when it would hold only the goal', () => {
    expect(start()).toBe('');
  });
  it('is injected when decisions exist', () => {
    p.human.recordDecision('Use tabs', 'Team style');
    expect(start()).toMatch(/Use tabs/);
  });
  it('is injected when a task is bound to the session', () => {
    p.human.createTask({ id: 't', title: 'Fix it', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'node -e "0"' }] });
    p.bindSession('s');
    expect(start()).toMatch(/Task t/);
  });
  it('is injected when something has drifted', () => {
    const old = p.human.recordDecision('Card', 'x');
    p.human.linkDecision(old, 'task', 'pay-4');
    p.human.recordDecision('Wallet', 'y', old);
    expect(start()).toMatch(/Decisions changed/);
  });
  it('can be forced with AGENTONTRACK_BRIEF=always', () => {
    process.env.AGENTONTRACK_BRIEF = 'always';
    expect(start()).toMatch(/Goal v1/);
  });
});
