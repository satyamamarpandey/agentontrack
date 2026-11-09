/**
 * Subscription first. An agent started by AgentOnTrack uses the sign-in the person already made with that agent's own CLI.
 * AgentOnTrack never reads, copies or relays that sign-in. The one thing it does control is the environment it hands the agent:
 * many agents switch to metered API billing when an API key is present, so those variables are removed unless the person has
 * turned on paid API mode for this companion.
 */
export const API_KEY_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
] as const;

export type AuthMode = 'subscription' | 'api-key' | 'unknown';

/** The environment for a child agent. Without `allowPaidApi`, every variable that could switch it to metered billing is dropped. */
export function agentEnv(env: NodeJS.ProcessEnv, allowPaidApi = false): NodeJS.ProcessEnv {
  if (allowPaidApi) return { ...env };
  const out: NodeJS.ProcessEnv = {};
  const drop = new Set<string>(API_KEY_VARS);
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase())) out[k] = v;
  return out;
}

/** Names only, never values. */
export function apiKeyVarsPresent(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>(API_KEY_VARS);
  return Object.keys(env).filter((k) => names.has(k.toUpperCase()) && !!env[k]).map((k) => k.toUpperCase());
}

/** What `claude auth status` calls its method: `claude.ai` is a Claude subscription; anything naming an API key or a cloud provider is metered. */
export function classifyClaudeMethod(method: string | null | undefined): AuthMode {
  if (!method) return 'unknown';
  const m = method.toLowerCase();
  if (/api|key|bedrock|vertex|foundry|token/.test(m)) return 'api-key';
  if (/claude\.ai|claude|oauth|subscription|max|pro/.test(m)) return 'subscription';
  return 'unknown';
}

/** Codex's own login status text. Wording 'Logged in using ChatGPT' was seen on a real login (codex-cli 0.167.0-alpha.3, 2026-11-07); the API-key wording is from documentation only. Anything unrecognised is `unknown`. */
export function classifyCodexStatus(text: string | null | undefined): AuthMode {
  if (!text) return 'unknown';
  if (/api[ -]?key/i.test(text)) return 'api-key';
  if (/chatgpt/i.test(text)) return 'subscription';
  return 'unknown';
}

/** Whether a run may start. Unknown is allowed (the environment is already cleaned); a known metered sign-in is not, without the person's opt-in. */
export function mayStartUnder(mode: AuthMode, allowPaidApi: boolean): { ok: true } | { ok: false; reason: string } {
  if (mode === 'api-key' && !allowPaidApi) return { ok: false, reason: 'This agent is signed in with an API key or a cloud account, which bills by use. Sign in with your subscription (the agent’s own login command), or turn on paid API mode for this companion.' };
  return { ok: true };
}
