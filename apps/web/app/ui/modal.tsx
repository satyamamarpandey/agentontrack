'use client';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The site's one dialog. Focus moves in, Tab stays inside, Escape and the close button close it, focus returns to the opener, the page behind is
 * inert and does not scroll. It plays a short exit before it goes, unless the person prefers reduced motion.
 */
export function Modal({ label, onClose, children, narrow, testId, closeLabel = 'Close' }: { label: string; onClose: () => void; children: ReactNode; narrow?: boolean; testId?: string; closeLabel?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => {
    if (closing) return;
    const quick = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (quick) { onClose(); return; }
    setClosing(true);
    setTimeout(onClose, 210);
  }, [closing, onClose]);
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const behind = [...document.querySelectorAll<HTMLElement>('body > header, body > main, body > footer, body > nav')];
    for (const el of behind) el.setAttribute('inert', '');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => { for (const el of behind) el.removeAttribute('inert'); document.body.style.overflow = prevOverflow; opener?.focus?.(); };
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const a = document.activeElement;
      if (e.shiftKey && (a === items[0] || !box.current.contains(a))) { e.preventDefault(); items.at(-1)!.focus(); }
      else if (!e.shiftKey && (a === items.at(-1) || !box.current.contains(a))) { e.preventDefault(); items[0]!.focus(); }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [close]);
  return createPortal(
    <div className="dialog-back" data-state={closing ? 'closing' : 'open'} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={box} className={`dialog${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true" aria-label={label} {...(testId ? { 'data-testid': testId } : {})}>
        <button type="button" className="icon-btn close" aria-label={closeLabel} onClick={close}><Icon name="x" /></button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
