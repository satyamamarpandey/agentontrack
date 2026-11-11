import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, describeCancel, get, isDemo, post, postStart, stopRuns } from './api';
import { useHuman } from './human';
import { Icon } from './icons';
import { Empty, Loading, useLoad } from './ui';
import { ModelField, useDiscovery } from './model-field';

type Mode = 'manual' | 'guided' | 'bounded';
interface Phase { id: string; title: string; kind: string; role: string; instructions: string; dependsOn: string[]; agent?: string; model?: string; acceptance: { id: string; description: string; kind: 'command' | 'manual'; command?: string }[]; budget: { maxUsd?: number; maxMinutes?: number; maxRuns?: number }; risks: string[]; effort?: { minutes: number; basis: string }; state: 'draft' | 'paused' | 'skipped'; taskId?: string }
interface Plan { id: string; goal: string; mode: Mode; limits: { maxUsd: number; maxMinutes: number; maxRuns: number }; defaults: Record<string, { agent: string; model?: string }>; phases: Phase[] }
interface View { id: string; status: string; why: string; runs: number; spentUsd: number }
interface PlanData { plan: Plan | null; version?: number; sha?: string; approved?: boolean; views?: View[]; spent?: { usd: number; runs: number; minutes: number }; facts?: { testCommand: string | null; testCommandSource: string | null }; sequence?: { active: boolean; ended: { reason: string; message: string } | null } }
interface Unattended { active: boolean; reason: string | null; grant: { remainingRuns: number; maxRuns: number; maxPhasesPerSequence: number; expiresAt: string } | null }

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
  const settings = useLoad<{ unattended?: Unattended; allowMobileExecution?: boolean }>(() => get('/api/settings'), [tick]);
  const { ask, dialog } = useHuman(() => { data.reload(); settings.reload(); });
  const unattended = settings.data?.unattended?.active === true;
  const grant = settings.data?.unattended?.grant ?? null;
  const mobileExec = settings.data?.allowMobileExecution === true;

  const server = data.data?.plan ?? null;
  const serverKey = JSON.stringify(server);
  const lastServer = useRef<string>('null');
  const adopt = useRef(false);
  // A refresh from the server replaces the draft only when the person has no unsaved edits; otherwise their edits are kept.
  useEffect(() => { const prev = lastServer.current; lastServer.current = serverKey; const take = adopt.current; adopt.current = false; setDraft((cur) => (!take && cur && prev !== 'null' && JSON.stringify(cur) !== prev ? cur : server ? structuredClone(server) : null)); }, [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server);

  const views = useMemo(() => new Map((data.data?.views ?? []).map((v) => [v.id, v])), [data.data]);
  if (!data.data) return <Loading error={data.error} />;
  const d = data.data;
  const fail = (e: unknown) => setMsg((e as Error).message);

  const create = async (replace = false) => {
    setBusy('create'); setMsg('');
    try { await post('/api/plan/draft', { goal, ...(replace && d.version ? { expectVersion: d.version } : {}) }); setGoal(''); adopt.current = true; data.reload(); } catch (e) { fail(e); } finally { setBusy(''); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy('save'); setMsg('');
    try { await post('/api/plan/draft', { plan: draft, expectVersion: d.version }); adopt.current = true; data.reload(); } catch (e) { fail(e); } finally { setBusy(''); }
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
    try { await postStart('/api/plan/phases/start', { phaseId: id }); onRunStarted(); data.reload(); return true; } catch (e) { fail(e); return false; } finally { setBusy(''); }
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

  /**
   * Bounded autonomous. The companion runs the sequence (POST /api/plan/continue, the same function the phone uses) and enforces the grant, the sign-in rule and the plan's
   * limits. This page only starts it and polls the plan for progress, so closing or reloading the page changes nothing about what is allowed.
   */
  const runPlan = async () => {
    cancel.current = false; setAuto({ note: 'Starting…', active: true });
    try {
      const n = Math.max(1, Math.min(grant?.maxPhasesPerSequence ?? 1, d.plan?.limits.maxRuns ?? 10));
      const r = await post<{ started: boolean; note: string }>('/api/plan/continue', { maxPhases: n });
      setAuto({ note: r.note, active: true });
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 1500));
        if (cancel.current) {
          await post('/api/plan/continue', { stop: true });
          const runs = await get<{ id: string; status: string }[]>('/api/runs');
          const out = await stopRuns(runs.filter((x) => x.status === 'running').map((x) => x.id));
          setAuto({ note: describeCancel(out), active: false }); break;
        }
        const now = await get<PlanData>('/api/plan');
        if (!now.sequence?.active) { setAuto({ note: now.sequence?.ended?.message ?? 'Nothing is running.', active: false }); break; }
        const cur = now.views?.find((v) => v.status === 'running');
        setAuto({ note: cur ? `Running: ${now.plan?.phases.find((p) => p.id === cur.id)?.title ?? cur.id}` : 'Working…', active: true });
        onRunStarted();
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
        <p className="muted small">{d.facts?.testCommand ? `This project's tests run with ${d.facts.testCommand}, found in ${d.facts.testCommandSource}.` : 'No test command was found in this project, so a test phase could not be checked by AgentOnTrack until you add one.'}</p>
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
        <p className="small muted" data-testid="plan-usd-note">The dollar limit counts only runs on your own API key with paid API mode on. Runs on a subscription sign-in have no dollar figure and are not counted against it: use the minutes and runs limits for those.</p>
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
                        <select aria-label={`Check ${k + 1} kind`} value={a.kind} onChange={(e) => patchPhase(ph.id, (x) => { const c = x.acceptance[k]!; c.kind = e.target.value as 'command' | 'manual'; if (c.kind === 'manual') delete c.command; else c.command ??= d.facts?.testCommand ?? ''; })} style={{ width: 120 }}><option value="command">Command</option><option value="manual">By hand</option></select>
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
                {canStart && startable(mine) && approvedNow && ph.taskId && ph.acceptance.some((a) => a.kind === 'command') && ['ready', 'failed', 'needs-evidence', 'stale'].includes(status) ? <button className="btn small" disabled={!!busy || !unattended} title={unattended ? 'Runs the agent, then the checks. If they fail it runs again with what failed, up to 3 times, and stops at the first pass.' : 'Off: unattended runs are not allowed. Turn them on below, or use Start to run this phase once.'} onClick={() => void loop(ph.id, 3)} data-testid={`loop-${ph.id}`}>Repeat until the checks pass (up to 3)</button> : null}
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
        {!dirty && d.approved && draft.mode === 'bounded' ? (auto?.active ? <button className="btn" onClick={() => { cancel.current = true; }} data-testid="plan-stop">Stop</button> : <span className="row wrap"><button className="btn primary" disabled={!unattended} onClick={() => void runPlan()} data-testid="plan-run">Run the plan within its limits</button>{unattended ? null : <span className="muted small" data-testid="plan-run-off">Off: running phases back to back is an unattended run. Turn on "Unattended runs" below, or start each phase yourself.</span>}</span>) : null}
        <button className="btn small" onClick={() => { if (window.confirm('Replace this plan with a new one? The old plan stays in the record.')) { setGoal(draft.goal); void post('/api/plan/draft', { goal: draft.goal, expectVersion: d.version }).then(() => data.reload()).catch(fail); } }}>Draft again from the same goal</button>
      </div>
      {auto ? <p role="status" data-testid="plan-auto">{auto.note}</p> : null}
      <div className="row wrap small" data-testid="unattended-row">
        <span className="muted">Unattended runs (repeating a phase, or continuing several phases, with nobody acting between runs): <b>{unattended ? 'on' : 'off'}</b>{unattended && grant ? `, ${grant.remainingRuns} of ${grant.maxRuns} runs left, until ${new Date(grant.expiresAt).toLocaleString()}, this project only` : ''}. Even when on, they run only with an API-key sign-in under paid API mode.</span>
        <button className="btn small" data-testid="unattended-toggle" onClick={() => ask(unattended
          ? { title: 'Turn unattended runs off', path: '/api/settings/unattended', body: { allow: false } }
          : { title: 'Allow unattended runs', detail: <p className="small">This gives THIS project a limited grant (up to 5 runs, for 4 hours), after which a plan can repeat a phase or continue through several phases without you pressing Start each time. Provider permission for unattended automation on a subscription sign-in is unresolved, so the companion refuses these runs unless the agent is signed in with your own API key and paid API mode is on; otherwise start each phase yourself. Each run is still bounded by the plan's limits, and nothing is approved for you.</p>, path: '/api/settings/unattended', body: { allow: true } })}>{unattended ? 'Turn off…' : 'Allow unattended runs…'}</button>
      </div>
      <div className="row wrap small" data-testid="mobile-exec-row">
        <span className="muted">Starting agents from a paired phone: <b>{mobileExec ? 'on' : 'off'}</b>. Viewing, stopping and approving from a phone do not depend on this.</span>
        <button className="btn small" data-testid="mobile-exec-toggle" onClick={() => ask(mobileExec
          ? { title: 'Stop phones from starting agents', path: '/api/settings/mobile-execution', body: { allow: false } }
          : { title: 'Let a paired phone start agents', detail: <p className="small">A paired phone will be able to start agent runs and sessions on this computer, inside the same limits. Turn this off again at any time.</p>, path: '/api/settings/mobile-execution', body: { allow: true } })}>{mobileExec ? 'Turn off…' : 'Allow phone starts…'}</button>
      </div>
      {d.approved && !dirty ? null : <p className="muted small">{dirty ? 'You have unsaved changes.' : 'Nothing can start until you approve the plan.'}</p>}
      {!d.plan.phases.length ? <Empty>No phases.</Empty> : null}
    </div>
  );
}
