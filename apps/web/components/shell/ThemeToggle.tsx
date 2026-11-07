'use client';

import { Icon } from '@/components/ui/icon';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'tl.theme';

/** data-theme on <html>; default follows prefers-color-scheme (see tokens.css). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const explicit = document.documentElement.dataset.theme as Theme | undefined;
    setTheme(explicit ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }, []);
  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    setTheme(next);
  };
  return (
    <button
      type="button"
      className="ib"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={flip}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
    </button>
  );
}

/** Inline script for <head>: applies a saved theme before paint. */
export const themeBootScript = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
