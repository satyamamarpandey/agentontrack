// The project Markdown files AgentOnTrack keeps: created when missing, never overwriting what is there, and regenerated only inside its own marked block.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decompose, detectProjectFacts, Project } from '@agentontrack/core';
import { applyProjectFiles, planProjectFiles } from '../src/init.js';

let dir: string; let root: string; let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-files-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  p = new Project(root);
  p.human.setGoal({ statement: 'Fix the parser', scope: { include: ['**'] } });
});
afterEach(() => { try { p.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const run = () => applyProjectFiles(root, planProjectFiles(root, p));
const read = (f: string) => readFileSync(join(root, f), 'utf8');

describe('project files', () => {
  it('creates the files that are missing, each inside a marked block', () => {
    const r = run();
    expect(r.failed).toEqual([]);
    for (const f of ['AGENTS.md', 'GOAL.md', 'DECISIONS.md', 'EVALS.md', 'SAFETY.md']) expect(read(f), f).toMatch(/agentontrack:begin[\s\S]*agentontrack:end/);
    expect(read('GOAL.md')).toContain('Fix the parser');
  });

  it('never overwrites what a person wrote: existing text is kept and the block is appended', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Our rules\n\nUse tabs. Never touch vendor/.\n');
    const plan = planProjectFiles(root, p);
    expect(plan.find((f) => f.path === 'AGENTS.md')!.action).toBe('append-block');
    applyProjectFiles(root, plan);
    expect(read('AGENTS.md')).toMatch(/^# Our rules\n\nUse tabs\. Never touch vendor\/\.\n/);
    expect(read('AGENTS.md')).toContain('agentontrack:begin');
  });

  it('on a later run changes only its own block and leaves the person’s text around it alone', () => {
    run();
    const before = read('GOAL.md');
    writeFileSync(join(root, 'GOAL.md'), `My intro\n\n${before}\nMy notes after\n`);
    p.human.recordDecision('Use tabs', 'Team style');
    p.human.setGoal({ statement: 'Fix the parser and the lexer', scope: { include: ['**'] } });
    run();
    const after = read('GOAL.md');
    expect(after.startsWith('My intro\n\n')).toBe(true);
    expect(after.endsWith('\nMy notes after\n')).toBe(true);
    expect(after).toContain('the lexer');
  });

  it('is idempotent: a second run with nothing new changes no file', () => {
    run();
    expect(planProjectFiles(root, p).every((f) => f.action === 'unchanged')).toBe(true);
  });

  it('shows a replaced decision and what still follows it', () => {
    const old = p.human.recordDecision('Refunds go to the card', 'Simple');
    p.human.linkDecision(old, 'task', 'pay-4');
    p.human.recordDecision('Refunds go to the wallet', 'Instant', old);
    run();
    const d = read('DECISIONS.md');
    expect(d).toContain('replaced by "Refunds go to the wallet"');
    expect(d).toContain('Still following a replaced decision');
    expect(d).toContain('task pay-4');
  });

  it('writes PLAN.md from the saved plan, and says when it is not approved', () => {
    expect(planProjectFiles(root, p).some((f) => f.path === 'PLAN.md')).toBe(false);
    p.savePlan(decompose('Fix the parser and ship it', detectProjectFacts(root)));
    run();
    const plan = read('PLAN.md');
    expect(plan).toMatch(/Plan v1 \(not approved/);
    expect(plan).toContain('Goal: Fix the parser and ship it');
    expect(plan).toMatch(/1\. \*\*/);
  });

  it('skips a file it cannot read instead of failing the rest', () => {
    mkdirSync(join(root, 'SAFETY.md'));
    const plan = planProjectFiles(root, p);
    expect(plan.find((f) => f.path === 'SAFETY.md')!.action).toBe('skip-unreadable');
    const r = applyProjectFiles(root, plan);
    expect(r.written).toContain('GOAL.md');
  });
});
