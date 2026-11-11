import type { ComponentProps } from 'react';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** A plain link, not Next's: its prefetch asks for files the static export does not produce. Pages are folders, so the path gets its trailing slash before any query or hash. */
export default function Link({ href, ...rest }: ComponentProps<'a'> & { href: string }) {
  const [beforeHash, hash] = href.split('#');
  const [path, query] = beforeHash!.split('?');
  const withSlash = path === '/' ? '/' : `${path}/`;
  return <a href={`${BASE}${withSlash}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`} {...rest} />;
}
