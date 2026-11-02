'use client';
import { useEffect, useState } from 'react';

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
  return <button className="btn small" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light' : 'Dark'}</button>;
}
