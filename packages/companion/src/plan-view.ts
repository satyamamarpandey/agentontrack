import { computeAnalytics, detectProjectFacts, PhasePlanSchema, phaseViews, planSha, type Project, type Registered, type RunFact } from '@agentontrack/core';

/** What a phase plan looks like right now, from the record. Shared by the dashboard's routes and the phone link, so they cannot disagree. */
export const planFacts = (entry: Registered, p: Project) => {
  const a = computeAnalytics(p);
  const n = a.tasks.length;
  return detectProjectFacts(entry.root, { meanSecondsPerTask: n >= 3 && a.time.runs ? a.time.runWallClockMs / 1000 / n : null, tasksInHistory: n });
};

/** A run with no end in the record is only running if this companion still has it going. */
export const planRunFacts = (p: Project, isRunning: (id: string) => boolean): RunFact[] =>
  p.planRuns().map((r) => (r.status === 'running' && !isRunning(r.id) ? { ...r, status: 'failed' } : r));

export function planView(entry: Registered, p: Project, isRunning: (id: string) => boolean) {
  const cur = p.state().plan;
  if (!cur) return { plan: null, facts: planFacts(entry, p) };
  const doc = PhasePlanSchema.parse(cur.doc);
  const facts = planRunFacts(p, isRunning);
  const approved = cur.approvedSha === planSha(doc);
  const views = phaseViews(doc, approved, facts, p.planTasks());
  const mine = facts.filter((r) => doc.phases.some((x) => x.id === r.phaseId));
  return {
    plan: doc, version: cur.version, sha: cur.sha, approved, approvedAt: cur.approvedAt, views, runs: mine,
    spent: { usd: mine.reduce((n, r) => n + (r.costUsd ?? 0), 0), runs: mine.length, minutes: cur.approvedAt ? Math.round((Date.now() - Date.parse(cur.approvedAt)) / 60_000) : 0 },
    facts: planFacts(entry, p),
  };
}
