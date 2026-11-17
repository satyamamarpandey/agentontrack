/**
 * Which models may bill beyond the subscription. This is a conservative local rule, not a provider fact: a model whose name matches a
 * credit-bearing family is treated as able to charge usage credits, and is blocked unless the person consents for that run.
 * A name that matches nothing is `unknown` and is allowed, because the run's real model is recorded and checked afterwards.
 */
export type Billing = 'included' | 'may-use-credits' | 'unknown';

const CREDIT_FAMILIES: RegExp[] = [/(^|[-_.])fable([-_.]|$)/i];
const INCLUDED_FAMILIES: RegExp[] = [/(^|[-_.])(haiku|sonnet|opus)([-_.]|$)/i];

export function classifyModelBilling(runtime: string, model: string | null | undefined): Billing {
  const m = (model ?? '').trim();
  if (!m || runtime !== 'claude-code') return 'unknown';
  if (CREDIT_FAMILIES.some((r) => r.test(m))) return 'may-use-credits';
  if (INCLUDED_FAMILIES.some((r) => r.test(m))) return 'included';
  return 'unknown';
}

export interface CreditGuardInput { runtime: string; model: string; /** Every dashboard and companion start is non-interactive. */ interactive: boolean; acceptUsageCredits: boolean }

/** A credit-bearing model never starts without the person's consent for this run, and never in a non-interactive start by default. */
export function creditGuard(i: CreditGuardInput): { ok: true; billing: Billing } | { ok: false; billing: Billing; reason: string } {
  const billing = classifyModelBilling(i.runtime, i.model);
  if (billing !== 'may-use-credits' || i.acceptUsageCredits) return { ok: true, billing };
  return {
    ok: false, billing,
    reason: `${i.model} may charge usage credits on top of your subscription${i.interactive ? '' : ', and this run starts without anyone at the keyboard to confirm it'}. Choose Sonnet, Opus or Haiku, or tick "I accept usage credits for this run" to proceed.`,
  };
}
