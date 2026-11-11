'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from '../link';
import { Modal } from '../ui/modal';
import { Icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { loadAccounts } from '../../lib/accounts-config';
import type { Access, AdminData, AppRow, InviteRow, MemberRow } from '../../lib/accounts';
import { csvCell, FREQUENCY_OPTIONS, labelOf, OS_OPTIONS, TOOL_OPTIONS, USE_OPTIONS } from '../../lib/early-access';
import type { Api } from '../sign-in/panel';

type Tab = 'applications' | 'members' | 'invitations' | 'feedback' | 'audit' | 'insights';
const TABS: [Tab, string][] = [['applications', 'Applications'], ['members', 'Testers'], ['invitations', 'Invitations'], ['feedback', 'Tester feedback'], ['insights', 'Insights'], ['audit', 'Audit log']];
const when = (d: Date | null) => (d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (d: Date | null) => (d ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

/** The invitation and membership that belong to an application, so one row can say where the person is in the process. */
function joinRows(data: AdminData) {
  const inviteFor = new Map<string, InviteRow>();
  for (const i of [...data.invites].reverse()) inviteFor.set(i.applicationId, i); // newest wins
  const memberFor = new Map<string, MemberRow>();
  for (const m of data.members) memberFor.set(m.applicationId, m);
  return { inviteFor, memberFor };
}
const inviteState = (i: InviteRow | undefined) => (!i ? 'none' : i.status === 'redeemed' ? 'redeemed' : i.status === 'revoked' ? 'revoked' : i.expired ? 'expired' : 'sent');
const BADGE: Record<string, string> = { pending: 'warn', approved: 'good', rejected: 'bad', none: 'muted', sent: 'accent', redeemed: 'good', revoked: 'bad', expired: 'muted', active: 'good' };

function Bars({ title, counts }: { title: string; counts: [string, number][] }) {
  const max = Math.max(1, ...counts.map(([, n]) => n));
  return (
    <section className="panel" style={{ margin: 0 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {counts.length ? <div className="bars">{counts.map(([label, n]) => <div key={label} className="bar"><span>{label}</span><span className="bar-track"><i style={{ width: `${(n / max) * 100}%` }} /></span><span className="bar-n">{n}</span></div>)}</div> : <p className="muted small">Nothing yet.</p>}
    </section>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
export function AdminPanel() {
  const [api, setApi] = useState<Api | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('applications');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [os, setOs] = useState('all');
  const [tool, setTool] = useState('all');
  const [selected, setSelected] = useState<AppRow | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(14);
  const [link, setLink] = useState<{ link: string; expiresAt: Date; email: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; detail: string; run: () => Promise<void>; danger?: boolean } | null>(null);

  const reload = async (a: Api) => { setData(await a.adminLoad()); };
  useEffect(() => {
    if (!loadAccounts) return;
    (async () => {
      try {
        const a = await loadAccounts!(); setApi(a);
        const acc = await a.access(); setAccess(acc);
        if (acc.admin) await reload(a);
      } catch (e) { setError(a0(e)); }
    })();
  }, []);
  const a0 = (e: unknown) => (api ? api.explain(e) : (e as Error).message);
  const act = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true); setError('');
    try { await fn(); await reload(api!); if (done) toast(done, 'good'); } catch (e) { setError(a0(e)); } finally { setBusy(false); }
  };

  const joined = useMemo(() => (data ? joinRows(data) : null), [data]);
  const rows = useMemo(() => {
    if (!data || !joined) return [];
    const needle = q.trim().toLowerCase();
    return data.applications.filter((r) => (status === 'all' || (status === 'invited' ? inviteState(joined.inviteFor.get(r.id)) === 'sent' : status === 'joined' ? !!joined.memberFor.get(r.id) : r.status === status))
      && (os === 'all' || r.os.includes(os as never)) && (tool === 'all' || r.tools.includes(tool as never))
      && (!needle || [r.name, r.email, r.organization, r.role, r.reference].some((v) => v?.toLowerCase().includes(needle))));
  }, [data, joined, q, status, os, tool]);

  if (!loadAccounts) return null;
  if (error && !access) return <div className="wrap article"><h1>Early access review</h1><p className="alert bad" role="alert">{error}</p></div>;
  if (!access) return <div className="wrap article"><h1>Early access review</h1><p className="muted" role="status">One moment…</p></div>;
  if (!access.signedIn) return <div className="wrap article"><h1>Early access review</h1><p>This page is for the administrator. <Link className="btn primary" href="/sign-in?next=admin">Sign in</Link></p></div>;
  if (!access.admin) return <div className="wrap article" data-testid="admin-denied"><h1>Not available</h1><p>This account does not administer this site.</p><p><Link href="/account">Your account</Link></p></div>;
  if (!data || !joined) return <div className="wrap article"><h1>Early access review</h1><p className="muted" role="status">Loading applications…</p></div>;

  const { inviteFor, memberFor } = joined;
  const counts = {
    total: data.applications.length,
    pending: data.applications.filter((r) => r.status === 'pending').length,
    approved: data.applications.filter((r) => r.status === 'approved').length,
    rejected: data.applications.filter((r) => r.status === 'rejected').length,
    sent: data.invites.filter((i) => inviteState(i) === 'sent').length,
    redeemed: data.invites.filter((i) => i.status === 'redeemed').length,
    active: data.members.filter((m) => m.status === 'active').length,
    revoked: data.members.filter((m) => m.status === 'revoked').length,
  };
  const tally = (pick: (r: AppRow) => string[], options: readonly (readonly [string, string])[]) => options.map(([id, label]) => [label, data.applications.filter((r) => pick(r).includes(id)).length] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const sel = selected ? data.applications.find((r) => r.id === selected.id) ?? null : null;
  const selInvite = sel ? inviteFor.get(sel.id) : undefined;
  const selMember = sel ? memberFor.get(sel.id) : undefined;

  const exportJson = () => act(async () => { download('agentontrack-applications.json', JSON.stringify(data.applications, null, 2), 'application/json'); await api!.adminRecordExport('applications.json'); }, 'Exported');
  const exportCsv = () => act(async () => {
    const head = ['reference', 'name', 'email', 'organization', 'role', 'os', 'tools', 'useCases', 'frequency', 'status', 'invitation', 'access', 'applied'];
    const lines = data.applications.map((r) => [r.reference, r.name, r.email, r.organization, r.role, r.os.join('|'), r.tools.join('|'), r.useCases.join('|'), r.frequency, r.status, inviteState(inviteFor.get(r.id)), memberFor.get(r.id)?.status ?? 'none', r.createdAt?.toISOString() ?? ''].map(csvCell).join(','));
    download('agentontrack-applications.csv', [head.join(','), ...lines].join('\n'), 'text/csv');
    await api!.adminRecordExport('applications.csv');
  }, 'Exported');

  return (
    <div className="wrap" style={{ paddingTop: 32, paddingBottom: 64 }} data-testid="admin">
      <header className="row between" style={{ alignItems: 'flex-end', marginBottom: 18 }}>
        <div><p className="eyebrow">Administration</p><h1 style={{ fontSize: 'clamp(30px, 4vw, 44px)', marginBottom: 6 }}>Early access review</h1><p className="muted" style={{ margin: 0 }}>Signed in as {access.email}. Every action here is written to the audit log.</p></div>
        <div className="row"><button className="btn small" onClick={() => act(() => Promise.resolve())} disabled={busy}><Icon name="search" size={16} />Refresh</button><button className="btn small" onClick={exportCsv} disabled={busy}><Icon name="download" size={16} />CSV</button><button className="btn small" onClick={exportJson} disabled={busy}><Icon name="download" size={16} />JSON</button></div>
      </header>
      {error ? <p className="alert bad" role="alert">{error}</p> : null}
      <div className="stat-tiles" data-testid="admin-stats">
        {([['Applications', counts.total], ['Pending', counts.pending], ['Approved', counts.approved], ['Rejected', counts.rejected], ['Invitations open', counts.sent], ['Invitations used', counts.redeemed], ['Active testers', counts.active], ['Access revoked', counts.revoked]] as [string, number][]).map(([l, n]) => <div key={l} className="stat-tile"><b data-stat={l}>{n}</b><span>{l}</span></div>)}
      </div>
      <div className="seg" role="tablist" aria-label="Sections" style={{ marginTop: 18 }}>{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>

      {tab === 'applications' ? (
        <>
          <div className="toolbar">
            <input type="search" placeholder="Search name, email, reference" aria-label="Search applications" value={q} onChange={(e) => setQ(e.target.value)} data-testid="admin-search" />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="filter-status"><option value="all">Any status</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="invited">Invitation open</option><option value="joined">Joined</option></select>
            <select aria-label="Operating system" value={os} onChange={(e) => setOs(e.target.value)} data-testid="filter-os"><option value="all">Any OS</option>{OS_OPTIONS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
            <select aria-label="Agent tool" value={tool} onChange={(e) => setTool(e.target.value)} data-testid="filter-tool"><option value="all">Any tool</option>{TOOL_OPTIONS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
            <span className="small muted">{rows.length} of {counts.total}</span>
          </div>
          <div className="table-wrap"><table className="dense" data-testid="applications-table">
            <thead><tr><th>Applicant</th><th>Operating system</th><th>Agent tools</th><th>Use cases</th><th>Applied</th><th>Status</th><th>Invitation</th><th>Access</th></tr></thead>
            <tbody>
              {rows.length ? rows.map((r) => { const inv = inviteState(inviteFor.get(r.id)); const mem = memberFor.get(r.id); return (
                <tr key={r.id} className="clickable" tabIndex={0} onClick={() => { setSelected(r); setNotes(r.notes ?? ''); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(r); setNotes(r.notes ?? ''); } }} data-testid="application-row" data-reference={r.reference}>
                  <td><b>{r.name}</b><br /><span className="small muted">{r.email}</span></td>
                  <td>{r.os.map((o) => labelOf(OS_OPTIONS, o)).join(', ')}</td>
                  <td>{r.tools.map((t) => labelOf(TOOL_OPTIONS, t)).join(', ')}</td>
                  <td>{r.useCases.slice(0, 2).map((u) => labelOf(USE_OPTIONS, u)).join(', ')}{r.useCases.length > 2 ? ` +${r.useCases.length - 2}` : ''}</td>
                  <td>{day(r.createdAt)}</td>
                  <td><span className={`badge ${BADGE[r.status]}`}>{r.status}</span></td>
                  <td><span className={`badge ${BADGE[inv]}`}>{inv === 'none' ? '—' : inv}</span></td>
                  <td>{mem ? <span className={`badge ${BADGE[mem.status]}`}>{mem.status}</span> : <span className="muted">—</span>}</td>
                </tr>
              ); }) : <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>{counts.total ? 'No application matches these filters.' : 'No applications yet. The form on the home page writes here.'}</td></tr>}
            </tbody>
          </table></div>
        </>
      ) : null}

      {tab === 'members' ? (
        <div className="table-wrap" style={{ marginTop: 14 }}><table className="dense" data-testid="members-table">
          <thead><tr><th>Tester</th><th>Joined</th><th>Status</th><th>Note</th><th>Actions</th></tr></thead>
          <tbody>{data.members.length ? data.members.map((m) => <tr key={m.uid} data-testid="member-row" data-email={m.email}>
            <td><b>{m.name || '—'}</b><br /><span className="small muted">{m.email}</span><br /><code className="tiny">{m.uid}</code></td><td>{day(m.joinedAt)}</td><td><span className={`badge ${BADGE[m.status]}`}>{m.status}</span></td><td className="small">{m.note ?? ''}</td>
            <td>{m.status === 'active'
              ? <button className="btn small danger" disabled={busy} data-testid="revoke-member" onClick={() => setConfirm({ title: `Revoke access for ${m.email}?`, detail: 'Their account keeps its sign-in, but every early-access feature stops working on their next request, including the dashboard account features and the phone link. You can reinstate later.', danger: true, run: () => api!.adminSetMember(m.uid, 'revoked') })}>Revoke access</button>
              : <button className="btn small" disabled={busy} data-testid="reinstate-member" onClick={() => act(() => api!.adminSetMember(m.uid, 'active'), 'Access reinstated')}>Reinstate</button>}</td>
          </tr>) : <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 28 }}>No testers yet. A tester appears here once they use an invitation.</td></tr>}</tbody>
        </table></div>
      ) : null}

      {tab === 'invitations' ? (
        <div className="table-wrap" style={{ marginTop: 14 }}><table className="dense" data-testid="invites-table">
          <thead><tr><th>Address</th><th>Created</th><th>Expires</th><th>State</th><th>Used</th><th>Actions</th></tr></thead>
          <tbody>{data.invites.length ? data.invites.map((i) => { const s = inviteState(i); return <tr key={i.id} data-testid="invite-row">
            <td>{i.email}</td><td>{when(i.createdAt)}</td><td>{when(i.expiresAt)}</td><td><span className={`badge ${BADGE[s]}`}>{s}</span></td><td>{i.redeemedAt ? when(i.redeemedAt) : '—'}</td>
            <td>{s === 'sent' ? <button className="btn small danger" disabled={busy} onClick={() => act(() => api!.adminRevokeInvite(i.id), 'Invitation revoked')}>Revoke</button> : null}</td>
          </tr>; }) : <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 28 }}>No invitations yet.</td></tr>}</tbody>
        </table></div>
      ) : null}

      {tab === 'feedback' ? (
        <div className="stack" style={{ marginTop: 14, gap: 10 }} data-testid="tester-feedback">
          {data.feedback.length ? data.feedback.map((f) => <article key={f.id} className="panel" style={{ margin: 0 }}>
            <div className="row between"><span className="row" style={{ gap: 8 }}><span className="badge accent">{f.kind}</span>{f.rating ? <span className="badge">{'★'.repeat(f.rating)}{'☆'.repeat(5 - f.rating)}</span> : null}{f.version ? <span className="badge muted">v{f.version}</span> : null}{f.os ? <span className="badge muted">{labelOf(OS_OPTIONS, f.os)}</span> : null}{f.connector ? <span className="badge muted">{f.connector}</span> : null}</span><span className="small muted">{when(f.createdAt)} · {f.email ?? f.uid}</span></div>
            <p style={{ whiteSpace: 'pre-wrap', margin: '10px 0 0' }}>{f.message}</p>
            {f.diagnostics ? <details className="small" style={{ marginTop: 8 }}><summary>Diagnostics the tester attached</summary><pre className="term" style={{ fontSize: 12 }}>{f.diagnostics}</pre></details> : null}
          </article>) : <p className="muted">No tester feedback yet.</p>}
        </div>
      ) : null}

      {tab === 'insights' ? (
        <div className="grid2" style={{ marginTop: 14 }} data-testid="insights">
          <Bars title="Operating systems" counts={tally((r) => r.os, OS_OPTIONS)} />
          <Bars title="Agent tools in use" counts={tally((r) => r.tools, TOOL_OPTIONS)} />
          <Bars title="What people want it for" counts={tally((r) => r.useCases, USE_OPTIONS)} />
          <Bars title="How often they use coding agents" counts={tally((r) => [r.frequency], FREQUENCY_OPTIONS)} />
          <Bars title="Funnel" counts={[['Applied', counts.total], ['Approved', counts.approved], ['Invited', counts.sent + counts.redeemed], ['Joined', counts.redeemed], ['Active now', counts.active]]} />
          <Bars title="Tester feedback by kind" counts={(['bug', 'feature', 'ui', 'connector', 'experience'] as const).map((k) => [k, data.feedback.filter((f) => f.kind === k).length] as [string, number]).filter(([, n]) => n > 0)} />
          <section className="panel" style={{ margin: 0 }}><h3 style={{ marginTop: 0 }}>Requested elsewhere</h3><ul className="plain small">{data.applications.filter((r) => r.toolsOther).map((r) => <li key={r.id}><b>{r.reference}</b>: {r.toolsOther}</li>)}</ul>{!data.applications.some((r) => r.toolsOther) ? <p className="muted small">No other tools named yet.</p> : null}</section>
        </div>
      ) : null}

      {tab === 'audit' ? (
        <ul className="audit" style={{ marginTop: 14 }} data-testid="audit-log">
          {data.audit.length ? data.audit.map((a) => <li key={a.id}><time>{when(a.at)}</time><span><b>{a.action}</b> {a.target}{a.note ? <span className="muted"> · {a.note}</span> : null}</span></li>) : <li className="muted">Nothing recorded yet.</li>}
        </ul>
      ) : null}

      {sel ? (
        <div className="drawer-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Application ${sel.reference}`} data-testid="application-drawer">
            <div className="row between"><span className="badge accent">{sel.reference}</span><button className="icon-btn" aria-label="Close" onClick={() => setSelected(null)}><Icon name="x" /></button></div>
            <h2>{sel.name}</h2>
            <p className="muted" style={{ margin: 0 }}>{sel.email}{sel.organization ? ` · ${sel.organization}` : ''}{sel.role ? ` · ${sel.role}` : ''}</p>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className={`badge ${BADGE[sel.status]}`}>{sel.status}</span><span className={`badge ${BADGE[inviteState(selInvite)]}`}>invitation: {inviteState(selInvite)}</span>{selMember ? <span className={`badge ${BADGE[selMember.status]}`}>access: {selMember.status}</span> : null}</div>
            <dl className="kv">
              <dt>Applied</dt><dd>{when(sel.createdAt)} from the {sel.source}</dd>
              <dt>OS</dt><dd>{sel.os.map((o) => labelOf(OS_OPTIONS, o)).join(', ')}{sel.osOther ? ` (${sel.osOther})` : ''}</dd>
              <dt>Tools</dt><dd>{sel.tools.map((t) => labelOf(TOOL_OPTIONS, t)).join(', ')}{sel.toolsOther ? ` (${sel.toolsOther})` : ''}</dd>
              <dt>Frequency</dt><dd>{labelOf(FREQUENCY_OPTIONS, sel.frequency)}</dd>
              <dt>Use cases</dt><dd>{sel.useCases.map((u) => labelOf(USE_OPTIONS, u)).join(', ')}{sel.useCasesNote ? <><br /><span className="muted">{sel.useCasesNote}</span></> : null}</dd>
              {sel.challenge ? <><dt>Challenge</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{sel.challenge}</dd></> : null}
              {sel.why ? <><dt>Why</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{sel.why}</dd></> : null}
              <dt>Updates</dt><dd>{sel.marketingConsent ? 'Agreed to occasional updates' : 'Did not ask for updates'}</dd>
              {selInvite ? <><dt>Invitation</dt><dd>created {when(selInvite.createdAt)}, expires {when(selInvite.expiresAt)}{selInvite.redeemedAt ? `, used ${when(selInvite.redeemedAt)}` : ''}</dd></> : null}
              {selMember ? <><dt>Account</dt><dd><code className="tiny">{selMember.uid}</code>, joined {when(selMember.joinedAt)}</dd></> : null}
            </dl>
            <label>Private notes<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} data-testid="admin-notes" /></label>
            <div className="row"><button className="btn small" disabled={busy || notes === (sel.notes ?? '')} onClick={() => act(() => api!.adminNote(sel.id, notes), 'Note saved')} data-testid="save-notes">Save note</button></div>
            <h4>Decision</h4>
            <div className="row wrap">
              {sel.status !== 'approved' ? <button className="btn primary" disabled={busy} data-testid="approve" onClick={() => act(() => api!.adminSetStatus(sel.id, 'approved'), 'Approved')}><Icon name="check" size={16} />Approve</button> : null}
              {sel.status !== 'rejected' ? <button className="btn" disabled={busy} data-testid="reject" onClick={() => act(() => api!.adminSetStatus(sel.id, 'rejected'), 'Rejected')}>Reject</button> : null}
              {sel.status !== 'pending' ? <button className="btn ghost" disabled={busy} onClick={() => act(() => api!.adminSetStatus(sel.id, 'pending'), 'Reopened')}>Back to pending</button> : null}
            </div>
            <h4>Invitation</h4>
            {selMember?.status === 'active' ? <p className="small muted">Already a tester. Nothing to send.</p> : (
              <div className="stack">
                <div className="row wrap">
                  <label style={{ width: 'auto' }}>Valid for<select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>{[7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
                  <button className="btn primary end-self" disabled={busy} data-testid="create-invite" onClick={() => act(async () => {
                    if (selInvite && inviteState(selInvite) === 'sent') await api!.adminRevokeInvite(selInvite.id, 'replaced by a new link');
                    const r = await api!.adminInvite(sel, days);
                    setLink({ link: r.link, expiresAt: r.expiresAt, email: sel.email });
                  })}><Icon name="mail" size={16} />{selInvite && inviteState(selInvite) === 'sent' ? 'New invitation link' : 'Create invitation link'}</button>
                </div>
                <p className="small muted">The link appears once; copy it and send it to {sel.email} yourself. It works for that address only, once, until it expires. Making a new link revokes the previous one.</p>
                {selInvite && inviteState(selInvite) === 'sent' ? <button className="btn small danger" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => act(() => api!.adminRevokeInvite(selInvite.id), 'Invitation revoked')}>Revoke the open invitation</button> : null}
              </div>
            )}
            {selMember ? <>
              <h4>Access</h4>
              {selMember.status === 'active'
                ? <button className="btn danger" disabled={busy} data-testid="revoke-access" onClick={() => setConfirm({ title: `Revoke access for ${sel.email}?`, detail: 'Every early-access feature stops working on their next request. Their sign-in stays, so you can reinstate later.', danger: true, run: () => api!.adminSetMember(selMember.uid, 'revoked') })}>Revoke access</button>
                : <button className="btn" disabled={busy} data-testid="reinstate-access" onClick={() => act(() => api!.adminSetMember(selMember.uid, 'active'), 'Access reinstated')}>Reinstate access</button>}
            </> : null}
            <h4>Remove</h4>
            <button className="btn small danger" style={{ alignSelf: 'flex-start' }} disabled={busy} data-testid="delete-application" onClick={() => setConfirm({ title: `Delete the application from ${sel.email}?`, detail: 'Removes the application itself. Invitations and membership records are kept separately and stay as they are. Use this when someone asks to be forgotten.', danger: true, run: async () => { await api!.adminDeleteApplication(sel.id); setSelected(null); } })}>Delete application</button>
          </aside>
        </div>
      ) : null}

      {link ? (
        <Modal label="Invitation link" onClose={() => setLink(null)} narrow testId="invite-link-dialog">
          <h2>Send this link to {link.email}</h2>
          <p className="small muted">Shown once. It expires {when(link.expiresAt)} and works for that address only.</p>
          <div className="input-wrap"><input readOnly value={link.link} aria-label="Invitation link" data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} /><button type="button" className="icon-btn" aria-label="Copy link" onClick={() => navigator.clipboard?.writeText(link.link).then(() => toast('Invitation link copied', 'good'))}><Icon name="copy" /></button></div>
          <div className="dialog-foot"><span className="small muted">Paste it into your own email or message to them.</span><button className="btn primary" onClick={() => setLink(null)}>Done</button></div>
        </Modal>
      ) : null}

      {confirm ? (
        <Modal label={confirm.title} onClose={() => setConfirm(null)} narrow testId="confirm-dialog">
          <h2>{confirm.title}</h2>
          <p>{confirm.detail}</p>
          <div className="dialog-foot"><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className={`btn ${confirm.danger ? 'danger' : 'primary'}`} disabled={busy} data-testid="confirm-yes" onClick={() => { const c = confirm; setConfirm(null); void act(c.run, 'Done'); }}>Yes, continue</button></div>
        </Modal>
      ) : null}
    </div>
  );
}
