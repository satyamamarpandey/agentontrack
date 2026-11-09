import { describe, expect, it } from 'vitest';
import { AUDIO_ATTACHMENT, CONSENT_KEY, DictationController, detectSupport, mapDictationError, type DictationEnv, type DictationStorage, type SpeechRecognitionLike, type SpeechResultEventLike } from '../src/dictation-core';

class Stub implements SpeechRecognitionLike {
  static last: Stub | null = null; static throwOnStart = false;
  lang = ''; continuous = true; interimResults = false; maxAlternatives = 0;
  onstart: SpeechRecognitionLike['onstart'] = null; onend: SpeechRecognitionLike['onend'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null; onresult: SpeechRecognitionLike['onresult'] = null;
  started = 0; stopped = 0; aborted = 0;
  constructor() { Stub.last = this; }
  start() { if (Stub.throwOnStart) throw new Error('InvalidStateError'); this.started++; }
  stop() { this.stopped++; }
  abort() { this.aborted++; }
}
const res = (idx: number, items: Array<[string, boolean]>): SpeechResultEventLike =>
  ({ resultIndex: idx, results: items.map(([t, f]) => ({ isFinal: f, 0: { transcript: t } })) });
const mem = (): DictationStorage & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const okEnv: DictationEnv = { SpeechRecognition: Stub, isSecureContext: true };
const make = (env: DictationEnv = okEnv, consent = true) => {
  const storage = mem(); if (consent) storage.setItem(CONSENT_KEY, 'accepted');
  const texts: string[] = [];
  return { c: new DictationController({ env, storage, onText: (t) => texts.push(t) }), texts, storage };
};

describe('support detection', () => {
  it('supports standard and webkit-prefixed constructors in a secure context', () => {
    expect(detectSupport(okEnv).supported).toBe(true);
    expect(detectSupport({ webkitSpeechRecognition: Stub, isSecureContext: true }).supported).toBe(true);
  });
  it('is unsupported with no API (Firefox) and offers the keyboard fallback', () => {
    const s = detectSupport({ isSecureContext: true });
    expect(s).toMatchObject({ supported: false, reason: 'no-api' }); expect(s.message).toMatch(/keyboard/);
    expect(make({ isSecureContext: true }).c.getSnapshot().state).toBe('unsupported');
  });
  it('is unsupported in an insecure context', () => {
    expect(detectSupport({ SpeechRecognition: Stub, isSecureContext: false })).toMatchObject({ supported: false, reason: 'insecure-context' });
    expect(detectSupport({ SpeechRecognition: Stub })).toMatchObject({ supported: false, reason: 'insecure-context' });
  });
  it('start on an unsupported browser never constructs a recognizer', () => {
    Stub.last = null; const { c } = make({ isSecureContext: false, SpeechRecognition: Stub });
    expect(c.start()).toBe('unsupported'); expect(Stub.last).toBeNull();
  });
});

describe('error mapping', () => {
  const cases: Array<[string, string, boolean]> = [
    ['not-allowed', 'permission-denied', true], ['service-not-allowed', 'service-not-allowed', false],
    ['audio-capture', 'no-microphone', true], ['no-speech', 'no-speech', true], ['network', 'network', true],
    ['aborted', 'aborted', true], ['language-not-supported', 'unknown', true], ['', 'unknown', true],
  ];
  it.each(cases)('maps %s -> %s', (code, kind, retryable) => {
    const e = mapDictationError(code); expect(e.kind).toBe(kind); expect(e.retryable).toBe(retryable); expect(e.message.length).toBeGreaterThan(10);
  });
  it('handles undefined/null and prototype names safely', () => {
    expect(mapDictationError(undefined).kind).toBe('unknown'); expect(mapDictationError(null).kind).toBe('unknown');
    expect(mapDictationError('constructor').kind).toBe('unknown');
  });
  it('each engine error code puts the controller in error state with the plain message', () => {
    for (const [code, kind] of cases.slice(0, 6)) {
      const { c } = make(); c.start(); Stub.last!.onerror!({ error: code });
      const s = c.getSnapshot(); expect(s.state).toBe('error'); expect(s.error?.kind).toBe(kind); expect(s.message).toBe(s.error!.message);
      Stub.last!.onend?.(); expect(c.getSnapshot().state).toBe('error');
    }
  });
});

describe('lifecycle, interim and final text', () => {
  it('goes idle -> requesting -> listening -> idle', () => {
    const { c } = make(); expect(c.getSnapshot().state).toBe('idle');
    expect(c.start()).toBe('started'); expect(c.getSnapshot().state).toBe('requesting');
    expect(Stub.last).toMatchObject({ interimResults: true, continuous: false, started: 1 });
    Stub.last!.onstart!(); expect(c.getSnapshot().state).toBe('listening');
    Stub.last!.onend!(); expect(c.getSnapshot().state).toBe('idle');
  });
  it('shows interim words but only commits final ones via onText', () => {
    const { c, texts } = make(); c.start(); Stub.last!.onstart!();
    Stub.last!.onresult!(res(0, [['hel', false]]));
    expect(c.getSnapshot().interim).toBe('hel'); expect(texts).toEqual([]);
    Stub.last!.onresult!(res(0, [['hello world', true]]));
    expect(texts).toEqual(['hello world']); expect(c.getSnapshot().interim).toBe('');
  });
  it('only processes results from resultIndex so earlier finals are not repeated', () => {
    const { c, texts } = make(); c.start();
    Stub.last!.onresult!(res(1, [['old', true], ['new', true]]));
    expect(texts).toEqual(['new']);
  });
  it('ignores empty finals', () => {
    const { c, texts } = make(); c.start(); Stub.last!.onresult!(res(0, [['  ', true]])); expect(texts).toEqual([]);
  });
  it('stop() asks the engine to stop (final result may still arrive) and does not abort', () => {
    const { c, texts } = make(); c.start(); const r = Stub.last!; c.stop();
    expect(r.stopped).toBe(1); expect(r.aborted).toBe(0);
    r.onresult!(res(0, [['tail', true]])); expect(texts).toEqual(['tail']);
  });
  it('start while active is busy and does not create a second recognizer', () => {
    const { c } = make(); c.start(); const r = Stub.last; expect(c.start()).toBe('busy'); expect(Stub.last).toBe(r);
  });
  it('a recognizer that throws on start() ends in error, not stuck requesting', () => {
    const { c } = make(); Stub.throwOnStart = true;
    try { expect(c.start()).toBe('failed'); } finally { Stub.throwOnStart = false; }
    expect(c.getSnapshot().state).toBe('error');
  });
});

describe('cancel and retry', () => {
  it('cancel aborts, discards interim, and ignores late results/errors/end', () => {
    const { c, texts } = make(); c.start(); const r = Stub.last!; r.onresult!(res(0, [['partial', false]]));
    c.cancel();
    expect(r.aborted).toBe(1); expect(c.getSnapshot()).toMatchObject({ state: 'idle', interim: '', error: null });
    r.onresult?.(res(0, [['late', true]])); r.onerror?.({ error: 'network' }); r.onend?.();
    expect(texts).toEqual([]); expect(c.getSnapshot().state).toBe('idle');
  });
  it('cancel when idle is harmless; cancel does not clear unsupported', () => {
    const { c } = make(); c.cancel(); expect(c.getSnapshot().state).toBe('idle');
    const u = make({ isSecureContext: true }).c; u.cancel(); expect(u.getSnapshot().state).toBe('unsupported');
  });
  it('retry after error starts a fresh recognizer, clears the error, and ignores the old one', () => {
    const { c } = make(); c.start(); const first = Stub.last!; first.onerror!({ error: 'no-speech' }); expect(c.getSnapshot().state).toBe('error');
    expect(c.retry()).toBe('started'); expect(Stub.last).not.toBe(first);
    expect(c.getSnapshot()).toMatchObject({ state: 'requesting', error: null });
    first.onend?.(); expect(c.getSnapshot().state).toBe('requesting');
  });
  it('start() after an error also recovers', () => {
    const { c } = make(); c.start(); Stub.last!.onerror!({ error: 'network' }); Stub.last!.onend?.();
    expect(c.start()).toBe('started'); expect(c.getSnapshot().state).toBe('requesting');
  });
});

describe('consent gating', () => {
  it('does not start or construct a recognizer until consent is accepted', () => {
    Stub.last = null; const { c, storage } = make(okEnv, false);
    expect(c.getSnapshot().consentRequired).toBe(true);
    expect(c.start()).toBe('needs-consent'); expect(Stub.last).toBeNull(); expect(storage.m.size).toBe(0);
  });
  it('accept remembers consent and starts; later starts need no prompt', () => {
    const { c, storage } = make(okEnv, false);
    expect(c.acceptConsent()).toBe('started'); expect(storage.m.get(CONSENT_KEY)).toBe('accepted');
    expect(c.getSnapshot().consentRequired).toBe(false);
    c.cancel(); expect(c.start()).toBe('started');
  });
  it('decline starts nothing and leaves consent unset', () => {
    Stub.last = null; const { c, storage } = make(okEnv, false);
    c.declineConsent(); expect(Stub.last).toBeNull(); expect(storage.m.has(CONSENT_KEY)).toBe(false); expect(c.getSnapshot().consentRequired).toBe(true);
  });
  it('revoke removes consent and stops listening', () => {
    const { c } = make(); c.start(); const r = Stub.last!; c.revokeConsent();
    expect(r.aborted).toBe(1); expect(c.hasConsent()).toBe(false);
  });
  it('without usable storage consent is held for this page only, never stored, and a new page asks again', () => {
    const bad: DictationStorage = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    const c = new DictationController({ env: okEnv, storage: bad, onText: () => {} });
    expect(c.start()).toBe('needs-consent'); expect(c.acceptConsent()).toBe('started'); // accepted, and held for this page though it cannot be stored
    c.revokeConsent(); expect(c.start()).toBe('needs-consent');
    expect(new DictationController({ env: okEnv, storage: null, onText: () => {} }).start()).toBe('needs-consent');
  });
  it('a different stored value is not consent', () => {
    const storage = mem(); storage.setItem(CONSENT_KEY, 'yes');
    expect(new DictationController({ env: okEnv, storage, onText: () => {} }).hasConsent()).toBe(false);
  });
});

describe('never auto-sends / audio attachments', () => {
  it('controller exposes no send API and delivers text only via onText', () => {
    const { c } = make();
    const names = Object.keys(c).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(c)));
    expect(names.some((k) => /send|submit/i.test(k))).toBe(false);
  });
  it('audio attachments are explicitly unsupported with a reason', () => {
    expect(AUDIO_ATTACHMENT.supported).toBe(false); expect(AUDIO_ATTACHMENT.reason).toMatch(/not supported/i);
  });
  it('subscribers are notified and can unsubscribe', () => {
    const { c } = make(); let n = 0; const un = c.subscribe(() => n++); c.start(); expect(n).toBeGreaterThan(0);
    const before = n; un(); c.cancel(); expect(n).toBe(before);
  });
});
