import { describe, expect, it } from 'vitest';
import { agentEnv, apiKeyVarsPresent, classifyClaudeMethod, classifyCodexStatus, mayStartUnder } from '../src/index.js';

describe('subscription first', () => {
  const env = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-x', openai_api_key: 'sk-y', CODEX_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1' };
  it('removes every variable that could switch an agent to metered billing, whatever its case', () => {
    expect(agentEnv(env)).toEqual({ PATH: '/bin', HOME: '/h' });
  });
  it('keeps them only when paid API mode is on, and never mutates the input', () => {
    expect(agentEnv(env, true)).toEqual(env);
    agentEnv(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
  });
  it('lists names but never values', () => {
    const names = apiKeyVarsPresent(env);
    expect(names.sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_API_KEY', 'OPENAI_API_KEY']);
    expect(JSON.stringify(names)).not.toMatch(/sk-/);
  });
  it('classifies sign-in methods, and calls anything unrecognised unknown', () => {
    expect(classifyClaudeMethod('claude.ai')).toBe('subscription');
    expect(classifyClaudeMethod('api_key')).toBe('api-key');
    expect(classifyClaudeMethod('bedrock')).toBe('api-key');
    expect(classifyClaudeMethod(null)).toBe('unknown');
    expect(classifyClaudeMethod('zzz')).toBe('unknown');
    expect(classifyCodexStatus('Logged in using ChatGPT')).toBe('subscription');
    expect(classifyCodexStatus('Logged in using an API key')).toBe('api-key');
    expect(classifyCodexStatus('')).toBe('unknown');
  });
  it('refuses a metered sign-in unless the person opted in', () => {
    expect(mayStartUnder('api-key', false).ok).toBe(false);
    expect(mayStartUnder('api-key', true).ok).toBe(true);
    expect(mayStartUnder('subscription', false).ok).toBe(true);
  });
});
