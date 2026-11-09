/** Phone "New session": the retry-safety key. A key is bound to the exact request it was made for; changing anything makes a NEW key, because the computer refuses one key used for two different requests. */
export interface KeyStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const SLOT = 'aot.newSession.pending';
/** If the browser will not keep the slot (private mode, full), this copy for the life of the page still keeps the key stable, so a resend cannot get a second key. */
const shadow = new WeakMap<object, string>();
const get = (store: KeyStore): string | null => { let v: string | null = null; try { v = store.getItem(SLOT); } catch { /* blocked */ } return v ?? shadow.get(store) ?? null; };
const put = (store: KeyStore, v: string): void => { shadow.set(store, v); try { store.setItem(SLOT, v); } catch { /* blocked or full: the copy above is used */ } };
const newKey = (): string => { const b = new Uint8Array(18); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const signatureOf = (r: { cid: string; project: string; agent: string; model: string; policy: string; prompt: string }): string => JSON.stringify([r.cid, r.project, r.agent, r.model, r.policy, r.prompt]);
/** The same request gets the same key every time (so a retry after a lost answer is deduplicated by the computer); a different request gets a fresh one. */
export function keyFor(store: KeyStore, sig: string): string {
  try { const cur = JSON.parse(get(store) ?? 'null') as { sig: string; key: string } | null; if (cur && cur.sig === sig && typeof cur.key === 'string') return cur.key; } catch { /* damaged: make a new one */ }
  const key = newKey(); try { put(store, JSON.stringify({ sig, key })); } catch { /* storage full or blocked: the key still works for this attempt */ }
  return key;
}
/** Called once the computer has answered definitively (started, or refused before starting). Never called on a timeout: that attempt may have started something. */
export const forgetKey = (store: KeyStore): void => { shadow.delete(store); try { store.removeItem(SLOT); } catch { /* nothing to do */ } };

/* ---------- When no answer came back: ask the computer what became of the request ---------- */

/** The pending request is marked "unsure" in the same slot, so a reload (or closing the page) still knows to ask. Cleared only by forgetKey, which is called only on a definite answer. */
export const markUnsure = (store: KeyStore, cid: string): void => {
  try { const cur = JSON.parse(get(store) ?? 'null') as { sig: string; key: string } | null; if (cur && typeof cur.key === 'string') put(store, JSON.stringify({ ...cur, cid, unsure: true })); } catch { /* storage blocked: this page still holds the key in memory */ }
};
/** The key of an earlier attempt on this computer that never got an answer, or null. */
export const pendingUnsure = (store: KeyStore, cid: string): string | null => {
  try { const cur = JSON.parse(get(store) ?? 'null') as { key?: string; cid?: string; unsure?: boolean } | null; return cur && cur.unsure && cur.cid === cid && typeof cur.key === 'string' ? cur.key : null; } catch { return null; }
};

export type SessionStatus =
  | { state: 'started'; sessionId: string; project: { id: string; name: string }; runId?: string }
  | { state: 'refused-before-start'; code?: string; note?: string }
  | { state: 'unknown-request'; note?: string }
  | { state: 'starting-indeterminate'; note?: string };
/** What the person sees, and what is safe to offer. Resending the same key is safe when the computer started nothing; when it may have, it would only be told "in doubt", so it is not offered. */
export const statusAdvice = (s: SessionStatus | null): { definite: boolean; canResend: boolean } =>
  !s ? { definite: false, canResend: false }
    : s.state === 'started' || s.state === 'refused-before-start' ? { definite: true, canResend: s.state === 'refused-before-start' }
      : s.state === 'unknown-request' ? { definite: false, canResend: true }
        : { definite: false, canResend: false };

export const POLL_DELAYS_MS = [0, 1500, 3000, 6000, 12000] as const;
/** Asks up to five times with growing pauses, stopping at the first answer that settles it (started or refused). A failed ask is not an answer. Returns the last status seen, or null if none could be had. */
export async function pollStatus(ask: () => Promise<SessionStatus>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), delays: readonly number[] = POLL_DELAYS_MS, stop: () => boolean = () => false): Promise<SessionStatus | null> {
  let last: SessionStatus | null = null;
  for (const d of delays) {
    if (stop()) return last;
    if (d) await sleep(d);
    if (stop()) return last;
    try { last = await ask(); } catch { continue; }
    if (last.state === 'started' || last.state === 'refused-before-start') return last;
  }
  return last;
}
