import type { ComponentProps } from 'react';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** A plain link, not Next's: its prefetch asks for files the static export does not produce. */
export default function Link({ href, ...rest }: ComponentProps<'a'> & { href: string }) {
  const [path, hash] = href.split('#');
  const withSlash = path === '/' ? '/' : `${path}/`;
  return <a href={`${BASE}${withSlash}${hash ? `#${hash}` : ''}`} {...rest} />;
}
