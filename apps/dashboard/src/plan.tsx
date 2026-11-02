import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, get, isDemo, post } from './api';
import { useHuman } from './human';
import { Icon } from './icons';
import { Empty, Loading, useLoad } from './ui';
import { ModelField, useDiscovery } from './model-field';

type Mode = 'manual' | 'guided' | 'bounded';
interface Phase { id: string; title: string; kind: string; role: string; instructions: string; dependsOn: string[]; agent?: string; model?: string; acceptance: { id: string; description: string; kind: 'command' | 'manual'; command?: string }[]; budget: { maxUsd?: number; maxMinutes?: number; maxRuns?: number }; risks: string[]; effort?: { minutes: number; basis: string }; state: 'draft' | 'paused' | 'skipped'; taskId?: string }
interface Plan { id: string; goal: string; mode: Mode; limits: { maxUsd: number; maxMinutes: number; maxRuns: number }; defaults: Record<string, { agent: string; model?: string }>; phases: Phase[] }
interface View { id: string; status: string; why: string; runs: number; spentUsd: number }
interface PlanData { plan: Plan | null; version?: number; sha?: string; approved?: boolean; views?: View[]; spent?: { usd: number; runs: number; minutes: number }; facts: { testCommand: string | null; testCommandSource: string | null } }

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: 'manual', label: 'Manual', help: 'You start every phase yourself, and check the result before the next.' },
  { id: 'guided', label: 'Guided', help: 'The next step is suggested after each phase. You still press Start.' },
  { id: 'bounded', label: 'Bounded autonomous', help: 'Runs ready phases one after another, only inside the limits below. It stops at a failure, at any held approval, and when you press Stop. It never approves anything or releases for you.' },
];
const STATUS_TEXT: Record<string, string> = { draft: 'Draft', ready: 'Ready', running: 'Running', paused: 'Paused', skipped: 'Skipped', blocked: 'Waiting', 'needs-evidence': 'Needs evidence', 'done-unchecked': 'Done, not checked', verified: 'Verified', stale: 'Stale evidence', failed: 'Failed' };
const STATUS_CLASS: Record<string, string> = { verified: 'good', failed: 'bad', stale: 'warn', 'needs-evidence': 'warn', 'done-unchecked': 'warn', running: '', ready: '', paused: 'muted', skipped: 'muted', blocked: 'muted', draft: 'muted' };

/** The numbers a person can change without needing the plan approved again. */
const SAFE_ONLY = (a: Plan, b: Plan) => JSON.stringify({ ...a, phases: a.phases.map((p) => ({ ...p, state: 0 })) }) === JSON.stringify({ ...b, phases: b.phases.map((p) => ({ ...p, state: 0 })) });

export function PlanPanel({ tick, agents, onRunStarted, reloadShell }: { tick: number; agents: { id: string; name: string; startable: boolean }[]; onRunStarted: () => void; reloadShell: () => void }) {
  const data = useLoad<PlanData>(() => get('/api/plan'), [tick]);
  const disc = useDiscovery(tick);
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState<Plan | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [prompt, setPrompt] = useState<{ phase: string; text: string } | null>(null);
  const [auto, setAuto] = useState<null | { note: string; active: boolean }>(null);
  const cancel = useRef(false);
  const { ask, dialog } = useHuman(() => data.reload());

  const server = data.data?.plan ?? null;
  const serverKey = JSON.stringify(server);
  useEffect(() => { setDraft(server ? structuredClone(server) : null); }, [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server);

  const views = useMemo(() => new Map((data.data?.views ?? []).map((v) => [v.id, v])), [data.data]);
  if (!data.data) return <Loading error={data.error} />;
  const d = data.data;
  const fail = (e: unknown) => setMsg((e as Error).message);

  const create = async (replace = false) => {
    setBusy('create'); setMsg('');
    try { await post('/api/plan/draft', { goal, ...(replace && d.version ? { expectVersion: d.version } : {}) }); setGoal(''); data.reload(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy('save'); setMsg('');
    try { await post('/api/plan/draft', { plan: draft, expectVersion: d.version }); data.reload(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const patch = (fn: (p: Plan) => void) => setDraft((cur) => { if (!cur) return cur; const n = structuredClone(cur); fn(n); return n; });
  const patchPhase = (id: string, fn: (p: Phase) => void) => patch((pl) => { const ph = pl.phases.find((x) => x.id === id); if (ph) fn(ph); });

  /** Saves a pause, resume or skip at once: they only ever do less, so they need no new approval. */
  const setState = async (id: string, state: Phase['state']) => {
    if (!server) return;
    setMsg('');
    try { const n = structuredClone(server); n.phases.find((x) => x.id === id)!.state = state; await post('/api/plan/draft', { plan: n, expectVersion: d.version }); data.reload(); } catch (e) { fail(e); }
  };
  const move = (id: string, dir: -1 | 1) => patch((pl) => {
    const i = pl.phases.findIndex((x) => x.id === id); const j = i + dir;
    if (j < 0 || j >= pl.phases.length) return;
    const linear = pl.phases.every((p, k) => JSON.stringify(p.dependsOn) === JSON.stringify(k ? [pl.phases[k - 1]!.id] : []));
    [pl.phases[i], pl.phases[j]] = [pl.phases[j]!, pl.phases[i]!];
    if (linear) pl.phases.forEach((p, k) => { p.dependsOn = k ? [pl.phases[k - 1]!.id] : []; });
  });
  const startable = (a?: string) => agents.find((x) => x.id === (a ?? 'claude-code'))?.startable ?? false;

  const start = async (id: string): Promise<boolean> => {
    setBusy(`start-${id}`); setMsg('');
    try { await post('/api/plan/phases/start', { phaseId: id }); onRunStarted(); data.reload(); return true; } catch (e) { fail(e); return false; } finally { setBusy(''); }
  };
  const verify = async (id: string) => {
    setBusy(`verify-${id}`); setMsg('');
    try { await post('/api/plan/phases/verify', { phaseId: id }); data.reload(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const loop = async (id: string, rounds: number) => {
    setBusy(`loop-${id}`); setMsg('');
    try { const r = await post<{ note: string }>('/api/plan/loop', { phaseId: id, rounds }); setMsg(r.note); data.reload(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const stopLoop = async (id: string) => { try { await post('/api/plan/loop', { phaseId: id, stop: true }); setMsg('Stopped.'); data.reload(); } catch (e) { fail(e); } };
  const showPrompt = async (id: string) => {
    try { const r = await get<{ prompt: string }>(`/api/plan/phases/prompt?phaseId=${encodeURIComponent(id)}`); setPrompt({ phase: id, text: r.prompt }); } catch (e) { fail(e); }
  };

  /** Bounded autonomous: one phase at a time, inside the plan's limits, until something needs a person. It cannot approve or release. */
  const runPlan = async () => {
    cancel.current = false; setAuto({ note: 'Starting…', active: true });
    let started = 0;
    try {
      for (;;) {
        if (cancel.current) { setAuto({ note: 'Stopped by you.', active: false }); break; }
        const cur = await get<PlanData>('/api/plan');
        const st = await get<{ approvals: { view: string }[] }>('/api/state');
        if (st.approvals.some((a) => a.view === 'pending')) { setAuto({ note: 'Paused: an action is waiting for your approval. Decide it, then run again.', active: false }); break; }
        const ready = cur.views?.find((v) => v.status === 'ready');
        const needs = cur.views?.find((v) => ['needs-evidence', 'stale'].includes(v.status));
        if (needs && cur.plan?.phases.find((p) => p.id === needs.id)?.taskId) { setAuto({ note: `Checking ${needs.id}…`, active: true }); await post('/api/plan/phases/verify', { phaseId: needs.id }); continue; }
        if (cur.views?.some((v) => v.status === 'failed')) { setAuto({ note: 'Stopped: a check failed. Look at it before going on.', active: false }); break; }
        if (!ready) { setAuto({ note: cur.views?.every((v) => ['verified', 'done-unchecked', 'skipped'].includes(v.status)) ? 'Nothing left to run.' : 'Stopped: nothing is ready to run.', active: false }); break; }
        const phase = cur.plan!.phases.find((p) => p.id === ready.id)!;
        if (phase.kind === 'release') { setAuto({ note: 'Stopped before the release phase. A release is always your decision.', active: false }); break; }
        if (!(phase.agent ? startable(phase.agent) : startable(cur.plan!.defaults[phase.role]?.agent))) { setAuto({ note: `Stopped: ${phase.title} is assigned to an agent that cannot be started from here. Run it in its own terminal.`, active: false }); break; }
        if (++started > cur.plan!.limits.maxRuns) { setAuto({ note: 'Stopped at the plan\'s run limit.', active: false }); break; }
        setAuto({ note: `Running: ${phase.title}`, active: true });
        await post('/api/plan/phases/start', { phaseId: phase.id });
        onRunStarted();
        for (;;) {
          await new Promise((ok) => setTimeout(ok, 1500));
          if (cancel.current) { const runs = await get<{ id: string; status: string }[]>('/api/runs'); for (const r of runs.filter((x) => x.status === 'running')) await post(`/api/runs/${r.id}/stop`); setAuto({ note: 'Stopped by you, and the running agent was stopped.', active: false }); return; }
          const now = await get<PlanData>('/api/plan');
          if (now.views?.find((v) => v.id === phase.id)?.status !== 'running') break;
        }
      }
    } catch (e) { setAuto({ note: `Stopped: ${(e as ApiError).message}`, active: false }); }
    data.reload(); reloadShell();
  };

  if (!d.plan || !draft) {
    return (
      <div className="plan stack" data-testid="plan-empty" tabIndex={0} role="region" aria-label="Plan">
        {dialog}
        <h2>What should be done?</h2>
        <p className="muted">Describe the goal in your own words. AgentOnTrack reads it with plain rules, not a model, and drafts only the phases it needs. You can edit everything before anything runs.</p>
        {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label>The goal<textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} required name="plan-goal" placeholder="For example: Fix the crash when the date is empty" /></label>
          <div><button className="btn primary" type="submit" disabled={!!busy || !goal.trim() || isDemo()} data-testid="plan-create">Create a plan</button></div>
        </form>
        <p className="muted small">{d.facts.testCommand ? `This project's tests run with ${d.facts.testCommand}, found in ${d.facts.testCommandSource}.` : 'No test command was found in this project, so a test phase could not be checked by AgentOnTrack until you add one.'}</p>
      </div>
    );
  }

  const approvedNow = !!d.approved && !dirty;
  return (
    <div className="plan stack" data-testid="plan" tabIndex={0} role="region" aria-label="Plan">
      {dialog}
      <div className="row wrap">
        <h2 className="grow" style={{ margin: 0 }}>{d.plan.goal}</h2>
        <span className={`badge ${d.approved ? 'good' : 'warn'}`} data-testid="plan-approval">{d.approved ? 'Approved' : 'Not approved'}</span>
      </div>
      {msg ? <div className="alert bad" role="alert" data-testid="plan-error">{msg}</div> : null}

      <fieldset className="card stack" style={{ border: '1px solid var(--border)' }}>
        <legend className="small muted">How much runs by itself</legend>
        <div className="row wrap" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => <label key={m.id} className="check"><input type="radio" name="plan-mode" checked={draft.mode === m.id} onChange={() => patch((p) => { p.mode = m.id; })} /> {m.label}</label>)}
        </div>
        <p className="muted small" data-testid="mode-help">{MODES.find((m) => m.id === draft.mode)!.help}</p>
        <div className="row wrap">
          <label>Most it may spend (USD)<input type="number" min={0.01} step={0.5} value={draft.limits.maxUsd} onChange={(e) => patch((p) => { p.limits.maxUsd = Number(e.target.value); })} name="limit-usd" style={{ width: 110 }} /></label>
          <label>Most time (minutes)<input type="number" min={1} value={draft.limits.maxMinutes} onChange={(e) => patch((p) => { p.limits.maxMinutes = Number(e.target.value); })} name="limit-minutes" style={{ width: 110 }} /></label>
          <label>Most agent runs<input type="number" min={1} max={40} value={draft.limits.maxRuns} onChange={(e) => patch((p) => { p.limits.maxRuns = Number(e.target.value); })} name="limit-runs" style={{ width: 110 }} /></label>
        </div>
        {d.approved && d.spent ? <p className="small muted" data-testid="plan-spent">So far: ${d.spent.usd.toFixed(3)} of ${d.plan.limits.maxUsd}, {d.spent.runs} of {d.plan.limits.maxRuns} runs, {d.spent.minutes} of {d.plan.limits.maxMinutes} minutes.</p> : null}
      </fieldset>

      <ol className="phases" aria-label="Phases" data-testid="phases">
        {draft.phases.map((ph, i) => {
          const v = views.get(ph.id);
          const status = dirty && !SAFE_ONLY(draft, server!) ? 'draft' : v?.status ?? 'draft';
          const canStart = approvedNow && status === 'ready';
          const mine = ph.agent ?? draft.defaults[ph.role]?.agent;
          return (
            <li key={ph.id} className="phase" data-testid={`phase-${ph.id}`} data-status={status}>
              <div className="row wrap">
                <b className="grow" style={{ minWidth: 160 }}><span className="muted">{i + 1}. </span>{ph.title}</b>
                <span className={`badge ${STATUS_CLASS[status] ?? ''}`} data-testid="phase-status">{STATUS_TEXT[status] ?? status}</span>
              </div>
              <p className="small muted" data-testid="phase-why">{v?.why ?? ''}</p>
              <details className="small">
                <summary>Edit this phase</summary>
                <div className="stack">
                  <label>Title<input value={ph.title} maxLength={120} onChange={(e) => patchPhase(ph.id, (x) => { x.title = e.target.value; })} name={`title-${ph.id}`} /></label>
                  <label>What to do<textarea rows={2} value={ph.instructions} maxLength={2000} onChange={(e) => patchPhase(ph.id, (x) => { x.instructions = e.target.value; })} name={`how-${ph.id}`} /></label>
                  <div className="row wrap">
                    <label>Agent
                      <select value={ph.agent ?? ''} onChange={(e) => patchPhase(ph.id, (x) => { if (e.target.value) x.agent = e.target.value; else delete x.agent; })} name={`agent-${ph.id}`}>
                        <option value="">Default for {ph.role}</option>
                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.startable ? '' : ' (runs in its own terminal)'}</option>)}
                      </select>
                    </label>
                    <ModelField agent={ph.agent ?? server?.defaults[ph.role]?.agent ?? 'claude-code'} value={ph.model ?? ''} onChange={(v) => patchPhase(ph.id, (x) => { if (v) x.model = v; else delete x.model; })} name={`model-${ph.id}`} models={disc.data?.models} />
                    <label>Most USD<input type="number" min={0.01} step={0.25} value={ph.budget.maxUsd ?? ''} onChange={(e) => patchPhase(ph.id, (x) => { if (e.target.value) x.budget.maxUsd = Number(e.target.value); else delete x.budget.maxUsd; })} name={`usd-${ph.id}`} style={{ width: 90 }} /></label>
                    <label>Most runs<input type="number" min={1} max={10} value={ph.budget.maxRuns ?? ''} onChange={(e) => patchPhase(ph.id, (x) => { if (e.target.value) x.budget.maxRuns = Number(e.target.value); else delete x.budget.maxRuns; })} name={`runs-${ph.id}`} style={{ width: 90 }} /></label>
                  </div>
                  <fieldset className="stack" style={{ border: 0, padding: 0 }}>
                    <legend className="small muted">Checked against</legend>
                    {ph.acceptance.map((a, k) => (
                      <div className="row wrap" key={a.id}>
                        <input className="grow" aria-label={`Check ${k + 1} description`} value={a.description} onChange={(e) => patchPhase(ph.id, (x) => { x.acceptance[k]!.description = e.target.value; })} />
                        <select aria-label={`Check ${k + 1} kind`} value={a.kind} onChange={(e) => patchPhase(ph.id, (x) => { const c = x.acceptance[k]!; c.kind = e.target.value as 'command' | 'manual'; if (c.kind === 'manual') delete c.command; else c.command ??= d.facts.testCommand ?? ''; })} style={{ width: 120 }}><option value="command">Command</option><option value="manual">By hand</option></select>
                        {a.kind === 'command' ? <input className="mono" aria-label={`Check ${k + 1} command`} value={a.command ?? ''} onChange={(e) => patchPhase(ph.id, (x) => { x.acceptance[k]!.command = e.target.value; })} style={{ width: 180 }} /> : null}
                        <button type="button" className="icon-btn" aria-label={`Remove check ${k + 1}`} onClick={() => patchPhase(ph.id, (x) => { x.acceptance.splice(k, 1); })}><Icon name="x" size={14} /></button>
                      </div>
                    ))}
                    <div><button type="button" className="btn small" onClick={() => patchPhase(ph.id, (x) => { x.acceptance.push({ id: `check-${x.acceptance.length + 1}-${Math.random().toString(36).slice(2, 5)}`, description: 'New check', kind: 'manual' }); })}>Add a check</button></div>
                  </fieldset>
                  {ph.acceptance.some((a) => a.kind === 'manual') && !ph.acceptance.some((a) => a.kind === 'command') ? <p className="small alert warn">With no command to run, AgentOnTrack cannot check this phase itself. It will never show as verified.</p> : null}
                </div>
              </details>
              {ph.risks.length ? <ul className="small" aria-label="Risks">{ph.risks.map((r) => <li key={r}>{r}</li>)}</ul> : null}
              {ph.effort ? <p className="small muted">Estimate: about {ph.effort.minutes} minutes. {ph.effort.basis}</p> : null}
              <p className="small muted">{mine ? `Agent: ${agents.find((a) => a.id === mine)?.name ?? mine}` : 'No agent chosen yet'}{ph.model ? `, model ${ph.model}` : ''}. {ph.acceptance.length ? `${ph.acceptance.filter((a) => a.kind === 'command').length} command check(s), ${ph.acceptance.filter((a) => a.kind === 'manual').length} by hand.` : 'No checks.'}</p>
              <div className="row wrap">
                {canStart && startable(mine) ? <button className="btn small primary" disabled={!!busy || draft.mode === 'bounded' && !!auto?.active} onClick={() => void start(ph.id)} data-testid={`start-${ph.id}`}><Icon name="play" size={12} />Start</button> : null}
                {canStart && startable(mine) && approvedNow && ph.taskId && ph.acceptance.some((a) => a.kind === 'command') && ['ready', 'failed', 'needs-evidence', 'stale'].includes(status) ? <button className="btn small" disabled={!!busy} title="Runs the agent, then the checks. If they fail it runs again with what failed, up to 3 times, and stops at the first pass." onClick={() => void loop(ph.id, 3)} data-testid={`loop-${ph.id}`}>Repeat until the checks pass (up to 3)</button> : null}
                {status === 'running' ? <button className="btn small" onClick={() => void stopLoop(ph.id)} data-testid={`stoploop-${ph.id}`}>Stop</button> : null}
                {canStart && !startable(mine) ? <button className="btn small" onClick={() => void showPrompt(ph.id)} data-testid={`prompt-${ph.id}`}>Copy the prompt for {agents.find((a) => a.id === mine)?.name ?? 'an agent'}</button> : null}
                {approvedNow && ph.taskId && ['needs-evidence', 'stale', 'failed', 'ready', 'blocked'].includes(status) && (v?.runs ?? 0) > 0 ? <button className="btn small" disabled={!!busy} onClick={() => void verify(ph.id)} data-testid={`verify-${ph.id}`}>Run the checks</button> : null}
                {ph.state === 'draft' ? <button className="btn small" onClick={() => void setState(ph.id, 'paused')} disabled={dirty}>Pause</button> : null}
                {ph.state === 'paused' ? <button className="btn small" onClick={() => void setState(ph.id, 'draft')} disabled={dirty}>Resume</button> : null}
                {ph.state !== 'skipped' ? <button className="btn small" onClick={() => void setState(ph.id, 'skipped')} disabled={dirty}>Skip</button> : <button className="btn small" onClick={() => void setState(ph.id, 'draft')} disabled={dirty}>Include again</button>}
                <button className="icon-btn" aria-label={`Move ${ph.title} up`} disabled={i === 0} onClick={() => move(ph.id, -1)}>↑</button>
                <button className="icon-btn" aria-label={`Move ${ph.title} down`} disabled={i === draft.phases.length - 1} onClick={() => move(ph.id, 1)}>↓</button>
              </div>
              {prompt?.phase === ph.id ? <div className="stack"><p className="small muted">Paste this into the agent's own terminal. Its hooks report back here, and the checks still run on your machine.</p><pre className="code small" tabIndex={0} data-testid="phase-prompt">{prompt.text}</pre></div> : null}
            </li>
          );
        })}
      </ol>

      <div className="row wrap plan-bar" data-testid="plan-bar">
        {dirty ? <button className="btn primary" onClick={() => void save()} disabled={!!busy} data-testid="plan-save">Save changes</button> : null}
        {dirty ? <button className="btn" onClick={() => setDraft(structuredClone(server))}>Discard changes</button> : null}
        {!dirty && !d.approved ? <button className="btn primary" data-testid="plan-approve" onClick={() => ask({ title: 'Approve this plan', detail: <div className="stack small"><p>This allows the phases below to be started, with exactly these agents, models, checks and limits. Any change to them needs a new approval. Approving starts nothing, and releasing is never automatic.</p><ol>{server!.phases.map((p) => <li key={p.id}><b>{p.title}</b>, {p.agent ?? server!.defaults[p.role]?.agent ?? 'default agent'}{p.acceptance.filter((a) => a.kind === 'command').map((a) => <div key={a.id} className="mono">runs: {a.command}</div>)}</li>)}</ol><p>Limits: ${server!.limits.maxUsd}, {server!.limits.maxMinutes} minutes, {server!.limits.maxRuns} runs. Mode: {server!.mode}.</p></div>, path: '/api/plan/approve', body: { sha256: d.sha, expectVersion: d.version } })}>Approve the plan…</button> : null}
        {!dirty && d.approved && draft.mode === 'bounded' ? (auto?.active ? <button className="btn" onClick={() => { cancel.current = true; }} data-testid="plan-stop">Stop</button> : <button className="btn primary" onClick={() => void runPlan()} data-testid="plan-run">Run the plan within its limits</button>) : null}
        <button className="btn small" onClick={() => { if (window.confirm('Replace this plan with a new one? The old plan stays in the record.')) { setGoal(draft.goal); void post('/api/plan/draft', { goal: draft.goal, expectVersion: d.version }).then(() => data.reload()).catch(fail); } }}>Draft again from the same goal</button>
      </div>
      {auto ? <p role="status" data-testid="plan-auto">{auto.note}</p> : null}
      {d.approved && !dirty ? null : <p className="muted small">{dirty ? 'You have unsaved changes.' : 'Nothing can start until you approve the plan.'}</p>}
      {!d.plan.phases.length ? <Empty>No phases.</Empty> : null}
    </div>
  );
}
