'use client';
import { lazy, Suspense, useEffect, useState } from 'react';
import Link from '../link';
import { EarlyAccessButton } from '../early-access/launcher';
import { Icon } from '../ui/icons';
import { loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import type { Access } from '../../lib/accounts';
import { REPO } from '../../lib/release';

// The instructions are a separate chunk, asked for only after the check passes. This is a door for people, not a vault: the program is open source.
const Steps = lazy(() => import('./steps').then((m) => ({ default: m.InstallSteps })));

type State = { kind: 'checking' } | { kind: 'signed-out' } | { kind: 'not-member'; access: Access } | { kind: 'member' } | { kind: 'error'; message: string };

/**
 * While early access lasts, the install steps are shown to approved testers. Everyone else sees how to apply, and an honest note that the source is public.
 * The visitor's gate is what the server renders, so nothing moves when the page hydrates; only someone whose browser says they signed in gets a check,
 * inside the same box, and a tester's steps then take its place.
 */
export function InstallGate() {
  const [state, setState] = useState<State>({ kind: 'signed-out' });
  useEffect(() => {
    if (!loadAccounts) return;
    let signedIn = false;
    try { signedIn = localStorage.getItem(SIGNED_IN_FLAG) === '1'; } catch { /* storage may be blocked */ }
    if (!signedIn) return;
    setState({ kind: 'checking' });
    loadAccounts().then(async (a) => {
      const access = await a.access();
      if (!access.signedIn) setState({ kind: 'signed-out' });
      else if (access.member === 'active' || access.admin) setState({ kind: 'member' });
      else setState({ kind: 'not-member', access });
    }).catch((e) => setState({ kind: 'error', message: (e as Error).message }));
  }, []);

  if (state.kind === 'member') return <Suspense fallback={<div className="gate" aria-busy="true"><p className="muted" role="status">Loading the install steps…</p></div>}><div data-testid="install-steps"><Steps /></div></Suspense>;
  return (
    <div className="gate" data-testid="install-gate">
      <div>
        <p className="eyebrow">Early access</p>
        <h2>Installs are open to invited testers for now.</h2>
        {state.kind === 'checking' ? <p className="muted" role="status" data-testid="install-checking">Checking your access…</p>
          : state.kind === 'error' ? <p className="alert bad" role="alert">{state.message}</p>
          : state.kind === 'signed-out' ? <p className="muted">If you have an account, sign in to see the install steps. If you have an invitation link, open it: it signs you up. Otherwise, apply, and the maintainer will be in touch.</p>
          : <p className="muted" data-testid="install-not-approved">You are signed in as {state.access.email}, but this account is not an approved tester{state.access.member === 'revoked' ? ' any more' : ' yet'}. Your account page shows where your application stands.</p>}
        <p className="small muted">AgentOnTrack is open source under Apache-2.0, so its <a href={REPO}>source and releases are public on GitHub</a>. This page gates the guided install and the support that comes with early access, not the code.</p>
      </div>
      <div className="stack" style={{ minWidth: 220 }}>
        {state.kind === 'signed-out' ? <Link className="btn primary big" href="/sign-in?next=install" data-testid="install-signin">Sign in<Icon name="arrow-right" size={16} data-nudge="" /></Link> : <Link className="btn big" href="/account">Your account</Link>}
        <EarlyAccessButton className="btn big" testId="install-apply">Apply for early access</EarlyAccessButton>
      </div>
    </div>
  );
}
