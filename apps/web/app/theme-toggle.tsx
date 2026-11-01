'use client';
import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    const saved = localStorage.getItem('bl-theme');
    if (saved) setTheme(saved);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('bl-theme', theme); }, [theme]);
  return <button className="btn small" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light' : 'Dark'}</button>;
}
