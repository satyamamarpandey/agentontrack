import { useMemo, useState } from 'react';
import { get, isDemo, post } from './api';
import { CATALOG, supportOf, SUPPORT, type Group, type Meta } from './catalog-data';
import { Modal } from './human';
import { Empty, Loading, Page, useLoad } from './ui';

interface Cert { id: string; name: string; status: string; version: string; evidence: string; capabilities: string; ifGateFails: string; limitations: string; proof: string }
const files = import.meta.glob('../../../benchmarks/results/provider-certification.json', { eager: true, import: 'default' }) as Record<string, { asOf: string; entries: Cert[]; models: { name: string; through: string; result: string }[] }>;
const RECORD = Object.values(files)[0] ?? { asOf: '', entries: [], models: [] };

const HOST_FAIL_MODE: Record<string, string> = {
  closed: 'The action is blocked. Observed on the real host.',
  open: 'The action runs anyway. Observed on the real host. Start it with agentontrack run, which tests the hook first.',
};
const CONTAINMENT: Record<string, string> = {
  none: 'Nothing. A script\'s network activity is not stopped. The strict profile holds scripts for approval instead.',
  'claude-sandbox-available': 'Claude Code\'s OS sandbox, if you connect with agentontrack install claude-code --sandbox. Verified on macOS. On Linux it could not start on the test runner, so it is not verified there.',
  'codex-sandbox': 'Codex\'s own sandbox, when started with agentontrack run codex. Network stays off unless you allow it.',
};
const GROUPS: ('All' | Group)[] = ['All', 'Coding agents', 'Editors', 'Local models', 'Research'];

type State = 'connected' | 'installed' | 'missing' | 'unsupported' | 'service' | 'demo';

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copybox">
      <code>{text}</code>
      <button type="button" className="btn small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function Probe({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const [url, setUrl] = useState(meta.baseUrl ?? '');
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal label={`Configure ${meta.name}`} onClose={onClose} wide onSubmit={async (e) => { e.preventDefault(); setBusy(true); setOut(await post('/api/probe', { baseUrl: url }).catch((err) => ({ notes: [err.message] }))); setBusy(false); }}>
      <h2>Configure {meta.name}</h2>
      <ol className="steps big">{meta.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <p className="muted small">{meta.note}</p>
      <label>Address it listens on<input value={url} onChange={(e) => setUrl(e.target.value)} name="baseUrl" data-autofocus /></label>
      {out ? <pre tabIndex={0} className="code small" data-testid="probe">{JSON.stringify(out, null, 2)}</pre> : null}
      <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button><button className="btn primary" type="submit" disabled={busy}>{busy ? 'Testing…' : 'Test the address'}</button></div>
    </Modal>
  );
}

export function AgentCatalog({ tick }: { tick: number }) {
  const core = useLoad<any[]>(() => get('/api/agents'), [tick]);
  const prov = useLoad<any[]>(() => get('/api/providers'), [tick]);
  const rt = useLoad<any[]>(() => get('/api/runtimes'), [tick]);
  const st = useLoad<any>(() => get('/api/state'), [tick]);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'All' | Group>('All');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [probe, setProbe] = useState<Meta | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});

  const rows = useMemo(() => CATALOG.map((m) => {
    const c = core.data?.find((a) => a.id === m.id);
    const p = prov.data?.find((a) => a.id === m.id);
    const cert = RECORD.entries.find((e) => e.id === m.cert);
    const modelRun = m.kind === 'model' ? RECORD.models.find((x) => x.name.toLowerCase().startsWith(m.name.toLowerCase().split(' ')[0]!)) : undefined;
    const installed = m.kind === 'model' ? null : (c?.installed ?? p?.installed ?? false);
    const connected = !!(c?.hooksInstalled ?? p?.hooksInstalled);
    const state: State = isDemo() && m.kind !== 'unsupported' ? 'demo' : m.kind === 'unsupported' ? 'unsupported' : m.kind === 'model' || m.kind === 'editor' ? 'service' : connected ? 'connected' : installed ? 'installed' : 'missing';
    const run = rt.data?.find((r) => r.id === m.id);
    return { m, c, p, cert, modelRun, installed, connected, state, run, version: c?.version ?? p?.version ?? null, roles: (st.data?.team?.members ?? []).filter((x: any) => x.agent === m.id).map((x: any) => x.role) as string[] };
  }), [core.data, prov.data, rt.data, st.data]);

  const shown = rows.filter((r) => (group === 'All' || r.m.group === group) && (!installedOnly || r.installed || r.connected)
    && (!q.trim() || `${r.m.name} ${r.m.maker} ${r.m.interfaces.join(' ')} ${r.m.group}`.toLowerCase().includes(q.trim().toLowerCase())));

  if (!core.data && !core.error) return <Loading />;
  const reload = () => { core.reload(); prov.reload(); rt.reload(); };

  return (
    <Page title="Agents" intro="Every agent AgentOnTrack knows about, and what has really been tested. Installing an agent does not let AgentOnTrack control it: you press Connect, per project, and your own sign-in stays with the agent.">
      {probe ? <Probe meta={probe} onClose={() => setProbe(null)} /> : null}
      <div className="toolbar" role="search">
        <label className="sr-only" htmlFor="agent-search">Search agents</label>
        <input id="agent-search" type="search" placeholder="Search agents, editors and models" value={q} onChange={(e) => setQ(e.target.value)} name="agent-search" data-testid="agent-search" />
        <div className="row wrap" role="group" aria-label="Kind">{GROUPS.map((g) => <button key={g} className={`chip ${group === g ? 'on' : ''}`} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}</div>
        <label className="check"><input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} /> Found on this computer</label>
      </div>
      {isDemo() ? <div className="alert warn" role="note" data-testid="agents-demo">This is the demo, so it cannot see which agents are on your computer. The test records below are real; the installed and connected status is not shown.</div> : null}
      <p role="status" className="muted small">{shown.length} of {rows.length} shown. Test status is from the project's own record of {RECORD.asOf}; nobody independent has checked it.</p>
      {shown.length === 0 ? <Empty>No agent matches.</Empty> : (
        <section className="agent-grid" aria-label="Agents">
          {shown.map(({ m, c, cert, modelRun, state, run, version, roles }) => {
            const level = m.kind === 'model' ? (modelRun ? 'model' : 'untested') : supportOf(cert?.status, m.kind);
            const stateLabel = state === 'demo' ? 'Not checked in the demo' : state === 'connected' ? 'Connected' : state === 'installed' ? 'Found, not connected' : state === 'missing' ? 'Not installed' : state === 'unsupported' ? 'Not supported' : m.kind === 'model' ? 'Model server' : 'Extension';
            return (
              <article className="card agent-card" key={m.id} data-testid={`agent-${m.id}`} data-state={state}>
                <h2>{m.name} <span className={`badge ${state === 'connected' ? 'good' : state === 'installed' ? 'warn' : 'muted'}`} data-testid="agent-state">{stateLabel}</span></h2>
                <div className="muted small">{m.maker}{version ? ` · version ${version}` : ''}</div>
                <div className="chips">
                  <span className={`badge ${level === 'verified-hooks' ? 'good' : level === 'partial' || level === 'model' || level === 'mcp' || level === 'research' || level === 'observation' ? 'warn' : 'muted'}`} title={SUPPORT[level].help} data-testid="agent-support">{SUPPORT[level].label}</span>
                  {m.kind === 'core' || m.kind === 'adapter' ? <span className={`badge ${run?.canStart ? 'good' : 'muted'}`} data-testid="agent-start">{run?.canStart ? 'Can start from AgentOnTrack' : m.id === 'claude-code' && state === 'installed' ? 'Can start once connected' : 'Starts in its own terminal'}</span> : null}
                  {roles.map((r) => <span key={r} className="badge">{r}</span>)}
                </div>
                <p className="small">{m.kind === 'model' && level === 'untested' ? 'No test has been recorded for this model server.' : SUPPORT[level].help}</p>
                {m.note && m.kind !== 'editor' ? <p className="muted small">{m.note}</p> : null}
                <dl className="kv">
                  <dt>Reached by</dt><dd>{m.interfaces.join(', ')}</dd>
                  {cert ? <><dt>Last test</dt><dd>{cert.evidence}{cert.version ? ` (version ${cert.version})` : ''}</dd></> : null}
                  {modelRun ? <><dt>Last test</dt><dd>{modelRun.result} Through {modelRun.through}.</dd></> : null}
                  {m.kind === 'model' && !modelRun ? <><dt>Last test</dt><dd>Not tested.</dd></> : null}
                  {!cert && m.kind !== 'model' ? <><dt>Last test</dt><dd>{m.kind === 'editor' ? m.note : 'Not tested.'}</dd></> : null}
                </dl>
                <details className="small" data-testid="agent-details"><summary>What it does here, and its limits</summary>
                <dl className="kv">
                  {cert ? <><dt>Does here</dt><dd>{cert.capabilities}</dd></> : null}
                  {cert ? <><dt>If its hook fails</dt><dd data-testid="host-fail-mode">{c ? (HOST_FAIL_MODE[c.coverage.hostFailMode] ?? cert.ifGateFails) : cert.ifGateFails}</dd></> : null}
                  {c ? <><dt>What contains its scripts</dt><dd data-testid="containment">{CONTAINMENT[c.coverage.containment] ?? 'Unavailable'}</dd></> : null}
                  {cert ? <><dt>Limits</dt><dd>{cert.limitations}</dd></> : null}
                </dl>
                </details>

                {err[m.id] ? <div className="alert bad" role="alert">{err[m.id]}</div> : null}
                <div className="row wrap">
                  {state === 'missing' || state === 'unsupported' || state === 'demo' ? <a className="btn primary" href={m.install.url} target="_blank" rel="noopener noreferrer" data-testid="agent-install">{m.install.label}</a> : null}
                  {(state === 'missing' && m.kind === 'core') || (state === 'demo' && m.kind === 'core') ? <button className="btn" disabled>Connect</button> : null}
                  {state === 'missing' ? <button className="btn" onClick={reload}>Check again</button> : null}
                  {state === 'installed' && (m.id === 'claude-code' || m.id === 'codex') ? <button className="btn primary" onClick={async () => { setErr((x) => ({ ...x, [m.id]: '' })); try { await post(`/api/agents/${m.id}/connect`); reload(); } catch (e) { setErr((x) => ({ ...x, [m.id]: `Could not connect: ${(e as Error).message}` })); } }}>Connect</button> : null}
                  {state === 'installed' && !(m.id === 'claude-code' || m.id === 'codex') ? <button className="btn primary" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id}>Connect</button> : null}
                  {state === 'connected' && (m.id === 'claude-code' || m.id === 'codex') ? <button className="btn" onClick={async () => { await post(`/api/agents/${m.id}/disconnect`); reload(); }}>Disconnect</button> : null}
                  {state === 'connected' && !(m.id === 'claude-code' || m.id === 'codex') ? <span className="muted small">Connected to this project. To remove it: <code>agentontrack uninstall {m.id}</code></span> : null}
                  {m.kind === 'model' ? <button className="btn primary" onClick={() => setProbe(m)}>Configure</button> : null}
                  {m.kind === 'editor' || m.kind === 'research' ? <button className="btn" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id}>Set up</button> : null}
                  {state === 'installed' || state === 'connected' || m.kind === 'model' || m.kind === 'editor' ? <a className="link small" href={m.install.url} target="_blank" rel="noopener noreferrer">{m.install.label.replace(/^(Install|Download|Get)/, 'Official site:')}</a> : null}
                </div>
                {state === 'missing' || state === 'installed' ? <p className="muted small">{state === 'missing' ? `${m.name} was not found on this computer. Install it from its maker, then press Check again.` : 'Found on this computer. Connecting adds AgentOnTrack\'s hook to this project, and nothing else.'}</p> : null}
                {open === m.id ? (
                  <div className="stack" data-testid={`setup-${m.id}`}>
                    <ol className="steps big">{m.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                    {m.command ? <Copy text={c || m.kind === 'core' ? (m.command ?? `agentontrack install ${m.id}`) : (prov.data?.find((p) => p.id === m.id)?.connect ?? m.command)} /> : null}
                    {m.note ? <p className="muted small">{m.note}</p> : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </Page>
  );
}
