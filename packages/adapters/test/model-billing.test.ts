import { describe, expect, it } from 'vitest';
import { classifyModelBilling, creditGuard } from '../src/index.js';

describe('usage-credit guard', () => {
  it('flags the Fable family and leaves Haiku, Sonnet, Opus as included', () => {
    expect(classifyModelBilling('claude-code', 'claude-fable-5-2')).toBe('may-use-credits');
    expect(classifyModelBilling('claude-code', 'fable')).toBe('may-use-credits');
    expect(classifyModelBilling('claude-code', 'claude-sonnet-5-5')).toBe('included');
    expect(classifyModelBilling('claude-code', 'haiku')).toBe('included');
    expect(classifyModelBilling('claude-code', 'something-new')).toBe('unknown');
    expect(classifyModelBilling('codex', 'fable')).toBe('unknown');
  });
  it('blocks a credit-bearing model without consent, interactive or not', () => {
    const base = { runtime: 'claude-code', model: 'claude-fable-5-2', acceptUsageCredits: false };
    const a = creditGuard({ ...base, interactive: false });
    expect(a.ok).toBe(false);
    expect(a.ok === false && a.reason).toMatch(/without anyone at the keyboard/);
    expect(creditGuard({ ...base, interactive: true }).ok).toBe(false);
  });
  it('allows it only with explicit consent, and always allows included models', () => {
    expect(creditGuard({ runtime: 'claude-code', model: 'fable', interactive: false, acceptUsageCredits: true }).ok).toBe(true);
    expect(creditGuard({ runtime: 'claude-code', model: 'sonnet', interactive: false, acceptUsageCredits: false }).ok).toBe(true);
  });
});
