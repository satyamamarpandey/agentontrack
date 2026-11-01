import type { Project } from './project.js';
import { approvalView } from './state.js';
import type { StoredEvent } from './types.js';

export type DataKind = 'actual' | 'derived-from-transcript' | 'benchmark' | 'estimated' | 'unavailable';

export interface UsageRow {
  seq: number;
  ts: string;
  day: string;
  taskId: string | null;
  runtime: string;
  model: string;
  source: 'provider-reported' | 'transcript-derived';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  costBasis: string | null;
  durationMs: number | null;
  sessionId: string | null;
}

/**
 * Usage is per session. Transcript figures are cumulative snapshots, so only the latest counts, and a
 * provider-reported figure for a session replaces any transcript figure for it.
 */
export function usageRows(events: StoredEvent[]): UsageRow[] {
  const provider: UsageRow[] = [];
  const transcript = new Map<string, UsageRow>();
  for (const e of events) {
    if (e.type !== 'usage.recorded') continue;
    const p = e.payload;
    const row: UsageRow = {
      seq: e.seq, ts: e.ts, day: e.ts.slice(0, 10), taskId: e.taskId, runtime: p.runtime, model: p.model, source: p.source,
      inputTokens: p.inputTokens ?? 0, outputTokens: p.outputTokens ?? 0, cacheReadTokens: p.cacheReadTokens ?? 0, cacheCreationTokens: p.cacheCreationTokens ?? 0,
      costUsd: p.costUsd ?? null, costBasis: p.costBasis ?? null, durationMs: p.durationMs ?? null, sessionId: p.sessionId ?? null,
    };
    if (p.source === 'provider-reported') provider.push(row);
    else transcript.set(p.sessionId ?? `seq${e.seq}`, row);
  }
  const covered = new Set(provider.map((r) => r.sessionId));
  return [...provider, ...[...transcript.values()].filter((r) => !covered.has(r.sessionId))].sort((a, b) => a.seq - b.seq);
}

export function computeAnalytics(p: Project) {
  const events = p.store.byType(['usage.recorded', 'action.requested', 'effect.mismatch', 'effect.reverted', 'evidence.recorded', 'run.started', 'run.finished', 'approval.requested', 'approval.granted', 'approval.denied', 'workspace.drift']);
  const s = p.state();
  const now = new Date();
  const usage = usageRows(events);
  const actions = events.filter((e) => e.type === 'action.requested');
  const count = (d: string) => actions.filter((a) => a.payload.decision === d).length;
  const loopDenied = actions.filter((a) => a.payload.decision === 'deny' && (a.payload.reasons ?? []).some((r: string) => /repeated|budget/i.test(r))).length;
  const repeatWarned = actions.filter((a) => (a.payload.warnings ?? []).some((w: string) => /repeated|failed earlier/i.test(w))).length;
  const byAssurance: Record<string, number> = {};
  for (const a of actions) byAssurance[a.payload.assurance] = (byAssurance[a.payload.assurance] ?? 0) + 1;

  const byDay = new Map<string, { day: string; allow: number; deny: number; request_approval: number; unsupported: number; input: number; output: number; cacheRead: number; cacheCreate: number }>();
  const dayRow = (day: string) => {
    let r = byDay.get(day);
    if (!r) { r = { day, allow: 0, deny: 0, request_approval: 0, unsupported: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }; byDay.set(day, r); }
    return r;
  };
  for (const a of actions) (dayRow(a.ts.slice(0, 10)) as any)[a.payload.decision]++;
  for (const u of usage) {
    const r = dayRow(u.day);
    r.input += u.inputTokens; r.output += u.outputTokens; r.cacheRead += u.cacheReadTokens; r.cacheCreate += u.cacheCreationTokens;
  }

  const group = (key: 'model' | 'runtime') => {
    const m = new Map<string, { name: string; input: number; output: number; cacheRead: number; cacheCreate: number; costUsd: number; sessions: number }>();
    for (const u of usage) {
      const r = m.get(u[key]) ?? { name: u[key], input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, sessions: 0 };
      r.input += u.inputTokens; r.output += u.outputTokens; r.cacheRead += u.cacheReadTokens; r.cacheCreate += u.cacheCreationTokens; r.costUsd += u.costUsd ?? 0; r.sessions++;
      m.set(u[key], r);
    }
    return [...m.values()];
  };

  const tasks = [...s.tasks.values()].map((t) => ({ id: t.id, title: t.title, closed: t.closed ?? null, createdAt: t.createdAt, actions: s.actionCounts.get(t.id) ?? 0, ...p.evaluate(t.id) }));
  const taskTotals: Record<string, number> = {};
  for (const t of tasks) taskTotals[t.status] = (taskTotals[t.status] ?? 0) + 1;

  const runs = events.filter((e) => e.type === 'run.finished').map((e) => ({ seq: e.seq, ...e.payload }));
  const approvals = [...s.approvals.values()].filter((a) => !a.id.endsWith('_portable'));
  const views: Record<string, number> = {};
  for (const a of approvals) { const v = approvalView(a, now); views[v] = (views[v] ?? 0) + 1; }
  const waits = approvals.filter((a) => a.decidedAt).map((a) => new Date(a.decidedAt!).getTime() - new Date(a.requestedAt).getTime());
  const verifyMs = s.receipts.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const costed = usage.filter((u) => u.costUsd !== null);

  return {
    totals: {
      input: usage.reduce((n, u) => n + u.inputTokens, 0),
      output: usage.reduce((n, u) => n + u.outputTokens, 0),
      cacheRead: usage.reduce((n, u) => n + u.cacheReadTokens, 0),
      cacheCreate: usage.reduce((n, u) => n + u.cacheCreationTokens, 0),
      costUsd: costed.length ? costed.reduce((n, u) => n + (u.costUsd ?? 0), 0) : null,
      costBasis: costed[0]?.costBasis ?? null,
      sessions: usage.length,
      providerReported: usage.filter((u) => u.source === 'provider-reported').length,
      transcriptDerived: usage.filter((u) => u.source === 'transcript-derived').length,
    },
    usage,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: group('model'),
    byRuntime: group('runtime'),
    safety: {
      actions: actions.length,
      allow: count('allow'), deny: count('deny'), requestApproval: count('request_approval'), unsupported: count('unsupported'),
      byAssurance,
      detectedAfter: s.mismatches.length,
      reverted: s.mismatches.filter((m) => m.reverted && !m.reverted.startsWith('NOT')).length,
      unresolved: s.mismatches.filter((m) => !m.acknowledged).length,
      // A block a human then approved is a candidate false positive. Whether it truly was one needs human judgement.
      blocksHumanApproved: views.approved ?? 0,
      blocksHumanApprovedAndUsed: views.consumed ?? 0,
      loopDenied, repeatWarned,
      // Share of attempted actions that fell outside the goal's scope: a measured sign of drift, not of intent.
      goalDrift: { outOfScope: actions.filter((a) => (a.payload.verdicts ?? []).some((v: any) => /outside the scope|excluded by goal/.test(v.reason ?? ''))).length, of: actions.length },
      missed: { kind: 'unavailable' as DataKind, note: 'Missed violations cannot be counted in real use: a miss leaves no record. See benchmark results.' },
    },
    approvals: { views, medianWaitMs: waits.length ? [...waits].sort((a, b) => a - b)[Math.floor(waits.length / 2)]! : null },
    time: {
      runWallClockMs: runs.reduce((n, r: any) => n + (r.wallClockMs ?? 0), 0),
      runApiMs: runs.reduce((n, r: any) => n + (r.durationApiMs ?? 0), 0),
      approvalWaitMs: waits.reduce((a, b) => a + b, 0),
      verificationMs: verifyMs,
      runs: runs.length,
    },
    tasks, taskTotals, runs,
    goals: { current: s.goal, versions: s.goals.length, status: s.goal?.status ?? null },
  };
}
