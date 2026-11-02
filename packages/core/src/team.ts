import { z } from 'zod/v4';

/**
 * Roles for the agents on a project, and the plans they make. Pure functions: nothing here starts an agent. Starting is runtime
 * specific, and each runtime's own interface decides whether it can be done at all.
 */

export const ROLES = ['implement', 'review', 'debug', 'test', 'research', 'analyze', 'classify', 'verify'] as const;
export type Role = (typeof ROLES)[number];

export const TeamMemberSchema = z.object({
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/, 'Use a short lower-case agent id such as claude-code'),
  role: z.enum(ROLES),
  budgetTokens: z.number().int().positive().max(50_000_000).optional(),
  budgetUsd: z.number().positive().max(10_000).optional(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamSchema = z.array(TeamMemberSchema).max(12).superRefine((members, ctx) => {
  const seen = new Set<string>();
  members.forEach((m, i) => {
    const k = `${m.agent}|${m.role}`;
    if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `${m.agent} is already ${m.role}`, path: [i] });
    seen.add(k);
  });
});

export type WorkflowKind = 'implement-review-verify' | 'parallel-then-compare' | 'review-only' | 'spec-review';

export interface Stage {
  id: string;
  role: Role;
  /** An agent id, or `checks` for the independent verification the engine runs itself. */
  agent: string;
  dependsOn: string[];
  isolated: boolean;
  note?: string;
}

export interface Plan { kind: WorkflowKind; stages: Stage[]; problems: string[]; warnings: string[] }

const byRole = (team: TeamMember[], role: Role) => team.filter((m) => m.role === role);

/** What would run, in what order, and what is missing. A plan with problems is not started. */
export function planWorkflow(team: TeamMember[], kind: WorkflowKind): Plan {
  const stages: Stage[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const need = (role: Role) => { const m = byRole(team, role); if (!m.length) problems.push(`No agent has the ${role} role.`); return m; };

  if (kind === 'implement-review-verify') {
    const impl = need('implement')[0];
    const rev = need('review')[0];
    if (impl) stages.push({ id: 'implement', role: 'implement', agent: impl.agent, dependsOn: [], isolated: true });
    if (rev) {
      stages.push({ id: 'review', role: 'review', agent: rev.agent, dependsOn: ['implement'], isolated: false, note: 'Reads the implementer\'s branch. Its findings are evidence only if a person accepts them.' });
      if (impl && rev.agent === impl.agent) warnings.push(`${impl.agent} both implements and reviews, so the review is not independent.`);
    }
    stages.push({ id: 'verify', role: 'verify', agent: 'checks', dependsOn: rev ? ['review'] : ['implement'], isolated: false, note: 'The acceptance criteria, run by AgentOnTrack itself.' });
  } else if (kind === 'parallel-then-compare') {
    const impls = need('implement');
    if (impls.length < 2) problems.push('Parallel work needs at least two agents with the implement role.');
    impls.forEach((m) => stages.push({ id: `implement-${m.agent}`, role: 'implement', agent: m.agent, dependsOn: [], isolated: true, note: 'Its own worktree and branch.' }));
    stages.push({ id: 'compare', role: 'verify', agent: 'checks', dependsOn: impls.map((m) => `implement-${m.agent}`), isolated: false, note: 'Overlap and merge preview from git, and each branch\'s test results side by side.' });
    stages.push({ id: 'decide', role: 'review', agent: 'person', dependsOn: ['compare'], isolated: false, note: 'A person accepts one result, merges both, or asks for another review.' });
    if (new Set(impls.map((m) => m.agent)).size !== impls.length) warnings.push('The same agent appears twice, so the results are not independent.');
  } else if (kind === 'spec-review') {
    // The drafter keeps the project's context. Reviewers start fresh, with only the document and the files it names, so a gap in the
    // document shows up as a wrong answer instead of being filled in from memory. The idea is the Elephant-Goldfish pattern for design review.
    const drafter = (byRole(team, 'analyze')[0] ?? byRole(team, 'research')[0]);
    if (!drafter) problems.push('No agent has the analyze role, to draft the specification.');
    const reviewers = need('review');
    if (drafter) stages.push({ id: 'draft', role: 'analyze', agent: drafter.agent, dependsOn: [], isolated: false, note: 'Writes the specification with the problem, plan, alternatives, exact files, data structures and signatures. Keeps the project context.' });
    stages.push({ id: 'structure-check', role: 'verify', agent: 'checks', dependsOn: drafter ? ['draft'] : [], isolated: false, note: 'AgentOnTrack checks that paths, data structures and signatures are written down. It does not judge the design.' });
    if (reviewers.length) {
      stages.push({ id: 'explain-back', role: 'review', agent: reviewers[0]!.agent, dependsOn: ['structure-check'], isolated: true, note: 'A fresh session reads only the document and explains the design back. A wrong explanation means the document is ambiguous: redraft.' });
      const attackers = [0, 1, 2].map((i) => reviewers[i % reviewers.length]!);
      attackers.forEach((m, i) => stages.push({ id: `attack-${i + 1}`, role: 'review', agent: m.agent, dependsOn: ['explain-back'], isolated: true, note: 'A fresh session hunts for edge cases, hidden dependencies and logic gaps.' }));
      stages.push({ id: 'go-no-go', role: 'review', agent: reviewers.at(-1)!.agent, dependsOn: attackers.map((_, i) => `attack-${i + 1}`), isolated: true, note: 'A fresh session advises go or no-go. This is an opinion, not evidence.' });
      stages.push({ id: 'approve', role: 'review', agent: 'person', dependsOn: ['go-no-go'], isolated: false, note: 'A person approves the specification, and with it the goal and task. Nothing is implemented before that.' });
      if (new Set(reviewers.map((m) => m.agent)).size < 2) warnings.push("Every reviewer is the same agent. Each starts a fresh session, but one model's blind spots repeat. Use a different agent for the final call if you can.");
      if (drafter && reviewers.some((m) => m.agent === drafter.agent)) warnings.push(`${drafter.agent} drafts and also reviews. Fresh sessions help, but the review is less independent.`);
    }
  } else {
    const rev = need('review')[0];
    if (rev) stages.push({ id: 'review', role: 'review', agent: rev.agent, dependsOn: [], isolated: false });
    stages.push({ id: 'verify', role: 'verify', agent: 'checks', dependsOn: rev ? ['review'] : [], isolated: false });
  }
  for (const m of team) if (m.role === 'research') warnings.push(`${m.agent} researches. A research answer is information, and counts as no evidence that work is done.`);
  return { kind, stages, problems, warnings };
}

/** The order stages may run in. A stage whose dependencies are not all done waits. */
export function readyStages(plan: Plan, done: Set<string>): Stage[] {
  return plan.stages.filter((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
}
