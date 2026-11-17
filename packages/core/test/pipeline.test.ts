import { describe, expect, it } from 'vitest';
import { authorizeStage, finishStage, newPipeline, sameModel, startStage, summary, unattendedChainAllowed, type Pipeline, type PipelineStage } from '../src/index.js';

const claude = (model: string) => ({ agent: 'claude-code' as const, model });
const done = (p: Pipeline, s: PipelineStage, model: string, actual = model, ev: string[] = ['x']) =>
  finishStage(startStage(authorizeStage(p, s, claude(model), 'owner', 1), s, 'run_a'), s, { ok: true, actualModel: actual, evidence: ev });

describe('plan → build → review → verify', () => {
  it('needs each stage authorized separately and in order', () => {
    const p = newPipeline('p1', 'goal');
    expect(() => startStage(p, 'plan', 'r')).toThrow(/not been authorized/);
    expect(() => authorizeStage(p, 'build', claude('sonnet'), 'owner', 1)).toThrow(/plan must be done/);
    const p2 = done(p, 'plan', 'haiku');
    expect(() => startStage(p2, 'build', 'r')).toThrow(/not been authorized/);
  });
  it('records a substituted model instead of hiding it', () => {
    let p = done(newPipeline('p', 'g'), 'plan', 'haiku');
    p = done(p, 'build', 'sonnet', 'claude-sonnet-5-5');
    p = done(p, 'review', 'opus', 'claude-sonnet-5-5');
    p = done(p, 'verify', 'haiku', 'claude-haiku-5-5');
    expect(summary(p).substitutions).toEqual(['review']);
    expect(summary(p).verified).toBe(true);
  });
  it('a substituted verify stage is not verified', () => {
    let p = newPipeline('p', 'g');
    for (const [s, m] of [['plan', 'haiku'], ['build', 'sonnet'], ['review', 'opus']] as const) p = done(p, s, m);
    p = done(p, 'verify', 'haiku', 'claude-sonnet-5-5');
    expect(summary(p).verified).toBe(false);
  });
  it('verified needs evidence', () => {
    let p = newPipeline('p', 'g');
    for (const [s, m] of [['plan', 'haiku'], ['build', 'sonnet'], ['review', 'opus']] as const) p = done(p, s, m);
    p = done(p, 'verify', 'haiku', 'haiku', []);
    expect(summary(p).verified).toBe(false);
  });
  it('blocks a credit-bearing model without consent', () => {
    const p = newPipeline('p', 'g');
    expect(() => authorizeStage(p, 'plan', claude('fable'), 'owner', 1, { billing: 'may-use-credits' })).toThrow(/usage credits/);
    expect(authorizeStage(p, 'plan', claude('fable'), 'owner', 1, { billing: 'may-use-credits', acceptUsageCredits: true }).stages[0]!.acceptedUsageCredits).toBe(true);
  });
  it('a failed stage can be re-authorized, a done one cannot', () => {
    let p = authorizeStage(newPipeline('p', 'g'), 'plan', claude('haiku'), 'o', 1);
    p = finishStage(startStage(p, 'plan', 'r'), 'plan', { ok: false, actualModel: null });
    p = authorizeStage(p, 'plan', claude('haiku'), 'o', 2);
    expect(p.stages[0]!.status).toBe('authorized');
    const d = done(newPipeline('p', 'g'), 'plan', 'haiku');
    expect(() => authorizeStage(d, 'plan', claude('haiku'), 'o', 2)).toThrow(/already done/);
  });
  it('matches aliases to full ids and keeps unattended chains off', () => {
    expect(sameModel('sonnet', 'claude-sonnet-5-5')).toBe(true);
    expect(sameModel('opus', 'claude-sonnet-5-5')).toBe(false);
    expect(unattendedChainAllowed().ok).toBe(false);
  });
});
