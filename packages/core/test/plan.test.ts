import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decompose, detectProjectFacts, hasCycle, intentsOf, orderOf, phasePrompt, phaseViews, PhasePlanSchema, planSha, startBlock, type ProjectFacts, type RunFact, type TaskFact } from '../src/index.js';

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({ testCommand: 'pnpm test', testCommandSource: 'the test script in package.json', protectedPaths: [], meanSecondsPerTask: null, tasksInHistory: 0, ...over });
const kinds = (goal: string, f = facts()) => decompose(goal, f).phases.map((p) => p.kind);

describe('decomposition uses only the phases the goal needs', () => {
  it('a bug fix reads, changes, tests and verifies, and does not plan or release', () => {
    expect(kinds('Fix the crash when the date is empty')).toEqual(['understand', 'implement', 'test', 'verify']);
  });
  it('a feature plans, builds, reviews, tests and verifies', () => {
    expect(kinds('Add dark mode to the settings page')).toEqual(['understand', 'plan', 'implement', 'review', 'test', 'verify']);
  });
  it('a refactor plans first and reviews', () => {
    expect(kinds('Refactor the parser to remove duplication')).toEqual(['plan', 'implement', 'test', 'review', 'verify']);
  });
  it('a review or an investigation changes nothing', () => {
    expect(kinds('Review the auth code')).toEqual(['understand', 'review']);
    expect(kinds('Investigate why the build is slow')).toEqual(['understand']);
  });
  it('documentation is written and reviewed, with no test phase', () => {
    expect(kinds('Update the README')).toEqual(['implement', 'review']);
  });
  it('a release phase appears only when asked for, and states that it is never automatic', () => {
    expect(kinds('Fix the bug and release it')).toContain('release');
    const rel = decompose('Fix the bug and release it', facts()).phases.find((p) => p.kind === 'release')!;
    expect(rel.risks[0]).toMatch(/never does this on its own/);
    expect(kinds('Fix the bug')).not.toContain('release');
  });
  it('a goal with no recognizable action still gets a safe start, and says why', () => {
    const plan = decompose('The thing with the dates', facts());
    expect(plan.phases[0]!.kind).toBe('understand');
    expect(plan.phases[0]!.title).toMatch(/named no action/);
    expect(intentsOf('The thing with the dates')).toEqual([]);
  });
  it('each phase waits for the one before, and the plan is valid', () => {
    const plan = decompose('Add a feature', facts());
    expect(plan.phases[0]!.dependsOn).toEqual([]);
    plan.phases.slice(1).forEach((p, i) => expect(p.dependsOn).toEqual([plan.phases[i]!.id]));
    expect(() => PhasePlanSchema.parse(plan)).not.toThrow();
  });
});

describe('what it will and will not claim', () => {
  it('uses a test command only if the project has one, and makes the check weak and manual if not', () => {
    const withTests = decompose('Fix a bug', facts()).phases.find((p) => p.kind === 'test')!;
    expect(withTests.acceptance[0]).toMatchObject({ kind: 'command', command: 'pnpm test' });
    const without = decompose('Fix a bug', facts({ testCommand: null, testCommandSource: null })).phases.find((p) => p.kind === 'test')!;
    expect(without.acceptance[0]!.kind).toBe('manual');
    expect(without.risks.join(' ')).toMatch(/No test command was found/);
  });
  it('gives an effort estimate only from enough history, and says where it comes from', () => {
    const none = decompose('Add a thing', facts()).phases.find((p) => p.kind === 'implement')!;
    expect(none.effort).toBeUndefined();
    const few = decompose('Add a thing', facts({ meanSecondsPerTask: 600, tasksInHistory: 2 })).phases.find((p) => p.kind === 'implement')!;
    expect(few.effort).toBeUndefined();
    const some = decompose('Add a thing', facts({ meanSecondsPerTask: 600, tasksInHistory: 5 })).phases.find((p) => p.kind === 'implement')!;
    expect(some.effort).toMatchObject({ minutes: 10 });
    expect(some.effort!.basis).toMatch(/5 earlier tasks/);
  });
  it('names risks from the goal\'s own words only', () => {
    const risky = decompose('Delete the old users table and migrate the database', facts()).phases.find((p) => p.kind === 'implement')!;
    expect(risky.risks.join(' ')).toMatch(/Removes things/);
    expect(risky.risks.join(' ')).toMatch(/stored data/);
    expect(decompose('Add a button', facts()).phases.find((p) => p.kind === 'implement')!.risks).toEqual([]);
  });
});

describe('validation', () => {
  const base = () => decompose('Fix a bug', facts());
  it('refuses a circular wait, an unknown dependency and a duplicate id', () => {
    const cyc = base(); cyc.phases[0]!.dependsOn = [cyc.phases.at(-1)!.id];
    expect(PhasePlanSchema.safeParse(cyc).success).toBe(false);
    expect(hasCycle(cyc.phases)).toBe(true);
    const unknown = base(); unknown.phases[1]!.dependsOn = ['nope'];
    expect(PhasePlanSchema.safeParse(unknown).success).toBe(false);
    const dup = base(); dup.phases[1]!.id = dup.phases[0]!.id;
    expect(PhasePlanSchema.safeParse(dup).success).toBe(false);
  });
  it('a command check must have its command, and a phase budget is bounded', () => {
    const bad = base(); bad.phases[2]!.acceptance = [{ id: 'x', description: 'runs', kind: 'command' }];
    expect(PhasePlanSchema.safeParse(bad).success).toBe(false);
    const rich = base(); rich.phases[1]!.budget = { maxUsd: 5000 };
    expect(PhasePlanSchema.safeParse(rich).success).toBe(false);
  });
  it('reordering by changing what waits for what keeps a valid order', () => {
    const plan = base();
    expect(orderOf(plan)).toEqual(plan.phases.map((p) => p.id));
  });
});

describe('the approval hash covers content, not bookkeeping', () => {
  it('changes when the goal, mode, agent, model, checks or limits change', () => {
    const p = decompose('Fix a bug', facts());
    const sha = planSha(p);
    for (const edit of [(x: typeof p) => { x.goal += ' more'; }, (x: typeof p) => { x.mode = 'bounded'; }, (x: typeof p) => { x.phases[1]!.agent = 'codex'; }, (x: typeof p) => { x.phases[1]!.model = 'opus'; }, (x: typeof p) => { x.phases[2]!.acceptance[0]!.command = 'rm -rf /'; }, (x: typeof p) => { x.limits.maxUsd = 100; }]) {
      const q = structuredClone(p); edit(q);
      expect(planSha(q), String(edit)).not.toBe(sha);
    }
  });
  it('does not change when a phase is paused or skipped, or an effort note is added', () => {
    const p = decompose('Fix a bug', facts());
    const sha = planSha(p);
    const q = structuredClone(p); q.phases[1]!.state = 'paused'; q.phases[2]!.state = 'skipped'; q.phases[1]!.taskId = 'ph-x'; q.phases[1]!.effort = { minutes: 3, basis: 'x' };
    expect(planSha(q)).toBe(sha);
  });
  it('is the same for the same plan regardless of key order', () => {
    const p = decompose('Fix a bug', facts());
    const flip = (v: unknown): unknown => (Array.isArray(v) ? v.map(flip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, flip(x)])) : v);
    expect(planSha(PhasePlanSchema.parse(flip(p)))).toBe(planSha(p));
  });
});

describe('status is read from evidence, never from an agent\'s word', () => {
  const plan = () => { const p = decompose('Fix a bug', facts()); p.phases.forEach((x) => { if (x.acceptance.some((a) => a.kind === 'command')) x.taskId = `t-${x.id}`; }); return p; };
  const run = (phaseId: string, status: string, costUsd = 0.01): RunFact => ({ id: `r-${phaseId}-${status}`, phaseId, status, costUsd, wallClockMs: 1000 });
  const byId = (views: ReturnType<typeof phaseViews>, id: string) => views.find((v) => v.id === id)!;

  it('before approval everything is a draft, and after it the first phase is ready and the rest wait', () => {
    const p = plan();
    expect(phaseViews(p, false, [], new Map()).every((v) => v.status === 'draft')).toBe(true);
    const v = phaseViews(p, true, [], new Map());
    expect(v[0]!.status).toBe('ready');
    expect(v[1]!.status).toBe('blocked');
  });
  it('a finished run on a phase with a check needs evidence, and with none is done but unchecked: never verified', () => {
    const p = plan();
    const testPhase = p.phases.find((x) => x.kind === 'test')!;
    const understand = p.phases[0]!;
    const tasks = new Map<string, TaskFact>([[testPhase.taskId!, { status: 'IMPLEMENTED_UNVERIFIED', criteriaStates: ['missing'] }]]);
    const v = phaseViews(p, true, [run(understand.id, 'finished'), run(testPhase.id, 'finished')], tasks);
    expect(byId(v, understand.id).status).toBe('done-unchecked');
    expect(byId(v, understand.id).why).toMatch(/agent's word only/);
    expect(byId(v, testPhase.id).status).toBe('needs-evidence');
    expect(v.some((x) => x.status === 'verified')).toBe(false);
  });
  it('verified only when the engine says the task is VERIFIED; stale and failed are told apart', () => {
    const p = plan();
    const t = p.phases.find((x) => x.kind === 'test')!;
    const mk = (status: string, states: string[]) => byId(phaseViews(p, true, [run(t.id, 'finished')], new Map([[t.taskId!, { status, criteriaStates: states }]])), t.id).status;
    expect(mk('VERIFIED', ['pass'])).toBe('verified');
    expect(mk('FAILED', ['fail'])).toBe('failed');
    expect(mk('IMPLEMENTED_UNVERIFIED', ['stale'])).toBe('stale');
  });
  it('a running run shows as running, and paused or skipped is honoured', () => {
    const p = plan();
    p.phases[1]!.state = 'paused'; p.phases[2]!.state = 'skipped';
    const v = phaseViews(p, true, [run(p.phases[0]!.id, 'running')], new Map());
    expect(v[0]!.status).toBe('running');
    expect(v[1]!.status).toBe('paused');
    expect(v[2]!.status).toBe('skipped');
  });
});

describe('what may start', () => {
  const p0 = () => { const p = decompose('Fix a bug', facts()); return p; };
  const views = (p: ReturnType<typeof p0>, runs: RunFact[] = []) => phaseViews(p, true, runs, new Map());
  const r = (phaseId: string, status = 'finished', costUsd = 0.5): RunFact => ({ id: `${phaseId}${status}${costUsd}${Math.random()}`, phaseId, status, costUsd, wallClockMs: 1 });

  it('needs an approval of exactly this content', () => {
    const p = p0();
    expect(startBlock(p, p.phases[0]!.id, null, views(p), [])).toMatch(/never approved/);
    expect(startBlock(p, p.phases[0]!.id, 'f'.repeat(64), views(p), [])).toMatch(/changed since you approved/);
    expect(startBlock(p, p.phases[0]!.id, planSha(p), views(p), [])).toBeNull();
  });
  it('will not start a phase whose dependency is unsettled, paused, skipped or already verified', () => {
    const p = p0();
    expect(startBlock(p, p.phases[1]!.id, planSha(p), views(p), [])).toMatch(/Waiting for/);
    p.phases[0]!.state = 'paused';
    expect(startBlock(p, p.phases[0]!.id, planSha(p), views(p), [])).toMatch(/paused/);
  });
  it('stops at the phase\'s run count and budget, and at the plan\'s run count and budget', () => {
    const p = p0();
    const first = p.phases[0]!;
    first.budget = { maxRuns: 1 };
    const sha = planSha(p);
    expect(startBlock(p, first.id, sha, views(p, [r(first.id, 'failed')]), [r(first.id, 'failed')])).toMatch(/used its 1 runs/);
    const q = p0(); q.phases[0]!.budget = { maxUsd: 1 };
    const spent = [r(q.phases[0]!.id, 'failed', 1.5)];
    expect(startBlock(q, q.phases[0]!.id, planSha(q), views(q, spent), spent)).toMatch(/\$1 budget/);
    const w = p0(); w.limits.maxRuns = 2;
    const many = [r(w.phases[0]!.id, 'failed'), r(w.phases[0]!.id, 'failed')];
    w.phases[0]!.budget = { maxRuns: 9 };
    expect(startBlock(w, w.phases[0]!.id, planSha(w), views(w, many), many)).toMatch(/plan has used its 2 runs/);
    const z = p0(); z.limits.maxUsd = 1;
    const dear = [r(z.phases[0]!.id, 'failed', 1.2)];
    z.phases[0]!.budget = { maxRuns: 9 };
    expect(startBlock(z, z.phases[0]!.id, planSha(z), views(z, dear), dear)).toMatch(/plan has used its \$1 budget/);
  });
  it('stops when the plan\'s time is used', () => {
    const p = p0(); p.limits.maxMinutes = 10;
    expect(startBlock(p, p.phases[0]!.id, planSha(p), views(p), [], 1_000_000 + 11 * 60_000, 1_000_000)).toMatch(/10 minutes/);
  });
});

describe('the prompt for a phase', () => {
  it('comes from the approved plan, says the checks are AgentOnTrack\'s, and tells the agent not to publish', () => {
    const p = decompose('Fix a bug', facts());
    const t = p.phases.find((x) => x.kind === 'test')!;
    const text = phasePrompt(p, t, 'be quick');
    expect(text).toMatch(/Goal: Fix a bug/);
    expect(text).toMatch(/AgentOnTrack will run: pnpm test/);
    expect(text).toMatch(/Do not publish, deploy or push/);
    expect(text).toMatch(/Do not claim the work is verified/);
    expect(text).toMatch(/Extra from the person: be quick/);
    expect(text.startsWith('-')).toBe(false);
  });
});

describe('detecting the project\'s own test command', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aot-facts-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  it('reads package.json and the lock file, and ignores the npm placeholder', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(detectProjectFacts(dir).testCommand).toBe('npm test');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectProjectFacts(dir)).toMatchObject({ testCommand: 'pnpm test', testCommandSource: 'the test script in package.json' });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectProjectFacts(dir).testCommand).toBeNull();
  });
  it('finds Cargo, Go and pytest only from their own files, and nothing from an empty folder', () => {
    expect(detectProjectFacts(dir).testCommand).toBeNull();
    writeFileSync(join(dir, 'go.mod'), 'module x');
    expect(detectProjectFacts(dir).testCommand).toBe('go test ./...');
    const d2 = mkdtempSync(join(tmpdir(), 'aot-facts2-')); mkdirSync(join(d2, 'tests'));
    expect(detectProjectFacts(d2).testCommand).toBeNull();
    writeFileSync(join(d2, 'pytest.ini'), '[pytest]');
    expect(detectProjectFacts(d2).testCommand).toBe('python -m pytest');
    rmSync(d2, { recursive: true, force: true });
  });
});
