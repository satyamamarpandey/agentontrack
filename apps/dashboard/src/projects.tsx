import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { accountPage, accountsEnabled, saveSummary, signedInHere } from './accounts';
import { get, isDemo, post, setProject } from './api';
import { ChartFrame, fmt, fmtMs, Provenance, StackedBars, Stat, type DataKind } from './charts';
import { buildSummary, buildTimeline, energyKwh, fmtEstimate, loadBaseline, loadFactors, meanSecondsPerTask, meanTokensPerTask, parseBaseline, parseMeasure, pct, saveBaseline, saveFactors, savingText, secondsSaved, tokensSaved, totalTokens, verification, waterLiters, type Baseline, type EnvFactors, type Measured, type TimelineEntry, type TimelineItem } from './metrics';
import { Modal } from './human';
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

function ProjectCard({ p, tick, onOpen, onChanged }: { p: any; tick: number; onOpen: (id: string) => void; onChanged: () => void }) {
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
        {p.missing ? <span className="badge bad">folder missing</span> : <span className="badge muted" title="This project's folder is on this computer">On this computer</span>}
        {p.archived ? <span className="badge muted">archived</span> : null}
      </div>
      <p className="project-goal">{p.goal ?? <span className="muted">No goal set</span>}</p>
      <dl className="project-facts">
        <div><dt>Status</dt><dd data-testid="card-status">{p.activeTask ? <Badge value={p.activeTask.status} /> : <span className="muted">No active task</span>}</dd></div>
        <div><dt>Pending approvals</dt><dd data-testid="card-pending" className={p.pendingApprovals ? 'attention' : ''}>{p.pendingApprovals ?? 0}</dd></div>
        <div><dt>Tokens used</dt><dd data-testid="card-tokens">{a ? (a.totals.sessions ? fmt(totalTokens(a)) : 'Unavailable') : an.error ? 'Unavailable' : '…'}{a?.totals.sessions ? <> <Provenance kind={kind} /></> : null}</dd></div>
        <div><dt>Connection</dt><dd data-testid="card-connection">{p.missing ? 'Folder not found' : isDemo() ? 'Demo' : 'Connected'}</dd></div>
        <div><dt>Last activity</dt><dd data-testid="card-activity">{last ? new Date(last).toLocaleString() : a ? <span className="muted">None recorded</span> : '…'}</dd></div>
      </dl>
      {isDemo() ? null : <div className="row"><button className="btn small card-action" onClick={async () => { await post('/api/projects/update', { id: p.id, archived: !p.archived }); onChanged(); }}>{p.archived ? 'Restore' : 'Archive'}</button></div>}
    </article>
  );
}

function AddProject({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'import' | 'create' | 'github'>('import');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal label="Add a project" onClose={onClose} onSubmit={async (e) => {
      e.preventDefault(); setMsg(''); setBusy(true);
      try {
        if (mode === 'github') await post('/api/projects/clone', { url, dest: path });
        else await post('/api/projects', { path, create: mode === 'create' });
        onDone(); onClose();
      } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
    }}>
      <h2>Add a project</h2>
      <div className="row wrap" role="group" aria-label="How to add it">
        <button type="button" className={`chip ${mode === 'import' ? 'on' : ''}`} aria-pressed={mode === 'import'} onClick={() => setMode('import')}>Import an existing folder</button>
        <button type="button" className={`chip ${mode === 'create' ? 'on' : ''}`} aria-pressed={mode === 'create'} onClick={() => setMode('create')}>Create a new folder</button>
        <button type="button" className={`chip ${mode === 'github' ? 'on' : ''}`} aria-pressed={mode === 'github'} onClick={() => setMode('github')}>From GitHub</button>
      </div>
      <p className="muted small">{mode === 'import' ? 'Attaching writes nothing into the folder. Your goal, approvals and evidence are kept outside it, on this machine.' : mode === 'create' ? 'The folder is created if it does not exist. Nothing is written into it yet.' : 'Copies a GitHub repository to a new folder on this computer, using your own git setup. AgentOnTrack never sees a GitHub password or token. Private repositories work if your git is already signed in.'}</p>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      {mode === 'github' ? <label>GitHub address<input value={url} onChange={(e) => setUrl(e.target.value)} required name="github-url" spellCheck={false} placeholder="https://github.com/owner/repo" data-autofocus /></label> : null}
      <label>{mode === 'github' ? 'New folder on this computer (full path)' : 'Absolute folder path'}<input value={path} onChange={(e) => setPath(e.target.value)} required name="path" spellCheck={false} placeholder="Full path to the folder" {...(mode === 'github' ? {} : { 'data-autofocus': true })} /></label>
      <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" type="submit" disabled={busy}>{mode === 'github' ? (busy ? 'Copying…' : 'Copy and add') : 'Attach'}</button></div>
    </Modal>
  );
}

/** Looks inside one folder the person names, for Git repositories. Nothing is added until they choose. */
function Discover({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [dir, setDir] = useState('');
  const [found, setFound] = useState<{ path: string; name: string; registered: boolean }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const look = async () => {
    setMsg(''); setBusy(true);
    try {
      const r = await post('/api/projects/discover', { dir, depth: 2 });
      setFound(r.found); setTruncated(r.truncated);
      setPicked(new Set(r.found.filter((x: any) => !x.registered).map((x: any) => x.path)));
    } catch (err) { setMsg((err as Error).message); setFound(null); } finally { setBusy(false); }
  };
  const add = async () => {
    setBusy(true); setMsg('');
    try { for (const p of picked) await post('/api/projects', { path: p }); onDone(); onClose(); } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal label="Find projects on this computer" onClose={onClose} wide>
      <h2>Find projects on this computer</h2>
      <p className="muted small">Name one folder, such as where you keep your code. AgentOnTrack looks two levels down for Git repositories there and nowhere else. It reads folder names only, and adds nothing until you choose.</p>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void look(); }}>
        <label className="grow">Folder to look in (full path)<input value={dir} onChange={(e) => setDir(e.target.value)} required name="discover-dir" spellCheck={false} data-autofocus placeholder="Full path to the folder" /></label>
        <button className="btn end-self" type="submit" disabled={busy}>{busy && !found ? 'Looking…' : 'Look'}</button>
      </form>
      {found ? (found.length === 0 ? <Empty>No Git repositories were found in that folder.</Empty> : (
        <div data-testid="discover-results">
          <ul className="list">{found.map((r) => (
            <li key={r.path}>
              <label className="check"><input type="checkbox" disabled={r.registered} checked={r.registered || picked.has(r.path)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(r.path); else n.delete(r.path); setPicked(n); }} /> <b>{r.name}</b> {r.registered ? <span className="badge good">already added</span> : null}</label>
              <div className="muted small mono">{r.path}</div>
            </li>
          ))}</ul>
          {truncated ? <p className="muted small">There are more than this. Look in a smaller folder to see the rest.</p> : null}
        </div>
      )) : null}
      <div className="row end"><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={busy || picked.size === 0} onClick={() => void add()} data-testid="discover-add">Add {picked.size || ''} selected</button></div>
    </Modal>
  );
}

type Sort = 'attention' | 'recent' | 'name';

export function ProjectsHome({ projects, tick, reloadShell, onOpen }: { projects: any[]; tick: number; reloadShell: () => void; onOpen: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [finding, setFinding] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('attention');
  const [archived, setArchived] = useState(false);
  const newest = (x: any, y: any) => String(y.lastEventAt ?? '').localeCompare(String(x.lastEventAt ?? ''));
  const shown = projects
    .filter((p) => (archived ? p.archived : !p.archived))
    .filter((p) => !q.trim() || `${p.name} ${p.goal ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((x, y) => (sort === 'name' ? x.name.localeCompare(y.name) : sort === 'recent' ? newest(x, y) : (y.pendingApprovals ?? 0) - (x.pendingApprovals ?? 0) || newest(x, y)));
  const hidden = projects.filter((p) => p.archived).length;
  return (
    <Page title="My projects" intro="Every project registered on this computer appears here. Open one to work in it." actions={<div className="row wrap"><button className="btn" onClick={() => setFinding(true)} data-testid="find-projects">Find projects on this computer</button><button className="btn primary" onClick={() => setAdding(true)} data-testid="add-project">Add project</button></div>}>
      {adding ? <AddProject onClose={() => setAdding(false)} onDone={reloadShell} /> : null}
      {finding ? <Discover onClose={() => setFinding(false)} onDone={reloadShell} /> : null}
      {projects.length > 1 || hidden ? (
        <div className="toolbar" role="search">
          <label className="sr-only" htmlFor="project-search">Search projects</label>
          <input id="project-search" type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} name="project-search" />
          <label className="sr-only" htmlFor="project-sort">Sort by</label>
          <select id="project-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} name="project-sort">
            <option value="attention">Needs attention first</option><option value="recent">Recently active</option><option value="name">Name</option>
          </select>
          {hidden ? <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived ({hidden})</label> : null}
        </div>
      ) : null}
      {projects.length === 0 ? <Empty>No project is registered on this computer yet. Use Find projects to look in your code folder, or Add project to import a folder, copy one from GitHub or start a new one.</Empty>
        : shown.length === 0 ? <Empty>No project matches.</Empty>
        : <section className="project-grid" aria-label="Your projects">{shown.map((p) => <ProjectCard key={p.id} p={p} tick={tick} onOpen={onOpen} onChanged={reloadShell} />)}</section>}
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
      <Page title={entry.name} intro={entry.root} actions={<div className="row">{entry.activeTask ? <Badge value={entry.activeTask.status} /> : null}<button className="btn primary" data-testid="open-workspace" onClick={() => openScreen('Workspace')}>Open workspace</button></div>}>
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
