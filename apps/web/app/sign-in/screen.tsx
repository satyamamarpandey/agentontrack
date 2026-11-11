'use client';
import { useEffect, useState } from 'react';
import { Icon } from '../ui/icons';
import { destination, SignInPanel } from './panel';

/** The sign-in page: a brand panel beside the card. After sign-in the person goes back to what sent them here, or to their account. */
export function SignInScreen() {
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => { setNext(new URLSearchParams(location.search).get('next')); }, []);
  return (
    <div className="wrap auth">
      <div className="auth-side">
        <p className="eyebrow">Welcome back</p>
        <h1>Sign in to AgentOnTrack.</h1>
        <p className="lead">Your account is for early access and the optional cloud features: your profile, saved summaries and the phone link. Your code, prompts and agents stay on your own machine.</p>
        <ul className="plain" style={{ marginTop: 20 }}>
          {[['lock', 'Accounts are invitation-only during early access.'], ['shield', 'Signing in grants this website nothing on your computer.'], ['phone', 'The phone link and saved summaries are off until you turn them on.']].map(([i, t]) => <li key={t} style={{ display: 'flex', gap: 12, alignItems: 'center' }}><span className="step-icon" style={{ marginBottom: 0, flex: 'none' }}><Icon name={i!} /></span><span className="muted">{t}</span></li>)}
        </ul>
      </div>
      <div className="auth-card">
        <h2>Sign in</h2>
        <SignInPanel next={next} onSignedIn={() => { location.href = destination(next); }} />
      </div>
    </div>
  );
}
