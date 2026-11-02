import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, sha256 } from './store.js';
import { branchOf, changedSince, git, headOf } from './worktrees.js';
import { approvalView, isPendingLive } from './state.js';
import type { Project } from './project.js';

/**
 * Evidence-preserving handoff, v2. It carries what can be checked again, not an agent's account of it: receipts with the digest they
 * were taken at, hashes of the files that matter, the decisions a person approved. Approvals are never carried: the receiver asks for
 * its own. The record is the JSON. HANDOFF.md is a view of it.
 */

export const HANDOFF_SCHEMA = 'agentontrack.handoff/v2';
const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GOAL.md', 'DECISIONS.md', 'EVALS.md', 'SAFETY.md'];

export interface HandoffV2 {
  schema: typeof HANDOFF_SCHEMA;
  id: string;
  createdAt: string;
  from: { runtime: string; sessionId?: string };
  to?: { runtime: string };
  reason: { kind: 'planned' | 'unavailable' | 'limit' | 'interrupted' | 'review'; detail?: string };
  project: { id: string; name: string };
  task: { id: string; title: string; status: string; criteria: { id: string; description: string; kind: string; state: string }[] };
  goal: { version: number | null; statement: string | null; scope: { include: string[]; exclude: string[] } | null; prohibit: string[] };
  policyVersion: number;
  source: { branch: string; head: string; dirty: boolean; workspaceDigest: string; worktree: { id: string; branch: string; base: string; commit?: string } | null; changed: { path: string; status: string; sha256: string | null }[] };
  decisions: { id: string; title: string; rationale: string }[];
  completed: { criterion: string; receiptSeq: number; current: boolean }[];
  outstanding: { criterion: string; state: string; why: string }[];
  knownFailures: { source: string; summary: string }[];
  evidence: { seq: number; criterion: string; passed: boolean; source: string; command: string | null; outputSha256: string | null; digest: string; goalVersion: number; current: boolean }[];
  constraints: { prohibit: string[]; protectedPaths: string[]; approvalRequired: string[]; opaqueExec: string; onMismatch: string };
  limits: string[];
  uncertainty: string[];
  approvalsToRevalidate: { id: string; effect: { kind: string; target: string }; status: string; runtime: string; note: string }[];
  recommendedNext: string;
  integrity: { headSeq: number; headHash: string | null; contextFiles: Record<string, string>; decisionCount: number };
  contentSha256: string;
}

const fileHash = (root: string, rel: string): string | null => { try { return sha256(readFileSync(join(root, rel))); } catch { return null; } };
const trunc = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildHandoff(p: Project, o: { from: string; to?: string; taskId?: string; sessionId?: string; reason?: HandoffV2['reason']; limits?: string[]; worktreeId?: string }): HandoffV2 {
  const s = p.state();
  const task = (o.taskId ? s.tasks.get(o.taskId) : p.taskForSession(s, o.sessionId)) ?? null;
  if (!task) throw new Error('There is no task to hand off. Create and activate one first.');
  const ev = p.evaluate(task.id);
  const digest = p.currentDigest();
  const goalVersion = s.goal?.version ?? 0;
  const receipts = s.receipts.filter((r) => r.taskId === task.id);
  const evidence = receipts.slice(-60).map((r) => ({ seq: r.seq, criterion: r.criterionId, passed: r.passed, source: r.source, command: r.command ?? null, outputSha256: r.outputSha256 ?? null, digest: r.workspaceDigest, goalVersion: r.goalVersion, current: r.workspaceDigest === digest && r.goalVersion === goalVersion }));
  const latest = new Map(evidence.map((e) => [e.criterion, e]));
  const wt = (o.worktreeId ? s.worktrees?.find((w) => w.id === o.worktreeId) : s.worktrees?.find((w) => w.status === 'active' && w.taskId === task.id && w.agent === o.from)) ?? null;
  const base = wt ? wt.path : p.root;
  const changed = wt ? changedSince(wt.path, wt.base) : (existsSync(join(p.root, '.git')) ? git(p.root, 'status', '--porcelain', '-uall').out.split('\n').filter(Boolean).map((l) => ({ path: l.slice(3).replace(/^"|"$/g, ''), status: l.startsWith('??') ? 'added' : l.includes('D') ? 'deleted' : 'modified' })) : []);
  const crit = ev.criteria.map((c) => ({ id: c.id, description: task.criteria.find((x) => x.id === c.id)?.description ?? '', kind: task.criteria.find((x) => x.id === c.id)?.kind ?? 'command', state: c.state }));
  const uncertainty: string[] = [];
  if (ev.criteria.some((c) => c.state === 'stale')) uncertainty.push('Some evidence is stale: the code or the goal changed after it was taken.');
  if (ev.criteria.some((c) => c.state === 'missing')) uncertainty.push('Some criteria have never been checked.');
  if (ev.weakCriteria?.length) uncertainty.push(`Weak checks: ${ev.weakCriteria.join('; ')}`);
  const open = s.mismatches.filter((m) => m.taskId === task.id && !m.acknowledged);
  if (open.length) uncertainty.push(`${open.length} unauthorized change(s) are unresolved: ${open.slice(0, 5).map((m) => m.path).join(', ')}`);
  const claims = s.claims.filter((c) => c.taskId === task.id);
  if (claims.length) uncertainty.push(`${claims.length} statement(s) by an agent are recorded as claims and count as no evidence.`);
  const dirty = changed.length > 0;
  if (dirty && !wt) uncertainty.push('The working folder has uncommitted changes, so the source revision does not describe it fully.');
  if (!p.verifyIntegrity().ok) uncertainty.push('The record failed its integrity check.');
  const failures = [
    ...receipts.filter((r) => !r.passed && latest.get(r.criterionId)?.seq === r.seq).map((r) => ({ source: `check ${r.criterionId}`, summary: trunc(r.observed) })),
    ...p.store.byType(['action.failed'], 5).map((e) => ({ source: `${e.payload.tool} failed`, summary: trunc(String(e.payload.summary ?? '')) })),
  ];
  const approvals = [...s.approvals.values()].filter((a) => a.taskId === task.id && (approvalView(a, new Date()) === 'approved' || isPendingLive(a, new Date()))).filter((a) => !a.id.endsWith('_portable'));
  const completed = ev.criteria.filter((c) => c.state === 'pass').map((c) => ({ criterion: c.id, receiptSeq: c.receiptSeq ?? 0, current: true }));
  const outstanding = ev.criteria.filter((c) => c.state !== 'pass').map((c) => ({ criterion: c.id, state: c.state, why: c.state === 'fail' ? 'The latest check failed.' : c.state === 'stale' ? 'It passed earlier, and has not been re-checked on the current code.' : 'It has not been checked.' }));
  const head = p.store.head();
  const body: Omit<HandoffV2, 'contentSha256'> = {
    schema: HANDOFF_SCHEMA, id: `hnd_${randomBytes(6).toString('hex')}`, createdAt: new Date().toISOString(), from: { runtime: o.from, ...(o.sessionId ? { sessionId: o.sessionId } : {}) }, ...(o.to ? { to: { runtime: o.to } } : {}),
    reason: o.reason ?? { kind: 'planned' }, project: { id: basename(p.stateDir), name: basename(p.root) },
    task: { id: task.id, title: task.title, status: ev.status, criteria: crit },
    goal: { version: s.goal?.version ?? null, statement: s.goal?.statement ?? null, scope: s.goal ? { include: s.goal.scope.include, exclude: s.goal.scope.exclude } : null, prohibit: s.goal?.prohibit ?? [] },
    policyVersion: s.policyVersion,
    source: { branch: existsSync(join(base, '.git')) || wt ? branchOf(base) : '', head: existsSync(join(base, '.git')) || wt ? headOf(base) : '', dirty, workspaceDigest: digest, worktree: wt ? { id: wt.id, branch: wt.branch, base: wt.base, ...(wt.commit ? { commit: wt.commit } : {}) } : null, changed: changed.slice(0, 200).map((c) => ({ path: c.path, status: c.status, sha256: fileHash(base, c.path) })) },
    decisions: s.decisions.slice(-20).map((d) => ({ id: d.id, title: d.title, rationale: d.rationale })),
    completed, outstanding, knownFailures: failures,
    evidence,
    constraints: { prohibit: s.goal?.prohibit ?? [], protectedPaths: s.policy.protectedPaths, approvalRequired: s.policy.approvalRequired, opaqueExec: s.policy.opaqueExec, onMismatch: s.policy.onMismatch },
    limits: o.limits ?? [],
    uncertainty,
    approvalsToRevalidate: approvals.map((a) => ({ id: a.id, effect: { kind: a.effect.kind, target: a.effect.target }, status: approvalView(a, new Date()), runtime: a.runtime, note: 'Approvals do not transfer. The receiving runtime requests its own, and a person grants it again.' })),
    recommendedNext: outstanding[0] ? `${outstanding[0].state === 'fail' ? 'Fix' : 'Run'} criterion "${outstanding[0].criterion}": ${crit.find((c) => c.id === outstanding[0]!.criterion)?.description ?? ''}`.trim() : ev.status === 'VERIFIED' ? 'Nothing outstanding. A person decides whether to close the task.' : 'Add acceptance criteria: with none, the task cannot be verified.',
    integrity: { headSeq: head?.seq ?? 0, headHash: head?.hash ?? null, contextFiles: Object.fromEntries(CONTEXT_FILES.map((f) => [f, fileHash(p.root, f)]).filter(([, h]) => h) as [string, string][]), decisionCount: s.decisions.length },
  };
  return { ...body, contentSha256: sha256(canonical(body)) };
}

export type ProblemCode = 'TAMPERED' | 'WRONG_PROJECT' | 'TASK_CLOSED' | 'STALE_GOAL' | 'POLICY_CHANGED' | 'SOURCE_MOVED' | 'CONTEXT_CHANGED' | 'DECISIONS_MISSING' | 'WORKTREE_GONE' | 'RECORD_DAMAGED';
export interface Problem { code: ProblemCode; message: string; blocking: boolean }

/** Whether a handoff still describes the project it was made from. Blocking problems cannot be waved through. */
export function validateHandoff(p: Project, h: HandoffV2): Problem[] {
  const out: Problem[] = [];
  const s = p.state();
  const { contentSha256, ...body } = h;
  if (h.schema !== HANDOFF_SCHEMA || sha256(canonical(body)) !== contentSha256) out.push({ code: 'TAMPERED', message: 'The handoff does not match its own hash, so it was changed or damaged.', blocking: true });
  if (h.project.id !== basename(p.stateDir)) out.push({ code: 'WRONG_PROJECT', message: 'This handoff was made for a different project.', blocking: true });
  const task = s.tasks.get(h.task.id);
  if (!task || task.closed) out.push({ code: 'TASK_CLOSED', message: task ? `Task ${h.task.id} was closed (${task.closed}).` : `Task ${h.task.id} does not exist here.`, blocking: true });
  if ((s.goal?.version ?? null) !== h.goal.version) out.push({ code: 'STALE_GOAL', message: `The goal is now version ${s.goal?.version ?? 'none'}, and this handoff is from version ${h.goal.version ?? 'none'}. Its evidence and approvals no longer apply.`, blocking: false });
  if (s.policyVersion !== h.policyVersion) out.push({ code: 'POLICY_CHANGED', message: `The policy changed from version ${h.policyVersion} to ${s.policyVersion}.`, blocking: false });
  const wt = h.source.worktree;
  if (wt) {
    const live = s.worktrees?.find((w) => w.id === wt.id && w.status === 'active');
    if (!live) out.push({ code: 'WORKTREE_GONE', message: 'The worktree this handoff was made in has been merged, discarded or removed.', blocking: false });
    else if (live.commit && wt.commit && live.commit !== wt.commit) out.push({ code: 'SOURCE_MOVED', message: 'The worktree has new commits since this handoff.', blocking: false });
  } else if (h.source.head && existsSync(join(p.root, '.git')) && headOf(p.root) !== h.source.head) {
    out.push({ code: 'SOURCE_MOVED', message: `The project moved from ${h.source.head.slice(0, 8)} to ${headOf(p.root).slice(0, 8)} since this handoff.`, blocking: false });
  } else if (p.currentDigest() !== h.source.workspaceDigest) {
    out.push({ code: 'SOURCE_MOVED', message: 'Files in the project changed since this handoff, so its evidence may no longer describe them.', blocking: false });
  }
  const changedCtx = Object.entries(h.integrity.contextFiles).filter(([f, hash]) => fileHash(p.root, f) !== hash).map(([f]) => f);
  if (changedCtx.length) out.push({ code: 'CONTEXT_CHANGED', message: `Instruction files changed since the handoff: ${changedCtx.join(', ')}. Read them again.`, blocking: false });
  if (s.decisions.length < h.integrity.decisionCount) out.push({ code: 'DECISIONS_MISSING', message: 'Fewer decisions are recorded now than when the handoff was made.', blocking: false });
  if (!p.verifyIntegrity().ok) out.push({ code: 'RECORD_DAMAGED', message: 'The record failed its integrity check.', blocking: true });
  return out;
}

/** The reading for the receiving agent: what is done and checkable, what is not, and what it may not assume. */
export function renderHandoffMarkdown(h: HandoffV2): string {
  const li = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- None');
  return [
    `# Handoff ${h.id}`, '',
    `From **${h.from.runtime}**${h.to ? ` to **${h.to.runtime}**` : ''}, ${h.createdAt}. Reason: ${h.reason.kind}${h.reason.detail ? `, ${h.reason.detail}` : ''}.`, '',
    `**Task ${h.task.id}:** ${h.task.title} (${h.task.status})`, `**Goal v${h.goal.version ?? 'none'}:** ${h.goal.statement ?? 'none approved'}`, '',
    '## Done, with evidence still current', li(h.completed.filter((c) => c.current).map((c) => `${c.criterion} (receipt ${c.receiptSeq}). Do not redo it unless the code it covers changes.`)), '',
    '## Not done', li(h.outstanding.map((o) => `${o.criterion}: ${o.why}`)), '',
    '## Known failures', li(h.knownFailures.map((f) => `${f.source}: ${f.summary}`)), '',
    '## Decisions a person approved. Do not reverse them silently', li(h.decisions.map((d) => `${d.title}: ${d.rationale}`)), '',
    '## What is uncertain', li(h.uncertainty), '',
    '## Source', `${h.source.branch || 'no git'} at ${h.source.head.slice(0, 12) || 'n/a'}${h.source.dirty ? ', with uncommitted changes' : ''}${h.source.worktree ? `, in worktree ${h.source.worktree.id}` : ''}.`, li(h.source.changed.slice(0, 30).map((c) => `${c.status} ${c.path}`)), '',
    '## Rules that apply', li([`Protected paths: ${h.constraints.protectedPaths.join(', ')}`, `Needs a person's approval: ${h.constraints.approvalRequired.join(', ')}`, ...(h.constraints.prohibit.length ? [`Prohibited by the goal: ${h.constraints.prohibit.join(', ')}`] : [])]),
    ...(h.approvalsToRevalidate.length ? ['', '## Approvals that do NOT carry over', li(h.approvalsToRevalidate.map((a) => `${a.effect.kind} ${a.effect.target} (${a.status}, for ${a.runtime}). Ask again.`))] : []),
    ...(h.limits.length ? ['', '## Limits of the receiving runtime', li(h.limits)] : []), '',
    '## Next', h.recommendedNext, '',
    `_Generated from the AgentOnTrack record (sha256 ${h.contentSha256.slice(0, 16)}). The record, not this file, is authoritative._`, '',
  ].join('\n');
}

const dirOf = (p: Project) => join(p.stateDir, 'handoffs');

/** Writes the JSON, then the readable view, each atomically, and logs it. If this stops half way, `pendingHandoffs` finds it. */
export function saveHandoff(p: Project, h: HandoffV2, opts: { writeMarkdown?: boolean } = {}): { json: string; markdown?: string } {
  mkdirSync(dirOf(p), { recursive: true });
  const json = join(dirOf(p), `${h.id}.json`);
  const tmp = `${json}.${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(h, null, 2));
  renameSync(tmp, json);
  p.store.append({ type: 'handoff.prepared', actor: { kind: 'agent', runtime: h.from.runtime }, taskId: h.task.id, payload: { id: h.id, schema: h.schema, handoffSha256: h.contentSha256, to: h.to?.runtime ?? null, reason: h.reason.kind, sections: ['task', 'goal', 'source', 'decisions', 'evidence', 'constraints', 'approvals(references only)'] } });
  if (!opts.writeMarkdown) return { json };
  const md = join(p.root, 'HANDOFF.md');
  const mtmp = `${md}.${randomBytes(3).toString('hex')}`;
  writeFileSync(mtmp, renderHandoffMarkdown(h));
  renameSync(mtmp, md);
  return { json, markdown: md };
}

/** Whether HANDOFF.md still says what the record says. An agent could have edited it, so a receiver takes its brief from the engine, not from the file. */
export function verifyHandoffFile(p: Project, id: string): { ok: boolean; reason: string } {
  const path = join(p.root, 'HANDOFF.md');
  if (!existsSync(path)) return { ok: false, reason: 'There is no HANDOFF.md' };
  const h = loadHandoff(p, id);
  const want = renderHandoffMarkdown(h);
  return readFileSync(path, 'utf8') === want ? { ok: true, reason: 'The file matches the record' } : { ok: false, reason: 'HANDOFF.md differs from the record, so it was edited, or is for another handoff. Do not trust it.' };
}

export const loadHandoff = (p: Project, id: string): HandoffV2 => {
  if (!/^hnd_[0-9a-f]{12}$/.test(id)) throw new Error('Not a handoff id');
  return JSON.parse(readFileSync(join(dirOf(p), `${id}.json`), 'utf8'));
};

export const listHandoffs = (p: Project): { id: string; createdAt: string; from: string; to: string | null; task: string; outcome: 'prepared' | 'accepted' | 'rejected' }[] => {
  if (!existsSync(dirOf(p))) return [];
  const events = p.store.byType(['handoff.accepted', 'handoff.rejected']);
  return readdirSync(dirOf(p)).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try {
      const h: HandoffV2 = JSON.parse(readFileSync(join(dirOf(p), f), 'utf8'));
      const last = events.filter((e) => e.payload.id === h.id).at(-1);
      return [{ id: h.id, createdAt: h.createdAt, from: h.from.runtime, to: h.to?.runtime ?? null, task: h.task.id, outcome: last ? (last.type === 'handoff.accepted' ? 'accepted' as const : 'rejected' as const) : 'prepared' as const }];
    } catch { return []; }
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

export interface AcceptResult { accepted: boolean; problems: Problem[]; brief: string | null; approvalsToRequest: HandoffV2['approvalsToRevalidate']; reusable: string[] }

/**
 * The receiver takes the handoff. Blocking problems refuse it. Others refuse it too, unless a person has acknowledged them, because a
 * stale handoff is how work gets redone or undone. Nothing granted before is granted now.
 */
export function acceptHandoff2(p: Project, h: HandoffV2, to: string, o: { acknowledge?: boolean } = {}): AcceptResult {
  const problems = validateHandoff(p, h);
  const blocked = problems.some((x) => x.blocking) || (problems.length > 0 && !o.acknowledge);
  // Judged now, against the project as it is, not as it was when the handoff was made.
  const now = p.currentDigest();
  const goalNow = p.state().goal?.version ?? 0;
  const reusable = h.completed.filter((c) => p.state().receipts.some((r) => r.seq === c.receiptSeq && r.passed && r.workspaceDigest === now && r.goalVersion === goalNow)).map((c) => c.criterion);
  const payload = { id: h.id, to, problems: problems.map((x) => x.code), acknowledged: !!o.acknowledge, transferred: { sections: ['task', 'goal', 'source', 'decisions', 'evidence', 'constraints'], approvalsCarried: 0, approvalReferences: h.approvalsToRevalidate.length, credentialsCarried: 0 } };
  if (blocked) {
    p.store.append({ type: 'handoff.rejected', actor: { kind: 'agent', runtime: to }, taskId: h.task.id, payload });
    return { accepted: false, problems, brief: null, approvalsToRequest: [], reusable: [] };
  }
  p.store.append({ type: 'handoff.accepted', actor: { kind: 'agent', runtime: to }, taskId: h.task.id, payload: { ...payload, reusable } });
  return { accepted: true, problems, brief: renderHandoffMarkdown({ ...h, to: { runtime: to } }), approvalsToRequest: h.approvalsToRevalidate, reusable };
}
