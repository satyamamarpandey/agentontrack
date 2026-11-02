import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planWorkflow, Project, readyStages, TeamSchema } from '../src/index.js';

let dir: string; let p: Project;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aot-team-')); process.env.AGENTONTRACK_HOME = join(dir, 'home'); mkdirSync(join(dir, 'r')); p = new Project(join(dir, 'r')); });
afterEach(() => { try { p.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const team = [{ agent: 'claude-code', role: 'implement' as const }, { agent: 'codex', role: 'review' as const }];
const swapped = [{ agent: 'codex', role: 'implement' as const }, { agent: 'claude-code', role: 'review' as const }];

describe('team', () => {
  it('is saved by a person, versioned, and swapping roles is just a new version', () => {
    expect(p.state().team).toEqual({ version: 0, members: [] });
    p.human.setTeam(team);
    expect(p.state().team).toMatchObject({ version: 1, members: team });
    p.human.setTeam(swapped, 1);
    expect(p.state().team.version).toBe(2);
    expect(p.state().team.members[0]).toMatchObject({ agent: 'codex', role: 'implement' });
  });

  it('refuses an edit based on an old version, so a stale window cannot undo a newer team', () => {
    p.human.setTeam(team);
    p.human.setTeam(swapped, 1);
    expect(() => p.human.setTeam(team, 1)).toThrow(/version 2, not 1/);
    expect(p.state().team.members[0]!.agent).toBe('codex');
  });

  it('an agent cannot assign itself a role', () => {
    expect(() => p.store.append({ type: 'team.set', actor: { kind: 'agent', runtime: 'codex' }, payload: { members: [{ agent: 'codex', role: 'implement' }] } })).toThrow(/human/);
  });

  it('rejects bad members, repeats, and too many', () => {
    expect(() => p.human.setTeam([{ agent: 'Claude Code', role: 'implement' }])).toThrow();
    expect(() => p.human.setTeam([{ agent: 'codex', role: 'boss' }])).toThrow();
    expect(() => p.human.setTeam([...team, team[0]])).toThrow(/already implement/);
    expect(TeamSchema.safeParse(Array.from({ length: 13 }, (_, i) => ({ agent: `agent-${i}`, role: 'review' }))).success).toBe(false);
    expect(TeamSchema.safeParse([{ agent: 'codex', role: 'implement', budgetTokens: -5 }]).success).toBe(false);
  });
});

describe('workflows', () => {
  it('A: one implements, another reviews, then the engine\'s own checks verify', () => {
    const plan = planWorkflow(team, 'implement-review-verify');
    expect(plan.problems).toEqual([]);
    expect(plan.stages.map((s) => [s.id, s.agent, s.dependsOn])).toEqual([['implement', 'claude-code', []], ['review', 'codex', ['implement']], ['verify', 'checks', ['review']]]);
    expect(plan.stages[0]!.isolated).toBe(true);
  });

  it('B: the same plan with the roles swapped', () => {
    expect(planWorkflow(swapped, 'implement-review-verify').stages.map((s) => s.agent)).toEqual(['codex', 'claude-code', 'checks']);
  });

  it('C: two implementers work in separate worktrees, then are compared, and a person decides', () => {
    const plan = planWorkflow([{ agent: 'claude-code', role: 'implement' }, { agent: 'codex', role: 'implement' }], 'parallel-then-compare');
    expect(plan.problems).toEqual([]);
    expect(plan.stages.filter((s) => s.isolated).map((s) => s.agent)).toEqual(['claude-code', 'codex']);
    expect(plan.stages.at(-1)).toMatchObject({ id: 'decide', agent: 'person', dependsOn: ['compare'] });
  });

  it('says what is missing, and warns when a review is not independent', () => {
    expect(planWorkflow([], 'implement-review-verify').problems).toEqual(['No agent has the implement role.', 'No agent has the review role.']);
    expect(planWorkflow([{ agent: 'codex', role: 'implement' }], 'parallel-then-compare').problems[0]).toMatch(/at least two/);
    const same = planWorkflow([{ agent: 'codex', role: 'implement' }, { agent: 'codex', role: 'review' }], 'implement-review-verify');
    expect(same.warnings.join()).toMatch(/not independent/);
    const research = planWorkflow([...team, { agent: 'perplexity', role: 'research' }], 'implement-review-verify');
    expect(research.warnings.join()).toMatch(/counts as no evidence/);
  });

  it('runs a stage only when what it depends on is done', () => {
    const plan = planWorkflow(team, 'implement-review-verify');
    expect(readyStages(plan, new Set()).map((s) => s.id)).toEqual(['implement']);
    expect(readyStages(plan, new Set(['implement'])).map((s) => s.id)).toEqual(['review']);
    expect(readyStages(plan, new Set(['implement', 'review'])).map((s) => s.id)).toEqual(['verify']);
    expect(readyStages(plan, new Set(['implement', 'review', 'verify']))).toEqual([]);
  });
});
