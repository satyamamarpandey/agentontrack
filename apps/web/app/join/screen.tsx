'use client';
import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import Link from '../link';
import { Icon } from '../ui/icons';
import { BASE_PATH, loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import type { Access } from '../../lib/accounts';
import { SignInPanel, type Api } from '../sign-in/panel';

type Stage =
  | { kind: 'loading' }
  | { kind: 'no-code' }
  | { kind: 'sign-in' }
  | { kind: 'verify'; user: User; sent: boolean; note: string }
  | { kind: 'redeeming' }
  | { kind: 'done' }
  | { kind: 'member' }
  | { kind: 'error'; message: string; signedIn: boolean };

const codeFromAddress = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('t') ?? '';

/** Using an invitation: sign in (or create the account) with the invited address, confirm it if needed, then the invitation is used once. */
export function JoinScreen() {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [api, setApi] = useState<Api | null>(null);
  const [busy, setBusy] = useState(false);

  const proceed = async (a: Api, user: User | null, access?: Access) => {
    if (!user) { setStage({ kind: 'sign-in' }); return; }
    const acc = access ?? await a.access();
    if (acc.member === 'active') { setStage({ kind: 'member' }); return; }
    if (!user.emailVerified) { setStage({ kind: 'verify', user, sent: false, note: '' }); return; }
    setStage({ kind: 'redeeming' });
    try { await a.redeemInvite(codeFromAddress()); setStage({ kind: 'done' }); }
    catch (e) { setStage({ kind: 'error', message: (e as Error).message, signedIn: true }); }
  };

  useEffect(() => {
    if (!codeFromAddress()) { setStage({ kind: 'no-code' }); return; }
    if (!loadAccounts) return;
    if (localStorage.getItem(SIGNED_IN_FLAG) !== '1') { setStage({ kind: 'sign-in' }); return; }
    loadAccounts().then(async (a) => { setApi(a); await proceed(a, await a.currentUser()); }).catch((e) => setStage({ kind: 'error', message: (e as Error).message, signedIn: false }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const card = (() => {
    switch (stage.kind) {
      case 'loading': return <p className="muted" role="status">One moment…</p>;
      case 'no-code': return <div className="stack" data-testid="join-no-code"><h2>This link is incomplete</h2><p>An invitation link ends with a long code. Copy the whole link from the message you received and open it again. If you were not invited yet, you can <Link href="/early-access">apply for early access</Link>.</p></div>;
      case 'sign-in': return <div className="stack"><h2>Use your invitation</h2><SignInPanel allowCreate next="join" intro="Sign in, or create your account, with the email address the invitation was sent to. The invitation works for that address only." onSignedIn={async (a, user, access) => { setApi(a); await proceed(a, user, access); }} /></div>;
      case 'verify': return (
        <div className="stack" data-testid="join-verify">
          <h2>Confirm your email address</h2>
          <p>Your invitation is for <b>{stage.user.email}</b>. Confirm that this address is yours: press the button, open the email from AgentOnTrack, follow its link, then come back here.</p>
          {stage.note ? <p className="alert good" role="status">{stage.note}</p> : null}
          <div className="row">
            <button className="btn primary" disabled={busy} data-testid="send-verification" onClick={() => { setBusy(true); api!.sendVerification().then(() => setStage({ ...stage, sent: true, note: 'Sent. Check your inbox, and the spam folder if it is not there.' })).catch((e) => setStage({ ...stage, note: api!.explain(e) })).finally(() => setBusy(false)); }}>{stage.sent ? 'Send again' : 'Send confirmation email'}</button>
            <button className="btn" disabled={busy} data-testid="verified-continue" onClick={() => { setBusy(true); api!.refreshVerified().then(async (ok) => { if (ok) await proceed(api!, stage.user); else setStage({ ...stage, note: 'Not confirmed yet. Follow the link in the email first, then press this again.' }); }).finally(() => setBusy(false)); }}>I have confirmed it</button>
          </div>
          <p className="small muted">Wrong account? <button type="button" className="link" onClick={() => api!.signOutHere().then(() => setStage({ kind: 'sign-in' }))}>Sign out</button> and use the invited address.</p>
        </div>
      );
      case 'redeeming': return <p className="muted" role="status">Checking your invitation…</p>;
      case 'done': return (
        <div className="stack" data-testid="join-done">
          <p className="badge good" style={{ alignSelf: 'flex-start' }}><Icon name="check" size={14} />You are in</p>
          <h2>Welcome to the early access group.</h2>
          <p>Your account is active. Three steps from here:</p>
          <ol>
            <li><Link href="/install">Install the desktop preview</Link> on your own computer. It needs no administrator rights.</li>
            <li>Run <code>agentontrack setup</code> in a project folder to connect your Claude Code or Codex, then <code>agentontrack dashboard --allow-public-site</code> to use the dashboard from this site.</li>
            <li>Tell the maintainer what you find on the <Link href="/feedback">feedback page</Link>: bugs, ideas, and what felt wrong.</li>
          </ol>
          <div className="row"><Link className="btn primary" href="/install">Install AgentOnTrack<Icon name="arrow-right" size={16} /></Link><Link className="btn" href="/account">Your account</Link></div>
        </div>
      );
      case 'member': return <div className="stack" data-testid="join-member"><h2>You already have access</h2><p>This account is an active early-access member, so the invitation is not needed.</p><div className="row"><Link className="btn primary" href="/install">Install</Link><Link className="btn" href="/account">Your account</Link></div></div>;
      case 'error': return (
        <div className="stack" data-testid="join-error">
          <h2>This invitation could not be used</h2>
          <p className="alert bad" role="alert">{stage.message}</p>
          <p className="small muted">Invitations work once, for the address they were sent to, and expire. If you think this is wrong, reply to the person who invited you and ask for a new link.</p>
          {stage.signedIn && api ? <p className="small"><button type="button" className="link" onClick={() => api.signOutHere().then(() => setStage({ kind: 'sign-in' }))}>Sign out and try another account</button></p> : null}
        </div>
      );
    }
  })();

  return (
    <div className="wrap auth">
      <div className="auth-side">
        <p className="eyebrow">Early access</p>
        <h1>Your invitation to AgentOnTrack.</h1>
        <p className="lead">A personal link from the maintainer. It creates your early-access account; everything AgentOnTrack does still happens on your own machine, with your own agents.</p>
        <p className="small muted">Prefer to look first? The <a href={`${BASE_PATH}/dashboard/?demo=1`}>demo</a> shows the dashboard with invented data and needs no account.</p>
      </div>
      <div className="auth-card">{card}</div>
    </div>
  );
}
