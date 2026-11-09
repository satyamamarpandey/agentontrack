import { findDrift } from './drift.js';
import { isPendingLive, type ProjectState } from './state.js';

/**
 * Answers a question from the project record alone, and shows where each part came from. No model is involved, so the answer cannot
 * contain a fact the record does not hold: it is a ranked list of matching entries plus a few fixed kinds of question (what is stale,
 * what is waiting, what changed). When nothing matches it says so. It does not see other tools.
 */
export interface Source { kind: 'decision' | 'note' | 'goal' | 'task' | 'drift' | 'approval'; id: string; ts: string | null; text: string }
export interface Answer { answer: string; sources: Source[]; matched: boolean }

/** Who is asking. A private note is returned only to its owner. */
export interface Viewer { owner: string }

const STOP = new Set(['the', 'and', 'for', 'was', 'are', 'what', 'why', 'who', 'how', 'did', 'does', 'this', 'that', 'with', 'from', 'have', 'has', 'been', 'now', 'our', 'about', 'which', 'when', 'where', 'any', 'all']);
const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
const clip = (t: string, n = 220) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function askRecord(s: ProjectState, question: string, viewer: Viewer, opts: { now?: Date; limit?: number } = {}): Answer {
  const q = question.trim();
  if (!q) return { answer: 'Ask a question about this project.', sources: [], matched: false };
  const limit = opts.limit ?? 5;
  const lower = q.toLowerCase();

  // Fixed kinds of question, answered from fixed parts of the record.
  if (/\b(stale|out of date|old spec|drift|still (follow|use|built))/.test(lower)) {
    const d = findDrift(s);
    if (!d.length) return { answer: 'Nothing is marked as following a replaced decision. This covers only items a person linked to a decision.', sources: [], matched: true };
    const sources: Source[] = d.slice(0, limit).map((x) => ({ kind: 'drift', id: `${x.kind}:${x.ref}`, ts: x.changedAt, text: `${x.kind} ${x.ref} still follows "${x.stale.title}"; now "${x.current.title}" (${x.current.rationale})` }));
    return { answer: `${d.length} item${d.length === 1 ? '' : 's'} still follow a replaced decision.`, sources, matched: true };
  }
  if (/\b(block|blocked|waiting|pending|needs? (me|my|approval))/.test(lower)) {
    const pending = [...s.approvals.values()].filter((a) => isPendingLive(a, opts.now ?? new Date()));
    const sources: Source[] = pending.slice(0, limit).map((a) => ({ kind: 'approval', id: a.id, ts: null, text: `${a.effect.kind} ${a.effect.target}` }));
    return { answer: pending.length ? `${pending.length} action${pending.length === 1 ? ' is' : 's are'} waiting for a person.` : 'No action is waiting for approval.', sources, matched: true };
  }

  // Everything else: rank entries by how many of the question's words they contain; newer entries win ties.
  const qw = new Set(words(q));
  const entries: Source[] = [
    ...s.decisions.map((d): Source => ({ kind: 'decision', id: d.id, ts: d.ts, text: `${d.title}: ${d.rationale}${d.supersededBy ? ' (replaced)' : ''}` })),
    ...s.notes.filter((n) => n.scope === 'project' || n.owner === viewer.owner).map((n): Source => ({ kind: 'note', id: n.id, ts: n.ts, text: `${n.text} (${n.owner}, ${n.scope})` })),
    ...s.goals.map((g): Source => ({ kind: 'goal', id: `goal v${g.version}`, ts: g.ts, text: g.statement })),
    ...[...s.tasks.values()].map((t): Source => ({ kind: 'task', id: t.id, ts: null, text: t.title })),
  ];
  const ranked = entries
    .map((e) => ({ e, score: words(e.text).filter((w) => qw.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.e.ts ?? '').localeCompare(a.e.ts ?? ''))
    .slice(0, limit);
  if (!ranked.length) return { answer: 'Nothing in this project’s record matches that. It does not cover other tools.', sources: [], matched: false };
  const sources = ranked.map((x) => ({ ...x.e, text: clip(x.e.text) }));
  return { answer: `${sources.length} entr${sources.length === 1 ? 'y' : 'ies'} in the record match, best first.`, sources, matched: true };
}
