import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { accountPage, accountsEnabled, mobileBackend } from './accounts';
import { Icon, Logo } from './icons';
import { RemoteError } from './remote-error';
import { DictationButton } from './dictation';
import { forgetKey, keyFor, markUnsure, pendingUnsure, pollStatus, signatureOf, statusAdvice, type SessionStatus } from './new-session';
import type { Backend, ComputerRow, DeviceStatus, Snapshot } from './mobile-backend';

const STALE_AFTER_MS = 3 * 60_000;
type Tab = 'progress' | 'activity' | 'evidence' | 'approvals' | 'more';
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'progress', label: 'Progress', icon: 'target' }, { id: 'activity', label: 'Activity', icon: 'terminal' }, { id: 'evidence', label: 'Evidence', icon: 'receipt' },
  { id: 'approvals', label: 'Approvals', icon: 'checkCircle' }, { id: 'more', label: 'More', icon: 'more' },
];
const ago = (iso: string | number | null | undefined) => {
  if (!iso) return 'never';
  const ms = Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso));
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const STATUS: Record<string, string> = { verified: 'Verified', ready: 'Ready', running: 'Running', blocked: 'Waiting', paused: 'Paused', skipped: 'Skipped', draft: 'Draft', 'needs-evidence': 'Needs evidence', 'done-unchecked': 'Done, not checked', stale: 'Stale evidence', failed: 'Failed' };
const TONE: Record<string, string> = { verified: 'good', failed: 'bad', stale: 'warn', 'needs-evidence': 'warn', 'done-unchecked': 'warn', running: '', ready: '' };

/** Runs one request, and keeps what the person needs to see: that it is working, what happened, and why a refusal was a refusal. */
function useAction(): { busy: boolean; msg: string; ok: boolean; run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined> } {
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [ok, setOk] = useState(true);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success = 'Done.') => {
    setBusy(true); setMsg('');
    try { const r = await fn(); setOk(true); setMsg(success); return r; } catch (e) { setOk(false); setMsg(e instanceof RemoteError ? e.message : (e as Error).message); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, msg, ok, run };
}

function Shell({ title, back, children, tabs }: { title: string; back?: () => void; children: ReactNode; tabs?: ReactNode }) {
  return (
    <div className="m-app">
      <header className="m-top">
        {back ? <button className="m-icon" onClick={back} aria-label="Back"><Icon name="chevron" size={22} /></button> : <Logo />}
        <h1>{title}</h1>
      </header>
      <main className="m-main" id="main" tabIndex={-1}>{children}</main>
      {tabs}
    </div>
  );
}

export function MobileApp() {
  const [be, setBe] = useState<Backend | null>(null);
  const [state, setState] = useState<'loading' | 'off' | 'out' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [route, setRoute] = useState<{ cid?: string; project?: string; tab: Tab }>(() => { const m = /^#m\/([^/]+)(?:\/([^/]+))?(?:\/(\w+))?/.exec(location.hash); return { ...(m?.[1] ? { cid: decodeURIComponent(m[1]) } : {}), ...(m?.[2] ? { project: decodeURIComponent(m[2]) } : {}), tab: (m?.[3] as Tab) ?? 'progress' }; });
  useEffect(() => { location.hash = route.cid ? `m/${encodeURIComponent(route.cid)}${route.project ? `/${encodeURIComponent(route.project)}/${route.tab}` : ''}` : 'm'; }, [route]);
  useEffect(() => {
    if (!accountsEnabled()) { setState('off'); return; }
    void mobileBackend().then((b) => { setBe(b); setState(b.user() ? 'ready' : 'out'); }).catch((e) => { setErr(e.message); setState('error'); });
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }, []);

  if (state === 'loading') return <Shell title="AgentOnTrack"><p className="m-note" role="status">Opening…</p></Shell>;
  if (state === 'off') return <Shell title="AgentOnTrack"><div className="m-card"><h2>Phone access is not switched on</h2><p>This site has no accounts set up, so a phone cannot be linked to your computer from here. Everything else works from your computer.</p></div></Shell>;
  if (state === 'error' || !be) return <Shell title="AgentOnTrack"><div className="m-card" role="alert"><h2>Could not start</h2><p>{err}</p></div></Shell>;
  if (state === 'out') return (
    <Shell title="AgentOnTrack">
      <div className="m-card stack">
        <h2>Sign in to see your computers</h2><p className="m-note" data-testid="experimental-note">Experimental: tested against emulators only, not on a real Firebase project or phone.</p>
        <p>Use the same account you used on your computer. Signing in only shows you what is linked to it. Each computer asks you to approve this phone separately.</p>
        <a className="btn primary m-btn" href={`${accountPage()}?next=mobile`} data-testid="m-signin">Sign in</a>
      </div>
    </Shell>
  );
  const go = (r: Partial<typeof route>) => setRoute((cur) => ({ tab: 'progress', ...r, ...(r.cid === undefined && r.project === undefined ? {} : {}), ...(cur && r.tab === undefined && r.project === cur.project ? { tab: cur.tab } : {}) }));
  if (route.cid && route.project === '_new') return <NewSessionScreen be={be} cid={route.cid} go={go} />;
  if (route.cid && route.project) return <ProjectScreen be={be} cid={route.cid} project={route.project} tab={route.tab} go={go} />;
  if (route.cid) return <ProjectsScreen be={be} cid={route.cid} go={go} />;
  return <HomeScreen be={be} go={go} onOut={() => setState('out')} />;
}

/* ---------- Home: the computers ---------- */

function HomeScreen({ be, go, onOut }: { be: Backend; go: (r: { cid?: string; project?: string; tab?: Tab }) => void; onOut: () => void }) {
  const [rows, setRows] = useState<ComputerRow[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { be.computers().then(setRows).catch((e) => setErr(e.message)); }, [be]);
  useEffect(load, [load]);
  const me = be.user();
  return (
    <Shell title="Your computers">
      {err ? <div className="m-card" role="alert">{err}</div> : null}
      {!rows ? <p className="m-note" role="status">Looking for your computers…</p> : rows.length === 0 ? (
        <div className="m-card"><h2>No computer is linked yet</h2><p>On your computer, open AgentOnTrack, go to Settings, and choose &ldquo;Link this computer to my account&rdquo;. Then come back here.</p><button className="btn m-btn" onClick={load}>Look again</button></div>
      ) : rows.map((c) => <ComputerCard key={c.id} be={be} c={c} go={go} />)}
      <div className="m-card stack">
        <p className="m-note">Signed in as <b data-testid="m-who">{me?.email ?? me?.uid}</b></p>
        <button className="btn m-btn" onClick={() => { void be.signOut().then(onOut); }}>Sign out</button>
      </div>
    </Shell>
  );
}

/** Whether this phone itself has a network. Offline, nothing can be sent, and what is shown is only what was last received. */
function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => { const up = () => setOn(true); const down = () => setOn(false); addEventListener('online', up); addEventListener('offline', down); return () => { removeEventListener('online', up); removeEventListener('offline', down); }; }, []);
  return on;
}

function usePresence(be: Backend, cid: string) {
  const [last, setLast] = useState<number | null | undefined>(undefined);
  useEffect(() => be.watchPresence(cid, setLast), [be, cid]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15_000); return () => clearInterval(t); }, []);
  const online = typeof last === 'number' && Date.now() - last < STALE_AFTER_MS;
  return { last, online };
}

function ComputerCard({ be, c, go }: { be: Backend; c: ComputerRow; go: (r: { cid?: string }) => void }) {
  const { last, online } = usePresence(be, c.id);
  const [status, setStatus] = useState<DeviceStatus>('none');
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [mine, setMine] = useState('');
  const [step, setStep] = useState<'idle' | 'compare'>('idle');
  const a = useAction();
  useEffect(() => be.watchDevice(c.id, setStatus), [be, c.id]);
  useEffect(() => { void be.pinned(c.id).then((p) => setPinned(!!p)); void be.device().then((d) => setMine(d.fingerprint)); }, [be, c.id, status]);
  const trusted = status === 'trusted' && pinned;
  return (
    <section className="m-card stack" data-testid={`m-computer-${c.id}`}>
      <div className="row wrap"><h2 className="grow" style={{ margin: 0 }}>{c.name}</h2><span className={`badge ${online ? 'good' : 'warn'}`} data-testid="m-presence">{online ? 'Online' : last ? `Last seen ${ago(last)}` : 'Not seen yet'}</span></div>
      {trusted ? <button className="btn primary m-btn" onClick={() => go({ cid: c.id })} data-testid="m-open">Open</button> : status === 'revoked' ? <p role="alert">This phone was removed from this computer. Ask to connect again to use it.</p> : null}
      {!trusted && status !== 'pending' && step === 'idle' ? <button className="btn primary m-btn" onClick={() => setStep('compare')} data-testid="m-connect">Connect this phone</button> : null}
      {step === 'compare' && status !== 'pending' ? (
        <div className="stack" data-testid="m-compare">
          <p>Before this phone is connected, check that its screen and your computer agree. On your computer, open Settings, Phone access. It shows the computer&apos;s fingerprint.</p>
          <p>This computer should show: <code className="m-code" data-testid="m-computer-fp">{c.fingerprint}</code></p>
          <button className="btn primary m-btn" disabled={a.busy} data-testid="m-match" onClick={() => void a.run(async () => { await be.pin(c.id, c.pub); await be.askToConnect(c.id); setStep('idle'); }, 'Asked. Now approve this phone on your computer.')}>They match: ask to connect</button>
          <button className="btn m-btn" onClick={() => setStep('idle')}>They do not match</button>
        </div>
      ) : null}
      {status === 'pending' ? <div className="stack" data-testid="m-waiting"><p><b>Waiting for you at your computer.</b> It will show this phone&apos;s fingerprint. Approve it only if it is:</p><code className="m-code" data-testid="m-phone-fp">{mine}</code></div> : null}
      {a.msg ? <p role={a.ok ? 'status' : 'alert'} className={a.ok ? 'm-note' : 'alert bad'}>{a.msg}</p> : null}
    </section>
  );
}

/* ---------- The computer's projects ---------- */

function ProjectsScreen({ be, cid, go }: { be: Backend; cid: string; go: (r: { cid?: string; project?: string; tab?: Tab }) => void }) {
  const [list, setList] = useState<Snapshot | null>(null);
  const [name, setName] = useState('this computer');
  const { last, online } = usePresence(be, cid);
  useEffect(() => be.watchSnapshot(cid, 'list', setList), [be, cid]);
  useEffect(() => { void be.computers().then((r) => setName(r.find((x) => x.id === cid)?.name ?? name)).catch(() => undefined); }, [be, cid]); // eslint-disable-line react-hooks/exhaustive-deps
  const items: any[] = Array.isArray(list?.body) ? list!.body : (list?.body?.items ?? list?.body ?? []);
  return (
    <Shell title={name} back={() => go({})}>
      <Freshness online={online} last={last} snap={list} />
      <button className="btn primary m-btn" disabled={!online} onClick={() => go({ cid, project: '_new', tab: 'progress' })} data-testid="m-new-session">New session</button>
      {!list ? <p className="m-note" role="status">Waiting for the computer&apos;s list of projects…</p> : null}
      {items.length === 0 && list ? <div className="m-card"><p>No projects are registered on this computer.</p></div> : null}
      {items.filter((p: any) => !p.archived).map((p: any) => (
        <button key={p.id} className="m-card m-row" onClick={() => go({ cid, project: p.id, tab: 'progress' })} data-testid={`m-project-${p.id}`}>
          <span className="grow"><b>{p.name}</b><br /><span className="muted small">{p.goal ?? 'No goal set'}</span></span>
          {p.pendingApprovals ? <span className="badge warn">{p.pendingApprovals} waiting</span> : null}
          {p.activeTask ? <span className="badge">{String(p.activeTask.status).replace(/_/g, ' ').toLowerCase()}</span> : null}
        </button>
      ))}
    </Shell>
  );
}

/* ---------- A brand new agent session, started on the computer ---------- */

const NEW_ERRORS: Record<string, string> = {
  'no-default-project': 'This computer has no default project for phone sessions. Pick a project below, or choose a default on the computer.',
  'default-unavailable': 'The default project is not available on the computer right now. Pick a project from the list.',
  'project-archived': 'That project is archived on the computer.', 'no-project': 'That project is not on the computer any more.',
  'agent-unavailable': 'That agent cannot be started in this project right now.', busy: 'Several runs are already going on the computer. Wait for one to finish.',
  'idem-mismatch': 'That request changed after it was sent. Nothing was started; send it again.',
  'in-doubt': 'An earlier attempt may have started a session on the computer. Check the Activity tab before trying again. Nothing new was started.',
  unavailable: 'The computer cannot start sessions from a phone (it may need updating).',
};

function NewSessionScreen({ be, cid, go }: { be: Backend; cid: string; go: (r: { cid?: string; project?: string; tab?: Tab }) => void }) {
  const { last, online } = usePresence(be, cid);
  const phoneOnline = useOnline();
  const [list, setList] = useState<Snapshot | null>(null);
  useEffect(() => be.watchSnapshot(cid, 'list', setList), [be, cid]);
  const items: any[] = (Array.isArray(list?.body) ? list!.body : (list?.body?.items ?? [])).filter((p: any) => !p.archived && !p.missing);
  const dflt = items.find((p: any) => p.isDefault);
  const [project, setProject] = useState('');
  const picked = project || (dflt ? 'default' : items[0]?.id ?? '');
  const choicesProject = picked === 'default' ? dflt?.id ?? '' : picked;
  const choices = useChoices(be, cid, choicesProject, online && !!choicesProject);
  const [agent, setAgent] = useState(''); const [model, setModel] = useState(''); const [policy, setPolicy] = useState<'standard' | 'read-only'>('standard'); const [prompt, setPrompt] = useState('');
  const startable = (choices.agents ?? []).filter((a) => a.canStart);
  const chosen = agent || startable[0]?.id || '';
  const modelsFor = (choices.models ?? []).filter((m) => m.agent === chosen);
  const modelChoice = model || modelsFor.find((m) => m.entitlement === 'worked')?.id || modelsFor[0]?.id || (chosen ? 'haiku' : '');
  const act = useAction();
  const [started, setStarted] = useState<{ sessionId: string; project: { id: string; name: string }; deduped: boolean; usedDefault: boolean } | null>(null);
  const [unsure, setUnsure] = useState(() => pendingUnsure(sessionStorage, cid) !== null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [checking, setChecking] = useState(false); const [checkFailed, setCheckFailed] = useState(false);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** Asks the computer what became of the unanswered request. Bounded; shows the real state; on "started" goes to the live view. */
  const reconcile = useCallback(async () => {
    const key = pendingUnsure(sessionStorage, cid); if (!key) return;
    setChecking(true); setCheckFailed(false);
    const got = await pollStatus(() => be.call<SessionStatus>(cid, 'session.status', { v: 1, idemKey: key }, 20_000), undefined, undefined, () => !alive.current);
    if (!alive.current) return;
    setChecking(false); setStatus(got); setCheckFailed(got === null);
    if (got?.state === 'started') { forgetKey(sessionStorage); setUnsure(false); setPrompt(''); setStarted({ sessionId: got.sessionId, project: got.project, deduped: false, usedDefault: false }); go({ cid, project: got.project.id, tab: 'activity' }); }
    else if (got?.state === 'refused-before-start') { forgetKey(sessionStorage); setUnsure(false); }
  }, [be, cid, go]);
  const askedOnce = useRef(false);
  useEffect(() => { if (unsure && !askedOnce.current && online && !started) { askedOnce.current = true; void reconcile(); } }, [unsure, online, started, reconcile]);
  const ready = online && phoneOnline && !act.busy && !!picked && !!chosen && !!modelChoice && prompt.trim().length > 0 && prompt.length <= 4000;
  const send = () => {
    const sig = signatureOf({ cid, project: picked, agent: chosen, model: modelChoice, policy, prompt });
    const idemKey = keyFor(sessionStorage, sig);
    setUnsure(false); setStatus(null);
    void act.run(async () => {
      try {
        const r = await be.call<any>(cid, 'session.new', { v: 1, idemKey, project: picked, agent: chosen, model: modelChoice, policy, prompt }, 60_000);
        forgetKey(sessionStorage); setStarted(r); setPrompt(''); return r;
      } catch (e) {
        // "In doubt" is the computer saying an earlier attempt may have started something: not a definite answer, so the key stays and its status is asked.
        if (e instanceof RemoteError && e.code === 'in-doubt') { markUnsure(sessionStorage, cid); setUnsure(true); askedOnce.current = true; void reconcile(); throw new RemoteError('in-doubt', 'An earlier attempt may have started a session. Checking with your computer…'); }
        if (e instanceof RemoteError && e.code !== 'offline') { forgetKey(sessionStorage); throw new RemoteError(e.code, NEW_ERRORS[e.code] ?? e.message); }
        // No answer: the computer may or may not have started it. The key is kept, so sending the same request again cannot start it twice.
        markUnsure(sessionStorage, cid); setUnsure(true); askedOnce.current = true; void reconcile(); throw new RemoteError('unsure', 'No answer came back. Checking with your computer what happened to it…');
      }
    }, 'Started on your computer.');
  };
  return (
    <Shell title="New session" back={() => go({ cid })}>
      <Freshness online={online} last={last} snap={list} />
      {started ? (
        <section className="m-card stack" data-testid="m-new-started">
          <h2>Started</h2>
          <p>A new session <code className="m-code" data-testid="m-new-id">{started.sessionId}</code> is running in <b>{started.project.name}</b>{started.usedDefault ? ' (the default project)' : ''}.{started.deduped ? ' This was already started by an earlier attempt; nothing new was started.' : ''}</p>
          <button className="btn primary m-btn" onClick={() => go({ cid, project: started.project.id, tab: 'activity' })} data-testid="m-new-watch">Watch it</button>
        </section>
      ) : (
        <section className="m-card stack">
          <h2>Start a new coding session</h2>
          <p className="m-note">This starts a fresh session on your computer. It runs there, in the project you pick, with the same approvals and limits as always. You choose a project, never a folder.</p>
          {!list ? <p className="m-note" role="status">Waiting for the computer&apos;s list of projects…</p> : items.length === 0 ? <p className="m-note" role="alert">No project is available on this computer.</p> : (
            <label>Project
              <select value={picked} onChange={(e) => { setProject(e.target.value); setAgent(''); setModel(''); }} name="m-new-project" data-testid="m-new-project">
                {dflt ? <option value="default">Default project ({dflt.name})</option> : null}
                {items.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>)}
          {!dflt && list ? <p className="m-note" data-testid="m-new-nodefault">No default project is chosen on the computer. Pick one above.</p> : null}
          <div className="row wrap">
            <label>Agent
              <select value={chosen} onChange={(e) => { setAgent(e.target.value); setModel(''); }} name="m-new-agent" data-testid="m-new-agent">
                {(choices.agents ?? []).map((a) => <option key={a.id} value={a.id} disabled={!a.canStart}>{a.name} ({a.canStart ? 'ready' : STATUS_WORDS[a.status] ?? a.status})</option>)}
              </select>
            </label>
            <label>Model
              <select value={modelChoice} onChange={(e) => setModel(e.target.value)} name="m-new-model" data-testid="m-new-model" disabled={modelsFor.length === 0}>
                {modelsFor.length === 0 ? <option value="haiku">haiku (small default, none found yet)</option> : modelsFor.map((m) => <option key={m.id} value={m.id}>{m.id}{m.entitlement === 'worked' ? ' (worked here)' : ' (found, not tried)'}</option>)}
              </select>
            </label>
          </div>
          <label>Mode
            <p className="m-note">Standard lets the agent edit files, asking where your computer requires it. Read only lets it read and search, and nothing else.</p>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as 'standard' | 'read-only')} name="m-new-policy" data-testid="m-new-policy">
              <option value="standard">Standard (can edit files)</option>
              <option value="read-only">Read only (no writes, no commands)</option>
            </select>
          </label>
          <label>What should the agent do?
            <textarea rows={4} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} name="m-new-prompt" data-testid="m-new-prompt" placeholder="Describe the task" />
          </label>
          <div className="row wrap"><DictationButton onText={(t) => setPrompt((p: string) => (p && !/\s$/.test(p) ? p + ' ' : p) + t)} /></div>
          <p className="m-note">{prompt.length} / 4000. Files cannot be attached from a phone yet, and a spoken note is typed text only: raw audio is not sent.</p>
          {choices.agents && startable.length === 0 ? <p className="m-note" role="alert" data-testid="m-new-noagent">No agent can be started in this project right now. {choices.agents.find((a) => a.reason)?.reason ?? ''}</p> : null}
          <button className="btn primary m-btn" disabled={!ready} onClick={send} data-testid="m-new-send">Start session</button>
          {!online || !phoneOnline ? <p className="m-note" data-testid="m-new-offline">{!phoneOnline ? 'This phone is offline.' : 'Your computer is not reachable.'} Nothing can be started until it is back.</p> : null}
        </section>
      )}
      {unsure && !started ? (
        <section className="m-card stack" role="status" data-testid="m-new-status">
          <h2>What happened to your request</h2>
          <p data-testid="m-new-status-text">{checking ? 'Checking with your computer…' : status?.state === 'refused-before-start' ? 'Your computer refused it before anything started. Nothing is running.' : status?.state === 'unknown-request' ? 'Your computer has no record of this request, so it started nothing. You can send the same request again; it cannot start twice.' : status?.state === 'starting-indeterminate' ? 'Your computer began this request but cannot prove a session started. It may or may not have. Look at Recent sessions in the Activity tab before doing anything else.' : checkFailed ? 'Could not reach your computer to check. The session may or may not have started.' : 'The session may or may not have started.'}</p>
          <div className="row wrap">
            <button className="btn m-btn" disabled={checking || !online || !phoneOnline} onClick={() => void reconcile()} data-testid="m-new-refresh">Refresh status</button>
            {statusAdvice(status).canResend ? <button className="btn primary m-btn" disabled={!ready} onClick={send} data-testid="m-new-resend">Send the same request again</button> : null}
          </div>
        </section>
      ) : null}
      {act.msg && !started && !unsure ? <p role={act.ok ? 'status' : 'alert'} className={act.ok ? 'm-note' : 'alert bad'} data-testid="m-new-result">{act.msg}</p> : null}
    </Shell>
  );
}

function Freshness({ online, last, snap }: { online: boolean; last: number | null | undefined; snap: Snapshot | null }) {
  const phoneOnline = useOnline();
  if (!phoneOnline) return <p className="m-fresh off" role="status" data-testid="m-fresh">This phone is offline. What you see is what was last received{snap?.generatedAt ? ` (${ago(snap.generatedAt)})` : ''}, nothing is live, and controls are off until it is back.</p>;
  return (
    <p className={`m-fresh ${online ? 'on' : 'off'}`} role="status" data-testid="m-fresh">
      {online ? 'Live.' : 'Your computer is not reachable.'} {snap?.generatedAt ? `Updated ${ago(snap.generatedAt)}.` : ''} {!online ? `${last ? `Last seen ${ago(last)}. ` : ''}Controls are off until it is back, and nothing here is live.` : ''}
    </p>
  );
}

/* ---------- One project ---------- */

function ProjectScreen({ be, cid, project, tab, go }: { be: Backend; cid: string; project: string; tab: Tab; go: (r: { cid?: string; project?: string; tab?: Tab }) => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const { last, online } = usePresence(be, cid);
  useEffect(() => { let off = () => undefined as void; void be.snapshotKey(cid, project).then((k) => { off = be.watchSnapshot(cid, k, setSnap); }); return () => off(); }, [be, cid, project]);
  const s = snap?.body;
  const act = useAction();
  // Loaded once per project screen, so switching tabs does not ask the computer again.
  const choices = useChoices(be, cid, project, true);
  const call = useCallback(<T,>(action: string, params: object = {}, ok = 'Done.') => act.run(() => be.call<T>(cid, action, { project, ...params }), ok), [act, be, cid, project]);
  const phoneOnline = useOnline();
  const can = online && phoneOnline && !act.busy;
  return (
    <Shell title={s?.project?.name ?? 'Project'} back={() => go({ cid })} tabs={
      <nav className="m-tabs" aria-label="Project">
        {TABS.map((t) => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go({ cid, project, tab: t.id })} data-testid={`m-tab-${t.id}`}><Icon name={t.icon} size={22} />{t.label}{t.id === 'approvals' && s?.approvals?.length ? <i className="m-dot" aria-label={`${s.approvals.length} waiting`} /> : null}</button>)}
      </nav>
    }>
      <Freshness online={online} last={last} snap={snap} />
      {act.msg ? <p role={act.ok ? 'status' : 'alert'} className={act.ok ? 'm-note' : 'alert bad'} data-testid="m-result">{act.msg}</p> : null}
      {!s ? <p className="m-note" role="status">Waiting for the project…</p> : tab === 'progress' ? <Progress s={s} can={can} call={call} choices={choices} />
        : tab === 'activity' ? <Activity s={s} can={can} call={call} />
        : tab === 'evidence' ? <Evidence s={s} be={be} cid={cid} project={project} online={online} />
        : tab === 'approvals' ? <Approvals s={s} can={can} call={call} />
        : <More s={s} be={be} can={can} call={call} />}
    </Shell>
  );
}

type Call = <T>(action: string, params?: object, ok?: string) => Promise<T | undefined>;

interface AgentRow { id: string; name: string; status: string; canStart: boolean; reason: string | null; commands: string[]; commandsSource: string }
interface ModelRow { id: string; agent: string; source: string; entitlement: string; note: string }
const STATUS_WORDS: Record<string, string> = { ready: 'ready', 'needs-setup': 'needs setup', 'terminal-only': 'start it in its own terminal', missing: 'not installed' };

/** What the computer really has: agents with a status, and models it found. Nothing is assumed, and a model is never called available just because it is listed. */
function useChoices(be: Backend, cid: string, project: string, online: boolean) {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!online) return;
    let live = true;
    void be.call<{ agents: AgentRow[] }>(cid, 'agents.list', { project }).then((r) => live && setAgents(r.agents)).catch((e) => live && setErr(e.message));
    void be.call<{ models: ModelRow[] }>(cid, 'models.list', {}).then((r) => live && setModels(r.models)).catch(() => undefined);
    return () => { live = false; };
  }, [be, cid, project, online]);
  return { agents, models, err };
}

function Progress({ s, can, call, choices }: { s: any; can: boolean; call: Call; choices: ReturnType<typeof useChoices> }) {
  const [extra, setExtra] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const { agents, models, err } = choices;
  const startable = (agents ?? []).filter((a) => a.canStart);
  // Until the computer has answered with its list, the usual agent is assumed and the computer decides: it refuses an agent it cannot start.
  const chosen = agent || startable[0]?.id || (agents === null ? 'claude-code' : '');
  const modelsFor = (models ?? []).filter((m) => m.agent === chosen);
  // With nothing found yet, the small default AgentOnTrack uses everywhere is used, and the screen says so. It is never claimed to be available.
  const FALLBACK_MODEL = 'haiku';
  const modelChoice = model || modelsFor.find((m) => m.entitlement === 'worked')?.id || modelsFor[0]?.id || (chosen ? FALLBACK_MODEL : '');
  const phases: any[] = s.plan?.phases ?? [];
  const next = phases.find((p) => p.status === 'ready');
  const done = phases.filter((p) => ['verified', 'done-unchecked', 'skipped'].includes(p.status)).length;
  return (
    <>
      <section className="m-card stack">
        <h2>{s.goal?.statement ?? 'No goal set'}</h2>
        {s.plan ? <>
          <div className="progress" role="progressbar" aria-valuenow={done} aria-valuemax={phases.length} aria-label="Phases done"><i style={{ width: `${phases.length ? (100 * done) / phases.length : 0}%` }} /></div>
          <p className="m-note">{done} of {phases.length} phases done. {s.plan.approved ? `Spent $${(s.plan.spent?.usd ?? 0).toFixed(3)} of $${s.plan.limits.maxUsd}.` : 'The plan is not approved yet: that happens on your computer.'}</p>
        </> : <p className="m-note">No plan yet. Plans are made and approved on your computer.</p>}
      </section>

      {phases.map((p, i) => (
        <section key={p.id} className="m-card stack" data-testid={`m-phase-${p.id}`} data-status={p.status}>
          <div className="row wrap"><b className="grow">{i + 1}. {p.title}</b><span className={`badge ${TONE[p.status] ?? 'muted'}`}>{STATUS[p.status] ?? p.status}</span></div>
          <p className="m-note">{p.why}</p>
          <p className="m-note">{p.agent ?? 'No agent'}{p.model ? `, ${p.model}` : ''}</p>
          <div className="row wrap">
            {p.status === 'ready' ? <button className="btn primary m-btn" disabled={!can} onClick={() => void call('run.start', { prompt: p.title, phaseId: p.id, extra }, 'Started on your computer.')} data-testid={`m-start-${p.id}`}>Start</button> : null}
            {['ready', 'failed', 'needs-evidence', 'stale'].includes(p.status) && p.checks > 0 ? <button className="btn m-btn" disabled={!can} onClick={() => void call('plan.loop', { phaseId: p.id, rounds: 3 }, 'Looping on your computer: up to 3 rounds, stopping at the first pass.')} data-testid={`m-loop-${p.id}`}>Repeat until checks pass</button> : null}
            {['needs-evidence', 'stale', 'failed'].includes(p.status) && p.checks > 0 ? <button className="btn m-btn" disabled={!can} onClick={() => void call('plan.verify', { phaseId: p.id }, 'Checks run.')}>Run the checks</button> : null}
            {p.state === 'draft' && !['verified', 'running'].includes(p.status) ? <button className="btn m-btn" disabled={!can} onClick={() => void call('plan.state', { phaseId: p.id, state: 'paused' }, 'Paused.')}>Pause</button> : null}
            {p.state === 'paused' ? <button className="btn m-btn" disabled={!can} onClick={() => void call('plan.state', { phaseId: p.id, state: 'draft' }, 'Resumed.')}>Resume</button> : null}
          </div>
        </section>
      ))}

      {phases.length ? (
        <section className="m-card stack">
          <h2>Keep going</h2>
          <p className="m-note">Runs the next ready phases on your computer, up to the number you choose. It stops at a failure, at anything waiting for approval, and before a release.</p>
          <div className="row wrap">
            {[1, 2, 3].map((n) => <button key={n} className="btn m-btn" disabled={!can || !next} onClick={() => void call('plan.continue', { maxPhases: n }, `Continuing for up to ${n}.`)} data-testid={`m-continue-${n}`}>{n} phase{n > 1 ? 's' : ''}</button>)}
            <button className="btn m-btn" disabled={!can} onClick={() => void call('plan.continue', { stop: true }, 'Stopped.')} data-testid="m-stop-continue">Stop</button>
          </div>
        </section>
      ) : null}

      <section className="m-card stack" data-testid="m-next">
        <h2>Next prompt</h2>
        {(s.suggestions ?? []).length === 0 ? <p className="m-note">Nothing is suggested right now.</p> : (s.suggestions as any[]).map((g) => (
          <div key={g.id} className="m-suggest stack" data-testid="m-suggestion">
            <b>{g.title}</b>
            <span className="m-note">{g.why}{g.agent ? ` Suggested agent: ${g.agent.name}${g.startable ? '' : ' (cannot be started from here)'}.` : ''} {g.scope}</span>
            {g.prompt ? <button className="btn m-btn" onClick={() => { setPrompt(g.prompt); if (g.agent && g.startable) { setAgent(g.agent.id); setModel(''); } }} data-testid="m-use-suggestion">Edit this prompt</button> : null}
          </div>))}
        <label>Add to the next phase<textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} name="m-extra" placeholder="Optional" /></label>
        <label>Or send your own prompt<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} name="m-prompt" placeholder="What should the agent do?" data-testid="m-prompt" /></label>
        <div className="row wrap">
          <label>Agent
            <select value={chosen} onChange={(e) => { setAgent(e.target.value); setModel(''); }} name="m-agent" data-testid="m-agent">
              {(agents ?? []).map((a) => <option key={a.id} value={a.id} disabled={!a.canStart}>{a.name} ({a.canStart ? 'ready' : STATUS_WORDS[a.status] ?? a.status})</option>)}
            </select>
          </label>
          <label>Model
            <select value={modelChoice} onChange={(e) => setModel(e.target.value)} name="m-model" data-testid="m-model" disabled={modelsFor.length === 0}>
              {modelsFor.length === 0 ? <option value={FALLBACK_MODEL}>{FALLBACK_MODEL} (small default, none found yet)</option> : modelsFor.map((m) => <option key={m.id} value={m.id}>{m.id}{m.entitlement === 'worked' ? ' (worked here)' : ' (found, not tried)'}</option>)}
            </select>
          </label>
        </div>
        {agents && startable.length === 0 ? <p className="m-note" data-testid="m-no-agent">No agent can be started from AgentOnTrack on this project yet. {agents.find((a) => a.reason)?.reason ?? ''}</p> : null}
        {agents === null && !err ? <p className="m-note" role="status">Asking your computer which agents it can start…</p> : null}
        {err ? <p className="m-note">Could not load the agent list: {err}. Sending still works if the computer is reachable.</p> : null}
        <p className="m-note">Models are those this computer reported or used. Whether your plan allows one is only known after a run uses it.</p>
        <button className="btn primary m-btn" disabled={!can || !prompt.trim() || !chosen || !modelChoice} onClick={() => void call('run.start', { prompt, agent: chosen, model: modelChoice }, 'Sent to your computer.').then((r) => { if (r) setPrompt(''); })} data-testid="m-send">Send</button>

      </section>
    </>
  );
}

function Activity({ s, can, call }: { s: any; can: boolean; call: Call }) {
  const runs: any[] = s.runs ?? [];
  return runs.length === 0 ? <div className="m-card"><p>No run since the computer's companion started.</p></div> : (
    <>{[...runs].reverse().map((r) => (
      <section key={r.id} className="m-card stack" data-testid="m-run" data-status={r.status}>
        <div className="row wrap"><b className="mono grow">{r.id}</b><span className="badge">{r.status}</span>{r.status === 'running' ? <button className="btn m-btn" disabled={!can} onClick={() => void call('run.stop', { runId: r.id }, 'Stopped.')} data-testid="m-stop-run">Stop</button> : null}</div>
        <pre className="code small" tabIndex={0}>{(r.tail ?? []).join('\n') || 'No output yet.'}</pre>
      </section>))}</>
  );
}

function Evidence({ s, be, cid, project, online }: { s: any; be: Backend; cid: string; project: string; online: boolean }) {
  const [files, setFiles] = useState<{ path: string }[] | null>(null);
  const [open, setOpen] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const a = useAction();
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const receipts: any[] = s.receipts ?? [];
  return (
    <>
      <section className="m-card stack"><h2>Checks the computer ran</h2>
        {receipts.length === 0 ? <p className="m-note">No receipt yet. An agent saying it is done is not evidence.</p> : receipts.map((r) => <p key={r.seq} className="m-note" data-testid="m-receipt"><span className={`badge ${r.passed ? 'good' : 'bad'}`}>{r.passed ? 'pass' : 'fail'}</span> {r.criterion}: {r.observed || r.source}</p>)}
        <p className="m-note">Record integrity: <b>{s.integrity?.ok ? 'intact' : 'a problem was found'}</b>.</p>
      </section>
      <section className="m-card stack"><h2>Files (read only)</h2>
        <button className="btn m-btn" disabled={!online || a.busy} onClick={() => void a.run(async () => { const r: any = await be.call(cid, 'files.list', { project }); setFiles(r.files); }, 'Loaded.')} data-testid="m-files">Show Markdown files</button>
        {files ? files.length === 0 ? <p className="m-note">No Markdown files.</p> : <ul className="list">{files.map((f) => <li key={f.path}><button className="link" onClick={() => void a.run(async () => { const r: any = await be.call(cid, 'file.read', { project, path: f.path }); setOpen(r); }, 'Opened.')}>{f.path}</button></li>)}</ul> : null}
        {a.msg && !a.ok ? <p role="alert" className="alert bad">{a.msg}</p> : null}
        {open ? <div className="stack"><b>{open.path}</b><pre className="code small" tabIndex={0} data-testid="m-file">{open.content}</pre>{open.truncated ? <p className="m-note">Cut short.</p> : null}</div> : null}
      </section>
    </>
  );
}

function Approvals({ s, can, call }: { s: any; can: boolean; call: Call }) {
  const list: any[] = s.approvals ?? [];
  return list.length === 0 ? <div className="m-card"><p>Nothing is waiting for you.</p></div> : (
    <>{list.map((a) => (
      <section key={a.id} className="m-card stack" data-testid="m-approval">
        <b>{a.kind}</b><code className="m-code">{a.target}</code><p className="m-note">{a.reason}</p>
        {!a.fromPhone ? <p className="m-note"><b>This kind of action is approved at your computer.</b> You can still decline it here.</p> : null}
        <div className="row wrap">
          {a.fromPhone ? <button className="btn primary m-btn" disabled={!can} onClick={() => void call('approval.decide', { id: a.id, decision: 'approve' }, 'Approved once, for ten minutes.')} data-testid="m-approve">Approve once</button> : null}
          <button className="btn m-btn" disabled={!can} onClick={() => void call('approval.decide', { id: a.id, decision: 'deny' }, 'Declined.')} data-testid="m-deny">Decline</button>
        </div>
      </section>))}</>
  );
}

function More({ s, be, can, call }: { s: any; be: Backend; can: boolean; call: Call }) {
  const [handoffs, setHandoffs] = useState<any[] | null>(null);
  const [me, setMe] = useState('');
  const [from, setFrom] = useState('claude-code');
  const [to, setTo] = useState('codex');
  useEffect(() => { void be.device().then((d) => setMe(`${d.name} (${d.fingerprint})`)); }, [be]);
  const u = s.usage ?? {};
  return (
    <>
      <section className="m-card stack" data-testid="m-usage"><h2>Usage and outcomes</h2>
        <dl className="kv"><dt>Tasks verified</dt><dd>{u.verified ?? 0} of {u.tasks ?? 0}</dd><dt>Tokens</dt><dd>{u.sessions ? (u.input + u.output).toLocaleString('en') : 'Unavailable'}</dd><dt>List-price cost</dt><dd>{u.costUsd === null || u.costUsd === undefined ? 'Unavailable' : `$${Number(u.costUsd).toFixed(4)}`}</dd><dt>Agent time</dt><dd>{u.runWallClockMs ? `${Math.round(u.runWallClockMs / 1000)} s` : 'Unavailable'}</dd></dl>
        <p className="m-note">As recorded on your computer. A saving is never claimed without a baseline you entered there.</p>
      </section>
      <section className="m-card stack"><h2>Hand work to another agent</h2>
        <p className="m-note">Carries the goal and the evidence, never the approvals: the next agent asks again.</p>
        <div className="row wrap"><label>From<input value={from} onChange={(e) => setFrom(e.target.value)} name="m-from" style={{ width: 120 }} /></label><label>To<input value={to} onChange={(e) => setTo(e.target.value)} name="m-to" style={{ width: 120 }} /></label></div>
        <div className="row wrap"><button className="btn primary m-btn" disabled={!can} onClick={() => void call('handoff.create', { from, to }, 'Handoff saved on your computer.')} data-testid="m-handoff">Create a handoff</button><button className="btn m-btn" disabled={!can} onClick={() => void call<{ handoffs: any[] }>('handoffs.list').then((r) => r && setHandoffs(r.handoffs))}>Show handoffs</button></div>
        {handoffs ? handoffs.length === 0 ? <p className="m-note">None yet.</p> : <ul className="list">{handoffs.map((h) => <li key={h.id} data-testid="m-handoff-row"><b className="mono">{h.id}</b> <span className="badge">{h.outcome}</span><br /><span className="m-note">{h.from} to {h.to ?? 'anyone'}</span> {h.outcome === 'prepared' ? <button className="link" disabled={!can} onClick={() => void call('handoff.accept', { id: h.id, to: h.to ?? to }, 'Accepted: no approval was carried over.')}>Accept</button> : null}</li>)}</ul> : null}
      </section>
      <section className="m-card stack"><h2>This phone</h2><p className="m-note">{me}</p><p className="m-note">If this phone is lost, remove it on your computer: Settings, Phone access, Revoke. It stops working at once.</p></section>
    </>
  );
}
