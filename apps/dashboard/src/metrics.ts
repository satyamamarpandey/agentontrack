// Pure arithmetic over what the companion reports. Nothing here invents a figure: with no input, the answer is `null` and a reason.

export type Measured = { value: number; why?: undefined } | { value: null; why: string };
const none = (why: string): Measured => ({ value: null, why });

export interface Baseline { tokens: number | null; seconds: number | null }
export interface EnvFactors { whPer1kTokens: number | null; litersPerKwh: number | null }

const MAX_TOKENS = 1e12;
const MAX_SECONDS = 1e8;

/** A number the user typed, or null for empty. Throws with a message for anything that cannot be a measurement. */
export function parseMeasure(text: string, what: string, max: number): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${what} must be a number above 0 and no more than ${max.toLocaleString('en')}.`);
  return n;
}

export function parseBaseline(tokens: string, seconds: string): Baseline {
  const b = { tokens: parseMeasure(tokens, 'Tokens', MAX_TOKENS), seconds: parseMeasure(seconds, 'Seconds', MAX_SECONDS) };
  if (b.tokens === null && b.seconds === null) throw new Error('Enter tokens, seconds or both, from a run you did without AgentOnTrack.');
  return b;
}

const read = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };
export const loadBaseline = (project: string) => read<Baseline>(`aot-baseline-${project}`);
export const saveBaseline = (project: string, b: Baseline | null) => { if (b) localStorage.setItem(`aot-baseline-${project}`, JSON.stringify(b)); else localStorage.removeItem(`aot-baseline-${project}`); };
export const loadFactors = (): EnvFactors => read<EnvFactors>('aot-env-factors') ?? { whPer1kTokens: null, litersPerKwh: null };
export const saveFactors = (f: EnvFactors) => localStorage.setItem('aot-env-factors', JSON.stringify(f));

export const totalTokens = (a: any): number => a.totals.input + a.totals.output;

/** Input plus output tokens per task in this project. Cache tokens are left out, as in the benchmarks. */
export function meanTokensPerTask(a: any): Measured {
  if (!a.totals.sessions) return none('No usage has been recorded for this project.');
  if (!a.tasks.length) return none('This project has no tasks, so there is no mean per task.');
  return { value: totalTokens(a) / a.tasks.length };
}

/** Wall clock is recorded only for runs started from the dashboard. */
export function meanSecondsPerTask(a: any): Measured {
  if (!a.time.runs) return none('Time is measured only for runs started from the dashboard, and none is recorded here.');
  if (!a.tasks.length) return none('This project has no tasks, so there is no mean per task.');
  return { value: a.time.runWallClockMs / 1000 / a.tasks.length };
}

function saving(baseline: number | null | undefined, actual: Measured, noBaseline: string): Measured {
  if (actual.value === null) return actual;
  if (baseline === null || baseline === undefined) return none(noBaseline);
  return { value: baseline - actual.value };
}

const NO_TOKENS = 'No baseline for this project. A saving needs a run without AgentOnTrack to compare with, and none has been entered.';
const NO_SECONDS = 'No baseline time for this project. A saving needs a run without AgentOnTrack to compare with, and none has been entered.';
export const tokensSaved = (a: any, b: Baseline | null) => saving(b?.tokens, meanTokensPerTask(a), NO_TOKENS);
export const secondsSaved = (a: any, b: Baseline | null) => saving(b?.seconds, meanSecondsPerTask(a), NO_SECONDS);

/** A negative saving is said as what it is. */
export function savingText(delta: number, unit: string): string {
  const n = Math.round(Math.abs(delta));
  if (n === 0) return 'no difference';
  return delta > 0 ? `saved ${n.toLocaleString('en')} ${unit}` : `cost ${n.toLocaleString('en')} more ${unit}`;
}

const rate = (passed: number, total: number): number | null => (total > 0 ? passed / total : null);
export const pct = (r: number | null) => (r === null ? null : `${Math.round(r * 100)}%`);

/** What the user's own checks showed. It says nothing about the code beyond those checks. */
export function verification(s: any) {
  const progress = s.tasks.map((t: any) => t.evaluation.progress);
  const criteriaPassed: number = progress.reduce((n: number, p: any) => n + p.passed, 0);
  const criteriaTotal: number = progress.reduce((n: number, p: any) => n + p.total, 0);
  const runsPassed: number = s.receipts.filter((r: any) => r.passed).length;
  return {
    criteriaPassed, criteriaTotal, criteriaRate: rate(criteriaPassed, criteriaTotal),
    runsPassed, runsTotal: s.receipts.length as number, runsRate: rate(runsPassed, s.receipts.length),
    openEffects: s.mismatches.filter((m: any) => !m.acknowledged).length as number,
    tasksVerified: s.tasks.filter((t: any) => t.evaluation.status === 'VERIFIED').length as number,
    tasksTotal: s.tasks.length as number,
  };
}

/** Kilowatt-hours for a token count: only ever an estimate, from a factor the user supplied. */
export const energyKwh = (tokens: number, f: EnvFactors) => (f.whPer1kTokens === null ? null : (tokens / 1000) * f.whPer1kTokens / 1000);
export const waterLiters = (tokens: number, f: EnvFactors) => { const k = energyKwh(tokens, f); return k === null || f.litersPerKwh === null ? null : k * f.litersPerKwh; };

export const fmtEstimate = (n: number) => (n === 0 ? '0' : Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 0.01 ? n.toPrecision(3) : n.toExponential(2));

export type TimelineKind = 'goal' | 'task' | 'action' | 'held' | 'blocked' | 'approved' | 'denied' | 'verification' | 'detected';
export interface TimelineItem { key: string; ts: string; seq: number | null; kind: TimelineKind; title: string; detail: string; badge?: string }
export type TimelineEntry = { group: false; item: TimelineItem } | { group: true; key: string; ts: string; items: TimelineItem[] };

const when = (ts: unknown) => (typeof ts === 'string' ? ts : '');
const pathsOf = (mismatches: any) => (Array.isArray(mismatches) ? mismatches.map((m: any) => m.path).filter(Boolean).join(', ') : '');

/** The project's record in time order. Runs of allowed actions fold into one entry, so what a person decided stays easy to see. */
export function buildTimeline(state: any, actions: any[]): TimelineEntry[] {
  const items: TimelineItem[] = [];
  for (const g of state.goals) items.push({ key: `goal-${g.version}`, ts: when(g.ts), seq: null, kind: 'goal', title: `Goal v${g.version} approved`, detail: g.statement, ...(g.fromProposal ? { badge: 'from a proposal' } : {}) });
  for (const t of state.tasks) items.push({ key: `task-${t.id}`, ts: when(t.createdAt), seq: null, kind: 'task', title: `Task created: ${t.title}`, detail: `${t.criteria.length} acceptance check${t.criteria.length === 1 ? '' : 's'}` });
  for (const e of actions) {
    const p = e.payload ?? {};
    if (e.type === 'action.requested') {
      const reason = p.reasons?.[0] ?? (p.effects ?? []).map((x: any) => x.kind).join(', ');
      const kind: TimelineKind = p.decision === 'request_approval' ? 'held' : p.decision === 'deny' ? 'blocked' : 'action';
      items.push({ key: `e-${e.seq}`, ts: when(e.ts), seq: e.seq, kind, title: kind === 'held' ? `Held for approval: ${p.tool}` : kind === 'blocked' ? `Denied by policy: ${p.tool}` : `Allowed: ${p.tool}`, detail: reason });
    } else if (e.type === 'effect.mismatch') {
      items.push({ key: `e-${e.seq}`, ts: when(e.ts), seq: e.seq, kind: 'detected', title: 'Unauthorized change detected afterwards', detail: pathsOf(p.mismatches) });
    } else if (e.type === 'workspace.drift') {
      items.push({ key: `e-${e.seq}`, ts: when(e.ts), seq: e.seq, kind: 'detected', title: 'Files changed while no hook fired', detail: '' });
    }
  }
  for (const a of state.approvals) {
    if (!a.decidedAt) continue;
    const denied = a.status === 'denied' || a.view === 'denied';
    items.push({ key: `apr-${a.id}`, ts: when(a.decidedAt), seq: null, kind: denied ? 'denied' : 'approved', title: `${denied ? 'Denied' : 'Approved'} by a person: ${a.effect.kind}`, detail: a.effect.target, badge: a.view });
  }
  for (const r of state.receipts) items.push({ key: `r-${r.seq}`, ts: when(r.ts), seq: r.seq, kind: 'verification', title: `Check ${r.passed ? 'passed' : 'failed'}: ${r.criterionId}`, detail: `Task ${r.taskId}`, badge: r.passed ? 'pass' : 'fail' });
  items.sort((a, b) => a.ts.localeCompare(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));

  const out: TimelineEntry[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === 'action' && last?.group) last.items.push(item);
    else if (item.kind === 'action') out.push({ group: true, key: item.key, ts: item.ts, items: [item] });
    else out.push({ group: false, item });
  }
  return out;
}

export interface ProjectSummary {
  label: string;
  totals: { inputTokens: number; outputTokens: number; sessions: number; tasks: number; tasksVerified: number; actions: number };
  rates: { criteriaPassing: number | null; verificationRunsPassing: number | null };
}

/** The only thing about a project that may leave this machine, and only if the person asks. Counts and rates, under a label they typed. */
export function buildSummary(label: string, a: any, s: any): ProjectSummary {
  const v = verification(s);
  return {
    label: label.trim().slice(0, 80),
    totals: { inputTokens: a.totals.input, outputTokens: a.totals.output, sessions: a.totals.sessions, tasks: v.tasksTotal, tasksVerified: v.tasksVerified, actions: a.safety.actions },
    rates: { criteriaPassing: v.criteriaRate, verificationRunsPassing: v.runsRate },
  };
}
