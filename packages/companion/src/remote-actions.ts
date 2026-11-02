import { z } from 'zod/v4';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acceptHandoff2, approvalView, buildHandoff, computeAnalytics, listHandoffs, loadHandoff, PhasePlanSchema, saveHandoff, suggestNext, type AgentFact, validateHandoff, type Project, type Registered } from '@agentontrack/core';
import { planView } from './plan-view.js';
import { Refusal, type Executor } from './remote-host.js';

/**
 * What a phone may do, and the limits on each. Every action is checked against the project, the plan, the goal and the approvals as they
 * are now, by this computer, whatever the phone believes. Nothing here can write a file, run a command, create a project, change the goal,
 * the policy or the team, or approve the plan: those stay on the desktop.
 */
export interface ExecDeps {
  registry(): Registered[];
  projectFor(id: string): { entry: Registered; p: Project };
  isRunning(runId: string): boolean;
  stopRun(projectId: string, runId: string): boolean;
  recentRuns(projectId: string): { id: string; status: string; started: number; events: string[] }[];
  startPhase(entry: Registered, p: Project, phaseId: string, extra: string, source: string): { id: string; status: string };
  startPrompt(entry: Registered, p: Project, o: { prompt: string; model: string; maxUsd: number; agent: string }, source: string): { id: string; status: string };
  continuePlan(entry: Registered, p: Project, maxPhases: number, source: string): { started: boolean; note: string };
  cancelContinue(projectId: string): boolean;
  models(): Promise<unknown>;
  agents(root?: string): Promise<any[]>;
  maxUsdPerRun(): number;
  version: string;
}

/** Effects a person can undo with git or a restore, so a phone may approve them. Everything else waits for the desktop. */
export const PHONE_MAY_APPROVE = new Set(['fs.write']);
const MARKDOWN = /\.(md|mdx|markdown|txt)$/i;
const MAX_FILE = 100_000;
const MAX_DIFF = 60_000;

const Project_ = z.object({ project: z.string().min(1).max(80) });
const Schemas = {
  ping: z.object({}).strict(),
  'projects.list': z.object({}).strict(),
  'project.snapshot': Project_.strict(),
  'files.list': Project_.strict(),
  'handoffs.list': Project_.strict(),
  'file.read': Project_.extend({ path: z.string().min(1).max(500) }).strict(),
  'diff.read': Project_.extend({ worktree: z.string().min(1).max(80), path: z.string().min(1).max(500) }).strict(),
  'models.list': z.object({}).strict(),
  'agents.list': z.object({ project: z.string().max(80).optional() }).strict(),
  'run.start': Project_.extend({ prompt: z.string().min(1).max(4000).regex(/^[^-]/, 'A prompt cannot start with a hyphen'), agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/).default('claude-code'), model: z.string().regex(/^[\w][\w.:/@+-]{0,99}$/).default('haiku'), phaseId: z.string().max(40).optional(), extra: z.string().max(2000).default('') }).strict(),
  'run.stop': Project_.extend({ runId: z.string().regex(/^run_\w+$/) }).strict(),
  'plan.state': Project_.extend({ phaseId: z.string().max(40), state: z.enum(['draft', 'paused', 'skipped']) }).strict(),
  'plan.continue': Project_.extend({ maxPhases: z.number().int().min(1).max(3).default(1), stop: z.boolean().default(false) }).strict(),
  'plan.verify': Project_.extend({ phaseId: z.string().max(40) }).strict(),
  'handoff.create': Project_.extend({ from: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/), to: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/).optional(), taskId: z.string().max(80).optional(), reason: z.enum(['planned', 'unavailable', 'limit', 'interrupted', 'review']).default('planned') }).strict(),
  'handoff.accept': Project_.extend({ id: z.string().min(1).max(80), to: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/) }).strict(),
  'approval.decide': Project_.extend({ id: z.string().min(1).max(80), decision: z.enum(['approve', 'deny']), note: z.string().max(300).default('') }).strict(),
} as const;
type ActionName = keyof typeof Schemas;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut: ${s.length - n} more characters)` : s);

export function snapshotOf(entry: Registered, p: Project, deps: Pick<ExecDeps, 'isRunning' | 'recentRuns'>, agents: AgentFact[] = []) {
  const s = p.state();
  const view: any = planView(entry, p, deps.isRunning);
  const a = computeAnalytics(p);
  const pending = [...s.approvals.values()].filter((x) => approvalView(x, new Date()) === 'pending');
  return {
    generatedAt: new Date().toISOString(),
    project: { id: entry.id, name: entry.name },
    goal: s.goal ? { statement: s.goal.statement, version: s.goal.version, status: s.goal.status } : null,
    activeTask: s.activeTaskId ? { id: s.activeTaskId, title: s.tasks.get(s.activeTaskId)?.title ?? '' } : null,
    plan: view.plan ? {
      goal: view.plan.goal, mode: view.plan.mode, approved: view.approved, version: view.version, limits: view.plan.limits, spent: view.spent,
      phases: view.plan.phases.map((ph: any) => { const v = view.views.find((x: any) => x.id === ph.id); return { id: ph.id, title: ph.title, kind: ph.kind, agent: ph.agent ?? view.plan.defaults[ph.role]?.agent ?? null, model: ph.model ?? null, state: ph.state, status: v?.status, why: v?.why, runs: v?.runs ?? 0, checks: ph.acceptance.filter((x: any) => x.kind === 'command').length }; }),
    } : null,
    runs: deps.recentRuns(entry.id).slice(-4).map((r) => ({ id: r.id, status: r.status, started: r.started, tail: r.events.slice(-12).map((e) => clip(e, 300)) })),
    approvals: pending.map((x) => ({ id: x.id, kind: x.effect.kind, target: clip(String(x.effect.target), 200), reason: clip(String(x.reason), 200), runtime: x.runtime, fromPhone: PHONE_MAY_APPROVE.has(x.effect.kind) })),
    receipts: s.receipts.slice(-8).map((r) => ({ seq: r.seq, ts: r.ts, criterion: r.criterionId, passed: r.passed, source: r.source, observed: clip(String(r.observed ?? ''), 160) })),
    usage: { sessions: a.totals.sessions, input: a.totals.input, output: a.totals.output, costUsd: a.totals.costUsd, providerReported: a.totals.providerReported, tasks: a.tasks.length, verified: a.taskTotals.VERIFIED ?? 0, runWallClockMs: a.time.runWallClockMs },
    integrity: { ok: p.verifyIntegrity().ok },
    suggestions: suggestNext({ goal: s.goal?.statement ?? null, plan: view.plan ?? null, approved: !!view.approved, views: view.views ?? [], pendingApprovals: pending.length, agents }).map(({ id, kind, title, prompt, why, agent, startable, needsApproval, scope, phaseId }) => ({ id, kind, title, prompt: clip(prompt, 1500), why, agent, startable, needsApproval, scope, phaseId })),
  };
}

/** Markdown and text files, to a few levels down, skipping hidden folders and dependency folders, and never following a link out. */
export function listReadable(root: string, isProtected: (rel: string) => boolean): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (out.length >= 150) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 3) walk(join(dir, e.name), r, depth + 1); }
      else if (MARKDOWN.test(e.name) && !isProtected(r)) { try { out.push({ path: r, size: statSync(join(dir, e.name)).size }); } catch { /* vanished */ } }
    }
  };
  walk(root, '', 0);
  return out;
}

export function makeExecutor(deps: ExecDeps): Executor {
  return async (action, raw, ctx) => {
    const schema = Schemas[action as ActionName];
    if (!schema) throw new Refusal('unknown-action', 'A phone cannot ask for that.');
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw new Refusal('bad-request', `That request is not valid: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'request'} ${i.message}`).join('; ')}`);
    const a = parsed.data as any;
    const source = `phone:${ctx.device.fingerprint}`;
    const where = () => {
      if (!deps.registry().some((r) => r.id === a.project)) throw new Refusal('no-project', 'That project is not registered on this computer.');
      const got = deps.projectFor(a.project);
      return got;
    };
    switch (action as ActionName) {
      case 'ping': return { now: Date.now(), version: deps.version };
      case 'projects.list': return deps.registry().map((r) => {
        // Names and status only: never the folder's path.
        if (!deps.registry().length) return null;
        try { const { p } = deps.projectFor(r.id); const s = p.state(); const t = s.activeTaskId ? s.tasks.get(s.activeTaskId) : null; return { id: r.id, name: r.name, archived: !!r.archived, goal: s.goal?.statement ?? null, activeTask: t ? { title: t.title, status: p.evaluate(t.id).status } : null, pendingApprovals: [...s.approvals.values()].filter((x) => approvalView(x, new Date()) === 'pending').length }; }
        catch { return { id: r.id, name: r.name, archived: !!r.archived, goal: null, activeTask: null, pendingApprovals: 0, missing: true }; }
      });
      case 'project.snapshot': { const { entry, p } = where(); return snapshotOf(entry, p, deps, (await deps.agents(entry.root)).map((x: any) => ({ id: x.id, name: x.name, canStart: x.canStart }))); }
      case 'files.list': { const { entry, p } = where(); return { files: listReadable(entry.root, (r) => p.isProtectedPath(r)) }; }
      case 'handoffs.list': { const { p } = where(); return { handoffs: listHandoffs(p).slice(-20).reverse() }; }
      case 'file.read': {
        const { p } = where();
        if (!MARKDOWN.test(a.path)) throw new Refusal('not-markdown', 'A phone reads Markdown and plain text only.');
        if (p.isProtectedPath(String(a.path).replaceAll('\\', '/').replace(/^\.\//, ''))) throw new Refusal('protected', 'That file is protected and is not shown on a phone.');
        const f = p.readWorkspaceFile(a.path);
        return { path: f.path, size: f.size, hash: f.hash, content: clip(f.content, MAX_FILE), truncated: f.content.length > MAX_FILE };
      }
      case 'diff.read': {
        const { p } = where();
        const d = p.worktreeFileDiff(a.worktree, a.path);
        return { path: d.path, before: d.before === null ? null : clip(d.before, MAX_DIFF), after: d.after === null ? null : clip(d.after, MAX_DIFF) };
      }
      case 'models.list': return deps.models();
      case 'agents.list': return { agents: await deps.agents(a.project ? where().entry.root : undefined) };
      case 'run.start': {
        const { entry, p } = where();
        if (a.phaseId) return deps.startPhase(entry, p, a.phaseId, a.extra, source);
        // A free prompt is capped by what the person allowed on the desktop, and an agent that cannot be started here is not pretended.
        return deps.startPrompt(entry, p, { prompt: a.prompt, model: a.model, maxUsd: Math.min(deps.maxUsdPerRun(), 5), agent: a.agent }, source);
      }
      case 'run.stop': { where(); if (!deps.stopRun(a.project, a.runId)) throw new Refusal('no-run', 'That run is not running on this computer.'); return { stopped: true }; }
      case 'plan.state': {
        const { p } = where();
        const cur = p.state().plan;
        if (!cur) throw new Refusal('no-plan', 'There is no plan.');
        const doc = PhasePlanSchema.parse(structuredClone(cur.doc));
        const ph = doc.phases.find((x) => x.id === a.phaseId);
        if (!ph) throw new Refusal('no-phase', 'No such phase.');
        ph.state = a.state;
        p.savePlan(doc, cur.version);
        return { phaseId: a.phaseId, state: a.state };
      }
      case 'plan.continue': {
        const { entry, p } = where();
        if (a.stop) return { stopped: deps.cancelContinue(entry.id) };
        return deps.continuePlan(entry, p, a.maxPhases, source);
      }
      case 'plan.verify': {
        const { entry, p } = where();
        const v: any = planView(entry, p, deps.isRunning);
        const phase = v.plan?.phases.find((x: any) => x.id === a.phaseId);
        if (!phase || !phase.taskId || !phase.acceptance.some((x: any) => x.kind === 'command') || !v.approved) throw new Refusal('no-checks', 'This phase has no check to run, or the plan changed since it was approved.');
        p.verifyTask(phase.taskId);
        return { verified: true };
      }
      case 'handoff.create': {
        const { p } = where();
        const h = buildHandoff(p, { from: a.from, ...(a.to ? { to: a.to } : {}), ...(a.taskId ? { taskId: a.taskId } : {}), reason: { kind: a.reason } });
        saveHandoff(p, h, {});
        return { id: h.id, problems: validateHandoff(p, h).length };
      }
      case 'handoff.accept': {
        const { p } = where();
        // Approvals are never carried by a handoff, so accepting one from a phone grants nothing.
        const r = acceptHandoff2(p, loadHandoff(p, a.id), a.to);
        return { accepted: r.accepted, problems: r.problems.map((x: any) => x.message ?? String(x)), reusable: r.reusable };
      }
      case 'approval.decide': {
        const { p } = where();
        const ap = p.state().approvals.get(a.id);
        if (!ap || approvalView(ap, new Date()) !== 'pending') throw new Refusal('not-pending', 'That request is no longer waiting.');
        const method = `remote-device:${ctx.device.fingerprint}`;
        if (a.decision === 'deny') { p.human.deny(a.id, a.note, { method }); return { decision: 'denied' }; }
        if (!PHONE_MAY_APPROVE.has(ap.effect.kind)) throw new Refusal('needs-desktop', `Approving "${ap.effect.kind}" needs you at your computer. It stays waiting there.`);
        try { p.human.approve(a.id, { uses: 1, ttlMs: 10 * 60_000, portable: false, ctx: { method } }); } catch (e) {
          throw new Refusal('needs-desktop', /approver|passphrase/i.test((e as Error).message) ? 'This project asks for the approver passphrase, which only your computer can take.' : (e as Error).message);
        }
        return { decision: 'approved', expiresInMinutes: 10, uses: 1 };
      }
    }
  };
}
