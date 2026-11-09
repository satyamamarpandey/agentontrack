import type { ProjectState as State } from './state.js';

/**
 * Drift: something a person linked to a decision, after that decision was replaced by a newer one and before the link was moved to the
 * newer one. Found by a fixed rule over the record, so the same record always gives the same answer. It finds only links a person made:
 * it does not guess which files or tickets "follow" a decision, and it cannot see changes made in other tools.
 */
export interface Drift {
  kind: 'task' | 'phase' | 'file';
  ref: string;
  /** The decision the item is still linked to, which is no longer current. */
  stale: { id: string; title: string };
  /** The decision now in force, at the end of the chain of replacements. */
  current: { id: string; title: string; rationale: string; ts: string };
  /** What changed: the current decision's text. */
  changedAt: string;
}

type Decision = State['decisions'][number];

const headOf = (s: State, d: Decision): Decision => {
  let cur = d;
  const seen = new Set<string>();
  while (cur.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = s.decisions.find((x) => x.id === cur.supersededBy);
    if (!next) break;
    cur = next;
  }
  return cur;
};

export function findDrift(s: State): Drift[] {
  const out: Drift[] = [];
  const seen = new Set<string>();
  for (const link of s.decisionLinks) {
    const d = s.decisions.find((x) => x.id === link.decisionId);
    if (!d || !d.supersededBy) continue;
    const head = headOf(s, d);
    // Resolved once the same item is linked to the decision now in force.
    if (s.decisionLinks.some((l) => l.kind === link.kind && l.ref === link.ref && l.decisionId === head.id)) continue;
    const key = `${link.kind}:${link.ref}:${d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: link.kind, ref: link.ref, stale: { id: d.id, title: d.title }, current: { id: head.id, title: head.title, rationale: head.rationale, ts: head.ts }, changedAt: head.ts });
  }
  return out.sort((a, b) => a.changedAt.localeCompare(b.changedAt) || a.ref.localeCompare(b.ref));
}

/** The lines an agent reads at the start of a session. Empty when nothing has drifted. */
export function driftBrief(drift: Drift[]): string[] {
  if (!drift.length) return [];
  const lines = ['Decisions changed. These still follow the old decision. Check them against the new one before building on them:'];
  for (const d of drift.slice(0, 10)) lines.push(`  - ${d.kind} ${d.ref}: now "${d.current.title}" (${d.current.rationale}); it still follows "${d.stale.title}"`);
  if (drift.length > 10) lines.push(`  - and ${drift.length - 10} more`);
  return lines;
}
