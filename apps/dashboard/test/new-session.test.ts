import { describe, expect, it } from 'vitest';
import { forgetKey, keyFor, markUnsure, pendingUnsure, pollStatus, signatureOf, statusAdvice, type KeyStore, type SessionStatus } from '../src/new-session';

const mem = (): KeyStore & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const req = { cid: 'c1', project: 'default', agent: 'claude-code', model: 'haiku', policy: 'standard', prompt: 'hello' };
const KEY = /^[A-Za-z0-9_-]{22,64}$/;

describe('phone new-session key', () => {
  it('stays the same for a resend even when the browser will not store it (a resend must never get a second key)', () => {
    const blocked: KeyStore = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
    const a = keyFor(blocked, signatureOf(req)); expect(keyFor(blocked, signatureOf(req))).toBe(a);
    expect(keyFor(blocked, signatureOf({ ...req, prompt: 'changed' }))).not.toBe(a);
    forgetKey(blocked); expect(keyFor(blocked, signatureOf(req))).not.toBe(a);
  });
  it('is a valid key and is the same for a retry of the same request', () => {
    const s = mem(); const a = keyFor(s, signatureOf(req)); const b = keyFor(s, signatureOf({ ...req }));
    expect(a).toMatch(KEY); expect(b).toBe(a);
  });
  it('changes whenever any part of the request changes (one key never covers two requests)', () => {
    const s = mem(); const a = keyFor(s, signatureOf(req));
    for (const ch of [{ prompt: 'hello!' }, { project: 'a'.repeat(24) }, { agent: 'codex' }, { model: 'sonnet' }, { policy: 'read-only' }, { cid: 'c2' }]) {
      const k = keyFor(s, signatureOf({ ...req, ...ch })); expect(k).not.toBe(a); expect(k).toMatch(KEY);
    }
  });
  it('is forgotten after a definite answer, so the next identical request is a new one', () => {
    const s = mem(); const a = keyFor(s, signatureOf(req)); forgetKey(s); expect(keyFor(s, signatureOf(req))).not.toBe(a);
  });
  it('survives a damaged or blocked store', () => {
    const bad: KeyStore = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
    expect(keyFor(bad, 's')).toMatch(KEY); expect(() => forgetKey(bad)).not.toThrow();
  });
  it('generates unguessable distinct keys', () => { const s = () => keyFor(mem(), 'x'); expect(new Set(Array.from({ length: 50 }, s)).size).toBe(50); });
});

describe('recovering after no answer', () => {
  const S = (state: SessionStatus['state']): SessionStatus => (state === 'started' ? { state, sessionId: 'ses_aaaaaaaaaaaa', project: { id: 'p', name: 'P' } } : { state } as SessionStatus);
  const noSleep = async () => {};

  it('the unsure mark survives a reload (same store, new page) and is tied to the computer', () => {
    const s = mem(); const k = keyFor(s, signatureOf(req));
    expect(pendingUnsure(s, 'c1')).toBeNull();
    markUnsure(s, 'c1');
    expect(pendingUnsure(s, 'c1')).toBe(k);
    expect(pendingUnsure(s, 'c2')).toBeNull();
    expect(keyFor(s, signatureOf(req))).toBe(k); // still the same key for the same request
  });
  it('is cleared only by a definite answer (forgetKey)', () => {
    const s = mem(); keyFor(s, signatureOf(req)); markUnsure(s, 'c1'); forgetKey(s);
    expect(pendingUnsure(s, 'c1')).toBeNull();
  });
  it('polls at most five times with growing pauses, and stops at started', async () => {
    const pauses: number[] = []; let n = 0;
    const r = await pollStatus(async () => { n++; return S('starting-indeterminate'); }, async (ms) => void pauses.push(ms));
    expect(n).toBe(5); expect(r?.state).toBe('starting-indeterminate'); expect(pauses).toEqual([1500, 3000, 6000, 12000]);
    n = 0;
    const r2 = await pollStatus(async () => { n++; return n < 3 ? S('unknown-request') : S('started'); }, noSleep);
    expect(n).toBe(3); expect(r2?.state).toBe('started');
  });
  it('a failed ask is not an answer: it keeps trying, and returns null if nothing ever answered', async () => {
    let n = 0;
    expect(await pollStatus(async () => { n++; throw new Error('offline'); }, noSleep)).toBeNull(); expect(n).toBe(5);
    n = 0;
    expect((await pollStatus(async () => { if (++n < 2) throw new Error('x'); return S('refused-before-start'); }, noSleep))?.state).toBe('refused-before-start');
  });
  it('stops when the screen is gone', async () => {
    let n = 0; let gone = false;
    await pollStatus(async () => { n++; gone = true; return S('unknown-request'); }, noSleep, undefined, () => gone);
    expect(n).toBe(1);
  });
  it('offers resending only when it is safe: nothing started, never when the computer may have started it', () => {
    expect(statusAdvice(S('started'))).toEqual({ definite: true, canResend: false });
    expect(statusAdvice(S('refused-before-start'))).toEqual({ definite: true, canResend: true });
    expect(statusAdvice(S('unknown-request'))).toEqual({ definite: false, canResend: true });
    expect(statusAdvice(S('starting-indeterminate'))).toEqual({ definite: false, canResend: false });
    expect(statusAdvice(null)).toEqual({ definite: false, canResend: false });
  });
});
