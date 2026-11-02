import type { PhasePlan, PhaseView } from './plan.js';

/**
 * The next things worth doing, read from the record: what is failing, what has no evidence, what is waiting. A fixed set of rules,
 * not a model, so the same state always gives the same answer and every suggestion says which fact it came from.
 */
export interface Suggestion {
  id: string;
  kind: 'draft-plan' | 'approve-plan' | 'start-phase' | 'run-checks' | 'fix-failure' | 'review' | 'decide-approval' | 'refresh-evidence' | 'finish';
  title: string;
  /** The text to send. The person may edit it before anything runs. */
  prompt: string;
  /** The fact it comes from, in plain words. */
  why: string;
  agent: { id: string; name: string } | null;
  /** True when the agent can be started from here; false means the prompt is for the person to copy. */
  startable: boolean;
  needsApproval: boolean;
  scope: string;
  phaseId?: string;
}

export interface AgentFact { id: string; name: string; canStart: boolean }
export interface SuggestInput {
  goal: string | null;
  plan: PhasePlan | null;
  approved: boolean;
  views: PhaseView[];
  pendingApprovals: number;
  agents: AgentFact[];
  /** What a failed check printed, if the caller has it. */
  failureNotes?: Record<string, string>;
  /** Phases the person dismissed. */
  dismissed?: string[];
}

const MAX = 3;

export function pickAgents(agents: AgentFact[], preferred?: string): { builder: AgentFact | null; reviewer: AgentFact | null; reviewerIndependent: boolean } {
  const startable = agents.filter((a) => a.canStart);
  const builder = startable.find((a) => a.id === preferred) ?? startable[0] ?? agents.find((a) => a.id === preferred) ?? null;
  const other = startable.find((a) => a.id !== builder?.id);
  // A reviewer that is the author is a weaker check, and the suggestion says so.
  return { builder, reviewer: other ?? builder, reviewerIndependent: !!other };
}

export function suggestNext(i: SuggestInput): Suggestion[] {
  const out: Suggestion[] = [];
  const push = (s: Suggestion) => { if (!(i.dismissed ?? []).includes(s.id) && out.length < MAX) out.push(s); };

  if (i.pendingApprovals > 0) push({ id: 'approvals', kind: 'decide-approval', title: `${i.pendingApprovals} action${i.pendingApprovals > 1 ? 's are' : ' is'} waiting for you`, prompt: '', why: 'An agent asked to do something that needs a person to decide.', agent: null, startable: false, needsApproval: true, scope: 'Approvals' });

  if (!i.goal) return out;
  if (!i.plan) {
    push({ id: 'draft-plan', kind: 'draft-plan', title: 'Break the goal into phases', prompt: i.goal, why: 'There is a goal but no plan, so nothing can be tracked or checked yet.', agent: null, startable: false, needsApproval: false, scope: 'Drafts a plan for you to edit. Runs nothing.' });
    return out;
  }
  if (!i.approved) {
    push({ id: 'approve-plan', kind: 'approve-plan', title: 'Review and approve the plan', prompt: '', why: 'A plan runs only after you approve exactly what it says.', agent: null, startable: false, needsApproval: true, scope: 'Nothing runs until you approve.' });
    return out;
  }

  const byId = new Map(i.plan.phases.map((p) => [p.id, p]));
  for (const v of i.views) {
    const ph = byId.get(v.id)!;
    const { builder } = pickAgents(i.agents, ph.agent);
    const agent = builder ? { id: builder.id, name: builder.name } : null;
    const startable = !!builder?.canStart;
    if (v.status === 'failed') push({ id: `fix:${v.id}`, kind: 'fix-failure', title: `Fix the failing check in "${ph.title}"`, prompt: `A check for "${ph.title}" failed.${i.failureNotes?.[v.id] ? ` It printed:\n${i.failureNotes[v.id]}\n` : ''} Find the cause, fix it, and do not change the check itself.`, why: v.why, agent, startable, needsApproval: false, scope: `One run, within the phase's limit.`, phaseId: v.id });
    else if (v.status === 'needs-evidence' || v.status === 'stale') push({ id: `checks:${v.id}`, kind: v.status === 'stale' ? 'refresh-evidence' : 'run-checks', title: `Run the checks for "${ph.title}"`, prompt: '', why: v.why, agent: null, startable: false, needsApproval: false, scope: 'Runs the phase’s own commands. No agent is involved.', phaseId: v.id });
  }
  for (const v of i.views) {
    if (v.status !== 'ready') continue;
    const ph = byId.get(v.id)!;
    const { builder } = pickAgents(i.agents, ph.agent);
    push({ id: `start:${v.id}`, kind: 'start-phase', title: `Start "${ph.title}"`, prompt: `${ph.title}. ${ph.instructions}`.trim(), why: `Its dependencies are done and it has not run yet.`, agent: builder ? { id: builder.id, name: builder.name } : null, startable: !!builder?.canStart, needsApproval: false, scope: ph.budget.maxUsd ? `Up to $${ph.budget.maxUsd} and ${ph.budget.maxRuns ?? 1} run${(ph.budget.maxRuns ?? 1) > 1 ? 's' : ''}.` : 'Within the plan limits.', phaseId: v.id });
    break;
  }
  const implemented = i.views.filter((v) => byId.get(v.id)?.kind === 'implement');
  if (implemented.length && implemented.every((v) => ['verified', 'done-unchecked'].includes(v.status))) {
    const reviewDone = i.views.some((v) => byId.get(v.id)?.kind === 'review' && v.status !== 'ready' && v.status !== 'blocked' && v.status !== 'draft');
    if (!reviewDone) {
      const { builder, reviewer, reviewerIndependent } = pickAgents(i.agents, byId.get(implemented[0]!.id)?.agent);
      push({ id: 'review', kind: 'review', title: 'Have the changes reviewed', prompt: `Review the changes made for: ${i.goal}. Report problems; do not edit files.`, why: reviewerIndependent ? 'The work is done and a different agent is available to look at it.' : 'The work is done. Only one agent can be started, so this review is by the same agent that wrote it, which is a weaker check.', agent: reviewer ? { id: reviewer.id, name: reviewer.name } : builder ? { id: builder.id, name: builder.name } : null, startable: !!reviewer?.canStart, needsApproval: false, scope: 'Read-only review. One run.' });
    }
  }
  if (i.views.length && i.views.every((v) => ['verified', 'skipped', 'done-unchecked'].includes(v.status))) {
    const unchecked = i.views.filter((v) => v.status === 'done-unchecked').length;
    push({ id: 'finish', kind: 'finish', title: unchecked ? `Done, with ${unchecked} phase${unchecked > 1 ? 's' : ''} nobody checked` : 'Every phase is verified', prompt: '', why: unchecked ? 'Those phases rest on the agent’s word only. Add a check or look at them yourself.' : 'Every check passes on the current code.', agent: null, startable: false, needsApproval: false, scope: 'Nothing to run.' });
  }
  return out;
}
