import { verifyBody } from './integrity.js';
import type { Criterion, GoalContract, Policy, StoredEvent, TaskStatus } from './types.js';
import { HUMAN_ONLY_EVENTS, PolicySchema } from './types.js';
import type { VerificationFinding, VerificationManifest } from './verification.js';

export interface Approval {
  id: string;
  requestSeq: number;
  taskId: string;
  fingerprint: string;
  effect: { kind: string; target: string };
  reason?: string;
  status: 'pending' | 'granted' | 'denied';
  granted: boolean;
  portable: boolean;
  usesLeft: number;
  requestedAt: string;
  pendingExpiresAt?: string;
  expiresAt?: string;
  revoked: boolean;
  goalVersion: number;
  policyVersion: number;
  runtime: string;
  approver?: unknown;
  decidedAt?: string;
}

export interface Task {
  id: string;
  title: string;
  goalVersion: number;
  criteria: Criterion[];
  limits: { maxActions?: number; maxElapsedMs?: number };
  createdAt: string;
  accepted: boolean;
  closed?: string;
  verificationBaseline: VerificationManifest;
  /** Weak-check warnings a human has read and accepted. A new warning is not covered. */
  weakAccepted?: string[];
}

export interface Receipt {
  seq: number;
  taskId: string;
  criterionId: string;
  passed: boolean;
  observed: string;
  ts: string;
  source: string;
  workspaceDigest: string;
  goalVersion: number;
  command?: string;
  outputSha256?: string;
  durationMs?: number;
}

export interface ActionRec {
  seq: number;
  taskId: string | null;
  tool: string;
  fingerprint: string;
  digest: string;
  decision: string;
  ts: string;
}

export interface WorktreeRec {
  id: string; taskId: string; agent: string; branch: string; path: string; base: string; createdAt: string;
  status: 'active' | 'merged' | 'discarded';
  commit?: string; mergedCommit?: string; mergeError?: string;
}

export interface Mismatch { seq: number; taskId: string | null; path: string; reason: string; acknowledged: boolean; reverted?: string }

export interface Proposal {
  seq: number;
  id: string;
  kind: 'goal' | 'decision';
  payload: any;
  ts: string;
  status: 'open' | 'accepted' | 'rejected';
  note?: string;
  actor: unknown;
}

export interface ProjectState {
  lastSeq: number;
  instance: string | null;
  approverKey: string | null;
  anchor?: { remote: string; every: number };
  worktrees: WorktreeRec[];
  team: { version: number; members: { agent: string; role: string; budgetTokens?: number; budgetUsd?: number }[] };
  /** The current phase plan. Editing it saves a new version. Approving it is a human-only event bound to the plan's content hash. */
  plan: { doc: any; version: number; sha: string; approvedSha: string | null; approvedAt: string | null; approvedVersion: number | null } | null;
  rejectedEvents: { seq: number; type: string; reason: string }[];
  goal: (GoalContract & { version: number; status: string }) | null;
  goals: (GoalContract & { version: number; ts: string; fromProposal?: string })[];
  proposals: Proposal[];
  decisions: { id: string; title: string; rationale: string; ts: string; goalVersion: number | null }[];
  policy: Policy;
  policyVersion: number;
  tasks: Map<string, Task>;
  activeTaskId: string | null;
  sessions: Map<string, string>;
  approvals: Map<string, Approval>;
  receipts: Receipt[];
  claims: { seq: number; taskId: string | null; text: string }[];
  actions: ActionRec[];
  actionCounts: Map<string, number>;
  lastDigest: string;
  mismatches: Mismatch[];
  failures: { fingerprint: string; ts: string; summary: string; digest: string }[];
  seenNonces: Set<string>;
  reads: Map<string, { hash: string; seq: number }>;
}

export function emptyState(): ProjectState {
  return {
    lastSeq: 0, instance: null, approverKey: null, rejectedEvents: [], goal: null, goals: [], proposals: [], decisions: [],
    policy: PolicySchema.parse({}), policyVersion: 0, tasks: new Map(), activeTaskId: null, sessions: new Map(), approvals: new Map(),
    worktrees: [], team: { version: 0, members: [] }, plan: null, receipts: [], claims: [], actions: [], actionCounts: new Map(), lastDigest: '', mismatches: [], failures: [], seenNonces: new Set(), reads: new Map(),
  };
}

const KEEP_ACTIONS = 300;
const KEEP_RECEIPTS = 2000;

/** Applies one event. Pure with respect to everything but `s`, so state can resume from a saved projection. */
export function applyEvent(s: ProjectState, e: StoredEvent): void {
  s.lastSeq = e.seq;
  const p = e.payload;
  if (HUMAN_ONLY_EVENTS.has(e.type) && s.approverKey) {
    const { sig, ...rest } = p ?? {};
    const body = { type: e.type, taskId: e.taskId, payload: rest, instance: s.instance };
    if (!sig || !verifyBody(s.approverKey, body, sig)) {
      // An unsigned human event is ignored, not merely flagged. It cannot take effect.
      s.rejectedEvents.push({ seq: e.seq, type: e.type, reason: 'missing or invalid approver signature' });
      return;
    }
    if (rest.nonce && s.seenNonces.has(rest.nonce)) {
      s.rejectedEvents.push({ seq: e.seq, type: e.type, reason: 'replayed signature' });
      return;
    }
    if (rest.nonce) s.seenNonces.add(rest.nonce);
  }
  switch (e.type) {
    case 'project.attached': s.instance = p.instance ?? null; break;
    case 'approver.enrolled': s.approverKey = p.publicKey; break;
    case 'goal.approved': {
      const version = (s.goal?.version ?? 0) + 1;
      s.goal = { ...p.goal, version, status: 'active' };
      s.goals.push({ ...p.goal, version, ts: e.ts, ...(p.fromProposal ? { fromProposal: p.fromProposal } : {}) });
      if (p.fromProposal) {
        const prop = s.proposals.find((x) => x.id === p.fromProposal);
        if (prop) prop.status = 'accepted';
      }
      break;
    }
    case 'goal.closed': if (s.goal) s.goal.status = p.outcome ?? 'completed'; break;
    case 'goal.reopened': if (s.goal) s.goal.status = 'active'; break;
    case 'goal.proposed': case 'decision.proposed':
      s.proposals.push({ seq: e.seq, id: p.id ?? `prop_${e.seq}`, kind: e.type === 'goal.proposed' ? 'goal' : 'decision', payload: p, ts: e.ts, status: 'open', actor: e.actor });
      break;
    case 'goal.rejected': case 'decision.rejected': {
      const prop = s.proposals.find((x) => x.id === p.id);
      if (prop) { prop.status = 'rejected'; prop.note = p.note; }
      break;
    }
    case 'decision.approved': {
      const prop = p.fromProposal ? s.proposals.find((x) => x.id === p.fromProposal) : undefined;
      if (prop) prop.status = 'accepted';
      s.decisions.push({ id: p.id, title: p.title, rationale: p.rationale, ts: e.ts, goalVersion: e.goalVersion });
      break;
    }
    case 'policy.set':
      s.policy = PolicySchema.parse(p.policy);
      s.policyVersion += 1;
      break;
    case 'task.created':
      s.tasks.set(p.id, { id: p.id, title: p.title, goalVersion: e.goalVersion ?? 0, criteria: p.criteria, limits: p.limits ?? {}, createdAt: e.ts, accepted: false, verificationBaseline: p.verificationBaseline ?? {} });
      break;
    case 'task.activated': s.activeTaskId = p.id; break;
    // Not a human-only event, and not a loophole: it changes the active task only to one that the person's approval of this exact plan created
    // for this phase, and only while that approval still matches the plan.
    case 'plan.phase_started': {
      const pl = s.plan;
      const ph = pl?.doc.phases.find((x: any) => x.id === p.phaseId);
      if (pl && pl.approvedSha === pl.sha && ph?.taskId && ph.taskId === p.taskId && s.tasks.has(p.taskId) && !s.tasks.get(p.taskId)!.closed) s.activeTaskId = p.taskId;
      break;
    }
    case 'task.accepted': { const t = s.tasks.get(p.id); if (t) t.accepted = true; break; }
    case 'task.closed': {
      const t = s.tasks.get(p.id);
      if (t) t.closed = p.outcome ?? 'closed';
      if (s.activeTaskId === p.id) s.activeTaskId = null;
      break;
    }
    case 'verification.accepted': {
      const t = s.tasks.get(p.id);
      if (t) t.verificationBaseline = p.verificationBaseline;
      break;
    }
    case 'weak.accepted': {
      const t = s.tasks.get(p.id);
      if (t) t.weakAccepted = p.warnings;
      break;
    }
    case 'anchor.configured': s.anchor = { remote: p.remote, every: p.every }; break;
    case 'plan.saved': s.plan = { doc: p.plan, version: (s.plan?.version ?? 0) + 1, sha: p.sha, approvedSha: s.plan?.approvedSha ?? null, approvedAt: s.plan?.approvedAt ?? null, approvedVersion: s.plan?.approvedVersion ?? null }; break;
    case 'plan.approved': if (s.plan && s.plan.sha === p.sha) {
      s.plan.approvedSha = p.sha; s.plan.approvedAt = e.ts; s.plan.approvedVersion = p.version;
      for (const ph of s.plan.doc.phases) if (p.tasks?.[ph.id]) ph.taskId = p.tasks[ph.id]; else delete ph.taskId;
    } break;
    case 'team.set': s.team = { version: (s.team?.version ?? 0) + 1, members: p.members }; break;
    case 'worktree.created': (s.worktrees ??= []).push({ ...p, status: 'active', createdAt: e.ts }); break;
    case 'worktree.committed': { const w = (s.worktrees ??= []).find((x) => x.id === p.id); if (w) w.commit = p.commit; break; }
    case 'worktree.merged': { const w = (s.worktrees ??= []).find((x) => x.id === p.id); if (w) { w.status = 'merged'; w.mergedCommit = p.commit; delete w.mergeError; } break; }
    case 'worktree.merge_failed': { const w = (s.worktrees ??= []).find((x) => x.id === p.id); if (w) w.mergeError = p.error; break; }
    case 'worktree.discarded': { const w = (s.worktrees ??= []).find((x) => x.id === p.id); if (w) w.status = 'discarded'; break; }
    case 'session.bound': s.sessions.set(p.sessionId, p.taskId); break;
    case 'approval.requested':
      s.approvals.set(p.id, {
        id: p.id, requestSeq: e.seq, taskId: e.taskId!, fingerprint: p.fingerprint, effect: p.effect, reason: p.reason, status: 'pending', granted: false, portable: false,
        usesLeft: 0, requestedAt: e.ts, ...(p.pendingExpiresAt ? { pendingExpiresAt: p.pendingExpiresAt } : {}), revoked: false, goalVersion: e.goalVersion ?? 0, policyVersion: e.policyVersion ?? 0, runtime: p.runtime,
      });
      break;
    case 'approval.granted': {
      const a = s.approvals.get(p.id);
      if (a && a.status === 'pending') {
        a.status = 'granted'; a.granted = true; a.portable = !!p.portable; a.usesLeft = p.uses ?? 1; a.approver = p.approver; a.decidedAt = e.ts;
        if (p.expiresAt) a.expiresAt = p.expiresAt;
      } else s.rejectedEvents.push({ seq: e.seq, type: e.type, reason: a ? `approval already ${a.status}` : 'unknown approval' });
      break;
    }
    case 'approval.denied': {
      const a = s.approvals.get(p.id);
      if (a && a.status === 'pending') { a.status = 'denied'; a.approver = p.approver; a.decidedAt = e.ts; }
      break;
    }
    case 'approval.revoked': { const a = s.approvals.get(p.id); if (a) a.revoked = true; break; }
    case 'approval.consumed': { const a = s.approvals.get(p.id); if (a) a.usesLeft -= 1; break; }
    case 'evidence.recorded':
      s.receipts.push({ ...p, seq: e.seq, taskId: e.taskId!, ts: e.ts, goalVersion: e.goalVersion ?? 0 });
      if (s.receipts.length > KEEP_RECEIPTS) s.receipts.shift();
      break;
    case 'evidence.claimed': s.claims.push({ seq: e.seq, taskId: e.taskId, text: p.text }); break;
    case 'action.requested':
      s.actions.push({ seq: e.seq, taskId: e.taskId, tool: p.tool, fingerprint: p.inputFingerprint, digest: p.workspaceDigest, decision: p.decision, ts: e.ts });
      if (s.actions.length > KEEP_ACTIONS) s.actions.shift();
      if (e.taskId) s.actionCounts.set(e.taskId, (s.actionCounts.get(e.taskId) ?? 0) + 1);
      if (p.workspaceDigest) s.lastDigest = p.workspaceDigest;
      break;
    case 'effect.mismatch':
      for (const m of p.mismatches) s.mismatches.push({ seq: e.seq, taskId: e.taskId, path: m.path, reason: m.reason, acknowledged: false });
      break;
    case 'effect.reverted':
      for (const r of p.reverted) {
        const m = s.mismatches.find((x) => x.seq === p.mismatchSeq && x.path === r.path);
        if (m) m.reverted = r.how;
      }
      break;
    case 'mismatch.acknowledged':
      for (const m of s.mismatches) if (m.seq === p.seq) m.acknowledged = true;
      break;
    case 'action.failed':
      s.failures.push({ fingerprint: p.inputFingerprint, ts: e.ts, summary: p.summary, digest: p.workspaceDigest ?? '' });
      if (s.failures.length > 200) s.failures.shift();
      break;
    case 'context.read': s.reads.set(p.path, { hash: p.hash, seq: e.seq }); break;
    case 'context.reset': s.reads.clear(); break;
  }
}

export function foldState(events: StoredEvent[]): ProjectState {
  const s = emptyState();
  for (const e of events) applyEvent(s, e);
  return s;
}

export function serializeState(s: ProjectState): string {
  return JSON.stringify({
    ...s, tasks: [...s.tasks], sessions: [...s.sessions], approvals: [...s.approvals], actionCounts: [...s.actionCounts], seenNonces: [...s.seenNonces], reads: [...s.reads],
  });
}

export function deserializeState(text: string): ProjectState {
  const o = JSON.parse(text);
  return { ...o, tasks: new Map(o.tasks), sessions: new Map(o.sessions), approvals: new Map(o.approvals), actionCounts: new Map(o.actionCounts), seenNonces: new Set(o.seenNonces), reads: new Map(o.reads) };
}

export function isPendingLive(a: Approval, now: Date): boolean {
  return a.status === 'pending' && !a.revoked && (!a.pendingExpiresAt || new Date(a.pendingExpiresAt) > now);
}

export type ApprovalView = 'pending' | 'approved' | 'consumed' | 'denied' | 'revoked' | 'expired';

export function approvalView(a: Approval, now: Date): ApprovalView {
  if (a.revoked) return 'revoked';
  if (a.status === 'denied') return 'denied';
  if (a.status === 'pending') return isPendingLive(a, now) ? 'pending' : 'expired';
  if (a.usesLeft <= 0) return 'consumed';
  if (a.expiresAt && new Date(a.expiresAt) <= now) return 'expired';
  return 'approved';
}

export interface TaskEvaluation {
  status: TaskStatus;
  reasons: string[];
  criteria: { id: string; state: 'pass' | 'fail' | 'stale' | 'missing'; receiptSeq?: number }[];
  progress: { passed: number; total: number };
  /** VERIFIED only means these checks passed. Reasons here say why that may prove little. */
  weakCriteria?: string[];
}

/**
 * Status comes from independent receipts, never from what an agent claims. VERIFIED requires a current pass for
 * every criterion, no unresolved unauthorized effect and no unreviewed sign that verification was weakened.
 */
export function evaluateTask(state: ProjectState, taskId: string, workspaceDigest: string, opts: { staleEvidence?: boolean; effectObserver?: boolean; findings?: VerificationFinding[]; now?: Date } = {}): TaskEvaluation {
  const useStale = opts.staleEvidence ?? true;
  const useMismatch = opts.effectObserver ?? true;
  const now = opts.now ?? new Date();
  const task = state.tasks.get(taskId);
  if (!task) return { status: 'UNKNOWN', reasons: [`No task ${taskId}`], criteria: [], progress: { passed: 0, total: 0 } };
  const reasons: string[] = [];
  const criteria: TaskEvaluation['criteria'] = task.criteria.map((c) => {
    const latest = state.receipts.filter((r) => r.taskId === taskId && r.criterionId === c.id).at(-1);
    if (!latest) return { id: c.id, state: 'missing' as const };
    const stale = useStale && c.kind !== 'human' && (latest.workspaceDigest !== workspaceDigest || latest.goalVersion !== (state.goal?.version ?? 0));
    if (stale) return { id: c.id, state: 'stale' as const, receiptSeq: latest.seq };
    return { id: c.id, state: latest.passed ? ('pass' as const) : ('fail' as const), receiptSeq: latest.seq };
  });
  for (const c of criteria) if (c.state !== 'pass') reasons.push(`Criterion ${c.id}: ${c.state}`);
  const openMismatches = useMismatch ? state.mismatches.filter((m) => m.taskId === taskId && !m.acknowledged) : [];
  for (const m of openMismatches) reasons.push(`Unresolved effect on ${m.path}: ${m.reason}${m.reverted ? ` (reverted: ${m.reverted})` : ''}`);
  const weakening = (opts.findings ?? []).filter((f) => f.severity === 'suspected-weakening');
  for (const f of weakening) reasons.push(`Verification may be weakened in ${f.path}: ${f.detail}`);
  const all = [...state.approvals.values()].filter((a) => a.taskId === taskId);
  const pending = all.some((a) => isPendingLive(a, now));
  const expired = all.filter((a) => a.status === 'pending' && !a.revoked && !isPendingLive(a, now));
  const acted = (state.actionCounts.get(taskId) ?? 0) > 0;

  let status: TaskStatus;
  const blocked = openMismatches.length > 0 || weakening.length > 0;
  if (task.criteria.length === 0) {
    status = acted ? 'IMPLEMENTED_UNVERIFIED' : 'PLANNED';
    reasons.push('Task has no acceptance criteria, so it cannot be verified');
  } else if (criteria.some((c) => c.state === 'fail')) status = 'FAILED';
  else if (criteria.every((c) => c.state === 'pass') && !blocked) status = 'VERIFIED';
  else if (criteria.some((c) => c.state === 'stale' || c.state === 'pass') || blocked) status = 'IMPLEMENTED_UNVERIFIED';
  else status = acted ? 'IN_PROGRESS' : 'PLANNED';
  if (pending && status !== 'VERIFIED') { status = 'NEEDS_HUMAN_APPROVAL'; reasons.push('A human approval is pending'); }
  if (expired.length) reasons.push(`${expired.length} approval request(s) expired unanswered; the action must be retried to ask again`);
  return { status, reasons, criteria, progress: { passed: criteria.filter((c) => c.state === 'pass').length, total: criteria.length } };
}
