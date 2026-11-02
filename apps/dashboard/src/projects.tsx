import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { accountPage, accountsEnabled, saveSummary, signedInHere } from './accounts';
import { get, isDemo, post, setProject } from './api';
import { ChartFrame, fmt, fmtMs, Provenance, StackedBars, Stat, type DataKind } from './charts';
import { buildSummary, buildTimeline, energyKwh, fmtEstimate, loadBaseline, loadFactors, meanSecondsPerTask, meanTokensPerTask, parseBaseline, parseMeasure, pct, saveBaseline, saveFactors, savingText, secondsSaved, tokensSaved, totalTokens, verification, waterLiters, type Baseline, type EnvFactors, type Measured, type TimelineEntry, type TimelineItem } from './metrics';
import { Badge, Empty, Loading, Page, useLoad } from './ui';

export const PROJECT_TABS = ['overview', 'workflow', 'usage', 'verification', 'environment'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
export interface ProjectRoute { id: string; tab: ProjectTab }

const titleCase = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const forProject = (path: string, id: string) => `${path}?project=${encodeURIComponent(id)}`;

/** What a card and a detail page need from the companion's released endpoints. */
const lastActivity = (a: any, actions: any[]): string | null => {
  const times = [...actions.map((e) => e.ts), ...a.usage.map((u: any) => u.ts)].filter(Boolean).sort();
  return times.at(-1) ?? null;
};

function ProjectCard({ p, tick, onOpen }: { p: any; tick: number; onOpen: (id: string) => void }) {
  const skip = p.missing;
  const an = useLoad(() => (skip ? Promise.resolve(null) : get(forProject('/api/analytics', p.id))), [tick, p.id, skip]);
  const ac = useLoad(() => (skip ? Promise.resolve([]) : get<any[]>(forProject('/api/actions', p.id))), [tick, p.id, skip]);
  const a: any = an.data;
  const last = a && ac.data ? lastActivity(a, ac.data) : null;
  const kind: DataKind = a?.totals.providerReported ? 'actual' : a?.totals.sessions ? 'transcript' : 'unavailable';
  return (
    <article className={`card project-card ${p.missing ? 'is-missing' : ''}`} data-testid="project-card" data-project={p.id}>
      <div className="project-card-head">
        <h2>{p.missing ? p.name : <button className="project-open" onClick={() => onOpen(p.id)}>{p.name}</button>}</h2>
        {isDemo() ? <span className="prov prov-demo" data-testid="card-demo-label">Demo data</span> : null}
        {p.missing ? <span className="badge bad">folder missing</span> : null}
      </div>
      <p className="project-goal">{p.goal ?? <span className="muted">No goal set</span>}</p>
      <dl className="project-facts">
        <div><dt>Status</dt><dd data-testid="card-status">{p.activeTask ? <Badge value={p.activeTask.status} /> : <span className="muted">No active task</span>}</dd></div>
        <div><dt>Pending approvals</dt><dd data-testid="card-pending" className={p.pendingApprovals ? 'attention' : ''}>{p.pendingApprovals ?? 0}</dd></div>
        <div><dt>Tokens used</dt><dd data-testid="card-tokens">{a ? (a.totals.sessions ? fmt(totalTokens(a)) : 'Unavailable') : an.error ? 'Unavailable' : '…'}{a?.totals.sessions ? <> <Provenance kind={kind} /></> : null}</dd></div>
        <div><dt>Last activity</dt><dd data-testid="card-activity">{last ? new Date(last).toLocaleString() : a ? <span className="muted">None recorded</span> : '…'}</dd></div>
      </dl>
    </article>
  );
}

export function ProjectsHome({ projects, tick, reloadShell, onOpen }: { projects: any[]; tick: number; reloadShell: () => void; onOpen: (id: string) => void }) {
  const [path, setPath] = useState('');
  const [create, setCreate] = useState(false);
  const [msg, setMsg] = useState('');
  return (
    <Page title="Projects" intro="Each project has its own local record, read from the companion on this machine. Open one for its workflow, usage, verification and environment.">
      {projects.length === 0 ? <Empty>No project attached yet. Attach a folder below.</Empty> : <section className="project-grid" aria-label="Your projects">{projects.map((p) => <ProjectCard key={p.id} p={p} tick={tick} onOpen={onOpen} />)}</section>}
      <details className="card attach" open={projects.length === 0}>
        <summary>Attach another project</summary>
        <form className="row wrap" onSubmit={async (e) => { e.preventDefault(); try { await post('/api/projects', { path, create }); setPath(''); setMsg(''); reloadShell(); } catch (err) { setMsg((err as Error).message); } }}>
          <p className="muted small full">Attaching writes nothing into the folder.</p>
          <label className="grow">Absolute folder path<input value={path} onChange={(e) => setPath(e.target.value)} required name="path" spellCheck={false} /></label>
          <label className="check"><input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} /> Create if missing</label>
          <button className="btn primary end-self" type="submit">Attach</button>
          {msg ? <div className="alert bad full" role="alert">{msg}</div> : null}
        </form>
      </details>
    </Page>
  );
}

function Tabs({ tab, onTab }: { tab: ProjectTab; onTab: (t: ProjectTab) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const key = (e: KeyboardEvent) => {
    const i = PROJECT_TABS.indexOf(tab);
    const n = PROJECT_TABS.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onTab(PROJECT_TABS[to]!);
    refs.current[PROJECT_TABS[to]!]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="Project sections" onKeyDown={key}>
      {PROJECT_TABS.map((t) => <button key={t} ref={(el) => { refs.current[t] = el; }} id={`tab-${t}`} role="tab" aria-selected={tab === t} aria-controls="project-panel" tabIndex={tab === t ? 0 : -1} className={tab === t ? 'on' : ''} data-testid={`project-tab-${t}`} onClick={() => onTab(t)}>{titleCase(t)}</button>)}
    </div>
  );
}

/** A measure with its value, or the word Unavailable and one line saying why. */
function Measure({ label, value, why, kind, testid, children }: { label: string; value: ReactNode | null; why?: string; kind?: DataKind; testid: string; children?: ReactNode }) {
  return (
    <div className="stat measure" data-testid={testid}>
      <span className="stat-label">{label}</span>
      {value === null ? <><span className="stat-value unavailable">Unavailable</span><span className="muted small">{why}</span></> : <><span className="stat-value">{value}</span>{kind ? <Provenance kind={kind} /> : null}</>}
      {children}
    </div>
  );
}

const BASELINE_LABEL = 'Your baseline, entered by you';
const savedValue = (m: Measured, unit: string) => (m.value === null ? null : savingText(m.value, unit));

function WaterSaved({ a, baseline, factors, testid }: { a: any; baseline: Baseline | null; factors: EnvFactors; testid: string }) {
  const saved = tokensSaved(a, baseline);
  const noFactors = factors.whPer1kTokens === null || factors.litersPerKwh === null;
  const liters = saved.value !== null && !noFactors ? waterLiters(Math.abs(saved.value), factors) : null;
  const why = saved.value === null ? 'Needs a measured tokens-saved figure, which needs your baseline.' : 'Needs your energy and water factors. Vendors publish no per-request figures.';
  const word = saved.value !== null && saved.value < 0 ? 'more used' : 'saved';
  return <Measure label="Water saved" testid={testid} value={liters === null ? null : <>{fmtEstimate(liters)} L {word}</>} why={why}>{liters === null ? null : <span className="prov prov-estimated">ESTIMATE</span>}</Measure>;
}

function SummarySaver({ a, s, projectId }: { a: any; s: any; projectId: string }) {
  const [on, setOn] = useState(false);
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = buildSummary(label, a, s);
  return (
    <section className="card stack" data-testid="summary-saver">
      <h2>Save a summary to your account</h2>
      {!signedInHere() ? <p className="muted small">Optional. <a href={accountPage()} target="_blank" rel="noopener">Sign in on the account page</a> in a new tab, then come back. Nothing here needs an account.</p> : <>
        <label className="check"><input type="checkbox" checked={on} data-testid="summary-toggle" onChange={(e) => { setOn(e.target.checked); setMsg(''); }} /> Save a summary of this project</label>
        <p className="muted small">Off unless you turn it on. Only the counts in the preview are sent, to your own account in Firebase. Never code, prompts, paths, commands, goals or records.</p>
        {on ? <>
          <label>Label for this summary, chosen by you<input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} name="summary-label" data-testid="summary-label" /></label>
          <pre className="code small" tabIndex={0} data-testid="summary-preview">{JSON.stringify(preview, null, 2)}</pre>
          <div><button className="btn primary" disabled={busy || !preview.label} onClick={async () => { setBusy(true); setMsg(''); try { await saveSummary(projectId, preview); setMsg('Saved to your account.'); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } }}>Save summary</button></div>
          {msg ? <p className="small" role="status" data-testid="summary-status">{msg}</p> : null}
        </> : null}
      </>}
    </section>
  );
}

function OverviewTab({ a, s, projectId, onTab, go }: { a: any; s: any; projectId: string; onTab: (t: ProjectTab) => void; go: (screen: string) => void }) {
  const baseline = loadBaseline(projectId);
  const v = verification(s);
  const tok = tokensSaved(a, baseline);
  const sec = secondsSaved(a, baseline);
  const pending = s.approvals.filter((x: any) => x.view === 'pending').length;
  return (
    <>
      {!s.integrity.ok ? <div className="alert bad" role="alert"><b>Log integrity problem.</b> {s.integrity.problems.join(' ')}</div> : null}
      {pending ? <button className="alert warn as-button" onClick={() => go('Approvals')}><b>{pending} approval{pending > 1 ? 's' : ''} waiting.</b> Review now →</button> : null}
      <section className="grid two">
        <div className="card">
          <h2 className="eyebrow">Current goal</h2>
          {s.goal ? <><p className="lead">{s.goal.statement}</p><p className="muted small">Version {s.goal.version} · {s.goal.status} · scope {s.goal.scope.include.join(', ')}</p></> : <Empty>No approved goal. <button className="link" onClick={() => go('Goals')}>Set one</button></Empty>}
        </div>
        <div className="card">
          <h2 className="eyebrow">Active task</h2>
          {s.activeTask ? <>
            <p className="lead">{s.activeTask.title} <Badge value={s.activeTask.evaluation.status} /></p>
            <p className="muted small">{s.activeTask.evaluation.progress.passed} of {s.activeTask.evaluation.progress.total} criteria have current passing evidence</p>
          </> : <Empty>No active task. <button className="link" onClick={() => go('Goals')}>Create one</button></Empty>}
        </div>
      </section>
      <section className="stats wide" aria-label="At a glance">
        <Measure label="Tokens saved" testid="glance-tokens-saved" value={savedValue(tok, 'tokens')} why={tok.why}>{tok.value === null ? null : <span className="muted small">{BASELINE_LABEL}</span>}</Measure>
        <Measure label="Time saved" testid="glance-time-saved" value={savedValue(sec, 'seconds')} why={sec.why}>{sec.value === null ? null : <span className="muted small">{BASELINE_LABEL}</span>}</Measure>
        <Measure label="Verification: criteria passing" testid="glance-verification" value={pct(v.criteriaRate)} why="This project has no acceptance criteria yet." kind="record">{v.criteriaRate === null ? null : <span className="muted small">{v.criteriaPassed} of {v.criteriaTotal}, from your own checks</span>}</Measure>
        <WaterSaved a={a} baseline={baseline} factors={loadFactors()} testid="glance-water-saved" />
      </section>
      <p className="row wrap small"><button className="link" onClick={() => onTab('workflow')}>See the workflow →</button><button className="link" onClick={() => go('Evidence')}>Evidence</button><button className="link" onClick={() => go('Safety')}>Safety</button><button className="link" onClick={() => go('Goals')}>Goals and tasks</button></p>
      {accountsEnabled() && !isDemo() ? <SummarySaver a={a} s={s} projectId={projectId} /> : null}
    </>
  );
}

const KIND_LABEL: Record<TimelineItem['kind'], string> = { goal: 'Goal', task: 'Task', action: 'Action', held: 'Held', blocked: 'Denied', approved: 'Approved', denied: 'Denied', verification: 'Verification', detected: 'Detected' };
const Stamp = ({ ts }: { ts: string }) => (ts ? <time className="muted small" dateTime={ts}>{new Date(ts).toLocaleString()}</time> : null);

function TimelineRow({ item, open }: { item: TimelineItem; open: (seq: number) => void }) {
  return (
    <li className={`tl-item tl-${item.kind}`} data-testid="timeline-item" data-kind={item.kind}>
      <div className="tl-body">
        <div className="row wrap"><span className="tl-kind">{KIND_LABEL[item.kind]}</span><b className="tl-title">{item.title}</b>{item.badge ? <Badge value={item.badge} /> : null}</div>
        {item.detail ? <p className="small tl-detail">{item.detail}</p> : null}
        <div className="row wrap"><Stamp ts={item.ts} />{item.seq !== null ? <button className="link small" onClick={() => open(item.seq!)}>source</button> : null}</div>
      </div>
    </li>
  );
}

function WorkflowTab({ s, actions, open, go }: { s: any; actions: any[]; open: (seq: number) => void; go: (screen: string) => void }) {
  const entries: TimelineEntry[] = buildTimeline(s, actions);
  if (!entries.length) return <Empty>Nothing recorded yet. <button className="link" onClick={() => go('Goals')}>Set a goal</button> to start the record.</Empty>;
  return (
    <section className="card">
      <h2>From goal to verification</h2>
      <p className="muted small">In time order, from this project's local record. Each source link shows the record behind a step.{actions.length >= 200 ? ' Showing the latest 200 action records.' : ''}</p>
      <ol className="timeline" data-testid="timeline">
        {entries.map((e) => (e.group
          ? <li key={e.key} className="tl-item tl-action" data-testid="timeline-group" data-count={e.items.length}>
              <details className="tl-body"><summary>{e.items.length} allowed action{e.items.length === 1 ? '' : 's'} <Stamp ts={e.ts} /></summary><ol className="timeline nested">{e.items.map((i) => <TimelineRow key={i.key} item={i} open={open} />)}</ol></details>
            </li>
          : <TimelineRow key={e.item.key} item={e.item} open={open} />))}
      </ol>
    </section>
  );
}

function BaselineForm({ projectId, baseline, onChange }: { projectId: string; baseline: Baseline | null; onChange: () => void }) {
  const [tokens, setTokens] = useState(baseline?.tokens?.toString() ?? '');
  const [seconds, setSeconds] = useState(baseline?.seconds?.toString() ?? '');
  const [msg, setMsg] = useState('');
  return (
    <form className="card stack" data-testid="baseline-form" onSubmit={(e) => { e.preventDefault(); try { saveBaseline(projectId, parseBaseline(tokens, seconds)); setMsg(''); onChange(); } catch (err) { setMsg((err as Error).message); } }}>
      <h2>{BASELINE_LABEL}</h2>
      <p className="muted small">From a run you did without AgentOnTrack, on a similar task. It stays in this browser and is not checked by anyone. A saving above is only as good as this comparison, which is not a controlled experiment.</p>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      <div className="row wrap">
        <label className="grow">Input + output tokens<input inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} name="baseline-tokens" /></label>
        <label className="grow">Seconds<input inputMode="decimal" value={seconds} onChange={(e) => setSeconds(e.target.value)} name="baseline-seconds" /></label>
      </div>
      <div className="row wrap">
        <button className="btn primary" type="submit">Save baseline</button>
        {baseline ? <button className="btn" type="button" onClick={() => { saveBaseline(projectId, null); setTokens(''); setSeconds(''); onChange(); }}>Remove baseline</button> : null}
      </div>
    </form>
  );
}

function UsageTab({ a, projectId }: { a: any; projectId: string }) {
  const [, redraw] = useState(0);
  const baseline = loadBaseline(projectId);
  const kind: DataKind = a.totals.providerReported ? 'actual' : a.totals.sessions ? 'transcript' : 'unavailable';
  const tok = tokensSaved(a, baseline);
  const sec = secondsSaved(a, baseline);
  const meanT = meanTokensPerTask(a);
  const meanS = meanSecondsPerTask(a);
  const series = [{ key: 'input', label: 'Input', color: 'var(--s1)' }, { key: 'output', label: 'Output', color: 'var(--s2)' }, { key: 'cacheCreate', label: 'Cache write', color: 'var(--s3)' }];
  return (
    <>
      <section className="stats">
        <Stat label="Input + output tokens" value={a.totals.sessions ? fmt(totalTokens(a)) : 'Unavailable'} {...(a.totals.sessions ? {} : { sub: 'No usage recorded for this project.' })} kind={kind} />
        <Stat label="Cache read" value={a.totals.sessions ? fmt(a.totals.cacheRead) : 'Unavailable'} kind={kind} />
        <Stat label="List-price cost" value={a.totals.costUsd === null ? 'Unavailable' : `$${a.totals.costUsd.toFixed(4)}`} sub={a.totals.costUsd === null ? 'No cost was reported for these sessions.' : 'List price, not necessarily what you pay'} kind={a.totals.costUsd === null ? 'unavailable' : 'actual'} />
        <Stat label="Run wall clock" value={a.time.runs ? fmtMs(a.time.runWallClockMs) : 'Unavailable'} sub={a.time.runs ? `${a.time.runs} run${a.time.runs === 1 ? '' : 's'}` : 'Measured only for runs started from the dashboard.'} kind={a.time.runs ? 'record' : 'unavailable'} />
        <Stat label="Waiting for approval" value={a.approvals.medianWaitMs === null ? 'Unavailable' : fmtMs(a.time.approvalWaitMs)} {...(a.approvals.medianWaitMs === null ? { sub: 'No approval has been decided.' } : {})} kind={a.approvals.medianWaitMs === null ? 'unavailable' : 'record'} />
        <Stat label="Verification time" value={a.time.verificationMs ? fmtMs(a.time.verificationMs) : 'Unavailable'} {...(a.time.verificationMs ? {} : { sub: 'No timed check has run.' })} kind={a.time.verificationMs ? 'record' : 'unavailable'} />
      </section>
      <section className="card stack" data-testid="savings">
        <h2>Saved against your baseline</h2>
        <section className="stats">
          <Measure label="Tokens per task" testid="saved-tokens" value={savedValue(tok, 'tokens')} why={tok.why}>{tok.value === null ? null : <span className="muted small">{BASELINE_LABEL}: {baseline!.tokens!.toLocaleString('en')}. Actual mean per task: {Math.round(meanT.value!).toLocaleString('en')}, over {a.tasks.length} task{a.tasks.length === 1 ? '' : 's'}.</span>}</Measure>
          <Measure label="Time per task" testid="saved-time" value={savedValue(sec, 'seconds')} why={sec.why}>{sec.value === null ? null : <span className="muted small">{BASELINE_LABEL}: {baseline!.seconds!.toLocaleString('en')} s. Actual mean per task: {Math.round(meanS.value!).toLocaleString('en')} s, over {a.tasks.length} task{a.tasks.length === 1 ? '' : 's'}.</span>}</Measure>
        </section>
        <p className="muted small">AgentOnTrack's own benchmarks found it costs more tokens and time, and those averages are never used here. Tokens are input plus output; cache tokens are left out.</p>
      </section>
      <BaselineForm key={JSON.stringify(baseline)} projectId={projectId} baseline={baseline} onChange={() => redraw((n) => n + 1)} />
      {a.byDay.some((d: any) => d.input || d.output || d.cacheCreate) ? <ChartFrame title="Tokens by day" kind={kind} table={<table><thead><tr><th>Day</th><th>Input</th><th>Output</th><th>Cache write</th></tr></thead><tbody>{a.byDay.map((d: any) => <tr key={d.day}><td>{d.day}</td><td>{fmt(d.input)}</td><td>{fmt(d.output)}</td><td>{fmt(d.cacheCreate)}</td></tr>)}</tbody></table>}>
        <StackedBars rows={a.byDay} x="day" series={series} label="Input, output and cache-write tokens per day" />
      </ChartFrame> : null}
    </>
  );
}

function VerificationTab({ s, open }: { s: any; open: (seq: number) => void }) {
  const v = verification(s);
  return (
    <>
      <p className="alert warn" role="note" data-testid="verification-scope">Verification means your own checks, run by AgentOnTrack on the current code. It says nothing about the code beyond what those checks test.</p>
      <section className="stats wide">
        <Measure label="Criteria with current passing evidence" testid="verify-criteria" value={pct(v.criteriaRate)} why="This project has no acceptance criteria yet." kind="record">{v.criteriaRate === null ? null : <span className="muted small">{v.criteriaPassed} of {v.criteriaTotal}</span>}</Measure>
        <Measure label="Verification runs that passed" testid="verify-runs" value={pct(v.runsRate)} why="No verification has run yet." kind="record">{v.runsRate === null ? null : <span className="muted small">{v.runsPassed} of {v.runsTotal}{v.runsTotal >= 200 ? ', latest 200' : ''}</span>}</Measure>
        <Stat label="Open unauthorized effects" value={v.openEffects} sub="Network and process effects of opaque programs cannot be observed." kind="record" />
        <Stat label="Tasks verified" value={`${v.tasksVerified} / ${v.tasksTotal}`} kind="record" />
      </section>
      <section className="card">
        <h2>Tasks</h2>
        {s.tasks.length === 0 ? <Empty>No tasks yet.</Empty> : <ul className="list">{[...s.tasks].reverse().map((t: any) => <li key={t.id}><b>{t.title}</b> <Badge value={t.evaluation.status} /><ul className="muted small plain">{t.evaluation.criteria.map((c: any) => <li key={c.id}><Badge value={c.state} /> {t.criteria.find((x: any) => x.id === c.id)?.description ?? c.id}</li>)}</ul></li>)}</ul>}
      </section>
      <section className="card">
        <h2>Verification runs</h2>
        {s.receipts.length === 0 ? <Empty>No runs yet. Use Verify now under Goals.</Empty> : <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col">When</th><th scope="col">Criterion</th><th scope="col">Result</th><th scope="col">Source</th><th scope="col"><span className="sr-only">Record</span></th></tr></thead>
          <tbody>{s.receipts.map((r: any) => <tr key={r.seq} data-testid="verify-run"><td>{new Date(r.ts).toLocaleString()}</td><td>{r.criterionId}</td><td><Badge value={r.passed ? 'pass' : 'fail'} /></td><td>{r.source}</td><td><button className="link small" onClick={() => open(r.seq)}>source</button></td></tr>)}</tbody>
        </table></div>}
      </section>
    </>
  );
}

function EnvironmentTab({ a, projectId }: { a: any; projectId: string }) {
  const [factors, setFactors] = useState<EnvFactors>(loadFactors);
  const [wh, setWh] = useState(factors.whPer1kTokens?.toString() ?? '');
  const [liters, setLiters] = useState(factors.litersPerKwh?.toString() ?? '');
  const [msg, setMsg] = useState('');
  const baseline = loadBaseline(projectId);
  const tokens = a.totals.sessions ? totalTokens(a) : null;
  const kwh = tokens === null ? null : energyKwh(tokens, factors);
  const water = tokens === null ? null : waterLiters(tokens, factors);
  const noTokens = 'No usage has been recorded for this project.';
  const est = <span className="prov prov-estimated">ESTIMATE</span>;
  return (
    <>
      <p className="muted" data-testid="env-vendors">Vendors do not publish per-request energy or water figures, so AgentOnTrack has no default for either. Any number here is your factor multiplied by this project's recorded tokens.</p>
      <section className="stats wide">
        <Measure label="Energy" testid="env-energy" value={kwh === null ? null : <>{fmtEstimate(kwh)} kWh</>} why={tokens === null ? noTokens : 'Needs your energy factor below.'}>{kwh === null ? null : est}</Measure>
        <Measure label="Water" testid="env-water" value={water === null ? null : <>{fmtEstimate(water)} L</>} why={tokens === null ? noTokens : 'Needs both of your factors below.'}>{water === null ? null : est}</Measure>
        <WaterSaved a={a} baseline={baseline} factors={factors} testid="env-water-saved" />
      </section>
      <form className="card stack" data-testid="env-factors" onSubmit={(e) => { e.preventDefault(); try { const f = { whPer1kTokens: parseMeasure(wh, 'Energy factor', 1e6), litersPerKwh: parseMeasure(liters, 'Water factor', 1e6) }; saveFactors(f); setFactors(f); setMsg(''); } catch (err) { setMsg((err as Error).message); } }}>
        <h2>Your factors</h2>
        <p className="muted small">Empty until you enter them, and kept in this browser. Choose a source you trust: the result is only as good as the factor. Tokens used are input plus output, not cache.</p>
        {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
        <div className="row wrap">
          <label className="grow">Energy (Wh per 1k tokens)<input inputMode="decimal" value={wh} onChange={(e) => setWh(e.target.value)} name="wh-per-1k" /></label>
          <label className="grow">Water (L per kWh)<input inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value)} name="l-per-kwh" /></label>
        </div>
        <div><button className="btn primary" type="submit">Use these factors</button></div>
      </form>
    </>
  );
}

export function ProjectDetail({ route, projects, tick, onTab, onBack, open, go }: { route: ProjectRoute; projects: any[]; tick: number; onTab: (t: ProjectTab) => void; onBack: () => void; open: (seq: number) => void; go: (screen: string) => void }) {
  const id = route.id;
  const entry = projects.find((p) => p.id === id);
  const st = useLoad<any>(() => get(forProject('/api/state', id)), [tick, id]);
  const an = useLoad<any>(() => get(forProject('/api/analytics', id)), [tick, id]);
  const ac = useLoad<any[]>(() => get(forProject('/api/actions', id)), [tick, id]);
  const back = <button className="link back" onClick={onBack}>← All projects</button>;
  if (!entry) return <>{back}<Empty>This project is not attached any more.</Empty></>;
  if (entry.missing) return <>{back}<div className="alert bad" role="alert">The folder for {entry.name} is missing, so its record cannot be read.</div></>;
  if (!st.data || !an.data || !ac.data) return <>{back}<Loading error={st.error || an.error || ac.error} /></>;
  const openScreen = (screen: string) => { setProject(id); go(screen); };
  return (
    <>
      {back}
      <Page title={entry.name} intro={entry.root} actions={entry.activeTask ? <Badge value={entry.activeTask.status} /> : undefined as any}>
        <Tabs tab={route.tab} onTab={onTab} />
        <div id="project-panel" role="tabpanel" aria-labelledby={`tab-${route.tab}`} className="panel" tabIndex={-1} data-testid={`project-panel-${route.tab}`}>
          {route.tab === 'overview' ? <OverviewTab a={an.data} s={st.data} projectId={id} onTab={onTab} go={openScreen} /> : null}
          {route.tab === 'workflow' ? <WorkflowTab s={st.data} actions={ac.data} open={open} go={openScreen} /> : null}
          {route.tab === 'usage' ? <UsageTab a={an.data} projectId={id} /> : null}
          {route.tab === 'verification' ? <VerificationTab s={st.data} open={open} /> : null}
          {route.tab === 'environment' ? <EnvironmentTab a={an.data} projectId={id} /> : null}
        </div>
      </Page>
    </>
  );
}
