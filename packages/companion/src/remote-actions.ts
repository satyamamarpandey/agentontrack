import { z } from 'zod/v4';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256, acceptHandoff2, approvalView, buildHandoff, computeAnalytics, listHandoffs, loadHandoff, PhasePlanSchema, saveHandoff, suggestNext, type AgentFact, validateHandoff, type Project, type Registered } from '@agentontrack/core';
import { planView } from './plan-view.js';
import { Refusal, type Executor } from './remote-host.js';
import { IdempotencyUnavailable, type IdemBegin, type IdemPeek } from './idempotency.js';

/**
 * What a phone may do, and the limits on each. Every action is checked against the project, the plan, the goal and the approvals as they
 * are now, by this computer, whatever the phone believes. Nothing here can write a file, run a command, create a project, change the goal,
 * the policy or the team, or approve the plan: those stay on the desktop.
 */
export interface ExecDeps {
  registry(): Registered[];
  projectFor(id: string): { entry: Registered; p: Project };
  isRunning(runId: string): boolean;
  stopRun(projectId: string, runId: string): boolean | Promise<boolean>;
  recentRuns(projectId: string): { id: string; status: string; started: number; events: string[] }[];
  startPhase(entry: Registered, p: Project, phaseId: string, extra: string, source: string): { id: string; status: string };
  startPrompt(entry: Registered, p: Project, o: { prompt: string; model: string; maxUsd: number; agent: string }, source: string): { id: string; status: string };
  loopPhase(entry: Registered, p: Project, phaseId: string, rounds: number, source: string): { started: boolean; note: string };
  continuePlan(entry: Registered, p: Project, maxPhases: number, source: string): { started: boolean; note: string };
  cancelContinue(projectId: string): boolean;
  /** Whether the owner holds a valid unattended grant for this project (the companion checks it again, plus the sign-in kind, when it runs a sequence). Absent means no. */
  allowUnattended?(projectId: string): boolean;
  /** Whether the owner has allowed a phone to START agents, at the computer. Absent means off. */
  allowMobileExecution?(): boolean;
  models(): Promise<unknown>;
  agents(root?: string): Promise<any[]>;
  maxUsdPerRun(): number;
  version: string;
  /** The project the owner chose on this computer for phone sessions, or null. */
  defaultProject?(): { projectId: string; realRoot: string } | null;
  /** Whether the project's folder is still, by real path, the folder that was chosen. A moved or swapped folder is not. */
  defaultStillValid?(entry: Registered, realRoot: string): boolean;
  /** How many runs are going on this computer now, so a phone cannot pile them up. */
  runningCount?(): number;
  /** Starts a genuinely new agent session. It throws a Refusal before any process exists, and never after. */
  startSession?(entry: Registered, p: Project, o: { agent: string; model: string; prompt: string; maxUsd: number; policy: 'standard' | 'read-only' }, source: string): { runId: string; sessionId: string; status: string };
  sessionDetail?(p: Project, sessionId: string): { id: string; status: string; title: string; runtime: string; canResume: boolean; linked: boolean; runs: { id: string; status: string | null; events: string[] }[] } | null;
  idem?: { begin(did: string, key: string, sha: string): IdemBegin; finish(did: string, key: string, result: unknown): void; abandon(did: string, key: string, code?: string): void; peek?(did: string, key: string): IdemPeek | null };
}

/** Whether a project's folder is still, by REAL path (links resolved), the folder that was chosen. A folder that moved, was deleted, or was swapped for a link elsewhere is not. */
export const stillTheSameFolder = (root: string, realRoot: string): boolean => { try { return realpathSync.native(root) === realRoot; } catch { return false; } };

/** Most runs a computer will have going when a phone asks for one more. */
export const MAX_RUNNING_FOR_PHONE_START = 3;
const PROJECT_ID = z.union([z.literal('default'), z.string().regex(/^[a-f0-9]{24}$/, 'That is not a project id')]);

/** Effects a person can undo with git or a restore, so a phone may approve them. Everything else waits for the desktop. */
export const PHONE_MAY_APPROVE = new Set(['fs.write']);
const MOBILE_EXECUTION_OFF = 'Starting agents from a phone is off on this computer. Turn it on at the computer, in Settings under Phone link, or start the run there. Viewing, stopping and approving from the phone still work.';
const UNATTENDED_OFF_PHONE = 'Unattended runs are off on this computer, so more than one phase or round in a row is refused. Turn them on at the computer, in Settings under Unattended runs, or run one phase at a time.';

/** A write held because of WHERE it is (a protected file such as the agent's hook settings or a .env, or a place outside the project) is not undoable with git and can switch the gate off, so it waits for the desktop even though it is an fs.write. */
export const NEEDS_DESKTOP_REASON = /^(protected path|path outside the project root):/;
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
  // A NEW agent session. No path, no argument list, no environment: a project id (or the owner's default), an agent, a model, a fixed policy, a prompt, and a key that makes a retry safe.
  'session.new': z.object({
    v: z.literal(1),
    idemKey: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    project: PROJECT_ID,
    agent: z.enum(['claude-code', 'codex']),
    model: z.string().regex(/^\w[\w.:-]{0,79}$/).default('haiku'),
    policy: z.enum(['standard', 'read-only']).default('standard'),
    prompt: z.string().min(1).max(4000).regex(/^[^-]/, 'A prompt cannot start with a hyphen').refine((s) => !s.includes('\0'), 'A prompt cannot contain a NUL character'),
    maxUsd: z.number().positive().max(5).optional(),
  }).strict(),
  // Asks what became of a session.new, by its key. Nothing else: the key is the whole question, and it is only answered for the phone that made it.
  'session.status': z.object({ v: z.literal(1), idemKey: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/) }).strict(),
  'session.get': Project_.extend({ sessionId: z.string().regex(/^ses_[a-f0-9]{8,32}$/) }).strict(),
  'run.stop': Project_.extend({ runId: z.string().regex(/^run_\w+$/) }).strict(),
  'plan.state': Project_.extend({ phaseId: z.string().max(40), state: z.enum(['draft', 'paused', 'skipped']) }).strict(),
  'plan.continue': Project_.extend({ maxPhases: z.number().int().min(1).max(3).default(1), stop: z.boolean().default(false) }).strict(),
  'plan.loop': Project_.extend({ phaseId: z.string().max(40), rounds: z.number().int().min(1).max(5).default(3) }).strict(),
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
    approvals: pending.map((x) => ({ id: x.id, kind: x.effect.kind, target: clip(String(x.effect.target), 200), reason: clip(String(x.reason), 200), runtime: x.runtime, fromPhone: PHONE_MAY_APPROVE.has(x.effect.kind) && !NEEDS_DESKTOP_REASON.test(String(x.reason)) })),
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
    // Every action that can start an agent (directly, or by continuing or looping a plan) is refused unless the owner allowed it at the computer. This is checked before anything else happens, including an idempotency record.
    const STARTS_AGENT = new Set<string>(['run.start', 'session.new', 'plan.loop']);
    if (STARTS_AGENT.has(action) || (action === 'plan.continue' && !a.stop)) {
      if (!(deps.allowMobileExecution?.() ?? false)) throw new Refusal('mobile-execution-off', MOBILE_EXECUTION_OFF);
    }
    switch (action as ActionName) {
      case 'ping': return { now: Date.now(), version: deps.version, ops: deps.startSession && deps.idem ? ['session.new@1', 'session.get@1', 'session.status@1'] : [] };
      case 'projects.list': return deps.registry().map((r) => {
        // Names and status only: never the folder's path.
        if (!deps.registry().length) return null;
        try { const { p } = deps.projectFor(r.id); const s = p.state(); const t = s.activeTaskId ? s.tasks.get(s.activeTaskId) : null; return { id: r.id, name: r.name, archived: !!r.archived, isDefault: deps.defaultProject?.()?.projectId === r.id, goal: s.goal?.statement ?? null, activeTask: t ? { title: t.title, status: p.evaluate(t.id).status } : null, pendingApprovals: [...s.approvals.values()].filter((x) => approvalView(x, new Date()) === 'pending').length }; }
        catch { return { id: r.id, name: r.name, archived: !!r.archived, isDefault: deps.defaultProject?.()?.projectId === r.id, goal: null, activeTask: null, pendingApprovals: 0, missing: true }; }
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
        if ((deps.runningCount?.() ?? 0) >= MAX_RUNNING_FOR_PHONE_START) throw new Refusal('busy', 'Several runs are already going on this computer. Wait for one to finish, then try again.');
        if (a.phaseId) return deps.startPhase(entry, p, a.phaseId, a.extra, source);
        // A free prompt is capped by what the person allowed on the desktop, and an agent that cannot be started here is not pretended.
        return deps.startPrompt(entry, p, { prompt: a.prompt, model: a.model, maxUsd: Math.min(deps.maxUsdPerRun(), 5), agent: a.agent }, source);
      }
      case 'session.get': {
        const { p } = where();
        const d = deps.sessionDetail?.(p, a.sessionId) ?? null;
        if (!d) throw new Refusal('no-session', 'That session is not in this project.');
        // A tail only, clipped: a phone reads progress, not a transcript.
        return { ...d, runs: d.runs.map((r) => ({ id: r.id, status: r.status, events: r.events.slice(-12).map((e) => clip(e, 300)) })) };
      }
      case 'session.status': {
        if (!deps.idem?.peek) throw new Refusal('unavailable', 'This computer cannot report on sessions started from a phone.');
        let seen: IdemPeek | null;
        // Scoped to the asking device: the store is keyed by device, so another phone's key reads as never seen.
        try { seen = deps.idem.peek(ctx.did, a.idemKey); } catch (e) { if (e instanceof IdempotencyUnavailable) throw new Refusal('unavailable', e.message); throw e; }
        if (!seen) return { v: 1, state: 'unknown-request', note: 'This computer has no record of that request. Nothing was started by it.' };
        if (seen.state === 'refused') return { v: 1, state: 'refused-before-start', code: seen.code, note: 'The computer refused it before anything started.' };
        // A session is reported started only when the event log of its project really has it: the store alone (or a restart) is never enough.
        const confirm = (projectId: string, sessionId: string, runId: string | undefined) => {
          try {
            const got = deps.projectFor(projectId);
            if (!deps.sessionDetail?.(got.p, sessionId)) return null;
            return { v: 1, state: 'started' as const, sessionId, project: { id: got.entry.id, name: got.entry.name }, ...(runId ? { runId } : {}) };
          } catch { return null; }
        };
        if (seen.state === 'done') {
          const r = seen.result as { sessionId?: string; runId?: string; project?: { id?: string } } | null;
          const ok = r?.sessionId && r.project?.id ? confirm(r.project.id, r.sessionId, r.runId) : null;
          if (ok) return ok;
        } else {
          // Begun, no recorded result (a crash or a failed write). The project's own log may still show it was requested and started by this phone.
          for (const reg of deps.registry()) {
            try {
              const { p } = deps.projectFor(reg.id);
              for (const ev of p.store.byType(['remote.session.requested'])) {
                const pl = ev.payload as { idemKey?: string; fingerprint?: string; outcome?: string; sessionId?: string; runId?: string };
                if (pl.idemKey !== a.idemKey || pl.fingerprint !== ctx.device.fingerprint || pl.outcome !== 'started' || !pl.sessionId) continue;
                const ok = confirm(reg.id, pl.sessionId, pl.runId);
                if (ok) return ok;
              }
            } catch { /* a project that cannot be opened proves nothing */ }
          }
        }
        return { v: 1, state: 'starting-indeterminate', note: 'The computer began this request but has no durable proof that a session started. It may or may not have. Asking again will not start anything.' };
      }
      case 'session.new': {
        if (!deps.startSession || !deps.idem) throw new Refusal('unavailable', 'This computer cannot start sessions from a phone.');
        const sha = sha256(canonical({ v: a.v, project: a.project, agent: a.agent, model: a.model, policy: a.policy, prompt: a.prompt, maxUsd: a.maxUsd ?? null }));
        let begun: IdemBegin;
        try { begun = deps.idem.begin(ctx.did, a.idemKey, sha); } catch (e) { if (e instanceof IdempotencyUnavailable) throw new Refusal('unavailable', e.message); throw e; }
        if (begun.kind === 'mismatch') throw new Refusal('idem-mismatch', 'That request key was already used for a different request. Nothing was started.');
        if (begun.kind === 'in-doubt') throw new Refusal('in-doubt', 'An earlier attempt may have started a session on this computer. Check Recent sessions before trying again. Nothing new was started.');
        if (begun.kind === 'done') {
          const prior = begun.result as { project?: { id: string } };
          try { if (prior?.project?.id) { const got = deps.projectFor(prior.project.id); got.p.store.append({ type: 'remote.session.requested', actor: { kind: 'system', runtime: 'agentontrack' }, payload: { fingerprint: ctx.device.fingerprint, idemKey: a.idemKey, outcome: 'deduped', projectId: prior.project.id } }); } } catch { /* the audit note is best effort for a repeat; the original was recorded */ }
          return { ...(begun.result as object), deduped: true };
        }
        // A new request. Anything refused from here on happens before a process exists, so the key is released and the same request may be tried again.
        let entry: Registered; let p: Project; let usedDefault = false;
        try {
          const dflt = deps.defaultProject?.() ?? null;
          usedDefault = a.project === 'default';
          if (usedDefault && !dflt) throw new Refusal('no-default-project', 'This computer has no default project for phone sessions. Pick a project from the list, or choose a default on the computer.');
          const projectId = usedDefault ? dflt!.projectId : a.project;
          if (!deps.registry().some((r) => r.id === projectId)) throw new Refusal(usedDefault ? 'default-unavailable' : 'no-project', usedDefault ? 'The default project is no longer registered on this computer. Pick a project from the list.' : 'That project is not registered on this computer.');
          try { ({ entry, p } = deps.projectFor(projectId)); } catch { throw new Refusal(usedDefault ? 'default-unavailable' : 'no-project', usedDefault ? 'The default project\'s folder could not be opened. Pick a project from the list.' : 'That project\'s folder could not be opened on this computer.'); }
          if (entry.archived) throw new Refusal('project-archived', 'That project is archived on this computer.');
          if (usedDefault && !(deps.defaultStillValid?.(entry, dflt!.realRoot) ?? false)) throw new Refusal('default-unavailable', 'The default project\'s folder has moved or changed since it was chosen. Choose it again on the computer, or pick a project from the list.');
          const ag = (await deps.agents(entry.root)).find((x: any) => x.id === a.agent);
          if (!ag?.canStart) throw new Refusal('agent-unavailable', `${a.agent} cannot be started in this project${ag?.reason ? `: ${String(ag.reason).slice(0, 200)}` : ''}.`);
          if ((deps.runningCount?.() ?? 0) >= MAX_RUNNING_FOR_PHONE_START) throw new Refusal('busy', 'Several runs are already going on this computer. Wait for one to finish, then try again.');
        } catch (e) {
          if (e instanceof Refusal) { try { deps.idem.abandon(ctx.did, a.idemKey, (e as Refusal).code); } catch { /* the key stays; a retry is then reported in doubt, which is safe */ } }
          throw e;
        }
        // The folder was checked before the awaits above; check it once more right before anything is spawned, so a swap in between is refused.
        if (usedDefault) {
          const again = deps.defaultProject?.() ?? null;
          if (!again || again.projectId !== entry.id || !(deps.defaultStillValid?.(entry, again.realRoot) ?? false)) {
            try { deps.idem.abandon(ctx.did, a.idemKey, 'default-unavailable'); } catch { /* as above */ }
            throw new Refusal('default-unavailable', 'The default project\'s folder changed while the request was being checked. Nothing was started.');
          }
        }
        const maxUsd = Math.min(a.maxUsd ?? deps.maxUsdPerRun(), deps.maxUsdPerRun(), 5);
        let started: { runId: string; sessionId: string; status: string };
        try { started = deps.startSession(entry, p, { agent: a.agent, model: a.model, prompt: a.prompt, maxUsd, policy: a.policy }, source); }
        catch (e) {
          // startSession refuses before any process exists. Anything else is unknown, so the key stays and a retry is reported "in doubt", never run twice.
          if (e instanceof Refusal) { try { deps.idem.abandon(ctx.did, a.idemKey, (e as Refusal).code); } catch { /* as above */ } }
          throw e;
        }
        const result = { runId: started.runId, sessionId: started.sessionId, status: started.status, project: { id: entry.id, name: entry.name }, agent: a.agent, model: a.model, policy: a.policy, usedDefault, acceptedAt: new Date().toISOString() };
        try { deps.idem.finish(ctx.did, a.idemKey, result); } catch { /* the run exists; the key stays "starting", so a retry is reported in doubt rather than started again */ }
        try { p.store.append({ type: 'remote.session.requested', actor: { kind: 'system', runtime: 'agentontrack' }, payload: { fingerprint: ctx.device.fingerprint, idemKey: a.idemKey, outcome: 'started', projectId: entry.id, usedDefault, agent: a.agent, model: a.model, policy: a.policy, runId: started.runId, sessionId: started.sessionId } }); } catch { /* the run record itself carries source phone:fingerprint */ }
        return { ...result, deduped: false };
      }
      case 'run.stop': { where(); if (!(await deps.stopRun(a.project, a.runId))) throw new Refusal('no-run', 'That run is not running on this computer.'); return { stopped: true }; }
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
        if (a.maxPhases > 1 && !(deps.allowUnattended?.(entry.id) ?? false)) throw new Refusal('unattended-off', UNATTENDED_OFF_PHONE);
        return deps.continuePlan(entry, p, a.maxPhases, source);
      }
      case 'plan.loop': { const { entry, p } = where(); if (a.rounds > 1 && !(deps.allowUnattended?.(entry.id) ?? false)) throw new Refusal('unattended-off', UNATTENDED_OFF_PHONE); return deps.loopPhase(entry, p, a.phaseId, a.rounds, source); }
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
        if (NEEDS_DESKTOP_REASON.test(String(ap.reason))) throw new Refusal('needs-desktop', 'That write is to a protected file or to a place outside the project, so it needs you at your computer. It stays waiting there.');
        try { p.human.approve(a.id, { uses: 1, ttlMs: 10 * 60_000, portable: false, ctx: { method } }); } catch (e) {
          throw new Refusal('needs-desktop', /approver|passphrase/i.test((e as Error).message) ? 'This project asks for the approver passphrase, which only your computer can take.' : (e as Error).message);
        }
        return { decision: 'approved', expiresInMinutes: 10, uses: 1 };
      }
    }
  };
}
