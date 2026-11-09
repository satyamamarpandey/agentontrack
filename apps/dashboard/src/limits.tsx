// Per-run limits. A time limit works for every agent. A dollar cap is shown only for an agent signed in with its own API key while paid API mode is on:
// a subscription sign-in has no dollar figure, so none is invented for it.
export interface RunLimits { minutes: number; usd: number }
export const DEFAULT_LIMITS: RunLimits = { minutes: 30, usd: 0.25 };

/** The fields to send with a start request. The dollar cap is sent only when the companion says it applies. */
export const limitsBody = (l: RunLimits, dollarCap: boolean): { maxMinutes: number; maxBudgetUsd?: number } => ({ maxMinutes: l.minutes, ...(dollarCap ? { maxBudgetUsd: l.usd } : {}) });

export function LimitFields({ value, onChange, dollarCap, name, usdLabel = 'Budget cap (USD)', width = 100 }: { value: RunLimits; onChange: (l: RunLimits) => void; dollarCap: boolean; name: string; usdLabel?: string; width?: number }) {
  return (
    <>
      <label>Time limit (minutes)<input type="number" min={1} max={240} step={1} value={value.minutes} onChange={(e) => onChange({ ...value, minutes: Math.max(1, Math.min(240, Math.round(Number(e.target.value)) || 1)) })} name={`${name}-minutes`} style={{ width }} data-testid="limit-minutes" /></label>
      {dollarCap ? <label>{usdLabel}<input type="number" min={0.01} max={5} step={0.01} value={value.usd} onChange={(e) => onChange({ ...value, usd: Number(e.target.value) })} name={`${name}-budget`} style={{ width }} data-testid="limit-usd" /></label> : null}
    </>
  );
}
