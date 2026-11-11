'use client';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** A plain link that knows when it is the current page, so the header can mark it. Not Next's Link: its prefetch asks for files the static export does not produce. */
export function NavLink({ href, ...rest }: ComponentProps<'a'> & { href: string }) {
  const here = (usePathname() ?? '/').replace(/\/+$/, '') || '/';
  const target = href.replace(/\/+$/, '') || '/';
  const current = here === target || (target !== '/' && here.startsWith(`${target}/`));
  return <a href={`${BASE}${href === '/' ? '/' : `${href}/`}`} aria-current={current ? 'page' : undefined} {...rest} />;
}
