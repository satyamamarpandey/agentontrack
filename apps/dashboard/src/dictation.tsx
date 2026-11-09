import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AUDIO_ATTACHMENT, CONSENT_NOTICE, DictationController, browserEnv, browserStorage } from './dictation-core';

export { AUDIO_ATTACHMENT };

/** Mic button. Inserts final transcript via onText; the caller's field stays editable and nothing is auto-sent. */
export function DictationButton({ onText, disabled, lang }: { onText: (t: string) => void; disabled?: boolean; lang?: string }) {
  const cb = useRef(onText); cb.current = onText;
  const ctl = useMemo(() => new DictationController({ env: browserEnv(), storage: browserStorage(), lang, onText: (t) => cb.current(t) }), [lang]);
  const s = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot);
  const [asking, setAsking] = useState(false);
  useEffect(() => () => ctl.cancel(), [ctl]);

  const active = s.state === 'requesting' || s.state === 'listening';
  const click = () => {
    if (active) { ctl.stop(); return; }
    const r = s.state === 'error' ? ctl.retry() : ctl.start();
    if (r === 'needs-consent') setAsking(true);
  };
  const label = active ? 'Stop dictation' : s.state === 'error' ? 'Retry dictation' : 'Start dictation';

  if (s.state === 'unsupported') {
    return <span className="dictation dictation-unsupported" role="status">{s.message}</span>;
  }
  return (
    <span className="dictation">
      <button type="button" className={active ? 'dictation-btn on' : 'dictation-btn'} aria-pressed={active} aria-label={label} title={label} disabled={disabled} onClick={click}>
        {active ? '● Listening' : 'Dictate'}
      </button>
      {active ? <button type="button" aria-label="Cancel dictation" onClick={() => ctl.cancel()}>Cancel</button> : null}
      {s.interim ? <span className="dictation-interim" aria-hidden="true">{s.interim}</span> : null}
      <span role="status" aria-live="polite" className={s.state === 'error' ? 'dictation-status err' : 'dictation-status'}>{s.state === 'idle' && !asking ? '' : s.message}</span>
      {asking ? (
        <span role="dialog" aria-label="Dictation privacy notice" className="dictation-consent">
          <span>{CONSENT_NOTICE}</span>
          <button type="button" onClick={() => { setAsking(false); ctl.acceptConsent(); }}>Accept</button>
          <button type="button" onClick={() => { setAsking(false); ctl.declineConsent(); }}>Cancel</button>
        </span>
      ) : null}
    </span>
  );
}
