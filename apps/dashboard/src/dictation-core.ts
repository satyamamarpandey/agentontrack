// Voice dictation core: browser Web Speech API only. No server calls, no paid speech API.
// Pure logic (no DOM access except through the injected env) so it is testable in node.
// Dictation never sends anything: it only hands text to the caller, who keeps an editable field.

export type DictationState = 'idle' | 'requesting' | 'listening' | 'error' | 'unsupported';

export type DictationErrorKind =
  | 'permission-denied' | 'service-not-allowed' | 'no-microphone' | 'no-speech'
  | 'network' | 'aborted' | 'unknown';

export interface DictationError { kind: DictationErrorKind; code: string; message: string; retryable: boolean }

const ERRORS: Record<string, Omit<DictationError, 'code'>> = {
  'not-allowed': { kind: 'permission-denied', message: 'Microphone permission was denied. Allow microphone access for this site in your browser settings, then try again.', retryable: true },
  'service-not-allowed': { kind: 'service-not-allowed', message: "Your browser's speech service is not available here (it may be disabled by policy or settings). Use your keyboard's or operating system's dictation instead.", retryable: false },
  'audio-capture': { kind: 'no-microphone', message: 'No microphone was found. Connect one and try again.', retryable: true },
  'no-speech': { kind: 'no-speech', message: 'No speech was heard. Try again and speak after the microphone starts.', retryable: true },
  network: { kind: 'network', message: "Could not reach your browser's speech service. Check your connection and try again.", retryable: true },
  aborted: { kind: 'aborted', message: 'Dictation was stopped.', retryable: true },
};

export function mapDictationError(code: string | undefined | null): DictationError {
  const c = typeof code === 'string' && code ? code : 'unknown';
  const hit = Object.prototype.hasOwnProperty.call(ERRORS, c) ? ERRORS[c] : undefined;
  return hit ? { ...hit, code: c } : { kind: 'unknown', code: c, message: 'Dictation failed for an unknown reason. You can try again or type instead.', retryable: true };
}

export const AUDIO_ATTACHMENT = {
  supported: false as const,
  reason: 'Raw audio attachments are not supported. Dictation converts speech to text in your browser; no audio file is stored or sent by this app. Audio upload needs encrypted relay storage that does not exist yet.',
};

export const UNSUPPORTED_FALLBACK = "Voice dictation is not available in this browser. Use your keyboard's or operating system's dictation instead.";

export const CONSENT_NOTICE =
  "Dictation uses your browser's built-in speech recognition. In Chrome, Edge and Safari the browser sends your microphone audio to the browser vendor's speech service to turn it into text. This app does not receive or store the audio. Text only enters the box after you dictate, and nothing is sent until you press send yourself.";

export const CONSENT_KEY = 'aot.dictation.consent.v1';

// Minimal shapes of the Web Speech API we rely on.
export interface SpeechAlternativeLike { transcript: string }
export interface SpeechResultLike { isFinal: boolean; 0?: SpeechAlternativeLike; length?: number }
export interface SpeechResultEventLike { resultIndex: number; results: { length: number; [i: number]: SpeechResultLike } }
export interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onstart: (() => void) | null; onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  start(): void; stop(): void; abort(): void;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface DictationEnv {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  isSecureContext?: boolean;
}
export interface DictationStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export interface Support { supported: boolean; reason?: 'no-api' | 'insecure-context'; message?: string }

export function detectSupport(env: DictationEnv): Support {
  const ctor = env.SpeechRecognition ?? env.webkitSpeechRecognition;
  if (!ctor) return { supported: false, reason: 'no-api', message: UNSUPPORTED_FALLBACK };
  if (env.isSecureContext !== true) return { supported: false, reason: 'insecure-context', message: "Dictation needs a secure (HTTPS) page. Use your keyboard's or operating system's dictation instead." };
  return { supported: true };
}

export interface DictationSnapshot {
  state: DictationState;
  interim: string;            // live, uncommitted words (display only, never inserted)
  error: DictationError | null;
  consentRequired: boolean;
  message: string;            // plain-language status for a live region
}

export type StartResult = 'started' | 'needs-consent' | 'unsupported' | 'busy' | 'failed';

export interface DictationOptions {
  env: DictationEnv;
  storage?: DictationStorage | null;
  lang?: string;
  onText: (finalText: string) => void;
}

const MSG: Record<DictationState, string> = {
  idle: 'Dictation is off.', requesting: 'Waiting for microphone permission.', listening: 'Listening. Speak now.', error: '', unsupported: UNSUPPORTED_FALLBACK,
};

export class DictationController {
  private rec: SpeechRecognitionLike | null = null;
  private state: DictationState;
  private interim = '';
  private error: DictationError | null = null;
  private support: Support;
  private subs = new Set<() => void>();
  private snap: DictationSnapshot;

  constructor(private opts: DictationOptions) {
    this.support = detectSupport(opts.env);
    this.state = this.support.supported ? 'idle' : 'unsupported';
    this.snap = this.build();
  }

  private pageConsent = false; // when storage is blocked, an accepted notice still holds until the page is closed
  hasConsent(): boolean {
    if (this.pageConsent) return true;
    try { return this.opts.storage?.getItem(CONSENT_KEY) === 'accepted'; } catch { return false; }
  }
  acceptConsent(): StartResult {
    this.pageConsent = true;
    try { this.opts.storage?.setItem(CONSENT_KEY, 'accepted'); } catch { /* storage blocked: consent not remembered */ }
    this.emit();
    return this.start();
  }
  declineConsent(): void {
    this.pageConsent = false;
    try { this.opts.storage?.removeItem(CONSENT_KEY); } catch { /* ignore */ }
    this.emit();
  }
  revokeConsent(): void { this.declineConsent(); this.cancel(); }

  getSnapshot = (): DictationSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };

  start(): StartResult {
    if (!this.support.supported) { this.state = 'unsupported'; this.emit(); return 'unsupported'; }
    if (this.state === 'requesting' || this.state === 'listening') return 'busy';
    if (!this.hasConsent()) { this.emit(); return 'needs-consent'; }
    const Ctor = (this.opts.env.SpeechRecognition ?? this.opts.env.webkitSpeechRecognition) as SpeechRecognitionCtor;
    let rec: SpeechRecognitionLike;
    try {
      rec = new Ctor();
      rec.lang = this.opts.lang ?? 'en-US'; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
    } catch { return this.fail(mapDictationError('unknown')); }
    this.rec = rec; this.error = null; this.interim = ''; this.state = 'requesting';
    rec.onstart = () => { if (this.rec === rec) { this.state = 'listening'; this.emit(); } };
    rec.onresult = (e) => { if (this.rec === rec) this.handleResult(e); };
    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      const err = mapDictationError(e?.error);
      this.rec = null; this.interim = ''; this.fail(err);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null; this.interim = '';
      if (this.state !== 'error') this.state = 'idle';
      this.emit();
    };
    this.emit();
    try { rec.start(); } catch { this.rec = null; return this.fail(mapDictationError('unknown')); }
    return 'started';
  }

  /** Finish: lets the engine deliver any final result, then ends. */
  stop(): void { if (this.rec) { try { this.rec.stop(); } catch { /* ignore */ } } }

  /** Cancel: discards interim text and ignores anything the engine delivers later. */
  cancel(): void {
    const r = this.rec; this.rec = null; this.interim = '';
    if (r) { r.onresult = null; r.onerror = null; r.onend = null; r.onstart = null; try { r.abort(); } catch { /* ignore */ } }
    if (this.state !== 'unsupported') { this.state = 'idle'; this.error = null; }
    this.emit();
  }

  retry(): StartResult { if (this.state === 'error') { this.state = 'idle'; this.error = null; } return this.start(); }

  private handleResult(e: SpeechResultEventLike) {
    let fin = ''; let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]; const t = r?.[0]?.transcript ?? '';
      if (r?.isFinal) fin += t; else interim += t;
    }
    this.interim = interim.trim();
    const text = fin.trim();
    if (text) this.opts.onText(text);
    this.emit();
  }

  private fail(err: DictationError): StartResult {
    this.error = err; this.state = 'error'; this.emit(); return 'failed';
  }

  private build(): DictationSnapshot {
    const message = this.state === 'error' ? (this.error?.message ?? '') : this.state === 'unsupported' ? (this.support.message ?? UNSUPPORTED_FALLBACK) : MSG[this.state];
    return { state: this.state, interim: this.interim, error: this.error, consentRequired: this.support.supported && !this.hasConsent(), message };
  }
  private emit() { this.snap = this.build(); for (const f of this.subs) f(); }
}

export function browserEnv(): DictationEnv {
  const w = (typeof window !== 'undefined' ? window : {}) as unknown as DictationEnv;
  return { SpeechRecognition: w.SpeechRecognition, webkitSpeechRecognition: w.webkitSpeechRecognition, isSecureContext: w.isSecureContext };
}
export function browserStorage(): DictationStorage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
