'use client';
import { useEffect, useState } from 'react';

type Kind = 'info' | 'good' | 'bad';
interface Toast { id: number; message: string; kind: Kind }
const EVENT = 'aot-toast';
let seq = 0;

/** Short confirmations ("Copied", "Saved") that do not interrupt. Errors that need an answer belong in the page, not here. */
export function toast(message: string, kind: Kind = 'info'): void {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id: ++seq, message, kind } }));
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setItems((all) => [...all, t].slice(-4));
      setTimeout(() => setItems((all) => all.filter((x) => x.id !== t.id)), t.kind === 'bad' ? 7000 : 3800);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!items.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.kind}`} data-testid="toast">{t.message}</div>)}
    </div>
  );
}
