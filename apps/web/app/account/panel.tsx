'use client';
import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { AccountData } from '../../lib/accounts';
import { loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import { applyTheme } from '../theme-toggle';

type Api = NonNullable<Awaited<ReturnType<NonNullable<typeof loadAccounts>>>>;

export function AccountPanel() {
  const [api, setApi] = useState<Api | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async (a: Api, u: User) => {
    const d = await a.loadData(u.uid);
    setData(d);
    if (d.preferences?.theme) applyTheme(d.preferences.theme);
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNote('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
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

  if (!user) {
    return (
      <section className="panel stack" data-testid="signed-out">
        <h2>What an account does</h2>
        <p>It keeps your name and email from Google, your theme, any feedback you send while signed in, and project summaries you choose to save. They are stored in Firebase, on Google&apos;s servers, under your own account only.</p>
        <p>It never receives code, prompts, paths, commands or project records. You can export or delete all of it here.</p>
        <p className="muted small">Pressing the button loads Google&apos;s sign-in and Firebase from their servers, so Google and Firebase become third parties for you. Until then, nothing is loaded from them.</p>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        <div><button className="btn primary" disabled={busy} data-testid="sign-in" onClick={() => act(async () => {
          const a = api ?? await loadAccounts!();
          setApi(a);
          const u = await a.signIn(document.documentElement.dataset.theme ?? 'dark');
          setUser(u);
          await refresh(a, u);
        })}>Sign in with Google</button></div>
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
          <p>This deletes your profile, preferences, saved summaries, feedback sent while signed in, and your sign-in. It cannot be undone. Feedback sent while signed out is not linked to you, so it cannot be found this way.</p>
          <div className="row">
            <button className="btn danger" disabled={busy} data-testid="delete-confirm" onClick={() => act(async () => { await api!.deleteEverything(user); setUser(null); setData(null); setConfirmDelete(false); })}>Delete everything</button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div> : null}
      </section>
    </div>
  );
}
