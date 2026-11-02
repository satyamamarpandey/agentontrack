import { useEffect, useState, type ReactNode } from 'react';
import { get, post } from './api';
import { Modal, useHuman } from './human';
import { Icon } from './icons';
import { Badge, Empty, useLoad } from './ui';

const ROLES = ['implement', 'review', 'debug', 'test', 'research', 'analyze', 'classify', 'verify'] as const;
const WORKFLOWS = ['implement-review-verify', 'parallel-then-compare', 'review-only', 'spec-review'] as const;
const ago = (ts: string | number) => new Date(ts).toLocaleTimeString();

/* ---------- Agent tab: the prompt composer and what the agent is doing ---------- */

/** Only Claude Code can be started from here. Others run in their own terminal, and their hooks report to this same record. */
export function AgentTab({ agents, tick }: { agents: any[]; tick: number }) {
  const runs = useLoad<any[]>(() => get('/api/runs'), [tick]);
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntime] = useState('claude-code');
  const [model, setModel] = useState('haiku');
  const [budget, setBudget] = useState(0.25);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState<Record<string, string>>({});
  useEffect(() => { const t = setInterval(runs.reload, 1500); return () => clearInterval(t); }, [runs.reload]);
  const claude = agents.find((a) => a.id === 'claude-code');
  const canStart = runtime === 'claude-code' && !!claude?.hooksInstalled;
  const submit = async () => {
    setMsg('');
    try {
      const r = await post<{ id: string }>('/api/runs', { runtime, prompt, model, maxBudgetUsd: budget });
      setSent((s) => ({ ...s, [r.id]: prompt }));
      setPrompt('');
      runs.reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <>
      <div className="feed" role="log" tabIndex={0} aria-label="Agent activity" aria-live="polite" data-testid="ws-feed">
        {runs.data?.length ? [...runs.data].reverse().map((r) => (
          <article className="msg" key={r.id} data-testid="ws-run-item" data-status={r.status}>
            <header><b className="mono">{r.id}</b><Badge value={r.status} /><span>started {ago(r.started)}</span>
              {r.status === 'running' ? <button className="btn small" style={{ marginLeft: 'auto' }} onClick={async () => { await post(`/api/runs/${r.id}/stop`); runs.reload(); }}><Icon name="stop" size={12} />Stop</button> : null}
            </header>
            {sent[r.id] ? <p className="small"><span className="muted">You: </span>{sent[r.id]}</p> : <p className="small muted">The prompt is not stored, only its hash.</p>}
            <pre tabIndex={0}>{r.events.join('\n') || 'Waiting for output…'}</pre>
          </article>
        )) : <Empty>No runs since the companion started. Write a prompt below to start one on Claude Code.</Empty>}
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
        <label>Prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} name="prompt" required placeholder="What should the agent do? It works inside the goal you approved."
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (prompt.trim() && canStart) void submit(); } }} /></label>
        <div className="row wrap">
          <label>Agent
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)} name="runtime">
              {agents.map((a) => <option key={a.id} value={a.id} disabled={a.id !== 'claude-code'}>{a.name}{a.id !== 'claude-code' ? ' (runs in its own terminal)' : ''}</option>)}
            </select>
          </label>
          <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} name="model" style={{ width: 110 }} /></label>
          <label>Budget cap (USD)<input type="number" min={0.01} max={5} step={0.01} value={budget} onChange={(e) => setBudget(Number(e.target.value))} name="budget" style={{ width: 110 }} /></label>
          <button className="btn primary end-self" type="submit" disabled={!canStart || !prompt.trim()} data-testid="ws-run"><Icon name="play" size={12} />Run <kbd>Ctrl ↵</kbd></button>
        </div>
        <p className="muted small">{!claude?.installed ? 'Claude Code is not installed on this machine.' : !claude.hooksInstalled ? 'Connect Claude Code in the Agents panel first, so its hooks are in place.' : 'This starts your own logged-in Claude Code, uses your usage, and is capped per run. Other agents start in their own terminal and report here.'}</p>
      </form>
    </>
  );
}

/* ---------- Right panel ---------- */

function AgentsList({ agents, team, reload }: { agents: any[]; team: any; reload: () => void }) {
  return (
    <>
      <p className="muted small" data-testid="one-system">Every agent here reports to one record, under one goal and one set of approvals. Each keeps its own login and model: AgentOnTrack never asks for provider credentials.</p>
      {agents.map((a) => {
        const roles = team.members.filter((m: any) => m.agent === a.id).map((m: any) => m.role);
        return (
          <div className="agent-row" key={a.id} data-testid={`ws-agent-${a.id}`}>
            <div className="row"><b>{a.name}</b><span className={`badge ${a.hooksInstalled ? 'good' : a.installed ? '' : 'muted'}`}>{a.hooksInstalled ? 'connected' : a.installed ? 'not connected' : 'not installed'}</span></div>
            <div className="muted small">{a.installed ? `Version ${a.version}` : a.liveStatus ?? 'Not found on this machine'}{a.authenticated === false ? ' · not logged in' : ''}</div>
            <div className="small">{roles.length ? <>Role: {roles.join(', ')}</> : <span className="muted">No role assigned</span>}</div>
            <div className="small muted">{a.coverage.hostFailMode === 'open' ? 'If its hook cannot run, the action runs anyway.' : 'If its hook cannot run, the action is blocked.'}</div>
            {a.provider ? <p className="muted small">Connect in your terminal, so you can review the files it writes: <code>{a.connect}</code></p> : a.id !== 'hermes' ? <div className="row">{a.hooksInstalled
              ? <button className="btn small" onClick={async () => { await post(`/api/agents/${a.id}/disconnect`); reload(); }}>Disconnect</button>
              : <button className="btn small primary" disabled={!a.installed} onClick={async () => { await post(`/api/agents/${a.id}/connect`); reload(); }}>Connect</button>}</div>
              : <p className="muted small">Hermes hooks live in your own config. Run <code>agentontrack install hermes</code>.</p>}
          </div>
        );
      })}
    </>
  );
}

function TeamPanel({ agents: listed, team, reload }: { agents: any[]; team: any; reload: () => void }) {
  const [custom, setCustom] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  // Any agent can be given a role, including one AgentOnTrack has no adapter for: its roles are recorded, and the plan says so.
  const agents = [...listed, ...[...new Set([...team.members.map((m: any) => m.agent), ...custom])].filter((id) => !listed.some((a) => a.id === id)).map((id) => ({ id, name: id, installed: false, custom: true }))];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<(typeof WORKFLOWS)[number]>('implement-review-verify');
  const { ask, dialog } = useHuman(reload);
  useEffect(() => { const d: Record<string, string> = {}; for (const m of team.members) d[m.role] = m.agent; setDraft(d); }, [team.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useLoad<any>(() => get(`/api/workflow?kind=${kind}`), [kind, team.version]);
  const members = ROLES.filter((r) => draft[r]).map((r) => ({ agent: draft[r], role: r }));
  const preset = (impl: string, rev: string) => setDraft({ implement: impl, review: rev });
  const ids = agents.map((a) => a.id);
  const has = (id: string) => ids.includes(id);
  return (
    <>
      {dialog}
      <p className="muted small">Choose which agent takes each role. Nothing starts by itself: the plan only says what would run, and in what order.</p>
      <div className="row wrap">
        <button className="btn small" disabled={!has('claude-code') || !has('codex')} onClick={() => preset('claude-code', 'codex')} data-testid="preset-claude-codex">Claude codes, Codex reviews</button>
        <button className="btn small" disabled={!has('claude-code') || !has('codex')} onClick={() => preset('codex', 'claude-code')} data-testid="preset-codex-claude">Codex codes, Claude reviews</button>
      </div>
      <div className="stack" style={{ marginTop: 8 }}>
        {ROLES.map((r) => (
          <label className="role-row" key={r}><span>{r[0]!.toUpperCase() + r.slice(1)}</span>
            <select value={draft[r] ?? ''} onChange={(e) => setDraft({ ...draft, [r]: e.target.value })} name={`role-${r}`}>
              <option value="">Nobody</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.custom ? ' (no adapter)' : a.installed ? '' : ' (not installed)'}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary small" data-testid="team-save" onClick={() => ask({ title: 'Set the agent team', detail: <ul className="small">{members.length ? members.map((m) => <li key={m.role}>{m.agent} → {m.role}</li>) : <li>No roles assigned</li>}</ul>, path: '/api/team', body: { members, expectVersion: team.version } })}>Save team…</button>
        <span className="muted small">Version {team.version}</span>
      </div>
      <form className="row wrap" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (/^[a-z0-9][a-z0-9-]{1,29}$/.test(newId)) { setCustom([...custom, newId]); setNewId(''); } }}>
        <label className="grow" style={{ minWidth: 120 }}>Another agent id<input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder="my-agent" name="custom-agent" /></label>
        <button className="btn small end-self" type="submit" disabled={!/^[a-z0-9][a-z0-9-]{1,29}$/.test(newId)}>Add</button>
      </form>
      <h3 style={{ marginTop: 14 }}>Plan</h3>
      <label>Workflow<select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} name="workflow">{WORKFLOWS.map((w) => <option key={w}>{w}</option>)}</select></label>
      {plan.data ? <>
        {plan.data.problems.map((p: string) => <p className="alert warn small" key={p}>{p}</p>)}
        {plan.data.warnings.map((p: string) => <p className="muted small" key={p}>{p}</p>)}
        <ol className="small" data-testid="plan-stages">{plan.data.stages.map((s: any) => <li key={s.id}><b>{s.role}</b> by {s.agent}{s.isolated ? ', in its own worktree' : ''}{s.dependsOn.length ? <span className="muted"> after {s.dependsOn.join(', ')}</span> : null}</li>)}</ol>
      </> : null}
    </>
  );
}

function ApprovalsPanel({ state, reload }: { state: any; reload: () => void }) {
  const { ask, dialog } = useHuman(reload);
  const pending = state.approvals.filter((a: any) => a.view === 'pending');
  return (
    <>
      {dialog}
      <p className="muted small">Held actions wait here. Each approval covers one effect, for this goal and policy, and is used once by default.</p>
      {pending.length === 0 ? <Empty>Nothing is waiting.</Empty> : pending.map((a: any) => (
        <div className="agent-row" key={a.id} data-testid="ws-approval">
          <div className="row"><b>{a.effect.kind}</b><span className="muted small">{a.runtime}</span></div>
          <div className="mono small" style={{ overflowWrap: 'anywhere' }}>{a.effect.target}</div>
          <div className="muted small">{a.reason}</div>
          <div className="row">
            <button className="btn small primary" onClick={() => ask({ title: `Approve ${a.effect.kind}`, detail: <p className="mono small">{a.effect.target}</p>, path: '/api/approvals/approve', body: { id: a.id } })}>Approve…</button>
            <button className="btn small" onClick={() => ask({ title: `Deny ${a.effect.kind}`, detail: <p className="mono small">{a.effect.target}</p>, path: '/api/approvals/deny', body: { id: a.id } })}>Deny…</button>
          </div>
        </div>
      ))}
    </>
  );
}

function HandoffsPanel({ agents, state, tick }: { agents: any[]; state: any; tick: number }) {
  const list = useLoad<any[]>(() => get('/api/handoffs'), [tick]);
  const [from, setFrom] = useState('claude-code');
  const [to, setTo] = useState('codex');
  const [taskId, setTaskId] = useState('');
  const [reason, setReason] = useState('planned');
  const [out, setOut] = useState<{ title: string; body: ReactNode } | null>(null);
  const [msg, setMsg] = useState('');
  const { ask, dialog } = useHuman(list.reload);
  const make = async () => {
    setMsg('');
    try {
      const r = await post('/api/handoffs', { from, to, ...(taskId ? { taskId } : {}), reason });
      setMsg(`Handoff ${r.id} saved. ${r.problems.length ? `${r.problems.length} problem(s) to review.` : 'It checks out against the current record.'}`);
      list.reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  const view = async (id: string) => { const r = await get(`/api/handoffs/markdown?id=${encodeURIComponent(id)}`); setOut({ title: `Handoff ${id}`, body: <pre className="code" tabIndex={0}>{r.markdown}</pre> }); };
  const accept = async (h: any) => {
    const r = await post('/api/handoffs/accept', { id: h.id, to: h.to ?? to }).catch((e) => ({ error: e.message }));
    if (r.error) { setOut({ title: 'Could not accept', body: <p className="alert bad">{r.error}</p> }); return; }
    setOut({ title: r.accepted ? 'Accepted' : 'Not accepted', body: <>
      {r.problems.map((p: any, i: number) => <p key={i} className="alert warn small">{p.message ?? JSON.stringify(p)}</p>)}
      {r.reusable?.length ? <><h3>Reusable work</h3><ul className="small">{r.reusable.map((x: string) => <li key={x}>{x}</li>)}</ul></> : null}
      {r.brief ? <pre className="code" tabIndex={0}>{r.brief}</pre> : null}
      {!r.accepted ? <button className="btn small" onClick={() => { setOut(null); ask({ title: `Accept ${h.id} knowing it is stale`, detail: <p className="alert warn">The work changed since this handoff was made. Approvals are never carried over.</p>, path: '/api/handoffs/accept-stale', body: { id: h.id, to: h.to ?? to } }); }}>Accept anyway…</button> : null}
    </> });
    list.reload();
  };
  return (
    <>
      {dialog}
      <p className="muted small">A handoff carries the goal, evidence and unfinished work to another agent. Approvals are never carried: the next agent asks again.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void make(); }}>
        <div className="row wrap">
          <label className="grow" style={{ minWidth: 100 }}>From<select value={from} onChange={(e) => setFrom(e.target.value)} name="from">{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="grow" style={{ minWidth: 100 }}>To<select value={to} onChange={(e) => setTo(e.target.value)} name="to">{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        </div>
        <label>Task<select value={taskId} onChange={(e) => setTaskId(e.target.value)} name="task"><option value="">Active task</option>{state.tasks.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        <label>Why<select value={reason} onChange={(e) => setReason(e.target.value)} name="reason">{['planned', 'unavailable', 'limit', 'interrupted', 'review'].map((r) => <option key={r}>{r}</option>)}</select></label>
        <button className="btn small primary" type="submit" data-testid="handoff-make" disabled={from === to}><Icon name="handoff" size={14} />Create handoff</button>
        {msg ? <p className="small" role="status" data-testid="handoff-msg">{msg}</p> : null}
      </form>
      <h3 style={{ marginTop: 12 }}>History</h3>
      {list.data?.length ? list.data.map((h) => (
        <div className="agent-row" key={h.id} data-testid="ws-handoff">
          <div className="row"><b className="mono small">{h.id}</b><Badge value={h.outcome === 'prepared' ? 'open' : h.outcome === 'accepted' ? 'accepted' : 'rejected'} /></div>
          <div className="muted small">{h.from} → {h.to ?? 'anyone'} · task {h.task}</div>
          <div className="row"><button className="btn small" onClick={() => void view(h.id)}>View</button>{h.outcome === 'prepared' ? <button className="btn small" onClick={() => void accept(h)}>Accept</button> : null}</div>
        </div>
      )) : <Empty>No handoffs yet.</Empty>}
      {out ? <Modal label={out.title} wide onClose={() => setOut(null)}><h2>{out.title}</h2>{out.body}<div className="row end"><button className="btn" data-autofocus onClick={() => setOut(null)}>Close</button></div></Modal> : null}
    </>
  );
}

export const RIGHT_TABS = ['Agents', 'Team', 'Approvals', 'Handoffs'] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

export function RightPanel({ tab, agents, state, reloadAgents, reloadState, tick }: { tab: RightTab; agents: any[]; state: any; reloadAgents: () => void; reloadState: () => void; tick: number }) {
  if (tab === 'Agents') return <AgentsList agents={agents} team={state.team} reload={reloadAgents} />;
  if (tab === 'Team') return <TeamPanel agents={agents} team={state.team} reload={reloadState} />;
  if (tab === 'Approvals') return <ApprovalsPanel state={state} reload={reloadState} />;
  return <HandoffsPanel agents={agents} state={state} tick={tick} />;
}

/* ---------- Bottom panel ---------- */

export const BOTTOM_TABS = ['Activity', 'Git', 'Verification'] as const;
export type BottomTab = (typeof BOTTOM_TABS)[number];

function Activity({ tick, open }: { tick: number; open: (seq: number) => void }) {
  const ac = useLoad<any[]>(() => get('/api/actions'), [tick]);
  const rows = (ac.data ?? []).filter((e) => e.type === 'action.requested').slice(0, 40);
  if (!rows.length) return <Empty>No agent action has been recorded yet.</Empty>;
  return <div className="table-wrap" tabIndex={0}><table>
    <thead><tr><th scope="col">When</th><th scope="col">Agent</th><th scope="col">Tool</th><th scope="col">Decision</th><th scope="col">Detail</th><th scope="col"><span className="sr-only">Record</span></th></tr></thead>
    <tbody>{rows.map((e) => <tr key={e.seq} data-testid="ws-action"><td>{ago(e.ts)}</td><td>{e.actor?.runtime ?? e.payload.runtime ?? ''}</td><td>{e.payload.tool}</td><td><Badge value={e.payload.decision} /></td><td className="small clip">{e.payload.reasons?.[0] ?? e.payload.effects?.map((x: any) => x.kind).join(', ')}</td><td><button className="link small" onClick={() => open(e.seq)}>source</button></td></tr>)}</tbody>
  </table></div>;
}

function Git({ state, tick, openDiff }: { state: any; tick: number; openDiff: (wt: string, path: string) => void }) {
  const wts = useLoad<any>(() => get('/api/worktrees'), [tick]);
  const [taskId, setTaskId] = useState('');
  const [agent, setAgent] = useState('claude-code');
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState<Record<string, any>>({});
  const { ask, dialog } = useHuman(wts.reload);
  const act = async (fn: () => Promise<unknown>) => { setMsg(''); try { await fn(); wts.reload(); } catch (e) { setMsg((e as Error).message); } };
  const tid = taskId || state.activeTask?.id || '';
  return (
    <>
      {dialog}
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void act(() => post('/api/worktrees', { taskId: tid, agent })); }}>
        <label>Task<select value={taskId} onChange={(e) => setTaskId(e.target.value)} name="wt-task"><option value="">{state.activeTask ? 'Active task' : 'Choose a task'}</option>{state.tasks.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        <label>Agent id<input value={agent} onChange={(e) => setAgent(e.target.value)} name="wt-agent" style={{ width: 130 }} /></label>
        <button className="btn small primary end-self" type="submit" disabled={!tid} data-testid="wt-create"><Icon name="branch" size={14} />New isolated worktree</button>
      </form>
      {msg ? <div className="alert bad" role="alert" style={{ marginTop: 6 }}>{msg}</div> : null}
      {wts.data?.conflicts?.length ? <div className="alert warn" role="status" style={{ marginTop: 6 }} data-testid="wt-conflicts"><b>Two agents changed the same files:</b> {wts.data.conflicts.map((c: any) => `${c.agents.join(' and ')}: ${c.files.join(', ')}`).join('; ')}</div> : null}
      {wts.data?.worktrees?.length ? wts.data.worktrees.map((w: any) => (
        <div className="agent-row" key={w.id} data-testid="ws-worktree">
          <div className="row"><b>{w.agent}</b><span className="mono small muted">{w.branch}</span><Badge value={w.status === 'active' ? 'open' : w.status === 'merged' ? 'accepted' : 'expired'} /></div>
          {w.status === 'active' ? <>
            <div className="small">{w.changed.length ? <ul className="plain">{w.changed.map((c: any) => <li key={c.path}><button className="link" onClick={() => openDiff(w.id, c.path)}>{c.path}</button> <span className="muted">{c.status ?? ''}</span></li>)}</ul> : <span className="muted">No changes yet.</span>}</div>
            {w.outOfScope.length ? <p className="alert warn small">Outside the approved scope: {w.outOfScope.map((o: any) => o.path).join(', ')}. Merging is refused until reviewed.</p> : null}
            {w.stale ? <p className="muted small">The project moved on by {w.behindBy} commit(s) since this started.</p> : null}
            {preview[w.id] ? <p className={`small ${preview[w.id].clean ? '' : 'alert warn'}`} role="status">{preview[w.id].clean ? 'Merge preview: no conflicts.' : `Merge preview: ${preview[w.id].detail}${preview[w.id].conflicts.length ? ` (${preview[w.id].conflicts.join(', ')})` : ''}`}</p> : null}
            <div className="row wrap">
              <button className="btn small" onClick={() => void act(() => post('/api/worktrees/commit', { id: w.id }))}>Commit</button>
              <button className="btn small" onClick={() => void act(async () => setPreview({ ...preview, [w.id]: await get(`/api/worktrees/preview?id=${encodeURIComponent(w.id)}`) }))}>Preview merge</button>
              <button className="btn small primary" onClick={() => ask({ title: `Merge ${w.agent}'s work`, detail: <p className="small">Merges <code>{w.branch}</code> into the project.</p>, path: '/api/worktrees/merge', body: { id: w.id } })}>Merge…</button>
              <button className="btn small" onClick={() => ask({ title: `Discard ${w.agent}'s worktree`, detail: <p className="alert warn">Its uncommitted work is lost.</p>, path: '/api/worktrees/discard', body: { id: w.id } })}>Discard…</button>
            </div>
          </> : null}
          {w.mergeError ? <p className="alert bad small">{w.mergeError}</p> : null}
        </div>
      )) : <Empty>No isolated worktrees. Give each agent its own, so two agents never edit the same checkout.</Empty>}
    </>
  );
}

function Verification({ state, reload }: { state: any; reload: () => void }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const t = state.activeTask;
  return (
    <>
      <p className="muted small" data-testid="ws-verify-note">Verification means your own checks, run by AgentOnTrack on the current code. What an agent says it did is not evidence.</p>
      <div className="row wrap">
        <span className="small"><Badge value={state.integrity.ok ? 'pass' : 'fail'} /> record integrity: {state.integrity.chain.events} events</span>
        {state.mismatches.filter((m: any) => !m.acknowledged).length ? <span className="badge warn">{state.mismatches.filter((m: any) => !m.acknowledged).length} unreviewed unauthorized change(s)</span> : null}
      </div>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      {t ? <div className="stack" style={{ marginTop: 8 }}>
        <div className="row"><b>{t.title}</b><Badge value={t.evaluation.status} />
          <button className="btn small primary" style={{ marginLeft: 'auto' }} disabled={busy === t.id} data-testid="ws-verify" onClick={async () => { setBusy(t.id); setMsg(''); try { await post('/api/verify', { taskId: t.id }); } catch (e) { setMsg((e as Error).message); } finally { setBusy(''); reload(); } }}>{busy === t.id ? 'Running checks…' : 'Verify now'}</button></div>
        <ul className="plain small">{t.evaluation.criteria.map((c: any) => <li key={c.id}><Badge value={c.state} /> {t.criteria.find((x: any) => x.id === c.id)?.description ?? c.id}</li>)}</ul>
        {t.evaluation.reasons.filter((r: string) => !r.startsWith('Criterion')).map((r: string) => <p className="muted small" key={r}>{r}</p>)}
      </div> : <Empty>No active task. Create one in the Tasks list.</Empty>}
      <h3 style={{ marginTop: 10 }}>Latest receipts</h3>
      {state.receipts.length ? <div className="table-wrap" tabIndex={0}><table><thead><tr><th scope="col">When</th><th scope="col">Criterion</th><th scope="col">Result</th><th scope="col">Observed</th></tr></thead>
        <tbody>{[...state.receipts].reverse().slice(0, 8).map((r: any) => <tr key={r.seq}><td>{ago(r.ts)}</td><td>{r.criterionId}</td><td><Badge value={r.passed ? 'pass' : 'fail'} /></td><td className="mono small clip">{r.observed}</td></tr>)}</tbody></table></div> : <Empty>No receipts yet.</Empty>}
    </>
  );
}

export function BottomPanel({ tab, state, tick, reloadState, open, openDiff }: { tab: BottomTab; state: any; tick: number; reloadState: () => void; open: (seq: number) => void; openDiff: (wt: string, path: string) => void }) {
  if (tab === 'Activity') return <Activity tick={tick} open={open} />;
  if (tab === 'Git') return <Git state={state} tick={tick} openDiff={openDiff} />;
  return <Verification state={state} reload={reloadState} />;
}
