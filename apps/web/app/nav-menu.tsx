'use client';
import { useState, type ReactNode } from 'react';
import { Icon } from './ui/icons';

/** The links are always in the page. Below the desktop width, this button shows or hides them. */
export function NavMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small nav-toggle" aria-label="Menu" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}><Icon name={open ? 'x' : 'menu'} size={16} /><span className="nav-toggle-label">Menu</span></button>
      <nav id="site-nav" aria-label="Main" className={`nav ${open ? 'open' : ''}`}>{children}</nav>
    </>
  );
}
