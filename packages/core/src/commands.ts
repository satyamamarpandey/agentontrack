/**
 * Choosing how to run a piece of work: with a command the agent itself reports, or with a bounded loop AgentOnTrack runs.
 * This module decides and refuses. It never invents a command: a slash command may be sent only if the runtime reported it.
 */
export type Intent = 'goal' | 'plan' | 'loop' | 'review' | 'none';

const PATTERNS: [Intent, RegExp][] = [
  ['review', /\b(review|audit|look over|double[- ]check|critique)\b/i],
  ['loop', /\b(keep (going|trying)|until (it |they |all )?(pass|work|green|done)|repeat|retry|iterate|loop|each of|every (file|test|page))\b/i],
  ['plan', /\b(plan|break (this )?down|phases?|roadmap|outline the steps|how should we)\b/i],
  ['goal', /\b(build|implement|add|create|fix|make|migrate|refactor|ship|finish|complete)\b/i],
];

export function detectIntent(text: string): Intent {
  const t = text.trim();
  if (!t) return 'none';
  for (const [intent, re] of PATTERNS) if (re.test(t)) return intent;
  return 'none';
}

/** The command a prompt starts with, if it starts with a slash. */
export function leadingCommand(prompt: string): string | null {
  const m = /^\s*\/([\w:.-]{1,60})(?:\s|$)/.exec(prompt);
  return m ? m[1]! : null;
}

export class CommandRefused extends Error {}

/**
 * A prompt that begins with a slash is a command for the agent, not text. It is allowed only if this runtime reported that command.
 * With nothing reported yet (no run has started a session here) it cannot be checked, so it is refused rather than guessed.
 */
export function checkSlashCommand(prompt: string, reported: string[] | null): void {
  const cmd = leadingCommand(prompt);
  if (!cmd) return;
  if (!reported || reported.length === 0) throw new CommandRefused(`"/${cmd}" was not sent: this agent has not told AgentOnTrack which commands it supports yet, and an unsupported command is read by the agent as plain text. Start a normal run first, or write the request in words.`);
  const norm = (c: string) => c.replace(/^\//, '').toLowerCase();
  if (!reported.some((c) => norm(c) === cmd.toLowerCase())) throw new CommandRefused(`"/${cmd}" is not one of the commands this agent reported, so it was not sent. Reported: ${reported.slice(0, 12).map((c) => `/${norm(c)}`).join(', ')}${reported.length > 12 ? ', …' : ''}.`);
}

export interface Orchestration {
  intent: Intent;
  recommended: 'managed' | 'native' | 'plain';
  reason: string;
  /** A runtime command that matches, offered only if the runtime reported it. */
  native: { command: string; reportedByRuntime: true; caveat: string } | null;
  /** The bounded loop AgentOnTrack itself can run, for an agent it can start. */
  managed: { kind: 'phases' | 'repeat-until-checks-pass' | 'review-pass' | 'single'; limits: string } | null;
}

const NATIVE_FOR: Record<Exclude<Intent, 'none'>, string[]> = { goal: ['goal'], plan: ['plan'], loop: ['loop'], review: ['review', 'code-review', 'security-review'] };

export function orchestrate(text: string, opts: { agentCanStart: boolean; reportedCommands: string[] | null }): Orchestration {
  const intent = detectIntent(text);
  if (intent === 'none') return { intent, recommended: 'plain', reason: 'This reads as a single request, so it is sent as written.', native: null, managed: opts.agentCanStart ? { kind: 'single', limits: 'One run, with your per-run cost limit.' } : null };
  const hit = (opts.reportedCommands ?? []).map((c) => c.replace(/^\//, '')).find((c) => NATIVE_FOR[intent].includes(c.toLowerCase()));
  const native = hit ? { command: hit, reportedByRuntime: true as const, caveat: 'The agent runs this by its own rules. AgentOnTrack cannot enforce its turn or cost limits, only its tool permissions through hooks.' } : null;
  const kind = intent === 'loop' ? 'repeat-until-checks-pass' : intent === 'review' ? 'review-pass' : 'phases';
  const managed = opts.agentCanStart ? { kind: kind as 'phases' | 'repeat-until-checks-pass' | 'review-pass', limits: intent === 'loop' ? 'At most the number of rounds you set, stopping at the first failure, approval or cost limit. You can cancel any time.' : 'Each phase has its own run, cost and time limits, and stops for approval.' } : null;
  if (managed) return { intent, recommended: 'managed', reason: 'AgentOnTrack can start this agent, so it runs the work itself within limits you set.', native, managed };
  if (native) return { intent, recommended: 'native', reason: 'AgentOnTrack cannot start this agent, but it reported this command. Start it yourself in the agent’s own terminal.', native, managed: null };
  return { intent, recommended: 'plain', reason: 'Neither a managed loop nor a reported command is available for this agent, so the request is a prompt to copy.', native: null, managed: null };
}
