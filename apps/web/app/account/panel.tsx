'use client';
import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import Link from '../link';
import { EarlyAccessButton } from '../early-access/launcher';
import { Icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { applyTheme } from '../theme-toggle';
import { loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import type { Access, AccountData, MyApplication } from '../../lib/accounts';
import { SignInPanel, type Api } from '../sign-in/panel';

export function AccountPanel() {
  const [api, setApi] = useState<Api | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [application, setApplication] = useState<MyApplication | null>(null);
  const [data, setData] = useState<AccountData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async (a: Api, u: User) => {
    const acc = await a.access();
    setAccess(acc);
    if (acc.member === 'active' || acc.admin) {
      let d = await a.loadData(u.uid);
      if (!d.profile) { await a.ensureProfile(u, document.documentElement.dataset.theme ?? 'dark'); d = await a.loadData(u.uid); }
      setData(d);
      if (d.preferences?.theme) applyTheme(d.preferences.theme);
    } else {
      setData(null);
      setApplication(await a.myApplication());
    }
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNote('');
    try { await fn(); } catch (e) { setError(api ? api.explain(e) : (e as Error).message); } finally { setBusy(false); }
  };

  // Firebase loads here only for someone who signed in on this browser before.
  useEffect(() => {
    if (localStorage.getItem(SIGNED_IN_FLAG) !== '1' || !loadAccounts) { setReady(true); return; }
    act(async () => {
      const a = await loadAccounts!();
      setApi(a);
      const u = await a.currentUser();
      setUser(u);
      if (u) await refresh(a, u);
    }).finally(() => setReady(true));
  }, [refresh]);

  if (!ready) return <p className="muted" role="status">One moment…</p>;
  if (!user) {
    return (
      <section className="panel stack">
        <h2>Sign in</h2>
        <SignInPanel onSignedIn={async (a, u) => { setApi(a); setUser(u); await refresh(a, u); }} />
      </section>
    );
  }

  const member = access?.member === 'active' || access?.admin;
  return (
    <div className="stack" data-testid="signed-in">
      {error ? <p className="alert bad" role="alert">{error}</p> : null}
      {note ? <p className="alert good" role="status" data-testid="account-note">{note}</p> : null}

      <section className="panel" data-testid="access-status">
        <h2>Early access</h2>
        {access?.admin ? <p><span className="badge accent">Administrator</span> You review applications on the <Link href="/admin">early access review page</Link>.</p> : null}
        {access?.member === 'active' ? <p><span className="badge good"><Icon name="check" size={13} />Active tester</span> You can <Link href="/install">install the desktop preview</Link>, use the dashboard from this site, and send <Link href="/feedback">tester feedback</Link>.</p> : null}
        {access?.member === 'revoked' ? <p><span className="badge bad">Access revoked</span> This account's early access was switched off. Write to the maintainer through the <Link href="/feedback">feedback page</Link> if you think that is wrong.</p> : null}
        {access?.member === 'none' && !access.admin ? (
          <div className="stack">
            <p><span className="badge warn">Not approved yet</span> This account is signed in but is not an early-access tester.</p>
            {application?.needsVerification ? <p className="small muted">Confirm your email address to see whether an application exists for it: <button type="button" className="link" disabled={busy} onClick={() => act(async () => { await api!.sendVerification(); setNote('Confirmation email sent. Follow its link, then reload this page.'); })}>send the confirmation email</button>.</p> : null}
            {application && !application.needsVerification ? <p className="small">Your application <code>{application.reference}</code> is <b>{application.status}</b>{application.status === 'approved' ? ': the maintainer will send your invitation link by email' : application.status === 'pending' ? ': it is in the queue and has been read or will be soon' : ''}.</p> : null}
            {!application ? <div className="row"><EarlyAccessButton className="btn primary">Apply for early access</EarlyAccessButton><span className="small muted">Received an invitation link? Open it; it signs you up.</span></div> : null}
            {application && !application.needsVerification ? <button type="button" className="link" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => act(async () => { await api!.withdrawApplication(); setApplication(null); setNote('Your application was withdrawn and deleted.'); })}>Withdraw and delete my application</button> : null}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Name</dt><dd data-testid="profile-name">{data?.profile?.name || user.displayName || 'Not given'}</dd>
          <dt>Email</dt><dd data-testid="profile-email">{data?.profile?.email || user.email || 'Not given'}{access?.verified ? '' : ' (not confirmed)'}</dd>
          <dt>Signs in with</dt><dd>{access?.providerId === 'google.com' ? 'Google' : access?.providerId === 'github.com' ? 'GitHub' : 'email and password'}</dd>
          <dt>Account id</dt><dd><code className="tiny" data-testid="account-uid">{user.uid}</code> <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(user.uid).then(() => toast('Account id copied', 'good'))}>copy</button></dd>
        </dl>
      </section>

      {member ? <>
        <section className="panel">
          <h2>Preferences</h2>
          <div className="seg" role="group" aria-label="Saved theme">{['dark', 'light'].map((t) => <button key={t} aria-pressed={data?.preferences?.theme === t} disabled={busy} onClick={() => act(async () => { await api!.savePreferences(user.uid, t); await refresh(api!, user); })}>{t}</button>)}</div>
        </section>
        <section className="panel" data-testid="account-feedback">
          <h2>Feedback you sent while signed in</h2>
          {data?.feedback.length ? <ul className="plain">{data.feedback.map((f) => <li key={f.id}>{f.rating ? <b>{f.rating}: </b> : null}{f.message}</li>)}</ul> : <p className="muted">None.</p>}
        </section>
        <section className="panel" data-testid="account-summaries">
          <h2>Project summaries you saved</h2>
          {data?.summaries.length ? <ul className="plain">{data.summaries.map((s) => <li key={s.id}><b>{s.label}</b> <code>{JSON.stringify({ ...s.totals, ...s.rates })}</code></li>)}</ul> : <p className="muted">None. You can save one from a project page in the dashboard.</p>}
        </section>
      </> : null}

      <section className="panel stack">
        <h2>Your data</h2>
        <div className="row">
          {member ? <button className="btn" disabled={busy || !data} data-testid="export-data" onClick={() => api!.downloadData(data!)}>Export my data</button> : null}
          <button className="btn" disabled={busy} onClick={() => act(async () => { await api!.signOutHere(); setUser(null); setData(null); setAccess(null); })}>Sign out</button>
          {!confirmDelete ? <button className="btn danger" disabled={busy} data-testid="delete-account" onClick={() => setConfirmDelete(true)}>Delete my account and data</button> : null}
        </div>
        {confirmDelete ? <div className="alert" role="alert">
          {access?.providerId === 'password' ? <label>Your password, to confirm<input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" name="delete-password" /></label> : null}
          <p>This deletes your profile, preferences, saved summaries, feedback sent while signed in, and your sign-in. It cannot be undone. Feedback sent while signed out is not linked to you, so it cannot be found this way. Your early-access application, if any, is deleted separately with the button above.</p>
          <div className="row">
            <button className="btn danger" disabled={busy} data-testid="delete-confirm" onClick={() => act(async () => { await api!.deleteEverything(user, deletePassword); setUser(null); setData(null); setAccess(null); setConfirmDelete(false); })}>Delete everything</button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div> : null}
      </section>
    </div>
  );
}
