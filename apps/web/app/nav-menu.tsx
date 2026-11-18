'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui/icons';

/** The links are always in the page. Below the desktop width, this button shows or hides them. */
export function NavMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  return (
    <>
      <button ref={trigger} className="btn small nav-toggle" aria-label="Menu" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}><Icon name={open ? 'x' : 'menu'} size={16} /><span className="nav-toggle-label">Menu</span></button>
      <nav id="site-nav" aria-label="Main" className={`nav ${open ? 'open' : ''}`} onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) setOpen(false);
      }}>{children}</nav>
    </>
  );
}
