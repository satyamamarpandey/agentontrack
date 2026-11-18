import { useEffect, useRef, useState } from 'react';

/** A command copy control that reports clipboard failures instead of silently doing nothing. */
export function CopyCommand({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus('idle'), 1800);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="stack">
      <div className="copybox">
        <code>{text}</code>
        <button type="button" className="btn small" onClick={() => void copy()}>{status === 'copied' ? 'Copied' : 'Copy'}</button>
      </div>
      <span className="sr-only" role="status">{status === 'copied' ? 'Command copied to the clipboard' : ''}</span>
      {status === 'error' ? <p role="alert" className="muted small">Clipboard access was blocked. Select and copy the command above manually.</p> : null}
    </div>
  );
}
