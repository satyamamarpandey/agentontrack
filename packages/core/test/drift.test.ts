// A decision is replaced; what a person linked to the old one is reported as drifted, until it is linked to the new one.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { driftBrief, findDrift, Project } from '../src/index.js';

let dir: string; let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-drift-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  const root = join(dir, 'repo');
  mkdirSync(root);
  p = new Project(root);
  p.human.setGoal({ statement: 'Ship refunds', scope: { include: ['**'] } });
  p.human.createTask({ id: 'pay-4', title: 'Refund to card', criteria: [{ id: 'c', description: 'works', kind: 'command', command: 'node -e "process.exit(0)"' }] });
});
afterEach(() => { try { p.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('drift', () => {
  it('reports nothing while no decision has been replaced', () => {
    const d = p.human.recordDecision('Refunds go to the card', 'Simplest path');
    p.human.linkDecision(d, 'task', 'pay-4');
    expect(findDrift(p.state())).toEqual([]);
  });

  it('reports what is still linked to a replaced decision, naming the old and the current one', () => {
    const old = p.human.recordDecision('Refunds go to the card', 'Simplest path');
    p.human.linkDecision(old, 'task', 'pay-4');
    p.human.linkDecision(old, 'file', 'src/refund.ts');
    const now = p.human.recordDecision('Refunds go to the wallet', 'Wallet refunds land at once', old);
    const drift = findDrift(p.state());
    expect(drift.map((d) => [d.kind, d.ref])).toEqual([['task', 'pay-4'], ['file', 'src/refund.ts']]);
    expect(drift[0]).toMatchObject({ stale: { id: old, title: 'Refunds go to the card' }, current: { id: now, title: 'Refunds go to the wallet' } });
  });

  it('follows a chain of replacements to the decision now in force', () => {
    const a = p.human.recordDecision('A', 'first');
    p.human.linkDecision(a, 'task', 'pay-4');
    const b = p.human.recordDecision('B', 'second', a);
    const c = p.human.recordDecision('C', 'third', b);
    expect(findDrift(p.state())[0]!.current.id).toBe(c);
  });

  it('is resolved once the same item is linked to the decision now in force', () => {
    const old = p.human.recordDecision('Card', 'x');
    p.human.linkDecision(old, 'task', 'pay-4');
    const now = p.human.recordDecision('Wallet', 'y', old);
    expect(findDrift(p.state())).toHaveLength(1);
    p.human.linkDecision(now, 'task', 'pay-4');
    expect(findDrift(p.state())).toEqual([]);
  });

  it('tells the agent in its session brief, and says nothing when nothing drifted', () => {
    const old = p.human.recordDecision('Card', 'x');
    expect(p.rehydrate().includes('Decisions changed')).toBe(false);
    p.human.linkDecision(old, 'task', 'pay-4');
    p.human.recordDecision('Wallet', 'Wallet refunds land at once', old);
    const b = p.rehydrate();
    expect(b).toContain('Decisions changed');
    expect(b).toContain('task pay-4');
    expect(b).toContain('Wallet');
    expect(driftBrief([])).toEqual([]);
  });

  it('refuses to replace or link a decision that does not exist', () => {
    expect(() => p.human.recordDecision('X', 'y', 'dec_nope')).toThrow(/No decision/);
    expect(() => p.human.linkDecision('dec_nope', 'task', 'pay-4')).toThrow(/No decision/);
  });

  it('cannot be written by an agent, so an agent cannot hide drift', () => {
    const old = p.human.recordDecision('Card', 'x');
    const before = p.state().decisionLinks.length;
    expect(() => p.store.append({ type: 'decision.linked', actor: { kind: 'agent', runtime: 'claude-code' }, payload: { decisionId: old, kind: 'task', ref: 'pay-4' } })).toThrow(/requires a human actor/);
    expect(p.state().decisionLinks.length).toBe(before);
  });
});
