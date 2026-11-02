import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { get, post, setTerminalPrompt } from './api';
import { Loading, useLoad } from './ui';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Every dialog goes through this. Focus moves in when it opens, Tab stays inside it, Escape closes it,
 * and focus goes back to what opened it. The page behind it is inert for assistive technology.
 */
export function Modal({ label, onClose, wide, testId, onSubmit, children }: { label: string; onClose: () => void; wide?: boolean; testId?: string; onSubmit?: (e: FormEvent) => void; children: ReactNode }) {
  const box = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const first = box.current?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    if (!box.current?.contains(document.activeElement)) first?.focus();
    return () => { root?.removeAttribute('inert'); opener?.focus?.(); };
  }, []);
  // Escape closes it wherever focus is. WebKit does not always focus what was clicked, so a handler on the dialog can miss it.
  useLayoutEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const a = document.activeElement;
      if (e.shiftKey && (a === items[0] || !box.current.contains(a))) { e.preventDefault(); items.at(-1)!.focus(); }
      else if (!e.shiftKey && (a === items.at(-1) || !box.current.contains(a))) { e.preventDefault(); items[0]!.focus(); }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [onClose]);
  const cls = `modal${wide ? ' wide' : ''}`;
  return createPortal(
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={label} {...(testId ? { 'data-testid': testId } : {})}>
      {onSubmit ? <form ref={box as never} className={cls} onSubmit={onSubmit}>{children}</form> : <div ref={box as never} className={cls}>{children}</div>}
    </div>,
    document.body,
  );
}

/** Every human action goes through this: a fresh code from the companion, typed back, plus the passphrase if enrolled. */
function HumanDialog({ title, detail, submit, onClose, onDone }: { title: string; detail?: ReactNode; submit: (proof: Record<string, string>) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const [ch, setCh] = useState<{ challengeId: string; code: string | null; inTerminal?: boolean; needsPassphrase: boolean } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const fresh = useCallback(() => { post('/api/challenge').then(setCh).catch((e) => setError(e.message)); }, []);
  useEffect(fresh, [fresh]);
  useEffect(() => { ref.current?.focus(); }, [ch]);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!ch) return;
    setBusy(true); setError('');
    try {
      await submit({ challengeId: ch.challengeId, confirm, ...(ch.needsPassphrase ? { passphrase } : {}) });
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setConfirm('');
      fresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal label={title} onClose={onClose} onSubmit={go}>
      <h2>{title}</h2>
      {detail}
      {error ? <div className="alert bad" role="alert">{error}</div> : null}
      {ch?.inTerminal ? <p className="muted small">Next, your terminal will show a code for this exact request.</p> : <label>Type <code data-testid="challenge-code">{ch?.code ?? '…'}</code> to confirm
        <input ref={ref} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" name="confirm" required />
      </label>}
      {ch?.needsPassphrase ? <label>Approver passphrase<input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" name="passphrase" required /></label> : null}
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !ch}>Confirm</button>
      </div>
    </Modal>
  );
}

export interface HumanRequest { title: string; detail?: ReactNode; path: string; body?: object }
export function useHuman(reload: () => void) {
  const [req, setReq] = useState<HumanRequest | null>(null);
  const dialog = req ? <HumanDialog title={req.title} {...(req.detail ? { detail: req.detail } : {})} submit={(proof) => post(req.path, { ...req.body, ...proof })} onClose={() => setReq(null)} onDone={reload} /> : null;
  return { ask: setReq, dialog };
}

/** Mounted once. Anything the public site tries to change comes through here with a code from the user's own terminal. */
export function TerminalPrompt() {
  const [ask, setAsk] = useState<{ action: string; resolve: (c: string) => void; reject: (e: Error) => void } | null>(null);
  const [code, setCode] = useState('');
  useEffect(() => setTerminalPrompt((action) => new Promise((resolve, reject) => { setCode(''); setAsk({ action, resolve, reject }); })), []);
  if (!ask) return null;
  const cancel = () => { ask.reject(new Error('Cancelled, so nothing changed.')); setAsk(null); };
  return (
    <Modal label="Code from your terminal" testId="terminal-code-dialog" onClose={cancel} onSubmit={(e) => { e.preventDefault(); ask.resolve(code.trim()); setAsk(null); }}>
        <h2>Confirm in your terminal</h2>
        <p className="muted small">Your terminal now shows a code. Check that it describes this request:</p>
        <pre className="code small" tabIndex={0}>{ask.action}</pre>
        <label>Code from your terminal<input value={code} onChange={(e) => setCode(e.target.value)} data-autofocus autoComplete="off" name="terminal-code" required /></label>
        <div className="row end">
          <button type="button" className="btn" onClick={cancel}>Cancel</button>
          <button type="submit" className="btn primary">Confirm</button>
        </div>
    </Modal>
  );
}

export function EventDrawer({ seq, onClose }: { seq: number; onClose: () => void }) {
  const { data, error } = useLoad(() => get(`/api/event/${seq}`), [seq]);
  return (
    <Modal label={`Record ${seq}`} onClose={onClose} wide>
      <h2>Source record #{seq}</h2>
      {data ? <pre tabIndex={0} className="code">{JSON.stringify(data, null, 2)}</pre> : <Loading error={error} />}
      <div className="row end"><button className="btn" data-autofocus onClick={onClose}>Close</button></div>
    </Modal>
  );
}
