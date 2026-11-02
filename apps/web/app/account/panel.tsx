'use client';
import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { AccountData } from '../../lib/accounts';
import { loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import { applyTheme } from '../theme-toggle';

type Api = NonNullable<Awaited<ReturnType<NonNullable<typeof loadAccounts>>>>;
// Kept outside React state so an error on the very first click can still be put in plain words.
let loadedApi: Api | null = null;

export function AccountPanel() {
  const [api, setApi] = useState<Api | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mode, setMode] = useState<'signin' | 'create' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [deletePassword, setDeletePassword] = useState('');

  const refresh = useCallback(async (a: Api, u: User) => {
    const d = await a.loadData(u.uid);
    setData(d);
    if (d.preferences?.theme) applyTheme(d.preferences.theme);
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNote('');
    try { await fn(); } catch (e) { setError(loadedApi ? loadedApi.explain(e) : (e as Error).message); } finally { setBusy(false); }
  };

  // Firebase loads here only for someone who signed in on this browser before.
  useEffect(() => {
    if (localStorage.getItem(SIGNED_IN_FLAG) !== '1' || !loadAccounts) return;
    act(async () => {
      const a = await loadAccounts!();
      setApi(a);
      const u = await a.currentUser();
      setUser(u);
      if (u) await refresh(a, u);
    });
  }, [refresh]);

  const theme = () => document.documentElement.dataset.theme ?? 'dark';
  const finishWith = async (a: Api, u: User) => {
    setUser(u);
    await refresh(a, u);
    // Came from the dashboard's welcome page: go back there, now signed in. Signing in grants nothing on the computer.
    const next = new URLSearchParams(location.search).get('next');
    if (next === 'dashboard') location.href = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/dashboard/`;
    if (next === 'mobile') location.href = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/dashboard/?m=1`;
  };
  const withApi = async () => { const a = api ?? await loadAccounts!(); loadedApi = a; setApi(a); return a; };

  if (!user) {
    return (
      <section className="panel stack" data-testid="signed-out">
        <h2>Sign in or create an account</h2>
        <p>An account is optional. It keeps your name and email, your theme, feedback you send while signed in, and project summaries you choose to save, in Firebase under your own account only.</p>
        <p><b>Signing in never gives this website access to your computer, your files or your agents.</b> Connecting your computer is a separate step, confirmed in your terminal.</p>
        <p className="muted small">Pressing a button loads Firebase, and for Google or GitHub their sign-in too, from their servers, so Google and Firebase become third parties for you. Until then, nothing is loaded from them. Code, prompts, paths, commands and project records are never sent.</p>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        <div className="row">
          <button className="btn primary" disabled={busy} data-testid="sign-in" onClick={() => act(async () => { const a = await withApi(); await finishWith(a, await a.signIn(theme(), 'google')); })}>Continue with Google</button>
          <button className="btn" disabled={busy} data-testid="sign-in-github" onClick={() => act(async () => { const a = await withApi(); await finishWith(a, await a.signIn(theme(), 'github')); })}>Continue with GitHub</button>
        </div>
        <form className="form" data-testid="email-form" onSubmit={(e) => { e.preventDefault(); act(async () => {
          const a = await withApi();
          if (mode === 'reset') { await a.resetPassword(email); setNote('If that address has an account, a reset link is on its way.'); return; }
          await finishWith(a, mode === 'create' ? await a.emailSignUp(name, email, password, theme()) : await a.emailSignIn(email, password, theme()));
        }).catch(() => undefined); }}>
          <div className="row" role="group" aria-label="How to use email">
            {(['signin', 'create', 'reset'] as const).map((m) => <button key={m} type="button" className={`btn small ${mode === m ? 'primary' : ''}`} aria-pressed={mode === m} onClick={() => { setMode(m); setError(''); setNote(''); }}>{m === 'signin' ? 'Sign in with email' : m === 'create' ? 'Create an account' : 'Reset password'}</button>)}
          </div>
          {mode === 'create' ? <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" name="name" /></label> : null}
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" name="email" required /></label>
          {mode !== 'reset' ? <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} name="password" required minLength={6} /></label> : null}
          <div><button className="btn" type="submit" disabled={busy} data-testid="email-submit">{mode === 'create' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button></div>
          {note ? <p role="status" data-testid="account-note">{note}</p> : null}
        </form>
        <p className="small"><a href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/dashboard/`}>Skip this: continue without an account</a></p>
      </section>
    );
  }

  return (
    <div className="stack" data-testid="signed-in">
      {error ? <p className="alert" role="alert">{error}</p> : null}
      {note ? <p className="panel" role="status" data-testid="account-note">{note}</p> : null}
      <section className="panel">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Name</dt><dd data-testid="profile-name">{data?.profile?.name || 'Not given'}</dd>
          <dt>Email</dt><dd data-testid="profile-email">{data?.profile?.email || 'Not given'}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Preferences</h2>
        <div className="row" role="group" aria-label="Saved theme">{['dark', 'light'].map((t) => <button key={t} className={`btn small ${data?.preferences?.theme === t ? 'primary' : ''}`} aria-pressed={data?.preferences?.theme === t} disabled={busy} onClick={() => act(async () => { await api!.savePreferences(user.uid, t); await refresh(api!, user); })}>{t}</button>)}</div>
      </section>
      <section className="panel" data-testid="account-feedback">
        <h2>Feedback you sent while signed in</h2>
        {data?.feedback.length ? <ul className="plain">{data.feedback.map((f) => <li key={f.id}>{f.rating ? <b>{f.rating}: </b> : null}{f.message}</li>)}</ul> : <p className="muted">None.</p>}
      </section>
      <section className="panel" data-testid="account-summaries">
        <h2>Project summaries you saved</h2>
        {data?.summaries.length ? <ul className="plain">{data.summaries.map((s) => <li key={s.id}><b>{s.label}</b> <code>{JSON.stringify({ ...s.totals, ...s.rates })}</code></li>)}</ul> : <p className="muted">None. You can save one from a project page in the dashboard.</p>}
      </section>
      <section className="panel stack">
        <h2>Your data</h2>
        <div className="row">
          <button className="btn" disabled={busy || !data} data-testid="export-data" onClick={() => api!.downloadData(data!)}>Export my data</button>
          <button className="btn" disabled={busy} onClick={() => act(async () => { await api!.signOutHere(); setUser(null); setData(null); })}>Sign out</button>
          {!confirmDelete ? <button className="btn danger" disabled={busy} data-testid="delete-account" onClick={() => setConfirmDelete(true)}>Delete my account and data</button> : null}
        </div>
        {confirmDelete ? <div className="alert" role="alert">
          {user.providerData[0]?.providerId === 'password' ? <label>Your password, to confirm<input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" name="delete-password" /></label> : null}
          <p>This deletes your profile, preferences, saved summaries, feedback sent while signed in, and your sign-in. It cannot be undone. Feedback sent while signed out is not linked to you, so it cannot be found this way.</p>
          <div className="row">
            <button className="btn danger" disabled={busy} data-testid="delete-confirm" onClick={() => act(async () => { await api!.deleteEverything(user, deletePassword); setUser(null); setData(null); setConfirmDelete(false); })}>Delete everything</button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div> : null}
      </section>
    </div>
  );
}
