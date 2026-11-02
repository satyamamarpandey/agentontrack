import { useState } from 'react';
import { accountsEnabled, sendCounts } from './accounts';
import { get } from './api';
import { Loading, useLoad } from './ui';

const INSTALL_KEY = 'aot-install-id';

/** ISO week, such as 2026-W44. Counts are sent once a week at most, so the week is part of the document's name. */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
}

/** A random id made here and kept in this browser. It is not tied to a person, a machine or an account, and withdrawing consent deletes it. */
function installId(): string {
  let id = localStorage.getItem(INSTALL_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(INSTALL_KEY, id); }
  return id;
}

export interface UsageCounts { week: string; version: string; runtimesConnected: string[]; tasksVerified: number; tasksTotal: number; activeDays: number }

/** Exactly what would be sent. Only counts and the names of agent programs: never code, prompts, paths, goals, commands or conversations. */
export function buildCounts(analytics: any, agents: any[], providers: any[]): UsageCounts {
  const connected = [...agents, ...providers].filter((a) => a.hooksInstalled).map((a) => String(a.id).slice(0, 30)).slice(0, 12);
  const days = new Set((analytics.byDay ?? []).filter((d: any) => (d.allow ?? 0) + (d.request_approval ?? 0) + (d.deny ?? 0) > 0).map((d: any) => d.day));
  return { week: isoWeek(), version: '1.0', runtimesConnected: [...new Set(connected)], tasksVerified: analytics.taskTotals?.VERIFIED ?? 0, tasksTotal: analytics.tasks?.length ?? 0, activeDays: days.size };
}

export function TelemetryCard({ consent, setConsent }: { consent: boolean; setConsent: (on: boolean) => void }) {
  const an = useLoad<any>(() => get('/api/analytics'), []);
  const ag = useLoad<any[]>(() => get('/api/agents'), []);
  const pv = useLoad<any[]>(() => get('/api/providers'), []);
  const [on, setOn] = useState(consent);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (!an.data || !ag.data) return <Loading error={an.error || ag.error} />;
  const counts = buildCounts(an.data, ag.data, pv.data ?? []);
  const canSend = accountsEnabled();
  const send = async () => {
    setBusy(true); setMsg('');
    try {
      await sendCounts(installId(), counts);
      setMsg(`Sent the counts for ${counts.week}. Thank you.`);
    } catch (e) { setMsg((e as Error).message.includes('permission') ? 'Counts for this week were already sent.' : (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="card stack" data-testid="telemetry">
      <h2>Share anonymous usage counts (optional)</h2>
      <p className="muted small">Off unless you turn it on, and separate from any account. It would let the project count how many installations are active, which agents are connected, and how many tasks were verified. It never includes code, prompts, paths, goals, commands, conversations or credentials, and it is not tied to you or to this machine.</p>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setConsent(e.target.checked); if (!e.target.checked) localStorage.removeItem(INSTALL_KEY); }} data-testid="telemetry-consent" /> I agree to share these counts, once a week at most</label>
      <details open={on}><summary>Exactly what would be sent</summary><pre className="code small" tabIndex={0} data-testid="telemetry-preview">{JSON.stringify(counts, null, 2)}</pre></details>
      {on ? (canSend
        ? <div className="row"><button className="btn" disabled={busy} onClick={() => void send()} data-testid="telemetry-send">Send this week&apos;s counts</button></div>
        : <p className="alert warn small" data-testid="telemetry-off">Sending is not switched on for this site, so nothing leaves your browser, whatever you choose here.</p>) : null}
      {msg ? <p role="status" className="small" data-testid="telemetry-msg">{msg}</p> : null}
    </section>
  );
}
