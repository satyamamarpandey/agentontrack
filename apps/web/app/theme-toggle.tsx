'use client';
import { useEffect, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { Icon } from './ui/icons';

const EVENT = 'aot-theme';
/** For a saved preference arriving from elsewhere on the page. */
export const applyTheme = (theme: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));

type Transitioning = Document & { startViewTransition?: (update: () => void) => { finished: Promise<unknown> } };

export function ThemeToggle() {
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    const saved = localStorage.getItem('bl-theme');
    if (saved) setTheme(saved);
    const on = (e: Event) => setTheme((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('bl-theme', theme); }, [theme]);
  const next = theme === 'dark' ? 'light' : 'dark';
  // Where the browser can, the new theme opens out from the button that asked for it. Otherwise, and for anyone who prefers reduced motion, it just changes.
  const flip = (e: MouseEvent<HTMLButtonElement>) => {
    const doc = document as Transitioning;
    if (typeof doc.startViewTransition !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) { setTheme(next); return; }
    const root = document.documentElement;
    const r = e.currentTarget.getBoundingClientRect();
    root.style.setProperty('--vx', `${Math.round(r.left + r.width / 2)}px`);
    root.style.setProperty('--vy', `${Math.round(r.top + r.height / 2)}px`);
    root.dataset.vt = 'theme';
    const done = () => { delete root.dataset.vt; };
    try {
      doc.startViewTransition(() => { flushSync(() => setTheme(next)); root.dataset.theme = next; }).finished.then(done, done);
    } catch { done(); setTheme(next); }
  };
  return <button className="icon-btn" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={flip}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>;
}
