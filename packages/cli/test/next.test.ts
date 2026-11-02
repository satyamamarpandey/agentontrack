import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decompose, Project } from '@agentontrack/core';

// The real built CLI. The same suggestions the website and the phone show come from the same record. Run `pnpm build` first.
const CLI = resolve('packages/cli/dist/index.js');
let dir: string; let root: string; let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-next-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  env = { ...(process.env as Record<string, string>), AGENTONTRACK_HOME: join(dir, 'home'), AGENTONTRACK_ROOT: root };
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, env, encoding: 'utf8' });

describe('agentontrack next and models', () => {
  it('says nothing without a goal, then suggests drafting a plan, then approving it', () => {
    expect(JSON.parse(cli('next').stdout)).toEqual([]);
    const p = new Project(root);
    p.human.setGoal({ statement: 'Fix the crash' });
    expect(JSON.parse(cli('next').stdout)[0]).toMatchObject({ kind: 'draft-plan' });
    p.savePlan(decompose('Fix the crash', { hasTests: false, testCommand: null, buildCommand: null, lintCommand: null, packageManager: null, meanSecondsPerTask: null, tasksInHistory: 0, languages: [] } as never, { id: 'p1' }));
    p.close();
    expect(JSON.parse(cli('next').stdout)[0]).toMatchObject({ kind: 'approve-plan', needsApproval: true });
  });
  it('lists models without claiming that any is available to the person', () => {
    const out = JSON.parse(cli('models').stdout);
    expect(out.note).toMatch(/only known when a run uses it/);
    for (const m of out.models) expect(m.entitlement === 'unknown' || m.source === 'used-in-a-run').toBe(true);
  });
});
