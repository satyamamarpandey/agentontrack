'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from '../link';
import { Modal } from '../ui/modal';
import { rememberSeen } from '../../lib/early-access';
import type { EarlyAccessForm } from './form';

type Form = typeof EarlyAccessForm;
const OPEN = 'aot-ea-open';
/** Any button anywhere opens the one dialog the host renders. */
export const openEarlyAccess = () => window.dispatchEvent(new Event(OPEN));

// The form is its own chunk, so the home page hydrates without it. It is fetched when a button is hovered or focused, shortly before the popup is
// due, and at the latest when the dialog is asked for. A failed fetch is forgotten, so the next click tries again.
let pending: Promise<Form> | null = null;
const loadForm = () => (pending ??= import('./form').then((m) => m.EarlyAccessForm, (e: unknown) => { pending = null; throw e; }));

export function EarlyAccessButton({ className = 'btn primary', children, testId }: { className?: string; children: ReactNode; testId?: string }) {
  // Safari does not focus a clicked button, so focus it first: the dialog returns focus to whatever opened it.
  return <button type="button" className={className} onMouseEnter={() => void loadForm().catch(() => undefined)} onFocus={() => void loadForm().catch(() => undefined)} onClick={(e) => { e.currentTarget.focus(); openEarlyAccess(); }} {...(testId ? { 'data-testid': testId } : {})}>{children}</button>;
}

/** Mounted once, in the layout. Renders nothing until asked. */
export function EarlyAccessHost() {
  const [open, setOpen] = useState(false);
  const [Form, setForm] = useState<Form | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const on = () => {
      rememberSeen();
      setFailed(false);
      // The form is in hand before the dialog animates in, so the entrance does not share its frames with the chunk's evaluation; past 400 ms it opens anyway and fills in.
      const ready = loadForm().then((f) => { if (alive) setForm(() => f); }, () => { if (alive) setFailed(true); });
      void Promise.race([ready, new Promise((r) => setTimeout(r, 400))]).then(() => { if (alive) setOpen(true); });
    };
    window.addEventListener(OPEN, on);
    return () => { alive = false; window.removeEventListener(OPEN, on); };
  }, []);
  if (!open) return null;
  return (
    <Modal label="Early access application" onClose={() => { rememberSeen(); setOpen(false); }} testId="early-access-dialog">
      {Form ? <Form source="popup" /> : failed ? (
        <div className="stack"><p className="eyebrow">Early access</p><h2>The form did not load</h2><p>Check your connection and try again, or <Link href="/early-access">open the application page</Link>.</p></div>
      ) : (
        <div className="stack" aria-busy="true"><p className="eyebrow">Early access</p><h2>Get early access to AgentOnTrack</h2><p className="skeleton" style={{ height: 18, width: '80%' }}>&nbsp;</p><p className="skeleton" style={{ height: 44 }}>&nbsp;</p><p className="skeleton" style={{ height: 44 }}>&nbsp;</p></div>
      )}
    </Modal>
  );
}

