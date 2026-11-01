export const WORKFLOWS = ['goal', 'plan', 'inspect', 'implement', 'debug', 'verify', 'repair', 'review', 'continue', 'handoff', 'pause', 'resume', 'approve', 'compare', 'benchmark', 'release-check'] as const;
export type Workflow = (typeof WORKFLOWS)[number];

const RULES: [RegExp, Workflow][] = [
  [/\b(approv\w*|permission to)\b/i, 'approve'],
  [/\b(hand ?off|pass (it|this) to|switch to (codex|claude|hermes))\b/i, 'handoff'],
  [/\b(release|ship it|publish|prepare a release)\b/i, 'release-check'],
  [/\b(verify|check everything|is it done|confirm)\b/i, 'verify'],
  [/\b(repair|failing tests?|fix the tests?|tests? (are|is) failing)\b/i, 'repair'],
  [/\b(fix|bug|crash|error|broken|debug)\b/i, 'debug'],
  [/\b(continue|carry on|pick up|where (was|were) (i|we))\b/i, 'continue'],
  [/\b(resume)\b/i, 'resume'],
  [/\b(pause|hold on|stop for now)\b/i, 'pause'],
  [/\b(benchmark|measure performance|improve performance)\b/i, 'benchmark'],
  [/\b(compare|versus|\bvs\b)\b/i, 'compare'],
  [/\b(review|audit|security)\b/i, 'review'],
  [/\b(plan|design|approach)\b/i, 'plan'],
  [/\b(explain|inspect|look at|what does|how does)\b/i, 'inspect'],
  [/\b(goal|objective|do not touch|don't touch|scope)\b/i, 'goal'],
  [/\b(build|add|implement|create|feature|write)\b/i, 'implement'],
];

const NATIVE: Partial<Record<string, Partial<Record<Workflow, string>>>> = {
  agentontrack: { goal: 'agentontrack goal set --file goal.json', verify: 'agentontrack verify', approve: 'agentontrack approvals', handoff: 'MCP tool handoff.prepare', continue: 'agentontrack status', 'release-check': 'agentontrack doctor, then agentontrack verify' },
  'claude-code': { continue: 'claude --continue', resume: 'claude --resume', plan: 'claude --permission-mode plan' },
};

/**
 * Keyword routing, deterministic and explainable. It suggests; it does not act. A command appears only if that
 * surface is known to have it, so a workflow with no native command says so instead of inventing one.
 */
export function routeIntent(text: string, runtime = 'claude-code'): { workflow: Workflow | null; matched: string | null; agentontrack: string | null; native: string | null; note: string } {
  for (const [re, workflow] of RULES) {
    const m = re.exec(text);
    if (m) {
      const native = NATIVE[runtime]?.[workflow] ?? null;
      return { workflow, matched: m[0], agentontrack: NATIVE.agentontrack?.[workflow] ?? null, native, note: native || NATIVE.agentontrack?.[workflow] ? 'Suggestion only.' : 'No dedicated command: describe this to your agent directly.' };
    }
  }
  return { workflow: null, matched: null, agentontrack: null, native: null, note: 'No confident match: describe the task to your agent directly.' };
}
