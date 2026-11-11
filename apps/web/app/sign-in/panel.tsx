'use client';
import { useEffect, useState, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import Link from '../link';
import { Icon } from '../ui/icons';
import { applyTheme } from '../theme-toggle';
import { AUTH_PROVIDERS, BASE_PATH, loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import type { Access } from '../../lib/accounts';

export type Api = NonNullable<Awaited<ReturnType<NonNullable<typeof loadAccounts>>>>;
type Mode = 'signin' | 'create' | 'reset';

/** Where a signed-in person goes next: back to what sent them here, or to their account. */
export function destination(next: string | null): string {
  if (next === 'dashboard') return `${BASE_PATH}/dashboard/`;
  if (next === 'mobile') return `${BASE_PATH}/dashboard/?m=1`;
  if (next === 'install') return `${BASE_PATH}/install/`;
  if (next === 'admin') return `${BASE_PATH}/admin/`;
  if (next === 'feedback') return `${BASE_PATH}/feedback/`;
  return `${BASE_PATH}/account/`;
}

/**
 * The sign-in choices. Creating an account is offered only where an invitation is being redeemed: everyone else signs in with an account they
 * already have. Signing in grants nothing on anyone's computer; connecting a computer is a separate step, confirmed in its terminal.
 */
export function SignInPanel({ allowCreate = false, onSignedIn, intro, next }: { allowCreate?: boolean; onSignedIn: (api: Api, user: User, access: Access) => void | Promise<void>; intro?: string; next?: string | null }) {
  const [mode, setMode] = useState<Mode>(allowCreate ? 'create' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [api, setApi] = useState<Api | null>(null);
  const theme = () => document.documentElement.dataset.theme ?? 'dark';
  const google = AUTH_PROVIDERS.includes('google');
  const github = AUTH_PROVIDERS.includes('github');
  const passwordAuth = AUTH_PROVIDERS.includes('password');

  const withApi = async () => { const a = api ?? await loadAccounts!(); setApi(a); return a; };
  const run = async (fn: (a: Api) => Promise<User | null>) => {
    setBusy(true); setError(''); setNote('');
    let a: Api | null = api; // the loaded module, kept here so the first failure is explained in plain words too
    try {
      a = await withApi();
      const user = await fn(a);
      if (user) {
        const access = await a.access();
        if (access.member === 'active' || access.admin) { const d = await a.loadData(user.uid).catch(() => null); if (d?.preferences?.theme) applyTheme(d.preferences.theme); }
        await onSignedIn(a, user, access);
      }
    } catch (e) { setError(a ? a.explain(e) : (e as Error).message); }
    finally { setBusy(false); }
  };

  // Someone who signed in on this browser before goes straight on.
  useEffect(() => {
    if (!loadAccounts || localStorage.getItem(SIGNED_IN_FLAG) !== '1') return;
    void run(async (a) => a.currentUser());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async (a) => {
      if (mode === 'reset') { await a.resetPassword(email); setNote('If that address has an account, a reset link is on its way.'); return null; }
      if (mode === 'create') return a.emailSignUp(name, email, password, theme());
      return a.emailSignIn(email, password, theme());
    });
  };

  return (
    <div className="stack" data-testid="signed-out">
      {intro ? <p className="muted">{intro}</p> : null}
      <p className="small muted"><b>Signing in never gives this website access to your computer, your files or your agents.</b> Connecting a computer is a separate step, confirmed in your own terminal. Pressing a button loads Firebase, and for Google or GitHub their sign-in too, from their servers, so Google and Firebase become third parties for you. Nothing is loaded before that.</p>
      {error ? <p className="alert bad" role="alert" data-testid="signin-error">{error}</p> : null}
      {note ? <p className="alert good" role="status" data-testid="account-note">{note}</p> : null}
      {google || github ? (
        <div className="providers">
          {google ? <button type="button" className="btn big" disabled={busy} data-testid="sign-in" onClick={() => void run((a) => a.signIn(theme(), 'google'))}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" opacity=".9" /><path fill="currentColor" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0012 22z" opacity=".7" /><path fill="currentColor" d="M6.4 14a6 6 0 010-3.9V7.5H3.1a10 10 0 000 9l3.3-2.5z" opacity=".5" /><path fill="currentColor" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 003.1 7.5L6.4 10c.8-2.3 3-4 5.6-4z" opacity=".8" /></svg>Continue with Google</button> : null}
          {github ? <button type="button" className="btn big" disabled={busy} data-testid="sign-in-github" onClick={() => void run((a) => a.signIn(theme(), 'github'))}><Icon name="git" />Continue with GitHub</button> : null}
        </div>
      ) : null}
      {passwordAuth ? (
        <>
          {google || github ? <div className="divider"><span>or with email</span></div> : null}
          <form className="form" style={{ marginTop: 0, maxWidth: 'none' }} data-testid="email-form" onSubmit={submit}>
            <div className="seg" role="group" aria-label="How to use email">
              {([...(allowCreate ? (['create'] as const) : []), 'signin', 'reset'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setError(''); setNote(''); }}>{m === 'signin' ? 'Sign in' : m === 'create' ? 'Create account' : 'Reset password'}</button>)}
            </div>
            {mode === 'create' ? <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" name="name" /></label> : null}
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" name="email" required /></label>
            {mode !== 'reset' ? (
              <label>Password
                <span className="input-wrap">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} name="password" required minLength={mode === 'create' ? 8 : 6} />
                  <button type="button" className="icon-btn" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((s) => !s)} data-testid="toggle-password"><Icon name={showPassword ? 'eye-off' : 'eye'} /></button>
                </span>
                {mode === 'create' ? <span className="hint">At least 8 characters. A sentence works well.</span> : null}
              </label>
            ) : null}
            <div className="row between">
              <button className="btn primary" type="submit" disabled={busy} data-testid="email-submit">{busy ? 'One moment…' : mode === 'create' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
              {mode === 'signin' ? <button type="button" className="link" onClick={() => setMode('reset')}>Forgot your password?</button> : null}
            </div>
          </form>
        </>
      ) : null}
      {!allowCreate ? <p className="small muted">No account yet? Accounts are created from an invitation. <Link href="/early-access">Apply for early access</Link>.</p> : null}
      {next !== 'join' ? <p className="small"><a href={`${BASE_PATH}/dashboard/`}>Skip this: continue to the dashboard</a></p> : null}
    </div>
  );
}
