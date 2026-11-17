import { useEffect, useState } from 'react';
import { get, post } from './api';
import { ModelField, mayUseCredits, useDiscovery } from './model-field';
import { Badge, Empty, Loading, useLoad } from './ui';

const STAGES = ['plan', 'build', 'review', 'verify'] as const;
type Stage = (typeof STAGES)[number];
const LABEL: Record<Stage, string> = { plan: 'Plan', build: 'Build', review: 'Review', verify: 'Verify' };
const ROLE_HINT: Record<Stage, string> = { plan: 'Planning: Haiku, or Fable if you accept usage credits', build: 'Coding: Sonnet', review: 'Reviewing: Opus, where your plan includes it', verify: 'Checking: Haiku' };

interface StageRec { stage: Stage; status: string; chosen?: { agent: string; model: string }; actualModel?: string | null; substituted?: boolean; evidence?: string[]; note?: string; acceptedUsageCredits?: boolean }
interface View { pipeline: { id: string; goal: string; stages: StageRec[] } | null; summary: { next: Stage | null; verified: boolean; substitutions: Stage[] } | null; suggestions: Record<Stage, string[]> }

/** Plan → Build → Review → Verify. Each stage is authorized by you, one at a time, with the agent and model you pick for it. Nothing here runs the next stage by itself. */
export function PipelinePanel({ tick }: { tick: number }) {
  const v = useLoad<View>(() => get('/api/pipeline'), [tick]);
  const disc = useDiscovery(tick);
  const [goal, setGoal] = useState('');
  const [msg, setMsg] = useState('');
  const [picks, setPicks] = useState<Partial<Record<Stage, { agent: string; model: string; credits: boolean; prompt: string }>>>({});
  const act = async (fn: () => Promise<unknown>) => { setMsg(''); try { await fn(); v.reload(); } catch (e) { setMsg((e as Error).message); } };
  const running = !!v.data?.pipeline?.stages.some((r) => r.status === 'running');
  useEffect(() => { if (!running) return; const t = setInterval(v.reload, 2000); return () => clearInterval(t); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v.data) return <Loading error={v.error} />;
  const pl = v.data.pipeline;
  if (!pl) {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (goal.trim()) void act(() => post('/api/pipeline', { goal })); }} data-testid="pipe-new">
        <p className="muted small">Work in four stages. You authorize each stage yourself, and choose its agent and model. The record shows which model the agent actually reported using.</p>
        <label>Goal<textarea value={goal} onChange={(e) => setGoal(e.target.value)} name="pipe-goal" required /></label>
        <button className="btn primary" type="submit" disabled={!goal.trim()}>Start pipeline</button>
        {msg ? <p className="alert bad small" role="alert">{msg}</p> : null}
      </form>
    );
  }
  return (
    <div className="stack" data-testid="pipe">
      <p className="small"><b>Goal:</b> {pl.goal}</p>
      {v.data.summary?.verified ? <p className="alert good small" data-testid="pipe-verified">All four stages finished and each reported the model you chose. This is not a test result: check the changes and the Verification tab yourself.</p> : null}
      {(v.data.summary?.substitutions.length ?? 0) > 0 ? <p className="alert bad small" role="alert" data-testid="pipe-substituted">The runtime reported a different model from the one chosen for: {v.data.summary!.substitutions.join(', ')}.</p> : null}
      {pl.stages.map((r) => {
        const pick = picks[r.stage] ?? { agent: 'claude-code', model: v.data!.suggestions[r.stage][0] ?? '', credits: false, prompt: '' };
        const set = (p: Partial<typeof pick>) => setPicks((x) => ({ ...x, [r.stage]: { ...pick, ...p } }));
        const open = r.status === 'not-started' || r.status === 'failed';
        const earlierDone = STAGES.slice(0, STAGES.indexOf(r.stage)).every((s) => pl.stages.find((x) => x.stage === s)?.status === 'done');
        return (
          <section key={r.stage} className="card stack" aria-label={LABEL[r.stage]} data-testid={`pipe-${r.stage}`}>
            <div className="row"><h3 style={{ margin: 0 }}>{LABEL[r.stage]}</h3><Badge value={r.status} /></div>
            <p className="muted small">{ROLE_HINT[r.stage]}</p>
            {r.chosen ? <p className="small">Chosen: <span className="mono">{r.chosen.model}</span> · Reported by the runtime: <span className="mono" data-testid={`pipe-actual-${r.stage}`}>{r.actualModel ?? (r.status === 'done' || r.status === 'failed' ? 'not reported' : 'not yet')}</span>{r.substituted ? ' · differs from the choice' : ''}</p> : null}
            {r.note ? <p className="muted small">{r.note}</p> : null}
            {open && earlierDone ? (
              <>
                <ModelField agent={pick.agent} value={pick.model} onChange={(m) => set({ model: m, credits: false })} name={`pipe-${r.stage}-model`} models={disc.data?.models} width={170} credits={pick.credits} onCredits={(c) => set({ credits: c })} />
                <button className="btn" data-testid={`pipe-auth-${r.stage}`} disabled={!pick.model || (mayUseCredits(pick.agent, pick.model) && !pick.credits)} onClick={() => void act(() => post('/api/pipeline/authorize', { stage: r.stage, agent: pick.agent, model: pick.model, acceptUsageCredits: pick.credits && mayUseCredits(pick.agent, pick.model) }))}>Authorize {LABEL[r.stage].toLowerCase()} with this model</button>
              </>
            ) : open ? <p className="muted small">Waiting for the stage before it to finish.</p> : null}
            {r.status === 'authorized' ? (
              <>
                <label>Prompt for this stage<textarea value={pick.prompt} onChange={(e) => set({ prompt: e.target.value })} name={`pipe-${r.stage}-prompt`} /></label>
                <button className="btn primary" data-testid={`pipe-run-${r.stage}`} disabled={!pick.prompt.trim()} onClick={() => void act(() => post('/api/pipeline/start', { stage: r.stage, prompt: pick.prompt }))}>Run {LABEL[r.stage].toLowerCase()} now</button>
              </>
            ) : null}
            {r.status === 'running' ? <p className="muted small" role="status">Running. This updates by itself.</p> : null}
            {r.evidence?.length ? <p className="muted small">Evidence: {r.evidence.join(', ')}</p> : null}
          </section>
        );
      })}
      <p className="muted small" data-testid="pipe-unattended">Running stages on their own, without you authorizing each one, is off: provider clearance for unattended subscription use is pending.</p>
      {msg ? <p className="alert bad small" role="alert">{msg}</p> : null}
      {v.data.summary?.next === null ? <button className="btn small" onClick={() => void act(() => post('/api/pipeline', { goal: pl.goal }))}>Start a new pipeline</button> : null}
      {!pl.stages.length ? <Empty>No stages.</Empty> : null}
    </div>
  );
}
