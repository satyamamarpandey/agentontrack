import { useEffect, useState } from 'react';
import { accountsEnabled, accountPage, linkBackend } from './accounts';
import { get, isDemo, post } from './api';
import { useHuman } from './human';
import { Loading, useLoad } from './ui';

interface Device { did: string; name: string; level: 'view' | 'control'; fingerprint: string; trustedAt: string; revokedAt?: string }
interface Status { exists: boolean; linked?: boolean; running?: boolean; online?: boolean; lastError?: string; degraded?: 'quota' | null; computerId?: string; name?: string; fingerprint?: string; devices?: Device[]; pending?: { did: string; name: string; fingerprint: string }[]; maxUsdPerRun?: number }

/**
 * Link this computer to the person's own account, and approve phones one by one. The phone is a remote control for projects that already
 * exist here: it cannot create projects, write code or run a terminal, and nothing is trusted until a person approves it on this computer.
 */
export function PhoneAccessCard() {
  return <><PhoneLinkCard /><DefaultProjectCard /></>;
}

function PhoneLinkCard() {
  const st = useLoad<Status>(() => get('/api/remote/status'), []);
  const [who, setWho] = useState<{ uid: string; email: string | null } | null | 'loading'>('loading');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState<Record<string, 'view' | 'control'>>({});
  const { ask, dialog } = useHuman(() => st.reload());
  const enabled = accountsEnabled() && !isDemo();

  useEffect(() => { const t = setInterval(st.reload, 4000); return () => clearInterval(t); }, [st.reload]);
  useEffect(() => { if (enabled) void linkBackend().then((b) => b.whoAmI(b.config)).then(setWho).catch(() => setWho(null)); }, [enabled]);

  if (!enabled) {
    return (
      <section className="card stack" data-testid="phone-access">
        <h2>Phone access <span className="badge muted" data-testid="experimental">experimental</span></h2>
        <p className="muted small">{isDemo() ? 'Not available in the demo.' : 'Controlling your projects from your phone needs the optional account features of the AgentOnTrack site. They are not switched on here, so nothing about your computer is shared, and this computer cannot be reached from outside.'}</p>
      </section>
    );
  }
  if (!st.data) return <Loading error={st.error} />;
  const s = st.data;

  const link = async () => {
    setBusy(true); setMsg('');
    try {
      const prepared = await post('/api/remote/prepare');
      const b = await linkBackend();
      const info = await b.createComputerAccount(b.config, prepared);
      ask({ title: 'Link this computer to your account', detail: <div className="stack small"><p>This lets a phone signed in to <b>{who && who !== 'loading' ? who.email ?? 'your account' : 'your account'}</b> ask this computer for things. Nothing is allowed yet: you approve each phone here, one by one, and a phone can never run a command, write code or create a project.</p><p>This computer&apos;s fingerprint: <code>{prepared.fingerprint}</code></p></div>, path: '/api/remote/link', body: info });
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card stack" data-testid="phone-access">
      {dialog}
      <h2>Phone access <span className="badge muted" data-testid="experimental">experimental</span></h2>
      <p className="muted small" data-testid="experimental-note">Experimental. Phone control has been tested against local emulators only, not against a real Firebase project or a physical phone. Do not rely on it to stop an agent.</p>
      <p className="muted small">Use your phone as a remote control for the projects already on this computer: see progress, send the next prompt, pause or stop, and decide what is waiting for you. It cannot write code, open a terminal or make projects. Everything is encrypted between your phone and this computer, and Firebase only carries sealed messages.</p>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}

      {!s.linked ? (
        <div className="stack">
          {who === 'loading' ? <p className="muted small">Checking your sign-in…</p> : !who
            ? <p>Sign in first, on the <a href={accountPage()} target="_blank" rel="noopener">account page</a> (it opens in a new tab), then come back and press the button.</p>
            : <p className="small">Signed in as <b data-testid="phone-who">{who.email ?? who.uid}</b>.</p>}
          <div><button className="btn primary" disabled={busy || !who || who === 'loading'} onClick={() => void link()} data-testid="phone-link">Link this computer to my account…</button></div>
        </div>
      ) : (
        <div className="stack">
          <p className="small" data-testid="phone-state">
            <span className={`badge ${s.online ? 'good' : 'warn'}`}>{s.degraded === 'quota' ? 'Paused: daily Firebase allowance used' : s.online ? 'Online' : 'Not reachable'}</span>{' '}
            {s.lastError ? <span className="muted">{s.lastError}</span> : null}
          </p>
          <p className="small">This computer: <b>{s.name}</b>. Its fingerprint, to compare with your phone: <code data-testid="computer-fingerprint">{s.fingerprint}</code></p>

          {(s.pending ?? []).length ? <div className="alert warn stack" data-testid="phone-pending">
            <b>A phone is asking to connect</b>
            {s.pending!.map((d) => (
              <div key={d.did} className="stack">
                <p className="small">{d.name || 'A phone'}. Its fingerprint: <code>{d.fingerprint}</code>. Approve it only if the same fingerprint is on your phone&apos;s screen.</p>
                <div className="row wrap">
                  <label>It may<select value={level[d.did] ?? 'view'} onChange={(e) => setLevel({ ...level, [d.did]: e.target.value as 'view' | 'control' })} name={`level-${d.did}`}><option value="view">Look only</option><option value="control">Look and control</option></select></label>
                  <button className="btn small primary end-self" onClick={() => ask({ title: 'Approve this phone', detail: <div className="stack small"><p>{d.name || 'A phone'} with fingerprint <code>{d.fingerprint}</code> will be able to {(level[d.did] ?? 'view') === 'control' ? 'see your projects and control them: start and stop runs, pause and continue plans, decline approvals, and approve small file writes. It can never approve a push, a deploy or a deletion.' : 'see your projects, but not change anything.'}</p></div>, path: '/api/remote/devices/trust', body: { did: d.did, level: level[d.did] ?? 'view', fingerprint: d.fingerprint } })} data-testid={`trust-${d.did}`}>Approve…</button>
                </div>
              </div>
            ))}
          </div> : null}

          <h3>Approved phones</h3>
          {(s.devices ?? []).filter((d) => !d.revokedAt).length === 0 ? <p className="muted small">None yet. On your phone, sign in to the same account, open AgentOnTrack and ask to connect.</p> : (
            <ul className="list" data-testid="phone-devices">{(s.devices ?? []).filter((d) => !d.revokedAt).map((d) => (
              <li key={d.did} className="row wrap">
                <span className="grow"><b>{d.name}</b> <span className="badge">{d.level === 'control' ? 'look and control' : 'look only'}</span><br /><span className="muted small">fingerprint {d.fingerprint}, approved {new Date(d.trustedAt).toLocaleDateString()}</span></span>
                <button className="btn small" onClick={async () => { setMsg(''); try { await post('/api/remote/devices/revoke', { did: d.did }); st.reload(); } catch (e) { setMsg((e as Error).message); } }} data-testid={`revoke-${d.did}`}>Revoke</button>
              </li>))}</ul>
          )}

          <div className="row wrap">
            <label>Most a phone may spend on one run (USD)<input type="number" min={0.05} max={5} step={0.05} defaultValue={s.maxUsdPerRun} name="phone-max" style={{ width: 110 }} onBlur={(e) => { const v = Number(e.target.value); if (v && v !== s.maxUsdPerRun) ask({ title: 'Change the phone spending limit', detail: <p>A phone will be able to start runs of up to ${v}.</p>, path: '/api/remote/settings', body: { maxUsdPerRun: v } }); }} /></label>
            <button className="btn danger end-self" onClick={() => { if (window.confirm('Unlink this computer? Every phone loses access at once.')) void post('/api/remote/unlink').then(() => st.reload()).catch((e) => setMsg(e.message)); }} data-testid="phone-unlink">Unlink and revoke every phone</button>
          </div>
        </div>
      )}
    </section>
  );
}

interface DefaultProject { projectId: string; name: string | null; path: string; valid: boolean; setAt: string }
interface ProjectRow { id: string; name: string; root: string; archived?: boolean; missing?: boolean }

/**
 * The one project a phone may start NEW sessions in. The phone never names a folder: it asks for "the default project", and this computer
 * resolves it. Setting, changing or clearing it needs the same proof as any other phone setting (a code from this computer's terminal).
 */
export function DefaultProjectCard() {
  const st = useLoad<{ exists: boolean; defaultProject?: DefaultProject | null }>(() => get('/api/remote/status'), []);
  const projects = useLoad<ProjectRow[]>(() => get('/api/projects'), []);
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState('');
  const { ask, dialog } = useHuman(() => st.reload());
  if (isDemo()) return null;
  if (!st.data) return <Loading error={st.error} />;
  const dp = st.data.defaultProject ?? null;
  const choices = (projects.data ?? []).filter((r) => !r.archived && !r.missing);
  const chosen = choices.find((r) => r.id === (pick || dp?.projectId || ''));
  const setup = async () => { setMsg(''); try { await post('/api/remote/prepare'); st.reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <section className="card stack" data-testid="default-project" aria-labelledby="dp-h">
      {dialog}
      <h2 id="dp-h">Default project for mobile sessions</h2>
      <p className="muted small">A phone you have approved to control may start a <b>new</b> agent session in this one project, and only here. It never chooses a folder: it can only ask for &quot;the default project&quot;, and this computer decides what that means. Anything dangerous, such as a push, a deploy or a deletion, is still approved on this computer, never from the phone. With no default project set, a phone cannot start new sessions.</p>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      {!st.data.exists ? (
        <div className="stack">
          <p className="small" data-testid="dp-not-ready">This computer has not been set up for phone access yet, so there is nothing to attach a default project to.</p>
          <div><button className="btn small" onClick={() => void setup()} data-testid="dp-setup">Set up phone access on this computer</button></div>
        </div>
      ) : (
        <div className="stack">
          <p className="small" data-testid="dp-current">
            {dp ? <>
              Current: <b>{dp.name ?? 'a project that is no longer registered'}</b>{' '}
              <span className={`badge ${dp.valid ? 'good' : 'bad'}`} data-testid="dp-valid">{dp.valid ? 'available' : 'not available'}</span><br />
              <span className="muted">Folder: <code data-testid="dp-path">{dp.path}</code></span>
              {dp.valid ? null : <><br /><span className="alert warn small" role="status">A phone cannot start sessions here: the project is archived, unregistered, or its folder is not the one that was chosen. Choose it again, or clear it.</span></>}
            </> : <>No default project is set. A phone cannot start new sessions.</>}
          </p>
          <div className="row wrap">
            <label>Project
              <select name="dp-select" value={chosen?.id ?? ''} onChange={(e) => setPick(e.target.value)} data-testid="dp-select">
                <option value="" disabled>Choose a project…</option>
                {choices.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <button className="btn small primary end-self" disabled={!chosen || (chosen.id === dp?.projectId && dp.valid)} data-testid="dp-save"
              onClick={() => chosen && ask({ title: dp ? 'Change the default project for phones' : 'Set the default project for phones', detail: <div className="stack small"><p>A phone you approved to control will be able to start new sessions in <b>{chosen.name}</b> (<code>{chosen.root}</code>), and nowhere else. It cannot pick a folder, and dangerous approvals stay on this computer.</p></div>, path: '/api/remote/settings', body: { defaultProjectId: chosen.id } })}>{dp ? 'Change…' : 'Set…'}</button>
            {dp ? <button className="btn small end-self" data-testid="dp-clear" onClick={() => ask({ title: 'Clear the default project for phones', detail: <p className="small">A phone will no longer be able to start new sessions. Sessions already running are not stopped.</p>, path: '/api/remote/settings', body: { defaultProjectId: null } })}>Clear…</button> : null}
          </div>
          {choices.length === 0 && projects.data ? <p className="muted small">No registered, unarchived project exists yet. Add one under Projects first.</p> : null}
        </div>
      )}
    </section>
  );
}
