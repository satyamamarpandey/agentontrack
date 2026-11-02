import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';

/**
 * A phase plan for one goal. Everything here is a pure function of its input: it decomposes by rules a person can read, it does not
 * ask a model, and it never decides that work is done. "Verified" is only ever read from the engine's own check receipts.
 */
export const PHASE_KINDS = ['understand', 'plan', 'implement', 'review', 'test', 'verify', 'release', 'custom'] as const;
export type PhaseKind = (typeof PHASE_KINDS)[number];
export const PLAN_ROLES = ['planning', 'coding', 'review', 'verification', 'research', 'release'] as const;
export type PlanRole = (typeof PLAN_ROLES)[number];
export const MODES = ['manual', 'guided', 'bounded'] as const;
export type Mode = (typeof MODES)[number];

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use a short lower-case id such as implement-1');
const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/);

export const PhaseSchema = z.object({
  id: Id,
  title: z.string().min(1).max(120),
  kind: z.enum(PHASE_KINDS),
  role: z.enum(PLAN_ROLES),
  instructions: z.string().max(2000).default(''),
  dependsOn: z.array(Id).max(20).default([]),
  agent: AgentId.optional(),
  model: z.string().regex(/^[\w][\w.:/@+-]{0,99}$/).optional(),
  acceptance: z.array(z.object({
    id: Id,
    description: z.string().min(1).max(300),
    kind: z.enum(['command', 'manual']),
    command: z.string().min(1).max(300).optional(),
  })).max(12).default([]),
  budget: z.object({ maxUsd: z.number().positive().max(50).optional(), maxMinutes: z.number().positive().max(600).optional(), maxRuns: z.number().int().positive().max(10).optional() }).default({}),
  risks: z.array(z.string().min(1).max(200)).max(10).default([]),
  effort: z.object({ minutes: z.number().positive(), basis: z.string().max(200) }).optional(),
  /** Not part of what a person approves: pausing or skipping only ever does less. */
  state: z.enum(['draft', 'paused', 'skipped']).default('draft'),
  /** Set when the plan is approved, for phases that have a command to run. */
  taskId: z.string().optional(),
});
export type Phase = z.infer<typeof PhaseSchema>;

export const PhasePlanSchema = z.object({
  id: Id,
  goal: z.string().min(1).max(2000),
  mode: z.enum(MODES).default('manual'),
  /** Hard ceilings over the whole plan. A phase's own budget can only be lower. */
  limits: z.object({ maxUsd: z.number().positive().max(200).default(5), maxMinutes: z.number().positive().max(1440).default(120), maxRuns: z.number().int().positive().max(40).default(10) }).default({ maxUsd: 5, maxMinutes: 120, maxRuns: 10 }),
  /** The agent and model for each kind of work, unless a phase names its own. */
  defaults: z.partialRecord(z.enum(PLAN_ROLES), z.object({ agent: AgentId, model: z.string().regex(/^[\w][\w.:/@+-]{0,99}$/).optional() })).default({}),
  phases: z.array(PhaseSchema).min(1).max(20),
}).superRefine((plan, ctx) => {
  const ids = new Set<string>();
  plan.phases.forEach((p, i) => {
    if (ids.has(p.id)) ctx.addIssue({ code: 'custom', message: `Two phases are called ${p.id}`, path: ['phases', i, 'id'] });
    ids.add(p.id);
  });
  plan.phases.forEach((p, i) => p.dependsOn.forEach((d) => {
    if (!ids.has(d)) ctx.addIssue({ code: 'custom', message: `${p.id} waits for ${d}, which is not in this plan`, path: ['phases', i, 'dependsOn'] });
    if (d === p.id) ctx.addIssue({ code: 'custom', message: `${p.id} cannot wait for itself`, path: ['phases', i, 'dependsOn'] });
  }));
  if (hasCycle(plan.phases)) ctx.addIssue({ code: 'custom', message: 'The phases wait for each other in a circle', path: ['phases'] });
  plan.phases.forEach((p, i) => p.acceptance.forEach((a, j) => {
    if (a.kind === 'command' && !a.command) ctx.addIssue({ code: 'custom', message: 'A command check needs its command', path: ['phases', i, 'acceptance', j] });
  }));
});
export type PhasePlan = z.infer<typeof PhasePlanSchema>;

export function hasCycle(phases: Pick<Phase, 'id' | 'dependsOn'>[]): boolean {
  const seen = new Map<string, 1 | 2>();
  const by = new Map(phases.map((p) => [p.id, p]));
  const visit = (id: string): boolean => {
    if (seen.get(id) === 2) return false;
    if (seen.get(id) === 1) return true;
    seen.set(id, 1);
    for (const d of by.get(id)?.dependsOn ?? []) if (by.has(d) && visit(d)) return true;
    seen.set(id, 2);
    return false;
  };
  return phases.some((p) => visit(p.id));
}

/** Phases in an order that respects what waits for what, keeping the plan's own order where there is a choice. */
export function orderOf(plan: PhasePlan): string[] {
  const done = new Set<string>(); const out: string[] = [];
  while (out.length < plan.phases.length) {
    const next = plan.phases.find((p) => !done.has(p.id) && p.dependsOn.every((d) => done.has(d)));
    if (!next) break;
    done.add(next.id); out.push(next.id);
  }
  return out;
}

/** What a person approves: the content, and not the bookkeeping. Changing any of it needs a new approval. */
export function contentOf(plan: PhasePlan): unknown {
  return {
    goal: plan.goal, mode: plan.mode, limits: plan.limits, defaults: plan.defaults,
    phases: plan.phases.map(({ state: _s, taskId: _t, effort: _e, ...p }) => p),
  };
}
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}` : JSON.stringify(v));
export const planSha = (plan: PhasePlan): string => createHash('sha256').update(canonical(contentOf(plan))).digest('hex');

/* ---------- Decomposition ---------- */

export interface ProjectFacts {
  /** The command that runs this project's tests, when one could be found in the project's own files. */
  testCommand: string | null;
  testCommandSource: string | null;
  protectedPaths: string[];
  /** Seconds per finished task, from this project's own record, or null when there is no history. */
  meanSecondsPerTask: number | null;
  tasksInHistory: number;
}

/** Finds a test command only from files that are really there. Nothing is guessed from the language alone. */
export function detectProjectFacts(root: string, extra: Partial<ProjectFacts> = {}): ProjectFacts {
  const has = (f: string) => existsSync(join(root, f));
  let testCommand: string | null = null; let source: string | null = null;
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const t = pkg.scripts?.test;
      if (t && !/no test specified/i.test(t)) {
        const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
        testCommand = `${pm} test`; source = 'the test script in package.json';
      }
    } catch { /* an unreadable package.json is not a test command */ }
  }
  if (!testCommand && has('Cargo.toml')) { testCommand = 'cargo test'; source = 'Cargo.toml'; }
  if (!testCommand && has('go.mod')) { testCommand = 'go test ./...'; source = 'go.mod'; }
  if (!testCommand && (has('pytest.ini') || has('tox.ini') || (has('pyproject.toml') && /\[tool\.pytest/.test(readFileSync(join(root, 'pyproject.toml'), 'utf8'))))) { testCommand = 'python -m pytest'; source = 'the pytest settings'; }
  return { testCommand, testCommandSource: source, protectedPaths: [], meanSecondsPerTask: null, tasksInHistory: 0, ...extra };
}

type Intent = 'fix' | 'build' | 'refactor' | 'review' | 'investigate' | 'docs' | 'release';

/** Reads the goal's own words. It returns every intent it finds, in a fixed order, so the result is explainable. */
export function intentsOf(goal: string): Intent[] {
  const g = goal.toLowerCase();
  const found: Intent[] = [];
  const test = (re: RegExp, i: Intent) => { if (re.test(g)) found.push(i); };
  test(/\b(fix|bug|broken|crash|regression|error|failing|fails)\b/, 'fix');
  test(/\b(add|create|implement|support|introduce|new feature|feature)\b|\bbuild (a|an|the|new|out)\b/, 'build');
  test(/\b(refactor|restructure|clean ?up|simplify|rename|migrate)\b/, 'refactor');
  test(/\b(review|audit|inspect|check over)\b/, 'review');
  test(/\b(investigate|research|explore|find out|understand|why does|analy[sz]e)\b/, 'investigate');
  test(/\b(docs?|documentation|readme|changelog)\b/, 'docs');
  test(/\b(release|deploy|publish|ship|launch|tag a version)\b/, 'release');
  return found;
}

const RISK_WORDS: [RegExp, string][] = [
  [/\b(delete|remove|drop|purge|wipe)\b/i, 'Removes things. Check what is removed and that it can be restored.'],
  [/\b(migrat|schema|database|db)\b/i, 'Touches stored data or its structure. A mistake can be hard to undo.'],
  [/\b(auth|login|password|token|secret|credential|permission)\b/i, 'Touches sign-in or secrets. Keep credentials out of prompts and files.'],
  [/\b(payment|billing|invoice|charge)\b/i, 'Touches money. Test with fake data only.'],
  [/\b(deploy|publish|release|production|prod)\b/i, 'Leaves your machine. This needs your own approval and is never done automatically.'],
  [/\b(dependenc|upgrade|bump|version)\b/i, 'Changes dependencies, which can change behavior far from the edit.'],
];

let n = 0;
const rid = (p: string) => `${p}-${++n}`;

/**
 * Builds a draft plan from a goal, using only the phases the goal needs. It is a starting point for a person to edit and approve,
 * and says nothing about whether the goal is wise or the plan is complete.
 */
export function decompose(goal: string, facts: ProjectFacts, opts: { id?: string; agents?: Partial<Record<PlanRole, { agent: string; model?: string }>> } = {}): PhasePlan {
  n = 0;
  const intents = intentsOf(goal);
  const kinds: PhaseKind[] = [];
  const add = (k: PhaseKind) => { if (!kinds.includes(k)) kinds.push(k); };
  const hasIntent = (i: Intent) => intents.includes(i);

  if (hasIntent('investigate') && intents.length === 1) { add('understand'); }
  else if (hasIntent('review') && !hasIntent('build') && !hasIntent('fix') && !hasIntent('refactor')) { add('understand'); add('review'); }
  else if (hasIntent('docs') && !hasIntent('build') && !hasIntent('fix')) { add('implement'); add('review'); }
  else if (hasIntent('fix') && !hasIntent('build')) { add('understand'); add('implement'); add('test'); add('verify'); }
  else if (hasIntent('refactor') && !hasIntent('build')) { add('plan'); add('implement'); add('test'); add('review'); add('verify'); }
  else { add('understand'); add('plan'); add('implement'); add('review'); add('test'); add('verify'); }
  if (hasIntent('release')) add('release');
  // A goal with no recognizable verb still gets the safe default, and the plan says so in its first phase.
  const unrecognized = intents.length === 0;

  const phases: Phase[] = [];
  const idOf = new Map<PhaseKind, string>();
  const roleOf: Record<PhaseKind, PlanRole> = { understand: 'research', plan: 'planning', implement: 'coding', review: 'review', test: 'verification', verify: 'verification', release: 'release', custom: 'coding' };
  const titleOf: Record<PhaseKind, string> = { understand: 'Understand the code and the problem', plan: 'PhasePlan the change', implement: 'Make the change', review: 'Review the change', test: 'Run the tests', verify: 'Verify the goal is met', release: 'Release', custom: 'Work' };
  const how: Record<PhaseKind, string> = {
    understand: 'Read the relevant code and report what it does and what is unclear. Change nothing.',
    plan: 'Write down the smallest change that meets the goal, the files it touches and how it will be checked. Change nothing yet.',
    implement: 'Make the change the plan describes, and only that. Stay inside the approved scope.',
    review: 'Read the change as a skeptical reviewer. List problems and risks. Change nothing.',
    test: 'Run the project\'s tests. AgentOnTrack runs the check itself and records the result.',
    verify: 'Check each acceptance criterion against the current code. AgentOnTrack records the result.',
    release: 'Prepare what a release needs. Do not publish or deploy: that needs your own approval.',
    custom: '',
  };

  for (const k of kinds) {
    const prev = phases.at(-1);
    const id = rid(k);
    idOf.set(k, id);
    const needsChecks = k === 'test' || k === 'verify';
    const acceptance: Phase['acceptance'] = [];
    if (k === 'test') {
      if (facts.testCommand) acceptance.push({ id: 'tests', description: `${facts.testCommand} passes (found in ${facts.testCommandSource})`, kind: 'command', command: facts.testCommand });
      else acceptance.push({ id: 'tests', description: 'The tests pass. No test command was found, so AgentOnTrack cannot run this check itself. Add one to make it count.', kind: 'manual' });
    }
    if (k === 'verify') acceptance.push({ id: 'goal', description: `The goal is met: ${goal.slice(0, 200)}`, kind: 'manual' });
    if (k === 'implement') acceptance.push({ id: 'in-scope', description: 'Changes stay inside the approved scope of the goal', kind: 'manual' });
    if (k === 'review') acceptance.push({ id: 'findings', description: 'Problems and risks are listed, each with where it is', kind: 'manual' });
    const risks = k === 'implement' || k === 'release' ? RISK_WORDS.filter(([re]) => re.test(goal)).map(([, t]) => t) : [];
    if (needsChecks && !facts.testCommand && k === 'test') risks.push('No test command was found, so nothing can show that this phase passed.');
    if (k === 'release') risks.unshift('A release leaves your machine. AgentOnTrack never does this on its own.');
    const effort = k === 'implement' && facts.meanSecondsPerTask !== null && facts.tasksInHistory >= 3
      ? { minutes: Math.max(1, Math.round(facts.meanSecondsPerTask / 60)), basis: `The average of ${facts.tasksInHistory} earlier tasks in this project. A guide, not a promise.` } : undefined;
    const pick = opts.agents?.[roleOf[k]];
    phases.push(PhaseSchema.parse({
      id, title: k === 'understand' && unrecognized ? `${titleOf[k]} (the goal named no action, so this starts with reading)` : titleOf[k], kind: k, role: roleOf[k], instructions: how[k],
      dependsOn: prev ? [prev.id] : [], ...(pick ? { agent: pick.agent, ...(pick.model ? { model: pick.model } : {}) } : {}),
      acceptance, risks, ...(effort ? { effort } : {}),
      budget: k === 'implement' ? { maxUsd: 2, maxRuns: 3 } : k === 'release' ? { maxRuns: 1 } : { maxUsd: 1, maxRuns: 2 },
    }));
  }
  return PhasePlanSchema.parse({ id: opts.id ?? 'plan-1', goal, mode: 'manual', limits: { maxUsd: 5, maxMinutes: 120, maxRuns: 10 }, defaults: {}, phases });
}

/* ---------- Status, read from evidence ---------- */

export interface RunFact { id: string; phaseId: string; status: string; costUsd: number | null; wallClockMs: number | null }
export interface TaskFact { status: string; criteriaStates: string[] }
export type PhaseStatus = 'draft' | 'ready' | 'running' | 'paused' | 'skipped' | 'blocked' | 'needs-evidence' | 'done-unchecked' | 'verified' | 'stale' | 'failed';

export interface PhaseView { id: string; status: PhaseStatus; why: string; runs: number; spentUsd: number }

/**
 * A phase counts as verified only when the engine's own evaluation of its task says VERIFIED. An agent's finished run moves it to
 * "needs evidence", or, with no command to run, to "done, not independently checked". Never to verified.
 */
export function phaseViews(plan: PhasePlan, approved: boolean, runs: RunFact[], tasks: Map<string, TaskFact>): PhaseView[] {
  const views = new Map<string, PhaseView>();
  const settled = (id: string) => ['verified', 'done-unchecked'].includes(views.get(id)?.status ?? '');
  for (const id of orderOf(plan)) {
    const p = plan.phases.find((x) => x.id === id)!;
    const mine = runs.filter((r) => r.phaseId === id);
    const spentUsd = mine.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const view = (status: PhaseStatus, why: string): PhaseView => ({ id, status, why, runs: mine.length, spentUsd });
    const checks = p.acceptance.some((a) => a.kind === 'command');
    const t = checks && p.taskId ? tasks.get(p.taskId) : undefined;
    let v: PhaseView;
    if (p.state === 'skipped') v = view('skipped', 'You skipped this phase.');
    else if (p.state === 'paused') v = view('paused', 'Paused by you. Nothing new starts here until you resume it.');
    else if (mine.some((r) => r.status === 'running')) v = view('running', 'An agent is working on it now.');
    else if (t?.status === 'VERIFIED') v = view('verified', 'Every check passes on the current code, recorded as a receipt.');
    else if (t?.status === 'FAILED') v = view('failed', 'A check ran and failed.');
    else if (t && t.criteriaStates.includes('stale') && mine.length) v = view('stale', 'The code or the goal changed since the checks last passed, so they no longer count.');
    else if (mine.some((r) => ['finished', 'stopped', 'failed'].includes(r.status)) && checks) v = view('needs-evidence', 'The agent finished. Run the checks to see whether it worked.');
    else if (mine.some((r) => r.status === 'finished') && !checks) v = view('done-unchecked', 'The agent finished. There is no check to run, so this is the agent\'s word only.');
    else if (!approved) v = view('draft', 'Waiting for you to approve the plan.');
    else if (!p.dependsOn.every(settled)) v = view('blocked', `Waiting for ${p.dependsOn.filter((d) => !settled(d)).join(', ')}.`);
    else v = view('ready', 'Ready to start.');
    views.set(id, v);
  }
  return plan.phases.map((p) => views.get(p.id)!);
}

/** Why a phase may not start, or null when it may. The server asks this before it starts anything. */
export function startBlock(plan: PhasePlan, phaseId: string, approvedSha: string | null, views: PhaseView[], runs: RunFact[], now = Date.now(), startedAt: number | null = null): string | null {
  const p = plan.phases.find((x) => x.id === phaseId);
  const v = views.find((x) => x.id === phaseId);
  if (!p || !v) return 'No such phase.';
  if (!approvedSha || approvedSha !== planSha(plan)) return 'The plan has changed since you approved it, or was never approved. Review it and approve it again.';
  if (['paused', 'skipped'].includes(p.state)) return `This phase is ${p.state}.`;
  if (v.status === 'running') return 'It is already running.';
  if (v.status === 'blocked') return v.why;
  if (v.status === 'verified') return 'It is already verified. Run it again only if the goal or the code changed.';
  if (p.budget.maxRuns !== undefined && v.runs >= p.budget.maxRuns) return `This phase has used its ${p.budget.maxRuns} runs.`;
  if (p.budget.maxUsd !== undefined && v.spentUsd >= p.budget.maxUsd) return `This phase has used its $${p.budget.maxUsd} budget.`;
  const all = runs.filter((r) => plan.phases.some((x) => x.id === r.phaseId));
  if (all.length >= plan.limits.maxRuns) return `The plan has used its ${plan.limits.maxRuns} runs.`;
  if (all.reduce((s, r) => s + (r.costUsd ?? 0), 0) >= plan.limits.maxUsd) return `The plan has used its $${plan.limits.maxUsd} budget.`;
  if (startedAt !== null && now - startedAt >= plan.limits.maxMinutes * 60_000) return `The plan has used its ${plan.limits.maxMinutes} minutes.`;
  return null;
}

/** The prompt for one phase, built from the approved plan so a page cannot swap in other instructions. */
export function phasePrompt(plan: PhasePlan, phase: Phase, extra = ''): string {
  const lines = [
    `Goal: ${plan.goal}`,
    `You are working on one phase of an approved plan: "${phase.title}" (${phase.kind}).`,
    phase.instructions ? `What to do: ${phase.instructions}` : '',
    phase.acceptance.length ? `This phase is checked against:\n${phase.acceptance.map((a) => `- ${a.description}${a.kind === 'command' ? ` (AgentOnTrack will run: ${a.command})` : ''}`).join('\n')}` : '',
    phase.risks.length ? `Known risks:\n${phase.risks.map((r) => `- ${r}`).join('\n')}` : '',
    'Stay inside the approved scope. Do not publish, deploy or push unless it is requested here and approved. Do not claim the work is verified: AgentOnTrack runs the checks itself and records the result.',
    extra.trim() ? `Extra from the person: ${extra.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n\n');
}
