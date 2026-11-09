import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { accountPage, accountsEnabled, signedInHere } from './accounts';
import { currentPort, enterDemo, localAddress, onPublicSite, pair, probeCompanion, setPort, type Probe } from './api';
import { Icon, Logo } from './icons';

const SITE = import.meta.env.BASE_URL.replace(/dashboard\/$/, '');
const START = 'agentontrack dashboard --allow-public-site';

function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="pair">
      <div className={`card pair-card ${wide ? 'wide' : ''}`}>
        <div className="brand"><Logo /> AgentOnTrack</div>
        {children}
      </div>
    </main>
  );
}

/** The sign-in choices. Signing in and connecting a computer are separate: this page only decides which comes first. */
function Welcome({ onLocal, onDemo }: { onLocal: () => void; onDemo: () => void }) {
  const on = accountsEnabled();
  const signedIn = signedInHere();
  const go = () => { location.href = `${accountPage()}?next=dashboard`; };
  return (
    <Frame>
      <h1>Keep your AI coding agents on track</h1>
      <p className="muted">Set a goal, approve what matters, and see proof when the work is done. Your code and your agents stay on your computer.</p>
      {signedIn ? <div className="alert good" role="status">You are signed in. <a href={accountPage()}>Account</a></div> : null}
      <div className="stack" data-testid="welcome-options">
        <button className="btn primary big" onClick={onLocal} data-testid="continue-local"><Icon name="terminal" />Continue on this computer</button>
        <p className="muted small">No account needed. Next, you connect this computer to your own AgentOnTrack.</p>
        <div className="divider"><span>or sign in to save your preferences</span></div>
        <button className="btn big" disabled={!on} onClick={go} data-testid="continue-google">Continue with Google</button>
        <button className="btn big" disabled={!on} onClick={go} data-testid="continue-github">Continue with GitHub</button>
        <button className="btn big" disabled={!on} onClick={go} data-testid="continue-email">Sign up or sign in with email</button>
        {!on
          ? <p className="muted small" data-testid="signin-off">Sign-in is not switched on for this site yet. Everything else works without it.</p>
          : <p className="muted small">Signing in is experimental (tested against emulators only) and saves your preferences. It never gives this website access to your computer.</p>}
        <div className="divider"><span>or look around first</span></div>
        <button className="btn big" onClick={onDemo} data-testid="explore-demo">Explore a demo <span className="badge warn">invented data</span></button>
      </div>
    </Frame>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copybox">
      <code>{text}</code>
      <button type="button" className="btn small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** Guided: find the companion, then ask for the one-time code it shows in the terminal. */
function Connect({ onPaired, notice, onBack }: { onPaired: () => void; notice?: string; onBack?: () => void }) {
  const [code, setCode] = useState('');
  const [port, setPortValue] = useState(currentPort());
  const [error, setError] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState(false);
  const lookSeq = useRef(0);
  const pub = onPublicSite();

  const look = useCallback(async () => {
    if (!pub) return;
    const mine = ++lookSeq.current; // answers can arrive out of order (mount probe vs a later Retry); only the newest one may set the result
    setProbe(null);
    try { setPort(port); } catch (e) { setError((e as Error).message); return; }
    const answer = await probeCompanion(port);
    if (mine === lookSeq.current) setProbe(answer);
  }, [pub, port]);
  useEffect(() => { void look(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { if (pub) setPort(port); await pair(code); onPaired(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const found = !pub || probe?.state === 'found';

  return (
    <Frame wide>
      {onBack ? <button className="link back" onClick={onBack}>Back</button> : null}
      <h1>Connect this computer</h1>
      <p className="muted">AgentOnTrack runs a small helper on your computer. It reads your projects and starts your agents, and this page only talks to it. Connecting needs a one-time code that appears in your own terminal, so no website can connect on its own.</p>
      {notice && !error ? <div className="alert warn" role="status" data-testid="pair-notice">{notice}</div> : null}

      {pub ? (
        <div role="status" aria-live="polite" data-testid="probe-status" className={`probe ${probe?.state ?? 'look'}`}>
          {probe === null ? 'Looking for AgentOnTrack on this computer…' : probe.state === 'found' ? 'Found AgentOnTrack on this computer.' : probe.state === 'blocked' ? 'Your browser is blocking this page from reaching your computer.' : 'AgentOnTrack was not found on this computer.'}
        </div>
      ) : null}

      {pub && probe?.state === 'blocked' ? (
        <div className="alert warn" data-testid="probe-blocked">
          <p>Allow &ldquo;local network access&rdquo; for this site in your browser&apos;s site settings, then press Retry. Safari does not allow this from a secure page; use the local dashboard instead.</p>
        </div>
      ) : null}

      {pub && probe?.state === 'none' ? (
        <ol className="steps big" data-testid="probe-steps">
          <li><b>Get AgentOnTrack.</b> It installs in one command and needs no administrator rights. <a href={`${SITE}install/`} data-testid="download-link">Download and install</a></li>
          <li><b>Start it.</b> In your project folder, run: <Copy text={START} /></li>
          <li><b>Come back and press Retry.</b></li>
        </ol>
      ) : null}

      {found ? (
        <form onSubmit={submit} className="stack" data-testid="pair-form">
          <ol className="steps big"><li>Your terminal now shows a pairing code. If it does not, press Enter there for a new one.</li><li>Type the code here. It works once and expires after 5 minutes.</li></ol>
          {error ? <div className="alert bad" role="alert">{error}</div> : null}
          <label>Pairing code<input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" spellCheck={false} name="code" /></label>
          <button className="btn primary big" type="submit" disabled={busy}>Pair</button>
        </form>
      ) : null}

      <div className="row wrap">
        {pub ? <button className="btn" type="button" onClick={() => void look()} data-testid="retry">Retry</button> : null}
        {pub ? <a className="btn" href={localAddress()} data-testid="open-local">Open the local dashboard</a> : null}
        {pub && !found ? <a className="btn" href={`${SITE}install/`}>Download</a> : null}
      </div>
      {pub ? (
        <details className="small"><summary>This computer uses a different port</summary>
          <label>Companion port<input value={port} onChange={(e) => setPortValue(e.target.value)} name="port" inputMode="numeric" /></label>
        </details>
      ) : <p className="muted small">Everything here stays on this machine. No account is needed.</p>}
      {pub ? <p className="muted small">This page talks only to the helper on your own machine. Your data does not go to this website. If your browser asks about local network access, it must be allowed. The address the helper prints in your terminal, such as <code>{localAddress()}</code>, always works and asks for nothing.</p> : null}
    </Frame>
  );
}

export function Entry({ onPaired, notice }: { onPaired: () => void; notice?: string }) {
  const pub = onPublicSite();
  // A person coming back after the companion restarted goes straight to connecting. A new visitor sees the welcome.
  const [step, setStep] = useState<'welcome' | 'connect'>(() => (!pub || notice || new URLSearchParams(location.search).has('connect') ? 'connect' : 'welcome'));
  if (step === 'welcome') return <Welcome onLocal={() => setStep('connect')} onDemo={() => { enterDemo(); onPaired(); }} />;
  return <Connect onPaired={onPaired} {...(notice ? { notice } : {})} {...(pub ? { onBack: () => setStep('welcome') } : {})} />;
}

/** Shown when a paired computer stops answering. Four ways forward, and no empty workspace. */
export function Offline({ onRetry, onConnect }: { onRetry: () => void; onConnect: () => void }) {
  return (
    <section className="offline" role="alert" data-testid="offline">
      <h2>Your computer is not connected</h2>
      <p>This page lost contact with AgentOnTrack on your computer. Your projects and records are safe: they live there, not here. The helper may have stopped, or been restarted.</p>
      <ol className="steps big">
        <li><b>Start it again.</b> In your project folder, run: <Copy text={START} /></li>
        <li>Press <b>Retry</b>. If the helper was restarted, you will need a new code: press <b>Connect again</b>.</li>
      </ol>
      <div className="row wrap">
        <button className="btn primary" onClick={onRetry} data-testid="offline-retry">Retry</button>
        <button className="btn" onClick={onConnect} data-testid="offline-connect">Connect again</button>
        <a className="btn" href={`${SITE}install/`}>Download</a>
        <a className="btn" href={localAddress()}>Open the local dashboard</a>
      </div>
    </section>
  );
}
