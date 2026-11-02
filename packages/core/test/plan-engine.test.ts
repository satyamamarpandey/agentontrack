// The plan inside the real engine: who may approve, what activating a phase can and cannot do, and what an approval is bound to.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand, decompose, Project, type ProjectFacts } from '../src/index.js';

const facts: ProjectFacts = { testCommand: null, testCommandSource: null, protectedPaths: [], meanSecondsPerTask: null, tasksInHistory: 0 };
let dir: string; let root: string; let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-pe-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo'); mkdirSync(root);
  p = new Project(root);
  p.human.setGoal({ statement: 'Fix a bug', scope: { include: ['**'] } });
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const draft = (goal = 'Fix a bug') => { const r = p.savePlan(decompose(goal, facts)); return r; };
const push = () => { const cl = classifyCommand('git push origin main'); return p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: cl.effects, opaque: false, coverage: 'enforced', rawInput: 'git push origin main' }); };

describe('approving a plan', () => {
  it('is a human-only event: an agent or the system cannot make it', () => {
    const d = draft();
    expect(() => p.store.append({ type: 'plan.approved', actor: { kind: 'agent', runtime: 'claude-code' }, payload: { sha: d.sha, version: d.version, tasks: {} } })).toThrow();
    expect(() => p.store.append({ type: 'plan.approved', actor: { kind: 'system' }, payload: { sha: d.sha, version: d.version, tasks: {} } })).toThrow();
    expect(p.state().plan!.approvedSha).toBeNull();
  });
  it('refuses a plan that changed since it was looked at, and one that does not exist', () => {
    expect(() => p.human.approvePlan('a'.repeat(64), 1)).toThrow(/no plan/);
    const d = draft();
    expect(() => p.human.approvePlan(d.sha, d.version + 1)).toThrow(/changed since you looked/);
    expect(() => p.human.approvePlan('b'.repeat(64), d.version)).toThrow(/changed since you looked/);
  });
  it('creates one task per phase, none of them active, and nothing is approved by a draft being saved', () => {
    const d = draft();
    expect(p.state().tasks.size).toBe(0);
    p.human.approvePlan(d.sha, d.version);
    const plan = p.state().plan!;
    expect(plan.approvedSha).toBe(d.sha);
    expect(plan.doc.phases.every((ph: any) => ph.taskId && p.state().tasks.has(ph.taskId))).toBe(true);
    expect(p.state().activeTaskId).toBeNull();
  });
  it('is withdrawn by an edit to what runs, and kept by a pause', () => {
    const d = draft();
    p.human.approvePlan(d.sha, d.version);
    const doc = structuredClone(p.state().plan!.doc);
    doc.phases[0].state = 'paused';
    p.savePlan(doc);
    expect(p.state().plan!.approvedSha).toBe(p.state().plan!.sha);
    doc.phases[1].model = 'opus';
    p.savePlan(doc);
    expect(p.state().plan!.approvedSha).not.toBe(p.state().plan!.sha);
  });
  it('a saved draft cannot carry its own task ids, so a phase cannot borrow another task\'s evidence', () => {
    const d = draft();
    const forged = structuredClone(p.state().plan!.doc);
    forged.phases[0].taskId = 'someone-elses-task';
    p.savePlan(forged, d.version);
    expect(p.state().plan!.doc.phases[0].taskId).toBeUndefined();
  });
});

describe('starting a phase', () => {
  it('makes the phase\'s own task active, so a held push is bound to it', () => {
    const d = draft();
    p.human.approvePlan(d.sha, d.version);
    expect(push().decision).toBe('deny');
    const first = p.state().plan!.doc.phases[0];
    p.activatePhase(first.id);
    expect(p.state().activeTaskId).toBe(first.taskId);
    const held = push();
    expect(held.decision).toBe('request_approval');
    expect([...p.state().approvals.values()].find((a) => a.view === 'pending' || a.status === 'pending')?.taskId).toBe(first.taskId);
  });
  it('refuses while the plan is unapproved or edited since, or for a phase it never made a task for', () => {
    const d = draft();
    expect(() => p.activatePhase(p.state().plan!.doc.phases[0].id)).toThrow(/not approved/);
    p.human.approvePlan(d.sha, d.version);
    const doc = structuredClone(p.state().plan!.doc);
    doc.phases[0].agent = 'codex';
    p.savePlan(doc);
    expect(() => p.activatePhase(doc.phases[0].id)).toThrow(/not approved/);
    expect(p.state().activeTaskId).toBeNull();
  });
  it('a forged phase_started event cannot activate any task but the approved plan\'s own', () => {
    const d = draft();
    const other = p.human.createTask({ title: 'Unrelated', criteria: [], activate: false });
    const doc0 = p.state().plan!.doc.phases[0].id;
    // Not approved yet: nothing happens, whatever the payload says.
    p.store.append({ type: 'plan.phase_started', actor: { kind: 'system' }, payload: { phaseId: doc0, taskId: other } });
    expect(p.state().activeTaskId).toBeNull();
    p.human.approvePlan(d.sha, d.version);
    p.store.append({ type: 'plan.phase_started', actor: { kind: 'system' }, payload: { phaseId: doc0, taskId: other } });
    expect(p.state().activeTaskId).toBeNull();
    p.store.append({ type: 'plan.phase_started', actor: { kind: 'system' }, payload: { phaseId: 'nope', taskId: other } });
    expect(p.state().activeTaskId).toBeNull();
  });
});
