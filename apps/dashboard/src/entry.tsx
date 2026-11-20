import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { accountPage, accountsEnabled, checkAccess, connectGated, earlyAccessPage, signedInHere, signInPage } from './accounts';
import { currentPort, enterDemo, localAddress, onPublicSite, pair, probeCompanion, setPort, type Probe } from './api';
import { Icon, Logo } from './icons';
import { CopyCommand as Copy } from './copy-command';

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

type Gate = 'open' | 'checking' | 'signed-out' | 'not-approved' | 'revoked';

/**
 * The welcome page on the public site. Signing in and connecting a computer are separate: this page only decides which comes first.
 * While early access lasts, connecting a computer from this site is for approved testers; the local address a companion prints always works.
 */
function Welcome({ onLocal, onDemo }: { onLocal: () => void; onDemo: () => void }) {
  const on = accountsEnabled();
  const gated = connectGated();
  const signedIn = signedInHere();
  const [gate, setGate] = useState<Gate>(() => (!gated ? 'open' : signedIn ? 'checking' : 'signed-out'));
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (gate !== 'checking') return;
    checkAccess().then((a) => { setEmail(a.email); setGate(a.admin || a.member === 'active' ? 'open' : a.member === 'revoked' ? 'revoked' : a.signedIn ? 'not-approved' : 'signed-out'); }).catch(() => setGate('signed-out'));
  }, [gate]);
  const go = () => { location.href = `${signInPage()}?next=dashboard`; };
  return (
    <Frame>
      <h1>One place for your coding agents</h1>
      <p className="muted">Choose a project, type what you need, and let your agent work. You can review every important action before it runs.</p>
      {signedIn && on ? <div className="alert good" role="status">You are signed in. <a href={accountPage()}>Account</a></div> : null}
      <div className="stack" data-testid="welcome-options">
        {gate === 'open' ? <>
          <button className="btn primary big" onClick={onLocal} data-testid="continue-local"><Icon name="terminal" />Open my workspace</button>
          <p className="muted small">{on ? 'Connect the AgentOnTrack app running on your computer.' : 'No account required. Connect the AgentOnTrack app on this computer.'}</p>
        </> : null}
        {gate === 'checking' ? <p className="muted" role="status" data-testid="gate-checking">Checking your early-access status…</p> : null}
        {gate === 'signed-out' ? <div className="gate-note" data-testid="gate-signed-out">
          <b>Early access</b>
          <p className="muted small" style={{ margin: 0 }}>Sign in with your approved account to open the web workspace. You can also run AgentOnTrack locally without signing in.</p>
          <a className="btn primary big" href={`${signInPage()}?next=dashboard`} data-testid="gate-signin">Sign in to continue</a>
          <a className="btn big" href={earlyAccessPage()} data-testid="gate-apply">Apply for early access</a>
        </div> : null}
        {gate === 'not-approved' ? <div className="gate-note" data-testid="gate-not-approved">
          <b>Not approved yet</b>
          <p className="muted small" style={{ margin: 0 }}>{email ? `${email} is signed in, but ` : 'This account is signed in, but '}it is not an early-access tester yet. Your account page shows where your application stands. The local address your companion prints works whenever the companion is running.</p>
          <a className="btn big" href={accountPage()}>Your account</a>
        </div> : null}
        {gate === 'revoked' ? <div className="gate-note" data-testid="gate-revoked">
          <b>Access revoked</b>
          <p className="muted small" style={{ margin: 0 }}>This account's early access was switched off. The local address your companion prints still works for your own computer.</p>
          <a className="btn big" href={accountPage()}>Your account</a>
        </div> : null}
        {!on ? <p className="muted small" data-testid="signin-off">Online accounts are unavailable here. You can still use AgentOnTrack locally.</p> : (!signedIn && gate === 'open' ? <>
          <div className="divider"><span>or</span></div>
          <button className="btn big" onClick={go} data-testid="continue-signin">Sign in to your account</button>
          <p className="muted small">An account is for early access and the optional cloud features. It never gives this website access to your computer.</p>
        </> : null)}
        <div className="divider"><span>or look around first</span></div>
        <button className="btn big" onClick={onDemo} data-testid="explore-demo">Explore a demo <span className="badge warn">invented data</span></button>
        {on ? <a className="link" href="?m=1" data-testid="phone-preview-link">Use your phone to control a linked computer <span className="badge muted">experimental</span></a> : null}
      </div>
    </Frame>
  );
}

/** Guided: find the companion, then ask for the one-time code it shows in the terminal. */
function Connect({ onPaired, notice, onBack }: { onPaired: () => void; notice?: string; onBack?: () => void }) {
  const [code, setCode] = useState('');
  const [port, setPortValue] = useState(currentPort());
  const [error, setError] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false); // nothing talks to this computer until the person presses the button
  const lookSeq = useRef(0);
  const pub = onPublicSite();

  const look = useCallback(async () => {
    if (!pub) return;
    setAsked(true);
    const mine = ++lookSeq.current; // answers can arrive out of order (mount probe vs a later Retry); only the newest one may set the result
    setProbe(null);
    try { setPort(port); } catch (e) { setError((e as Error).message); return; }
    const answer = await probeCompanion(port);
    if (mine === lookSeq.current) setProbe(answer);
  }, [pub, port]);

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

      {pub && !asked ? (
        <div className="stack" data-testid="probe-intro">
          <p><b>Step 1.</b> Open a terminal on this computer and start AgentOnTrack:</p>
          <Copy text={START} />
          <p><b>Step 2.</b> Click below. We will look for the app running on this computer.</p>
          <button className="btn primary big" type="button" onClick={() => void look()} data-testid="retry">Check for AgentOnTrack</button>
          <details className="small"><summary>Why might my browser ask for permission?</summary>
            <p>Chrome and Edge may ask for local network access. <b>Allow</b> lets this page reach the app on your computer. <b>Block</b> leaves your account and website working, but prevents this connection. Nothing starts until you click the check button. Safari may require opening the local app directly instead.</p>
          </details>
        </div>
      ) : null}

      {pub && asked ? (
        <div role="status" aria-live="polite" data-testid="probe-status" className={`probe ${probe?.state ?? 'look'}`}>
          {probe === null ? 'Looking for AgentOnTrack on this computer… If your browser asks for permission, choose Allow or Block.' : probe.state === 'timeout' ? 'No answer yet. The permission question may still be open, or nothing is listening on this port. Press Retry.' : probe.state === 'found' ? 'Found AgentOnTrack on this computer.' : probe.state === 'blocked' ? 'Your browser is blocking this page from reaching your computer.' : 'AgentOnTrack isn’t running on this computer.'}
        </div>
      ) : null}

      {pub && probe?.state === 'blocked' ? (
        <div className="alert warn" data-testid="probe-blocked">
          <p>You chose Block, or your browser blocks it. That is fine: use the local address instead, or allow &ldquo;local network access&rdquo; for this site in your browser&apos;s site settings, then press Retry. Safari does not allow this from a secure page; use the local dashboard instead.</p>
        </div>
      ) : null}

      {pub && (probe?.state === 'none' || probe?.state === 'timeout') ? (
        <ol className="steps big" data-testid="probe-steps">
          <li><b>Get AgentOnTrack.</b> It installs in one command and needs no administrator rights. <a href={`${SITE}install/`} data-testid="download-link">Download and install</a> (a ZIP is an archive to unpack, not an installation)</li>
          <li><b>Start it.</b> In your project folder, run: <Copy text={START} /></li>
          <li><b>Come back and press “I’ve started it, check again”.</b></li>
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
        {pub && asked ? <button className="btn" type="button" onClick={() => void look()} data-testid="retry">I’ve started it, check again</button> : null}
        {pub && (found || probe?.state === 'blocked' || probe?.state === 'timeout') ? <a className="btn" href={localAddress()} data-testid="open-local">Open the local dashboard</a> : null}
        {pub && !found ? <a className="btn" href={`${SITE}install/`}>Download</a> : null}
      </div>
      {pub ? (
        <details className="small"><summary>This computer uses a different port</summary>
          <label>Companion port<input value={port} onChange={(e) => setPortValue(e.target.value)} name="port" inputMode="numeric" /></label>
        </details>
      ) : <p className="muted small">Everything here stays on this machine. No account is needed.</p>}
      {pub ? <details className="small"><summary>Connection troubleshooting</summary><p>The address the helper prints in your terminal, such as <code>{localAddress()}</code>, works only while the helper is running, and asks for nothing. If your browser blocks local network access, open that address directly. It is reachable only from this computer: to control a desktop from your phone, use the experimental phone link, not this address.</p></details> : null}
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
      </div>
    </section>
  );
}
