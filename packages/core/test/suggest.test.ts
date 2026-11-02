import { describe, expect, it } from 'vitest';
import { decompose, suggestNext, type AgentFact, type PhaseView } from '../src/index.js';

const facts = { hasTests: true, testCommand: 'npm test', buildCommand: null, lintCommand: null, packageManager: 'npm', meanSecondsPerTask: null, tasksInHistory: 0, languages: ['ts'] } as never;
const plan = () => decompose('Fix the crash when the date is empty', facts, { id: 'p1' });
const both: AgentFact[] = [{ id: 'claude-code', name: 'Claude Code', canStart: true }, { id: 'codex', name: 'Codex', canStart: false }];
const view = (id: string, status: PhaseView['status']): PhaseView => ({ id, status, why: `because ${status}`, runs: 0, spentUsd: 0 });
const base = (over: object) => ({ goal: 'Fix the crash', plan: plan(), approved: true, views: [] as PhaseView[], pendingApprovals: 0, agents: both, ...over });

describe('next-prompt suggestions', () => {
  it('suggests nothing without a goal', () => expect(suggestNext(base({ goal: null }))).toEqual([]));
  it('suggests drafting a plan when there is a goal and no plan, and approving one before anything runs', () => {
    expect(suggestNext(base({ plan: null }))[0]).toMatchObject({ kind: 'draft-plan', startable: false });
    const s = suggestNext(base({ approved: false }));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'approve-plan', needsApproval: true });
  });
  it('puts a failing check first, with what it printed, and never tells the agent to change the check', () => {
    const p = plan(); const id = p.phases[0]!.id;
    const s = suggestNext(base({ plan: p, views: p.phases.map((x, n) => view(x.id, n === 0 ? 'failed' : 'blocked')), failureNotes: { [id]: 'expected 1 got 2' } }));
    expect(s[0]).toMatchObject({ kind: 'fix-failure', startable: true, agent: { id: 'claude-code' } });
    expect(s[0]!.prompt).toContain('expected 1 got 2');
    expect(s[0]!.prompt).toMatch(/do not change the check/);
    expect(s[0]!.why).toBe('because failed');
  });
  it('suggests running checks, not another agent run, when the agent finished without evidence', () => {
    const p = plan();
    const s = suggestNext(base({ plan: p, views: p.phases.map((x, n) => view(x.id, n === 0 ? 'needs-evidence' : 'blocked')) }));
    expect(s[0]).toMatchObject({ kind: 'run-checks', agent: null });
  });
  it('starts the first ready phase on an agent that can really be started, and a phase for an agent that cannot is a prompt to copy', () => {
    const p = plan(); p.phases[0]!.agent = 'codex';
    const s = suggestNext(base({ plan: p, views: p.phases.map((x, n) => view(x.id, n === 0 ? 'ready' : 'blocked')) }));
    expect(s[0]).toMatchObject({ kind: 'start-phase', agent: { id: 'claude-code' }, startable: true });
    const only = suggestNext(base({ plan: p, agents: [{ id: 'codex', name: 'Codex', canStart: false }], views: p.phases.map((x, n) => view(x.id, n === 0 ? 'ready' : 'blocked')) }));
    expect(only[0]).toMatchObject({ agent: { id: 'codex' }, startable: false });
  });
  it('recommends a different agent for review, and says when it has to be the same one', () => {
    const p = plan();
    const done = p.phases.map((x) => view(x.id, x.kind === 'review' ? 'ready' : 'verified'));
    const same = suggestNext(base({ plan: p, views: done })).find((s) => s.kind === 'review');
    expect(same?.why).toMatch(/weaker check/);
    const diff = suggestNext(base({ plan: p, views: done, agents: [{ id: 'claude-code', name: 'Claude Code', canStart: true }, { id: 'codex', name: 'Codex', canStart: true }] })).find((s) => s.kind === 'review');
    expect(diff?.agent?.id).toBe('codex');
    expect(diff?.why).toMatch(/different agent/);
  });
  it('gives at most three, honours dismissals, and is the same every time for the same state', () => {
    const p = plan();
    const input = base({ plan: p, pendingApprovals: 2, views: p.phases.map((x, n) => view(x.id, n === 0 ? 'failed' : n === 1 ? 'needs-evidence' : 'ready')) });
    const s = suggestNext(input);
    expect(s.length).toBeLessThanOrEqual(3);
    expect(suggestNext(input)).toEqual(s);
    expect(suggestNext({ ...input, dismissed: ['approvals'] }).some((x) => x.id === 'approvals')).toBe(false);
  });
  it('does not call work finished on the agent’s word', () => {
    const p = plan();
    const s = suggestNext(base({ plan: p, views: p.phases.map((x, n) => view(x.id, n === 0 ? 'done-unchecked' : 'verified')) })).find((x) => x.kind === 'finish');
    expect(s?.title).toMatch(/nobody checked/);
  });
});
