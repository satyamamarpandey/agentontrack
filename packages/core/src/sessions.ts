// Sessions, as a PROJECTION of the project's existing event log. There is no second database: a session is what `run.started`, `run.finished` and the `session.*` events say it is.
// Events used:
//   run.started   { id, runtime, model, worktreeId?, resumedFrom? (Claude), resumedSession? (Codex), planId?, phaseId?, source? }
//   run.finished  { id, status, sessionId? }                     (the provider's session id, when the run learned it)
//   session.created { sessionId, runtime, model?, title?, worktreeId? }
//   session.run     { sessionId, runId }                           (which session a run belongs to)
//   session.linked  { sessionId, providerSessionId, runId }        (written as soon as the provider names its session, so a STOPPED run can be resumed too)
//   session.updated { sessionId, title?, pinned?, archived? }
//   session.prompt / session.message { sessionId, runId, text }    (only when the owner turned transcript retention on)
// A log written before sessions existed still projects: runs are grouped by their resume links, and a run with none is a session of its own.
import { randomBytes } from 'node:crypto';
import type { StoredEvent } from './types.js';

export type SessionStatus = 'running' | 'idle' | 'failed' | 'stopped' | 'orphaned';

export interface SessionView {
  id: string;
  runtime: string;
  model: string | null;
  title: string;
  titleSource: 'user' | 'default';
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  worktreeId: string | null;
  /** The provider's own session id, if one was learned. Never shown as a secret, but not needed by a UI either. */
  providerSessionId: string | null;
  runIds: string[];
  lastRunId: string | null;
  /** The run to resume through (`resumeTarget` reads its session). Null when nothing resumable was left behind. */
  resumeRunId: string | null;
  canResume: boolean;
  source: 'user' | 'plan' | 'workflow' | 'phone' | 'other';
  /** The last stored prompt, present only when transcript retention is on. */
  lastPrompt: string | null;
  messages: number;
}

const SESSION_ID = /^ses_[a-f0-9]{8,32}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{8,80}$/;
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && SESSION_ID.test(s);
export const isProviderSessionId = (s: unknown): s is string => typeof s === 'string' && PROVIDER_ID.test(s);
export const newSessionId = (): string => `ses_${randomBytes(6).toString('hex')}`;

interface RunInfo { id: string; runtime: string; model: string | null; worktreeId: string | null; resumedFrom: string | null; resumedSession: string | null; ts: string; source: SessionView['source']; finishedStatus: string | null; providerSessionId: string | null; linked: string | null }
interface Draft { id: string; runtime: string; model: string | null; title: string | null; worktreeId: string | null; createdAt: string; updatedAt: string; pinned: boolean; archived: boolean; runIds: string[]; lastPrompt: string | null; messages: number; source: SessionView['source'] }

const sourceOf = (p: any): SessionView['source'] => {
  const s = typeof p?.source === 'string' ? p.source : '';
  if (s.startsWith('phone:')) return 'phone';
  if (s.startsWith('cross-review:')) return 'workflow';
  if (p?.planId || s.startsWith('plan')) return 'plan';
  return s ? 'other' : 'user';
};

/** Replays the log. `live` is the set of run ids the companion has running RIGHT NOW; a run with no end and not live is `orphaned`, which is shown and never written. */
export function projectSessions(events: readonly StoredEvent[], opts: { live?: ReadonlySet<string> } = {}): SessionView[] {
  const live = opts.live ?? new Set<string>();
  const runs = new Map<string, RunInfo>();
  const explicit = new Map<string, string>(); // runId -> sessionId
  const drafts = new Map<string, Draft>();
  const touch = (id: string, ts: string) => { const d = drafts.get(id); if (d && ts > d.updatedAt) d.updatedAt = ts; };

  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.type) {
      case 'run.started': if (typeof p.id === 'string') runs.set(p.id, { id: p.id, runtime: String(p.runtime ?? 'unknown'), model: typeof p.model === 'string' ? p.model : null, worktreeId: typeof p.worktreeId === 'string' ? p.worktreeId : null, resumedFrom: typeof p.resumedFrom === 'string' ? p.resumedFrom : null, resumedSession: typeof p.resumedSession === 'string' ? p.resumedSession : null, ts: e.ts, source: sourceOf(p), finishedStatus: null, providerSessionId: null, linked: null }); break;
      case 'run.finished': { const r = runs.get(p.id); if (r) { r.finishedStatus = String(p.status ?? 'failed'); if (isProviderSessionId(p.sessionId)) r.providerSessionId = p.sessionId; } break; }
      case 'session.created': if (isSessionId(p.sessionId)) drafts.set(p.sessionId, { id: p.sessionId, runtime: String(p.runtime ?? 'unknown'), model: typeof p.model === 'string' ? p.model : null, title: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 120) : null, worktreeId: typeof p.worktreeId === 'string' ? p.worktreeId : null, createdAt: e.ts, updatedAt: e.ts, pinned: false, archived: false, runIds: [], lastPrompt: null, messages: 0, source: 'user' }); break;
      case 'session.run': if (isSessionId(p.sessionId) && typeof p.runId === 'string') { explicit.set(p.runId, p.sessionId); const d = drafts.get(p.sessionId); if (d && !d.runIds.includes(p.runId)) { d.runIds.push(p.runId); touch(d.id, e.ts); } } break;
      case 'session.linked': { const r = runs.get(p.runId); if (r && isProviderSessionId(p.providerSessionId)) r.linked = p.providerSessionId; break; }
      case 'session.updated': { const d = drafts.get(p.sessionId); if (d) { if (typeof p.title === 'string') d.title = p.title.trim().slice(0, 120) || null; if (typeof p.pinned === 'boolean') d.pinned = p.pinned; if (typeof p.archived === 'boolean') d.archived = p.archived; touch(d.id, e.ts); } break; }
      case 'session.prompt': { const d = drafts.get(p.sessionId); if (d && typeof p.text === 'string') { d.lastPrompt = p.text; d.messages++; touch(d.id, e.ts); } break; }
      case 'session.message': { const d = drafts.get(p.sessionId); if (d) { d.messages++; touch(d.id, e.ts); } break; }
    }
  }

  // Runs that no session event names (a log from before sessions, or a plan run): group by resume links, else a session of their own.
  const resolved = new Map<string, string>();
  const providerToRun = new Map<string, string>();
  // The EARLIEST run that owns a provider session is its head: a later run that resumes it must join that one, not map to itself.
  for (const r of runs.values()) { const id = r.providerSessionId ?? r.linked; if (id && !providerToRun.has(id)) providerToRun.set(id, r.id); }
  const sessionOf = (runId: string, depth = 0): string => {
    const known = resolved.get(runId); if (known) return known;
    const ex = explicit.get(runId);
    let out: string;
    const r = runs.get(runId)!;
    if (ex && drafts.has(ex)) out = ex;
    else if (depth < 50 && r.resumedFrom && runs.has(r.resumedFrom)) out = sessionOf(r.resumedFrom, depth + 1);
    else if (depth < 50 && r.resumedSession && providerToRun.has(r.resumedSession) && providerToRun.get(r.resumedSession) !== runId) out = sessionOf(providerToRun.get(r.resumedSession)!, depth + 1);
    else out = `ses_${runId.replace(/^run_/, '').replace(/[^a-f0-9]/g, '0').padEnd(10, '0').slice(0, 24)}`;
    resolved.set(runId, out);
    return out;
  };
  const byId = new Map<string, { draft: Draft | null; runs: RunInfo[] }>();
  for (const r of runs.values()) {
    const sid = sessionOf(r.id);
    const slot = byId.get(sid) ?? { draft: drafts.get(sid) ?? null, runs: [] };
    slot.runs.push(r); byId.set(sid, slot);
  }
  for (const d of drafts.values()) if (!byId.has(d.id)) byId.set(d.id, { draft: d, runs: [] });

  const out: SessionView[] = [];
  for (const [id, { draft, runs: rs }] of byId) {
    rs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const first = rs[0]; const last = rs[rs.length - 1];
    const provider = [...rs].reverse().map((r) => r.providerSessionId ?? r.linked).find((x): x is string => !!x) ?? null;
    const resumeRun = [...rs].reverse().find((r) => (r.providerSessionId ?? r.linked) && !live.has(r.id)) ?? null;
    let status: SessionStatus = 'idle';
    if (last) {
      if (live.has(last.id)) status = 'running';
      else if (last.finishedStatus === null) status = 'orphaned';
      else if (last.finishedStatus === 'failed') status = 'failed';
      else if (last.finishedStatus === 'stopped') status = 'stopped';
    }
    const runtime = draft?.runtime ?? first?.runtime ?? 'unknown';
    const when = draft?.createdAt ?? first?.ts ?? '';
    out.push({
      id, runtime, model: draft?.model ?? last?.model ?? null,
      title: draft?.title ?? `${runtime === 'claude-code' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : runtime} session`, titleSource: draft?.title ? 'user' : 'default',
      status, createdAt: when, updatedAt: [draft?.updatedAt, last?.ts].filter(Boolean).sort().at(-1) ?? when,
      pinned: draft?.pinned ?? false, archived: draft?.archived ?? false, worktreeId: draft?.worktreeId ?? first?.worktreeId ?? null,
      providerSessionId: provider, runIds: rs.map((r) => r.id), lastRunId: last?.id ?? null, resumeRunId: resumeRun?.id ?? null,
      canResume: !!resumeRun && status !== 'running', source: draft ? (first?.source ?? draft.source) : (first?.source ?? 'user'),
      lastPrompt: draft?.lastPrompt ?? null, messages: draft?.messages ?? 0,
    });
  }
  // Pinned first, then most recently active.
  return out.sort((a, b) => (a.pinned === b.pinned ? (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) : a.pinned ? -1 : 1));
}

/** The session a run belongs to, by the same rules, or null if the run is unknown. */
export function sessionIdOfRun(events: readonly StoredEvent[], runId: string, opts: { live?: ReadonlySet<string> } = {}): string | null {
  return projectSessions(events, opts).find((s) => s.runIds.includes(runId))?.id ?? null;
}

export interface SessionHit { sessionId: string; where: 'title' | 'prompt' | 'message'; snippet: string }

/** Case-insensitive search over titles, and over stored prompt and transcript text when the owner kept any. Text is never searched that was never stored. */
export function searchSessions(events: readonly StoredEvent[], query: string, opts: { live?: ReadonlySet<string> } = {}): SessionHit[] {
  const q = query.trim().toLowerCase();
  if (!q || q.length > 200) return [];
  const sessions = projectSessions(events, opts);
  const hits: SessionHit[] = [];
  const seen = new Set<string>();
  const snip = (t: string) => { const i = t.toLowerCase().indexOf(q); const a = Math.max(0, i - 40); return (a > 0 ? '…' : '') + t.slice(a, a + 160).replace(/\s+/g, ' '); };
  for (const s of sessions) if (s.title.toLowerCase().includes(q)) { hits.push({ sessionId: s.id, where: 'title', snippet: snip(s.title) }); seen.add(`${s.id}:title`); }
  const live = new Map<string, string>(); // run id -> session id
  for (const s of sessions) for (const r of s.runIds) live.set(r, s.id);
  for (const e of events) {
    if (e.type !== 'session.prompt' && e.type !== 'session.message') continue;
    const t = e.payload?.text; const sid = e.payload?.sessionId;
    if (typeof t !== 'string' || !isSessionId(sid) || !t.toLowerCase().includes(q)) continue;
    const where = e.type === 'session.prompt' ? 'prompt' : 'message';
    const key = `${sid}:${where}`; if (seen.has(key)) continue; seen.add(key);
    hits.push({ sessionId: sid, where, snippet: snip(t) });
  }
  return hits.slice(0, 100);
}
