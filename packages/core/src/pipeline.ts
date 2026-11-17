import { z } from 'zod/v4';

/**
 * Plan → Build → Review → Verify. Each stage needs its own explicit authorization before it may start, and records the model the
 * runtime reported using, which is compared with the model the person chose. Pure: it holds no clock, no network and no model call.
 * Nothing here approves a stage on the person's behalf.
 */
export const PIPELINE_STAGES = ['plan', 'build', 'review', 'verify'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Suggested model per role for one Claude login. A suggestion only: the person chooses, and only discovered models are offered. */
export const CLAUDE_ROLE_SUGGESTIONS: Record<PipelineStage, string[]> = {
  plan: ['haiku', 'fable'],
  build: ['sonnet'],
  review: ['opus'],
  verify: ['haiku'],
};

const Model = z.string().regex(/^\w[\w.:-]{0,79}$/);
export const PipelineStageChoiceSchema = z.object({ agent: z.enum(['claude-code', 'codex', 'hermes']), model: Model, effort: z.string().max(20).optional() });
export type PipelineStageChoice = z.infer<typeof PipelineStageChoiceSchema>;

export type PipelineStageStatus = 'not-started' | 'authorized' | 'running' | 'done' | 'failed';
export interface PipelineStageRecord {
  stage: PipelineStage; status: PipelineStageStatus; chosen?: PipelineStageChoice;
  authorizedBy?: string; authorizedAt?: number;
  /** What the runtime reported it used. Never filled from the choice. */
  actualModel?: string | null; runId?: string; evidence?: string[];
  acceptedUsageCredits?: boolean;
  /** True when the runtime reported a different model from the one chosen. */
  substituted?: boolean;
  note?: string;
}
export interface Pipeline { id: string; goal: string; stages: PipelineStageRecord[] }

export class PipelineError extends Error {}

export function newPipeline(id: string, goal: string): Pipeline {
  if (!goal.trim()) throw new PipelineError('A pipeline needs a goal');
  return { id, goal, stages: PIPELINE_STAGES.map((stage) => ({ stage, status: 'not-started' as const })) };
}
const idx = (s: PipelineStage) => PIPELINE_STAGES.indexOf(s);
const rec = (p: Pipeline, s: PipelineStage) => p.stages[idx(s)]!;
const copy = (p: Pipeline): Pipeline => ({ ...p, stages: p.stages.map((r) => ({ ...r })) });

/** The person authorizes ONE stage, naming the agent and model. Earlier stages must be done; a later stage is never authorized by an earlier approval. */
export function authorizeStage(p: Pipeline, stage: PipelineStage, choice: PipelineStageChoice, by: string, at: number, opts: { acceptUsageCredits?: boolean; billing?: 'included' | 'may-use-credits' | 'unknown' } = {}): Pipeline {
  const c = PipelineStageChoiceSchema.parse(choice);
  if (!by.trim()) throw new PipelineError('A stage needs the name of the person who authorizes it');
  const r = rec(p, stage);
  if (r.status !== 'not-started' && r.status !== 'failed') throw new PipelineError(`${stage} is already ${r.status}`);
  for (const prev of PIPELINE_STAGES.slice(0, idx(stage))) if (rec(p, prev).status !== 'done') throw new PipelineError(`${prev} must be done before ${stage} can be authorized`);
  if (opts.billing === 'may-use-credits' && !opts.acceptUsageCredits) throw new PipelineError(`${c.model} may charge usage credits: the person must accept that for this stage`);
  const out = copy(p);
  out.stages[idx(stage)] = { stage, status: 'authorized', chosen: c, authorizedBy: by, authorizedAt: at, acceptedUsageCredits: !!opts.acceptUsageCredits };
  return out;
}

export function startStage(p: Pipeline, stage: PipelineStage, runId: string): Pipeline {
  const r = rec(p, stage);
  if (r.status !== 'authorized') throw new PipelineError(`${stage} has not been authorized, so it cannot start`);
  const out = copy(p); out.stages[idx(stage)] = { ...r, status: 'running', runId }; return out;
}

/** Records the outcome. `actualModel` comes from the runtime; a difference from the choice is recorded as a substitution, never hidden or corrected. */
export function finishStage(p: Pipeline, stage: PipelineStage, o: { ok: boolean; actualModel: string | null; evidence?: string[]; note?: string }): Pipeline {
  const r = rec(p, stage);
  if (r.status !== 'running') throw new PipelineError(`${stage} is not running`);
  const substituted = !!o.actualModel && !!r.chosen && !sameModel(r.chosen.model, o.actualModel);
  const out = copy(p);
  out.stages[idx(stage)] = { ...r, status: o.ok ? 'done' : 'failed', actualModel: o.actualModel, evidence: o.evidence ?? [], substituted, ...(o.note ? { note: o.note } : {}) };
  return out;
}

/** `sonnet` matches `claude-sonnet-5-5`: an alias is one dash-separated word of the full id. */
export function sameModel(chosen: string, actual: string): boolean {
  const a = chosen.toLowerCase(); const b = actual.toLowerCase();
  return a === b || b.split(/[-_.:]/).includes(a) || a.split(/[-_.:]/).includes(b);
}

/** `verified` here means only that the verify stage finished with a recorded run and no model substitution. It is not a check receipt: the project verification engine decides what is verified. */
export function summary(p: Pipeline): { next: PipelineStage | null; verified: boolean; substitutions: PipelineStage[] } {
  const next = PIPELINE_STAGES.find((s) => rec(p, s).status !== 'done') ?? null;
  const v = rec(p, 'verify');
  return { next, verified: v.status === 'done' && (v.evidence?.length ?? 0) > 0 && !v.substituted, substitutions: p.stages.filter((r) => r.substituted).map((r) => r.stage) };
}

/** Subscription chains that run on their own are blocked until the provider's terms are cleared. A stage needs a person's authorization each time. */
export function unattendedChainAllowed(): { ok: false; reason: string } {
  return { ok: false, reason: 'Running the next stage without a person authorizing it is off: provider clearance for unattended subscription use is pending. Authorize each stage yourself.' };
}
