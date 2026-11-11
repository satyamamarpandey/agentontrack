'use client';
import { useEffect, useState } from 'react';
import { Icon } from './ui/icons';

const EVENT = 'aot-theme';
/** For a saved preference arriving from elsewhere on the page. */
export const applyTheme = (theme: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));

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
  return <button className="icon-btn" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setTheme(next)}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>;
}
