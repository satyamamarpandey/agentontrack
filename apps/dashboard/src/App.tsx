import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { PROJECT_TABS, ProjectDetail, ProjectsHome, type ProjectRoute, type ProjectTab } from './projects';
import { Badge, Empty, Loading, Page, useLoad } from './ui';
import { currentPort, currentProject, downloadExport, enterDemo, forgetSession, get, isDemo, leaveDemo, localAddress, onPublicSite, pair, post, resumeSession, setPort, setProject, setTerminalPrompt, subscribe } from './api';
import { ChartFrame, fmt, fmtMs, HBars, Provenance, StackedBars, Stat } from './charts';

const SCREENS = ['Projects', 'Overview', 'Goals', 'Agents', 'Usage', 'Comparisons', 'Evidence', 'Safety', 'Approvals', 'Evaluations', 'Environment', 'Feedback', 'Settings'] as const;
type Screen = (typeof SCREENS)[number];
type Reload = () => void;

/** Escape closes a dialog wherever focus is. WebKit does not always focus what was clicked, so a handler on the dialog can miss it. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
}

/** Every human action goes through this: a fresh code from the companion, typed back, plus the passphrase if enrolled. */
function HumanDialog({ title, detail, submit, onClose, onDone }: { title: string; detail?: ReactNode; submit: (proof: Record<string, string>) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const [ch, setCh] = useState<{ challengeId: string; code: string | null; inTerminal?: boolean; needsPassphrase: boolean } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEscape(onClose);
  const fresh = useCallback(() => { post('/api/challenge').then(setCh).catch((e) => setError(e.message)); }, []);
  useEffect(fresh, [fresh]);
  useEffect(() => { ref.current?.focus(); }, [ch]);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!ch) return;
    setBusy(true); setError('');
    try {
      await submit({ challengeId: ch.challengeId, confirm, ...(ch.needsPassphrase ? { passphrase } : {}) });
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setConfirm('');
      fresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title}>
      <form className="modal" onSubmit={go}>
        <h2>{title}</h2>
        {detail}
        {error ? <div className="alert bad" role="alert">{error}</div> : null}
        {ch?.inTerminal ? <p className="muted small">Next, your terminal will show a code for this exact request.</p> : <label>Type <code data-testid="challenge-code">{ch?.code ?? '…'}</code> to confirm
          <input ref={ref} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" name="confirm" required />
        </label>}
        {ch?.needsPassphrase ? <label>Approver passphrase<input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" name="passphrase" required /></label> : null}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !ch}>Confirm</button>
        </div>
      </form>
    </div>
  );
}

interface HumanRequest { title: string; detail?: ReactNode; path: string; body?: object }
function useHuman(reload: Reload) {
  const [req, setReq] = useState<HumanRequest | null>(null);
  const dialog = req ? <HumanDialog title={req.title} {...(req.detail ? { detail: req.detail } : {})} submit={(proof) => post(req.path, { ...req.body, ...proof })} onClose={() => setReq(null)} onDone={reload} /> : null;
  return { ask: setReq, dialog };
}

/** Mounted once. Anything the public site tries to change comes through here with a code from the user's own terminal. */
function TerminalPrompt() {
  const [ask, setAsk] = useState<{ action: string; resolve: (c: string) => void; reject: (e: Error) => void } | null>(null);
  const [code, setCode] = useState('');
  useEffect(() => setTerminalPrompt((action) => new Promise((resolve, reject) => { setCode(''); setAsk({ action, resolve, reject }); })), []);
  if (!ask) return null;
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Code from your terminal" data-testid="terminal-code-dialog">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); ask.resolve(code.trim()); setAsk(null); }}>
        <h2>Confirm in your terminal</h2>
        <p className="muted small">Your terminal now shows a code. Check that it describes this request:</p>
        <pre className="code small" tabIndex={0}>{ask.action}</pre>
        <label>Code from your terminal<input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" name="terminal-code" required /></label>
        <div className="row end">
          <button type="button" className="btn" onClick={() => { ask.reject(new Error('Cancelled, so nothing changed.')); setAsk(null); }}>Cancel</button>
          <button type="submit" className="btn primary">Confirm</button>
        </div>
      </form>
    </div>
  );
}

function EventDrawer({ seq, onClose }: { seq: number; onClose: () => void }) {
  const { data, error } = useLoad(() => get(`/api/event/${seq}`), [seq]);
  useEscape(onClose);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={`Record ${seq}`}>
      <div className="modal wide">
        <h2>Source record #{seq}</h2>
        {data ? <pre tabIndex={0} className="code">{JSON.stringify(data, null, 2)}</pre> : <Loading error={error} />}
        <div className="row end"><button className="btn" autoFocus onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function Pairing({ onPaired, notice }: { onPaired: () => void; notice?: string }) {
  const [code, setCode] = useState('');
  const [port, setPortValue] = useState(currentPort());
  const [error, setError] = useState('');
  return (
    <main className="pair">
      <form className="card" onSubmit={async (e) => { e.preventDefault(); setError(''); try { if (onPublicSite()) setPort(port); await pair(code); onPaired(); } catch (err) { setError((err as Error).message); } }}>
        <div className="brand"><Logo /> AgentOnTrack</div>
        <h1>Pair this browser</h1>
        <p className="muted">Enter the code shown in the terminal running <code>agentontrack dashboard{onPublicSite() ? ' --allow-public-site' : ''}</code>. It works once, and expires after 5 minutes.</p>
        {notice && !error ? <div className="alert warn" role="status" data-testid="pair-notice">{notice}</div> : null}
        {error ? <div className="alert bad" role="alert">{error}</div> : null}
        <label>Pairing code<input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" spellCheck={false} name="code" /></label>
        {onPublicSite() ? <label>Companion port<input value={port} onChange={(e) => setPortValue(e.target.value)} name="port" inputMode="numeric" /></label> : null}
        <button className="btn primary" type="submit">Pair</button>
        {onPublicSite() ? <>
          <button className="btn" type="button" onClick={() => { enterDemo(); onPaired(); }}>View the demo instead</button>
          <p className="muted small">This page talks only to the companion on your own machine. Your data does not go to this website. No account is needed. Your browser may ask to allow local network access, or block this connection outright, as Safari does. The local address the companion prints, such as <code>{localAddress()}</code>, always works.</p>
        </> : <p className="muted small">Everything here stays on this machine. No account is needed.</p>}
      </form>
    </main>
  );
}

const Logo = () => <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 12h16M4 18h7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /><circle cx="19" cy="6" r="2" fill="var(--accent)" /><circle cx="15" cy="18" r="2" fill="var(--accent)" /></svg>;

function Overview({ tick, go }: { tick: number; go: (s: Screen) => void }) {
  const st = useLoad(() => get('/api/state'), [tick]);
  const an = useLoad(() => get('/api/analytics'), [tick]);
  const ag = useLoad(() => get('/api/agents'), []);
  if (!st.data || !an.data) return <Loading error={st.error || an.error} />;
  const s = st.data; const a = an.data;
  const pending = s.approvals.filter((x: any) => x.view === 'pending');
  const verifiedTask = a.tasks.filter((t: any) => t.status === 'VERIFIED').at(-1);
  return (
    <Page title={s.project.name} intro={s.project.root}>
      {!s.integrity.ok ? <div className="alert bad" role="alert"><b>Log integrity problem.</b> {s.integrity.problems.join(' ')} Approvals are suspended until recovery: run <code>agentontrack audit --recover</code>.</div> : null}
      {pending.length ? <button className="alert warn as-button" onClick={() => go('Approvals')}><b>{pending.length} approval{pending.length > 1 ? 's' : ''} waiting.</b> Review now →</button> : null}
      <section className="grid two">
        <div className="card">
          <h2 className="eyebrow">Current goal</h2>
          {s.goal ? <><p className="lead">{s.goal.statement}</p><p className="muted small">Version {s.goal.version} · {s.goal.status} · scope {s.goal.scope.include.join(', ')}</p></> : <Empty>No approved goal. <button className="link" onClick={() => go('Goals')}>Set one</button></Empty>}
        </div>
        <div className="card">
          <h2 className="eyebrow">Active task</h2>
          {s.activeTask ? <>
            <p className="lead">{s.activeTask.title} <Badge value={s.activeTask.evaluation.status} /></p>
            <div className="progress" role="progressbar" aria-valuenow={s.activeTask.evaluation.progress.passed} aria-valuemax={s.activeTask.evaluation.progress.total} aria-label="Criteria passing"><i style={{ width: `${s.activeTask.evaluation.progress.total ? (100 * s.activeTask.evaluation.progress.passed) / s.activeTask.evaluation.progress.total : 0}%` }} /></div>
            <p className="muted small">{s.activeTask.evaluation.progress.passed} of {s.activeTask.evaluation.progress.total} criteria have current passing evidence</p>
          </> : <Empty>No active task. <button className="link" onClick={() => go('Goals')}>Create one</button></Empty>}
          {verifiedTask ? <p className="muted small">Last verified: {verifiedTask.title}</p> : null}
        </div>
      </section>
      <section className="stats">
        <Stat label="Tokens (in + out)" value={fmt(a.totals.input + a.totals.output)} sub={`${fmt(a.totals.cacheRead)} cache read`} kind={a.totals.sessions ? (a.totals.providerReported ? 'actual' : 'transcript') : 'unavailable'} />
        <Stat label="List-price cost" value={a.totals.costUsd === null ? '–' : `$${a.totals.costUsd.toFixed(3)}`} sub={a.totals.costBasis === 'list' ? 'Not your bill if on a subscription' : undefined as any} kind={a.totals.costUsd === null ? 'unavailable' : 'actual'} />
        <Stat label="Actions gated" value={fmt(a.safety.actions)} sub={`${a.safety.deny + a.safety.requestApproval} stopped`} />
        <Stat label="Detected after the fact" value={fmt(a.safety.detectedAfter)} sub={`${a.safety.unresolved} unresolved`} />
        <Stat label="Tasks verified" value={`${a.taskTotals.VERIFIED ?? 0} / ${a.tasks.length}`} />
      </section>
      <section className="card">
        <h2 className="eyebrow">Connected agents</h2>
        {ag.data ? <div className="agents-mini">{ag.data.map((x: any) => <span key={x.id}><b>{x.name}</b> <span className={`badge ${x.hooksInstalled ? 'good' : x.installed ? '' : 'muted'}`}>{x.hooksInstalled ? 'hooks installed' : x.installed ? 'not connected' : 'not installed'}</span></span>)}</div> : <Loading error={ag.error} />}
      </section>
      <p className="muted small">Savings are not shown here. A savings figure needs a matched comparison; see Comparisons.</p>
    </Page>
  );
}

/** The evaluation lists every weak check, accepted or not. Only those without a human's acceptance still hold back VERIFIED. */
const openWeakChecks = (t: any): string[] => (t.evaluation.weakCriteria ?? []).filter((w: string) => t.evaluation.reasons.includes(`Weak check: ${w}`));

function Goals({ tick }: { tick: number }) {
  const { data, error, reload } = useLoad(() => get('/api/state'), [tick]);
  const { ask, dialog } = useHuman(reload);
  const [statement, setStatement] = useState('');
  const [include, setInclude] = useState('**');
  const [exclude, setExclude] = useState('');
  const [prohibit, setProhibit] = useState('deploy');
  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  const [verifying, setVerifying] = useState('');
  const [weakNotes, setWeakNotes] = useState<Record<string, string>>({});
  if (!data) return <Loading error={error} />;
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const goalBody = { goal: { statement, scope: { include: list(include), exclude: list(exclude) }, prohibit: list(prohibit) } };
  return (
    <Page title="Goals and tasks" intro="Changing the goal invalidates earlier approvals and makes earlier evidence stale. That is deliberate.">
      {dialog}
      <section className="grid two">
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); ask({ title: data.goal ? `Replace goal v${data.goal.version}` : 'Approve this goal', detail: <p>{statement}</p>, path: '/api/goal', body: goalBody }); }}>
          <h2>{data.goal ? 'Change goal' : 'Set goal'}</h2>
          <label>Goal<textarea value={statement} onChange={(e) => setStatement(e.target.value)} required rows={2} name="statement" /></label>
          <label>In scope (comma-separated globs)<input value={include} onChange={(e) => setInclude(e.target.value)} name="include" /></label>
          <label>Excluded<input value={exclude} onChange={(e) => setExclude(e.target.value)} name="exclude" /></label>
          <label>Prohibited effects<input value={prohibit} onChange={(e) => setProhibit(e.target.value)} name="prohibit" /></label>
          <button className="btn primary" type="submit">Review and approve</button>
        </form>
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); ask({ title: 'Create task', detail: command ? <p>This check will run on your machine: <code>{command}</code></p> : <p className="alert warn">With no check, this task can never be VERIFIED.</p>, path: '/api/tasks', body: { title, criteria: command ? [{ id: 'check', description: command, kind: 'command', command }] : [] } }); }}>
          <h2>New task</h2>
          <label>Task<input value={title} onChange={(e) => setTitle(e.target.value)} required name="title" /></label>
          <label>Acceptance check (command)<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm test" name="command" className="mono" /></label>
          <button className="btn primary" type="submit">Review and create</button>
        </form>
      </section>
      {data.goal ? <section className="card row wrap">
        <p className="grow"><b>Goal v{data.goal.version}</b> <Badge value={data.goal.status} /> {data.goal.statement}</p>
        {data.goal.status === 'active' ? <button className="btn" onClick={() => ask({ title: 'Mark goal completed', path: '/api/goal/close', body: { outcome: 'completed' } })}>Complete</button> : <button className="btn" onClick={() => ask({ title: 'Reopen goal', path: '/api/goal/reopen' })}>Reopen</button>}
      </section> : null}
      <section className="card">
        <h2>Proposals from agents</h2>
        {data.proposals.length === 0 ? <Empty>No proposals. An agent can only propose: nothing takes effect until you accept it.</Empty> : (
          <ul className="list">{[...data.proposals].reverse().map((p: any) => (
            <li key={p.id} className="row wrap">
              <div className="grow"><Badge value={p.status} /> <b>{p.payload.statement ?? p.payload.title}</b><div className="muted small">{p.kind} · {p.payload.rationale ?? 'no rationale'} · {p.actor?.runtime ?? 'agent'}</div>{p.note ? <div className="muted small">Note: {p.note}</div> : null}</div>
              {p.status === 'open' ? <>
                <button className="btn small" onClick={() => ask({ title: `Accept: ${p.payload.statement ?? p.payload.title}`, detail: p.kind === 'goal' ? <p className="alert warn">Earlier approvals stop matching, and evidence for the current goal goes stale.</p> : undefined as any, path: '/api/proposals/accept', body: { id: p.id } })}>Accept</button>
                <button className="btn small" onClick={() => ask({ title: 'Reject proposal', path: '/api/proposals/reject', body: { id: p.id } })}>Reject</button>
              </> : null}
            </li>
          ))}</ul>
        )}
      </section>
      <section className="card">
        <h2>Tasks</h2>
        {data.tasks.length === 0 ? <Empty>No tasks yet.</Empty> : (
          <ul className="list">{[...data.tasks].reverse().map((t: any) => (
            <li key={t.id}>
              <div className="row wrap">
                <div className="grow"><b>{t.title}</b> <Badge value={t.evaluation.status} /> {data.activeTask?.id === t.id ? <span className="badge">active</span> : null}{t.closed ? <span className="badge muted">closed: {t.closed}</span> : null}</div>
                <button className="btn small" disabled={verifying === t.id} onClick={async () => { setVerifying(t.id); try { await post('/api/verify', { taskId: t.id }); } finally { setVerifying(''); reload(); } }}>{verifying === t.id ? 'Running…' : 'Verify now'}</button>
                {data.activeTask?.id !== t.id && !t.closed ? <button className="btn small" onClick={() => ask({ title: `Activate ${t.title}`, path: '/api/tasks/activate', body: { id: t.id } })}>Activate</button> : null}
              </div>
              <ul className="muted small plain">{t.evaluation.criteria.map((c: any) => <li key={c.id}><Badge value={c.state} /> {t.criteria.find((x: any) => x.id === c.id)?.description ?? c.id}</li>)}</ul>
              {t.evaluation.reasons.filter((r: string) => !r.startsWith('Criterion') && !r.startsWith('Weak check:')).map((r: string) => <p className="muted small" key={r}>{r}</p>)}
              {openWeakChecks(t).length ? <div className="alert warn stack" data-testid="weak-checks">
                <p><b>Weak checks withhold VERIFIED.</b> They could pass without showing the work is done. Strengthen them, or accept them yourself.</p>
                <ul className="small">{openWeakChecks(t).map((w: string) => <li key={w}>{w}</li>)}</ul>
                <div className="row wrap">
                  <label className="grow">Why they are acceptable (optional)<input value={weakNotes[t.id] ?? ''} maxLength={500} onChange={(e) => setWeakNotes({ ...weakNotes, [t.id]: e.target.value })} name="weak-note" /></label>
                  <button className="btn small end-self" onClick={() => ask({ title: `Accept weak checks on ${t.title}`, detail: <p className="alert warn">VERIFIED may then rest on checks that prove little. Your decision goes in the record.</p>, path: '/api/verification/accept-weak', body: { taskId: t.id, note: weakNotes[t.id] ?? '' } })}>Accept weak checks</button>
                </div>
              </div> : null}
            </li>
          ))}</ul>
        )}
      </section>
      <section className="card">
        <h2>Goal history</h2>
        {data.goals.length === 0 ? <Empty>None.</Empty> : <ol className="list">{[...data.goals].reverse().map((g: any) => <li key={g.version}><b>v{g.version}</b> {g.statement} <span className="muted small">{new Date(g.ts).toLocaleString()}{g.fromProposal ? ' · from a proposal' : ''}</span></li>)}</ol>}
      </section>
    </Page>
  );
}

const HOST_FAIL_MODE: Record<string, string> = {
  closed: 'The action is blocked. Observed on the real host.',
  open: 'The action runs anyway. Observed on the real host. Start it with agentontrack run, which tests the hook first.',
};
const CONTAINMENT: Record<string, string> = {
  none: 'Nothing. A script\'s network activity is not stopped. The strict profile holds scripts for approval instead.',
  'claude-sandbox-available': 'Claude Code\'s OS sandbox, if you connect with agentontrack install claude-code --sandbox. Verified on macOS. On Linux it could not start on the test runner, so it is not verified there.',
  'codex-sandbox': 'Codex\'s own sandbox, when started with agentontrack run codex. Network stays off unless you allow it.',
};

/** Other platforms, from the same adapter list as the command line. Connecting one is a terminal step, so its files can be reviewed. */
function OtherPlatforms() {
  const { data, error } = useLoad(() => get<any[]>('/api/providers'), []);
  if (!data) return error ? <p className="muted small">Other platforms: Unavailable</p> : null;
  return (
    <section className="card stack" data-testid="other-platforms">
      <h2>Other platforms</h2>
      <div className="table-wrap" tabIndex={0}><table>
        <thead><tr><th scope="col">Platform</th><th scope="col">On this machine</th><th scope="col">Hooks in this project</th><th scope="col">If its hook crashes</th><th scope="col">To connect</th></tr></thead>
        <tbody>{data.map((p) => <tr key={p.id} data-testid={`platform-${p.id}`}><th scope="row">{p.name}</th><td>{p.version ?? 'Not found'}</td><td>{p.hooksInstalled ? 'Yes' : 'No'}</td><td>{p.failure.crash}</td><td><code>{p.connect}</code></td></tr>)}</tbody>
      </table></div>
      <p className="muted small">See the integrations page for what has really been tested on each.</p>
    </section>
  );
}

function Agents({ tick }: { tick: number }) {
  const { data, error, reload } = useLoad(() => get('/api/agents'), []);
  const runs = useLoad(() => get('/api/runs'), [tick]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('haiku');
  const [budget, setBudget] = useState(0.25);
  const [msg, setMsg] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434');
  const [probe, setProbe] = useState<any>(null);
  useEffect(() => { const t = setInterval(runs.reload, 1500); return () => clearInterval(t); }, [runs.reload]);
  if (!data) return <Loading error={error} />;
  const claude = data.find((a: any) => a.id === 'claude-code');
  return (
    <Page title="Agents" intro="Status comes from checks run now on this machine. AgentOnTrack never asks for or stores provider logins.">
      <section className="grid three">{data.map((a: any) => (
        <article className="card stack" key={a.id} data-testid={`agent-${a.id}`}>
          <h2>{a.name}</h2>
          <dl className="kv">
            <dt>Installed</dt><dd>{a.installed ? a.version : 'No'}</dd>
            <dt>Logged in</dt><dd>{a.authenticated === null ? 'Not checked' : a.authenticated ? `Yes (${a.method})` : 'No'}</dd>
            <dt>Hooks</dt><dd>{a.hooksInstalled ? 'Installed' : 'Not installed'}</dd>
            <dt>If its hook cannot run</dt><dd data-testid="host-fail-mode">{HOST_FAIL_MODE[a.coverage.hostFailMode] ?? 'Unavailable'}</dd>
            <dt>What contains its scripts</dt><dd data-testid="containment">{CONTAINMENT[a.coverage.containment] ?? 'Unavailable'}</dd>
            <dt>Evidence</dt><dd>{{ 'live-tested': 'Live-tested with its normal login', 'real-host-scripted-model': 'The real program with a scripted model, not a live model', 'live-local-model': 'Live-tested with a small local model only', 'hook-fired-live': 'Hook fired live; gate not yet exercised', 'documentation-only': 'Documentation only: not run' }[a.coverage.evidence as string]}</dd>
          </dl>
          {a.id !== 'hermes' ? <div className="row">
            {a.hooksInstalled ? <button className="btn" onClick={async () => { await post(`/api/agents/${a.id}/disconnect`); reload(); }}>Disconnect</button>
              : <button className="btn primary" disabled={!a.installed} onClick={async () => { await post(`/api/agents/${a.id}/connect`); reload(); }}>Connect</button>}
          </div> : <p className="muted small">Hermes hooks live in your own config. Run <code>agentontrack install hermes</code> for the snippet.</p>}
          {!a.installed ? <p className="badge muted">{a.liveStatus}</p> : null}
          <details><summary>Enforcement coverage</summary>
            <h4>Enforced before running</h4><ul className="small">{a.coverage.enforced.map((x: string) => <li key={x}>{x}</li>)}</ul>
            <h4>Only observed afterwards</h4><ul className="small">{a.coverage.observedOnly.map((x: string) => <li key={x}>{x}</li>)}</ul>
            <h4>Not covered</h4><ul className="small">{a.coverage.unsupported.map((x: string) => <li key={x}>{x}</li>)}</ul>
            {a.coverage.notes.map((n: string) => <p className="muted small" key={n}>{n}</p>)}
          </details>
        </article>
      ))}</section>
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); setMsg(''); try { await post('/api/runs', { runtime: 'claude-code', prompt, model, maxBudgetUsd: budget }); setPrompt(''); runs.reload(); } catch (err) { setMsg((err as Error).message); } }}>
        <h2>Start a run on Claude Code</h2>
        <p className="muted small">This starts your real, locally logged-in Claude Code and uses your usage. Spending is capped per run.</p>
        {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
        <label>Prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} required name="prompt" /></label>
        <div className="row wrap">
          <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} name="model" /></label>
          <label>Budget cap (USD)<input type="number" min={0.01} max={5} step={0.01} value={budget} onChange={(e) => setBudget(Number(e.target.value))} name="budget" /></label>
          <button className="btn primary end-self" type="submit" disabled={!claude?.hooksInstalled}>Start run</button>
        </div>
        {!claude?.hooksInstalled ? <p className="muted small">Connect Claude Code first.</p> : null}
      </form>
      <section className="card">
        <h2>Runs</h2>
        {runs.data?.length ? <ul className="list">{[...runs.data].reverse().map((r: any) => (
          <li key={r.id} data-testid="run" data-status={r.status}>
            <div className="row"><b className="mono grow">{r.id}</b> <span className="badge">{r.status}</span>{r.status === 'running' ? <button className="btn small" onClick={async () => { await post(`/api/runs/${r.id}/stop`); runs.reload(); }}>Stop</button> : null}</div>
            <pre tabIndex={0} className="code small">{r.events.join('\n') || 'Waiting for output…'}</pre>
          </li>
        ))}</ul> : <Empty>No runs since the companion started.</Empty>}
      </section>
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); setProbe(await post('/api/probe', { baseUrl }).catch((err) => ({ notes: [err.message] }))); }}>
        <h2>Local model endpoint</h2>
        <p className="muted small">Tests what an OpenAI-compatible endpoint actually does. A model server is not an agent: it has no tools, approvals or session state on its own.</p>
        <div className="row wrap"><label className="grow">Base URL<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} name="baseUrl" /></label><button className="btn end-self" type="submit">Probe</button></div>
        {probe ? <pre tabIndex={0} className="code small" data-testid="probe">{JSON.stringify(probe, null, 2)}</pre> : null}
      </form>
      <OtherPlatforms />
    </Page>
  );
}

function Usage({ tick, open }: { tick: number; open: (seq: number) => void }) {
  const { data: a, error } = useLoad(() => get('/api/analytics'), [tick]);
  if (!a) return <Loading error={error} />;
  const kind = a.totals.providerReported ? 'actual' : a.totals.sessions ? 'transcript' : 'unavailable';
  const series = [{ key: 'input', label: 'Input', color: 'var(--s1)' }, { key: 'output', label: 'Output', color: 'var(--s2)' }, { key: 'cacheCreate', label: 'Cache write', color: 'var(--s3)' }];
  return (
    <Page title="Usage" intro="Tokens as your provider reported them. Cache reads are kept separate: they are priced differently and would swamp the chart.">
      <section className="stats">
        <Stat label="Input" value={fmt(a.totals.input)} kind={kind} />
        <Stat label="Output" value={fmt(a.totals.output)} kind={kind} />
        <Stat label="Cache read" value={fmt(a.totals.cacheRead)} kind={kind} />
        <Stat label="Cache write" value={fmt(a.totals.cacheCreate)} kind={kind} />
        <Stat label="List-price cost" value={a.totals.costUsd === null ? '–' : `$${a.totals.costUsd.toFixed(4)}`} sub="List price, not necessarily what you pay" kind={a.totals.costUsd === null ? 'unavailable' : 'actual'} />
      </section>
      {a.totals.sessions === 0 ? <Empty>No usage recorded yet. Usage comes from runs started here, or from Claude Code session records.</Empty> : <>
        <ChartFrame title="Tokens by day" kind={kind} table={<table><thead><tr><th>Day</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead><tbody>{a.byDay.map((d: any) => <tr key={d.day}><td>{d.day}</td><td>{fmt(d.input)}</td><td>{fmt(d.output)}</td><td>{fmt(d.cacheRead)}</td><td>{fmt(d.cacheCreate)}</td></tr>)}</tbody></table>}>
          <StackedBars rows={a.byDay} x="day" series={series} label="Input, output and cache-write tokens per day" />
        </ChartFrame>
        <section className="grid two">
          <ChartFrame title="Cache reads by model" kind={kind}><HBars rows={a.byModel.map((m: any) => ({ label: m.name, value: m.cacheRead }))} /></ChartFrame>
          <ChartFrame title="Tokens by runtime" kind={kind}><HBars rows={a.byRuntime.map((m: any) => ({ label: m.name, value: m.input + m.output }))} /></ChartFrame>
        </section>
        <ChartFrame title="Time" kind="record" note="Measured for runs started here. No time-saved figure appears without a matched comparison.">
          <HBars rows={[{ label: 'Run wall clock', value: a.time.runWallClockMs / 1000 }, { label: 'API time', value: a.time.runApiMs / 1000 }, { label: 'Waiting for approval', value: a.approvals.medianWaitMs === null ? null : a.time.approvalWaitMs / 1000 }, { label: 'Verification', value: a.time.verificationMs / 1000 }]} unit=" s" />
        </ChartFrame>
        <section className="card"><h2>Records</h2><div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Runtime</th><th>Model</th><th>Source</th><th>In</th><th>Out</th><th>Cost</th><th /></tr></thead>
          <tbody>{[...a.usage].reverse().map((u: any) => <tr key={u.seq}><td>{new Date(u.ts).toLocaleString()}</td><td>{u.runtime}</td><td className="mono">{u.model}</td><td><Provenance kind={u.source === 'provider-reported' ? 'actual' : 'transcript'} /></td><td>{fmt(u.inputTokens)}</td><td>{fmt(u.outputTokens)}</td><td>{u.costUsd === null ? '–' : `$${u.costUsd.toFixed(4)}`}</td><td><button className="link small" onClick={() => open(u.seq)}>source</button></td></tr>)}</tbody>
        </table></div></section>
      </>}
    </Page>
  );
}

function Comparisons() {
  const { data, error } = useLoad(() => get('/api/evaluations'), []);
  if (!data) return <Loading error={error} />;
  const m = data.matched;
  return (
    <Page title="Comparisons" intro="Only matched experiments appear here: same task, model and acceptance check. Nothing is extrapolated to your projects.">
      {m ? <>
        <p className="alert warn">{m.limits}</p>
        {m.vsA ? <section className="card"><h2>Difference from the agent alone</h2><div className="table-wrap"><table><thead><tr><th>Condition</th><th>Tokens, 95% CI</th><th>Seconds, 95% CI</th></tr></thead><tbody>{m.vsA.map((v: any) => <tr key={v.condition}><td>{v.condition}</td><td>{Math.round(v.tokensDiffCI95[0])} to {Math.round(v.tokensDiffCI95[1])}</td><td>{v.wallSecondsDiffCI95[0].toFixed(1)} to {v.wallSecondsDiffCI95[1].toFixed(1)}</td></tr>)}</tbody></table></div></section> : null}
        {['tokens', 'duration', 'success'].map((metric) => (
          <ChartFrame key={metric} title={metric === 'tokens' ? 'Input + output tokens per task (mean)' : metric === 'duration' ? 'Wall clock per task (mean)' : 'Tasks passing the independent check'} kind="benchmark" note={`${m.models?.join(', ') ?? m.model}, ${m.claudeVersion}, ${m.tasks} tasks, up to ${m.repeats} repeats each${m.complete === false ? `, ${m.completedRuns} of ${m.plannedRuns} planned runs` : ''}, ${m.ranAt?.slice(0, 10)}`}>
            <HBars rows={m.summary.map((c: any) => ({ label: c.condition, value: metric === 'tokens' ? c.meanTokens : metric === 'duration' ? c.meanWallSeconds : c.passRate * 100, note: metric === 'tokens' ? `±${fmt(c.sdTokens)} sd` : '' }))} unit={metric === 'duration' ? ' s' : metric === 'success' ? '%' : ''} />
          </ChartFrame>
        ))}
      </> : <Empty><Provenance kind="unavailable" /> No matched benchmark has been run, so no savings are claimed.</Empty>}
      <section className="card"><h2>Not comparable yet</h2><p className="muted">Claude versus Codex versus Hermes: Codex and Hermes are not installed here, so there is no runtime comparison. Before-and-after on your own projects needs a matched baseline, which ordinary use does not provide.</p></section>
    </Page>
  );
}

function Evidence({ tick, open }: { tick: number; open: (seq: number) => void }) {
  const { data, error } = useLoad(() => get('/api/state'), [tick]);
  if (!data) return <Loading error={error} />;
  return (
    <Page title="Evidence" intro="Receipts come from checks AgentOnTrack ran itself. What an agent says is listed separately, and proves nothing.">
      <section className="card">
        <h2>Receipts</h2>
        {data.receipts.length === 0 ? <Empty>No receipts yet. Run Verify on a task.</Empty> : <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Task</th><th>Criterion</th><th>Result</th><th>Source</th><th>Observed</th><th /></tr></thead>
          <tbody>{data.receipts.map((r: any) => <tr key={r.seq} data-testid="receipt"><td>{new Date(r.ts).toLocaleString()}</td><td className="mono small">{r.taskId}</td><td>{r.criterionId}</td><td><Badge value={r.passed ? 'pass' : 'fail'} /></td><td>{r.source}</td><td className="mono small clip">{r.observed}</td><td><button className="link small" onClick={() => open(r.seq)}>source</button></td></tr>)}</tbody>
        </table></div>}
      </section>
      <section className="card">
        <h2>Agent claims <span className="badge muted">not evidence</span></h2>
        {data.claims.length === 0 ? <Empty>None.</Empty> : <ul className="list">{data.claims.map((c: any) => <li key={c.seq}>{c.text}</li>)}</ul>}
      </section>
      <section className="card">
        <h2>Record integrity</h2>
        <p><Badge value={data.integrity.ok ? 'pass' : 'fail'} /> {data.integrity.chain.events} events, {data.integrity.witnessEntries} witnessed, {data.integrity.signedCheckpoints} signed checkpoints</p>
        {data.integrity.problems.map((x: string) => <p className="alert bad" key={x}>{x}</p>)}
        <p className="muted small">{data.integrity.assurance}</p>
      </section>
    </Page>
  );
}

function Safety({ tick, open }: { tick: number; open: (seq: number) => void }) {
  const st = useLoad(() => get('/api/state'), [tick]);
  const an = useLoad(() => get('/api/analytics'), [tick]);
  const ac = useLoad(() => get('/api/actions'), [tick]);
  const { ask, dialog } = useHuman(() => { st.reload(); an.reload(); });
  if (!st.data || !an.data) return <Loading error={st.error || an.error} />;
  const s = an.data.safety; const pol = st.data.policy;
  return (
    <Page title="Safety" intro="Prevented means it never ran. Detected means it already happened. These are never merged.">
      {dialog}
      <section className="stats">
        <Stat label="Prevented (denied)" value={s.deny} />
        <Stat label="Held for approval" value={s.requestApproval} />
        <Stat label="Detected afterwards" value={s.detectedAfter} sub={`${s.reverted} reversed`} />
        <Stat label="Blocks a human then approved" value={s.blocksHumanApproved + s.blocksHumanApprovedAndUsed} sub="Candidate false positives" />
        <Stat label="Repeats stopped" value={s.loopDenied} sub={`${s.repeatWarned} warned`} />
        <Stat label="Missed" value="Unavailable" sub="A miss leaves no record. See Evaluations." kind="unavailable" />
      </section>
      {an.data.byDay.length ? <ChartFrame title="Decisions by day" kind="record" note="From this project's local record.">
        <StackedBars rows={an.data.byDay} x="day" label="Allowed, held and denied actions per day" series={[{ key: 'allow', label: 'Allowed', color: 'var(--s1)' }, { key: 'request_approval', label: 'Held for approval', color: 'var(--s4)' }, { key: 'deny', label: 'Denied', color: 'var(--s2)' }]} />
      </ChartFrame> : null}
      <section className="grid two">
        <ChartFrame title="How much was enforced" kind="record" note="Partial: the gate fired, but what the program does can only be seen afterwards.">
          <HBars rows={Object.entries<number>(s.byAssurance).map(([k, v]) => ({ label: k, value: v }))} />
        </ChartFrame>
        <section className="card stack">
          <h2>Policy v{st.data.policyVersion}</h2>
          <p><b>Opaque programs:</b> {pol.opaqueExec === 'approval' ? 'need approval first (preventive)' : 'run, and are checked afterwards (detection only)'}</p>
          <p><b>Unauthorized file changes:</b> {pol.onMismatch === 'quarantine' ? 'reversed automatically' : 'reported only'}</p>
          <div className="row">
            {(['standard', 'strict'] as const).map((p) => <button key={p} className="btn" disabled={(p === 'strict') === (pol.opaqueExec === 'approval')} onClick={() => ask({ title: `Switch to ${p} policy`, detail: <p className="alert warn">Earlier approvals stop matching.</p>, path: '/api/policy/profile', body: { profile: p } })}>Use {p}</button>)}
          </div>
          <details><summary>Rules</summary>
            <p className="small"><b>Denied:</b> {pol.denied.join(', ')}</p>
            <p className="small"><b>Approval required:</b> {pol.approvalRequired.join(', ')}</p>
            <p className="small"><b>Protected:</b> {pol.protectedPaths.join(', ')}</p>
          </details>
        </section>
      </section>
      <section className="card">
        <h2>Unauthorized effects</h2>
        {st.data.mismatches.length === 0 ? <Empty>None observed. Network and process effects of opaque programs cannot be observed at all.</Empty> : <ul className="list">{st.data.mismatches.map((m: any) => (
          <li key={`${m.seq}${m.path}`} className="row wrap" data-testid="mismatch">
            <div className="grow"><b className="mono">{m.path}</b> <span className="muted small">{m.reason}</span>{m.reverted ? <div className="small">Reversal: {m.reverted}</div> : null}</div>
            {m.acknowledged ? <span className="badge muted">reviewed</span> : <button className="btn small" onClick={() => ask({ title: `Mark ${m.path} as reviewed`, path: '/api/mismatch/ack', body: { seq: m.seq } })}>Mark reviewed</button>}
            <button className="link small" onClick={() => open(m.seq)}>source</button>
          </li>
        ))}</ul>}
      </section>
      <section className="card"><h2>Recent actions</h2><div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Tool</th><th>Decision</th><th>Assurance</th><th>Detail</th><th /></tr></thead>
        <tbody>{(ac.data ?? []).filter((e: any) => e.type === 'action.requested').slice(0, 50).map((e: any) => <tr key={e.seq} data-testid="action" data-decision={e.payload.decision}><td>{new Date(e.ts).toLocaleTimeString()}</td><td>{e.payload.tool}</td><td><Badge value={e.payload.decision} /></td><td><Badge value={e.payload.assurance} /></td><td className="small clip">{e.payload.reasons?.[0] ?? e.payload.effects?.map((x: any) => x.kind).join(', ')}</td><td><button className="link small" onClick={() => open(e.seq)}>source</button></td></tr>)}</tbody>
      </table></div></section>
    </Page>
  );
}

function Approvals({ tick }: { tick: number }) {
  const { data, error, reload } = useLoad(() => get('/api/state'), [tick]);
  const { ask, dialog } = useHuman(reload);
  const [filter, setFilter] = useState('all');
  if (!data) return <Loading error={error} />;
  const views = ['all', 'pending', 'approved', 'consumed', 'denied', 'revoked', 'expired'];
  const rows = data.approvals.filter((a: any) => filter === 'all' || a.view === filter);
  return (
    <Page title="Approvals" intro="Each covers one effect, for one task, goal version, policy version and runtime. Used once by default.">
      {dialog}
      <div className="filters" role="group" aria-label="Filter approvals">{views.map((v) => <button key={v} className={`chip ${filter === v ? 'on' : ''}`} aria-pressed={filter === v} onClick={() => setFilter(v)}>{v}</button>)}</div>
      <section className="card">
        {rows.length === 0 ? <Empty>Nothing here.</Empty> : <ul className="list">{rows.map((a: any) => (
          <li key={a.id} data-testid="approval" data-view={a.view} data-id={a.id}>
            <div className="row wrap">
              <div className="grow">
                <Badge value={a.view} /> <b>{a.effect.kind}</b>
                <div className="mono small clip">{a.effect.target}</div>
                <div className="muted small">{a.reason} · {a.runtime} · goal v{a.goalVersion} · policy v{a.policyVersion} · {new Date(a.requestedAt).toLocaleString()}</div>
                {a.view === 'pending' && a.pendingExpiresAt ? <div className="muted small">Lapses {new Date(a.pendingExpiresAt).toLocaleTimeString()} if unanswered</div> : null}
                {a.approver ? <div className="muted small">Decided by {a.approver.osUser} via {a.approver.method}</div> : null}
              </div>
              {a.view === 'pending' ? <>
                <button className="btn primary small" onClick={() => ask({ title: `Approve ${a.effect.kind}`, detail: <p className="mono small">{a.effect.target}</p>, path: '/api/approvals/approve', body: { id: a.id } })}>Approve</button>
                <button className="btn small" onClick={() => ask({ title: `Deny ${a.effect.kind}`, detail: <p className="mono small">{a.effect.target}</p>, path: '/api/approvals/deny', body: { id: a.id } })}>Deny</button>
              </> : null}
              {a.view === 'approved' ? <button className="btn small" onClick={() => ask({ title: 'Revoke this approval', path: '/api/approvals/revoke', body: { id: a.id } })}>Revoke</button> : null}
            </div>
          </li>
        ))}</ul>}
      </section>
    </Page>
  );
}

function Evaluations() {
  const { data, error } = useLoad(() => get('/api/evaluations'), []);
  if (!data) return <Loading error={error} />;
  const h = data.heldout;
  const rows = h ? Object.entries<any>(h.results) : [];
  return (
    <Page title="Evaluations" intro="Benchmark results, misses included. Self-run: no independent evaluator has reproduced these.">
      {h ? <>
        <ChartFrame title="Held-out scenarios: unauthorized actions" kind="benchmark" note={`${h.scenarios} fixed traces, ${h.ranAt?.slice(0, 10)}, commit ${h.commit?.slice(0, 7)}. No model in the loop.`} table={
          <table><thead><tr><th>Condition</th><th>Prevented</th><th>Detected after</th><th>Missed</th><th>False blocks</th><th>False completions</th></tr></thead><tbody>{rows.map(([n, t]) => <tr key={n}><td>{n.replace(/agentontrack/i, 'AgentOnTrack')}</td><td>{t.prevented}</td><td>{t.detectedAfter}</td><td>{t.missed}</td><td>{t.falseBlocks}</td><td>{t.falseCompletions}</td></tr>)}</tbody></table>
        }>
          <StackedBars rows={rows.map(([n, t]) => ({ name: n, prevented: t.prevented, detectedAfter: t.detectedAfter, missed: t.missed }))} x="name" tick={(n) => n.replace(/^C minus (\w+).*/, '−$1').replace(/^([ABC]) .*/, '$1')} label="Prevented, detected and missed per condition" series={[{ key: 'prevented', label: 'Prevented', color: 'var(--s1)' }, { key: 'detectedAfter', label: 'Detected after', color: 'var(--s4)' }, { key: 'missed', label: 'Missed', color: 'var(--s2)' }]} />
        </ChartFrame>
        <section className="card"><h2>Why it missed</h2><ul className="small">{(h.results['C agentontrack full']?.details ?? []).map((d: string) => <li className="mono" key={d}>{d}</li>)}</ul></section>
      </> : <Empty>No results packaged with this install.</Empty>}
      {data.securityCampaign ? <section className="card"><h2>Security campaign</h2><p className="muted small">{data.securityCampaign.note}</p><div className="table-wrap"><table>
        <thead><tr><th>Scenario</th><th>Outcome</th><th>Detail</th></tr></thead>
        <tbody>{data.securityCampaign.rows.map((r: any) => <tr key={r.scenario}><td>{r.scenario}</td><td><span className={`badge ${r.outcome === 'prevented' ? 'good' : r.outcome === 'missed' ? 'bad' : r.outcome === 'detected-after' ? 'warn' : 'muted'}`}>{r.outcome}</span></td><td className="small">{r.detail}</td></tr>)}</tbody>
      </table></div></section> : null}
      {data.performance ? <section className="card"><h2>Hook latency</h2><p className="muted small">{data.performance.env}</p><div className="table-wrap"><table>
        <thead><tr><th>Measure</th><th>p50</th><th>p95</th><th>p99</th></tr></thead>
        <tbody>{data.performance.rows.map((r: any) => <tr key={r.name}><td>{r.name}</td><td>{fmtMs(r.p50)}</td><td>{fmtMs(r.p95)}</td><td>{fmtMs(r.p99)}</td></tr>)}</tbody>
      </table></div></section> : null}
    </Page>
  );
}

function Environment() {
  const an = useLoad(() => get('/api/analytics'), []);
  const set = useLoad(() => get('/api/settings'), []);
  const [grid, setGrid] = useState('');
  return (
    <Page title="Environmental impact" intro="Most of this cannot be measured from here, and this page says so instead of guessing.">
      <section className="grid three">
        <div className="card stack"><h2>Energy</h2><Provenance kind="unavailable" /><p className="muted small">Providers do not report per-request energy for these runs. Converting tokens to watt-hours needs a figure for the specific model and hardware, which AgentOnTrack does not have. Published figures for other providers' models do not transfer.</p></div>
        <div className="card stack"><h2>Water</h2><Provenance kind="unavailable" /><p className="muted small">No defensible provider-specific method exists here, so no liters are shown.</p></div>
        <div className="card stack"><h2>Carbon</h2><Provenance kind="unavailable" /><p className="muted small">Depends on energy, which is unavailable. No savings figure of any kind is claimed.</p></div>
      </section>
      <section className="card stack">
        <h2>Local device (optional)</h2>
        <p className="muted small">If you measure your machine with your own power meter, you can work out local emissions from your grid's published intensity. AgentOnTrack only does the arithmetic; the inputs and their accuracy are yours.</p>
        <label>Your grid intensity (gCO₂e per kWh)<input type="number" min={0} value={grid} onChange={(e) => setGrid(e.target.value)} name="grid" /></label>
        <p className="small" data-testid="env-calc">{grid ? <>1 kWh measured locally ≈ {Number(grid)} gCO₂e. <Provenance kind="estimated" note="User-supplied factor" /></> : 'Enter a value to use the calculator.'}</p>
        {an.data && set.data ? <p className="muted small">AgentOnTrack has recorded {fmt(an.data.totals.input + an.data.totals.output)} tokens here, shown for context only: they are not converted.</p> : null}
      </section>
    </Page>
  );
}

function Feedback() {
  const [rating, setRating] = useState<'helpful' | 'not-helpful' | null>(null);
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [mayQuote, setMayQuote] = useState(false);
  const [done, setDone] = useState('');
  return (
    <Page title="Feedback" intro="Was AgentOnTrack helpful for this task? Your feedback helps improve the tool. It is optional, and nothing depends on it.">
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); const r = await post('/api/feedback', { rating, text, contact, mayQuote }); setDone(r.note); setText(''); }}>
        <div className="row" role="group" aria-label="Rating">
          <button type="button" className={`chip ${rating === 'helpful' ? 'on' : ''}`} aria-pressed={rating === 'helpful'} onClick={() => setRating('helpful')}>Helpful</button>
          <button type="button" className={`chip ${rating === 'not-helpful' ? 'on' : ''}`} aria-pressed={rating === 'not-helpful'} onClick={() => setRating('not-helpful')}>Not helpful</button>
        </div>
        <label>{rating === 'helpful' ? 'What worked well?' : rating === 'not-helpful' ? 'What should we improve?' : 'Anything to add?'}<textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} name="text" /></label>
        <label>Contact (optional)<input value={contact} onChange={(e) => setContact(e.target.value)} name="contact" /></label>
        <label className="check"><input type="checkbox" checked={mayQuote} onChange={(e) => setMayQuote(e.target.checked)} /> You may quote this publicly. Leave unticked if not.</label>
        <button className="btn primary" type="submit">Save feedback</button>
        {done ? <p className="alert good" role="status">{done}</p> : null}
      </form>
    </Page>
  );
}

function SettingsPage({ theme, setTheme, onUnpair, reloadShell }: { theme: string; setTheme: (t: string) => void; onUnpair: () => void; reloadShell: Reload }) {
  const { data, error, reload } = useLoad(() => get('/api/settings'), []);
  const { ask, dialog } = useHuman(() => reloadShell());
  const [msg, setMsg] = useState('');
  if (!data) return <Loading error={error} />;
  const save = async (body: object) => { setMsg(''); try { await post('/api/settings', body); reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <Page title="Settings" intro="Local-only. No account is needed, and this version sends nothing anywhere.">
      {dialog}
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      <section className="card stack">
        <h2>Appearance</h2>
        <div className="row" role="group" aria-label="Theme">{['dark', 'light'].map((t) => <button key={t} className={`chip ${theme === t ? 'on' : ''}`} aria-pressed={theme === t} onClick={() => setTheme(t)}>{t}</button>)}</div>
      </section>
      <section className="card stack">
        <h2>Optional sharing</h2>
        <label className="check"><input type="checkbox" checked={data.telemetry} onChange={(e) => save({ telemetry: e.target.checked })} /> Product analytics (off by default)</label>
        <label className="check"><input type="checkbox" checked={data.diagnostics} onChange={(e) => save({ diagnostics: e.target.checked })} /> Diagnostics (off by default)</label>
        <p className="muted small">These only record your preference. This build sends no analytics or diagnostics, whatever they are set to.</p>
      </section>
      <section className="card stack">
        <h2>This browser and others</h2>
        <ul className="list">{data.sessions.map((s: any) => <li key={s.id} className="row wrap"><span className="grow small">{s.current ? 'This browser' : s.userAgent || 'Browser'} · expires {new Date(s.expiresAt).toLocaleString()}</span>{!s.current ? <button className="btn small" onClick={async () => { await post('/api/sessions/revoke', { id: s.id }); reload(); }}>Revoke</button> : null}</li>)}</ul>
        <div><button className="btn" onClick={async () => { await post('/api/unpair'); forgetSession(); onUnpair(); }}>Disconnect this browser</button></div>
      </section>
      <section className="card stack">
        <h2>Your data</h2>
        <p className="muted small">Credentials are never stored here. Claude Code keeps its own login.</p>
        <div className="row wrap">
          <button className="btn" onClick={() => downloadExport().catch((e) => setMsg(e.message))}>Export this project's record</button>
          <button className="btn danger" onClick={() => ask({ title: 'Delete this project\'s AgentOnTrack record', detail: <p className="alert warn">This removes the local record, witness and evidence for this project. Your project files are not touched. It cannot be undone.</p>, path: '/api/data/delete' })}>Delete record</button>
        </div>
      </section>
    </Page>
  );
}

/** A project page's address: #project/<id>/<tab>. */
function routeFromHash(): ProjectRoute | null {
  const m = /^#project\/([^/]+)(?:\/(\w+))?$/.exec(location.hash);
  if (!m) return null;
  const tab = PROJECT_TABS.find((t) => t === m[2]) ?? ('overview' as ProjectTab);
  return { id: decodeURIComponent(m[1]!), tab };
}

export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [screen, setScreen] = useState<Screen>(() => (SCREENS.find((s) => s.toLowerCase() === location.hash.slice(1)) ?? 'Projects'));
  const [route, setRoute] = useState<ProjectRoute | null>(() => routeFromHash());
  const [tick, setTick] = useState(0);
  const [projects, setProjects] = useState<any[] | null>(null);
  const [theme, setThemeState] = useState(() => localStorage.getItem('bl-theme') ?? 'dark');
  const [open, setOpen] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const [menu, setMenu] = useState(false);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('bl-theme', theme); }, [theme]);
  useEffect(() => { resumeSession().then((ok) => { const r = routeFromHash(); if (ok && r) setProject(r.id); setPaired(ok); }); }, []);
  useEffect(() => { location.hash = route ? `project/${encodeURIComponent(route.id)}/${route.tab}` : screen.toLowerCase(); document.title = `${route ? 'Project' : screen} · AgentOnTrack`; }, [screen, route]);
  const loadProjects = useCallback(() => {
    get('/api/projects').then((list) => {
      setProjects(list);
      if (!list.some((p: any) => p.id === currentProject()) && list[0]) setProject(list[0].id);
      bump();
    }).catch((e) => { if (e.status === 401) setPaired(false); });
  }, [bump]);
  useEffect(() => { if (paired) loadProjects(); }, [paired, loadProjects]);
  // Anything a button does that fails shows here, so no click ends in silence.
  const [notice, setNotice] = useState('');
  const [pairNotice, setPairNotice] = useState('');
  const sessionGone = useCallback(() => { forgetSession(); setPairNotice('The companion restarted, so this browser has to pair again. Enter a new code from its terminal.'); setPaired(false); }, []);
  useEffect(() => {
    const on = (e: PromiseRejectionEvent) => setNotice(String(e.reason?.message ?? e.reason));
    window.addEventListener('unhandledrejection', on);
    return () => window.removeEventListener('unhandledrejection', on);
  }, []);

  // A live feed of the real record; EventSource reconnects by itself and resumes from the last id.
  useEffect(() => {
    if (!paired || !projects?.length) return undefined;
    return subscribe(bump, setLive, sessionGone);
  }, [paired, projects?.length, currentProject(), bump, sessionGone]); // eslint-disable-line react-hooks/exhaustive-deps

  if (paired === null) return <p className="muted center" role="status">Connecting…</p>;
  if (!paired) return <Pairing notice={pairNotice} onPaired={() => { setPairNotice(''); setPaired(true); }} />;
  const go = (s: Screen) => { setRoute(null); setScreen(s); setMenu(false); };
  const openProject = (id: string) => { setProject(id); setRoute({ id, tab: 'overview' }); setMenu(false); bump(); };

  let body: ReactNode = <Loading />;
  if (route && projects) {
    body = <ProjectDetail key={route.id} route={route} projects={projects} tick={tick} onTab={(tab) => setRoute({ id: route.id, tab })} onBack={() => go('Projects')} open={setOpen} go={(s) => go(s as Screen)} />;
  } else if (projects && projects.length === 0 && screen !== 'Projects') {
    body = <Empty>No project attached. <button className="link" onClick={() => go('Projects')}>Attach one</button></Empty>;
  } else if (projects) {
    body = {
      Overview: <Overview tick={tick} go={go} />,
      Projects: <ProjectsHome projects={projects} tick={tick} reloadShell={loadProjects} onOpen={openProject} />,
      Goals: <Goals tick={tick} />,
      Agents: <Agents tick={tick} />,
      Usage: <Usage tick={tick} open={setOpen} />,
      Comparisons: <Comparisons />,
      Evidence: <Evidence tick={tick} open={setOpen} />,
      Safety: <Safety tick={tick} open={setOpen} />,
      Approvals: <Approvals tick={tick} />,
      Evaluations: <Evaluations />,
      Environment: <Environment />,
      Feedback: <Feedback />,
      Settings: <SettingsPage theme={theme} setTheme={setThemeState} onUnpair={() => setPaired(false)} reloadShell={loadProjects} />,
    }[screen];
  }
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className={menu ? 'open' : ''}>
        <div className="brand"><Logo /> AgentOnTrack
          <button className="menu" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu(!menu)}>☰</button>
        </div>
        <nav aria-label="Main">
          {SCREENS.map((s) => <button key={s} className={!route && screen === s || route && s === 'Projects' ? 'on' : ''} aria-current={!route && screen === s || route && s === 'Projects' ? 'page' : undefined} onClick={() => go(s)}>{s}</button>)}
        </nav>
        <p className="live small" role="status" data-testid="live-status"><i className={live ? 'on' : ''} />{isDemo() ? 'Demo: not connected' : live ? 'Live: local record' : 'Reconnecting…'}</p>
        {isDemo() ? <button className="btn small" onClick={() => { leaveDemo(); history.replaceState(null, '', location.pathname); setPaired(false); }}>Pair with my companion</button> : null}
      </aside>
      <main id="main" tabIndex={-1}>
        {isDemo() ? <div className="alert warn" role="note" data-testid="demo-banner"><b>Demo data.</b> These values are invented to show the interface. Only Comparisons and Evaluations show real recorded benchmark results.</div> : null}
        {notice ? <div className="alert bad" role="alert">{notice} <button className="link" onClick={() => setNotice('')}>Dismiss</button></div> : null}
        {body}
      </main>
      {open !== null ? <EventDrawer seq={open} onClose={() => setOpen(null)} /> : null}
      <TerminalPrompt />
    </div>
  );
}
