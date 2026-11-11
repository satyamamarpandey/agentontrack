import type { SVGProps } from 'react';

// A small inline set, 24px grid, 1.5 stroke: no icon dependency, and nothing fetched.
const PATHS: Record<string, string> = {
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  'arrow-right': 'M5 12h14m-6-6l6 6-6 6',
  'arrow-left': 'M19 12H5m6 6l-6-6 6-6',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6L12 3zm-3 9l2 2 4-4',
  terminal: 'M4 5h16v14H4zM7.5 9l3 3-3 3M12.5 15h4',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zm9.5 2.8a2.8 2.8 0 100-5.6 2.8 2.8 0 000 5.6z',
  'eye-off': 'M3 3l18 18M10.6 10.7a2.8 2.8 0 003.9 3.9M7.4 7.5C4.5 9.2 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.8 0 3.3-.5 4.6-1.2M9.9 5.8A9 9 0 0112 5.5c6 0 9.5 6.5 9.5 6.5s-.9 1.7-2.6 3.4',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  users: 'M16 19v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 17.5V19m16 0v-1.2a3.5 3.5 0 00-2.5-3.3M10 11a3 3 0 100-6 3 3 0 000 6zm5-.3a3 3 0 000-5.4',
  layers: 'M12 3l9 4.5-9 4.5-9-4.5L12 3zm-9 9l9 4.5 9-4.5M3 16.5L12 21l9-4.5',
  chart: 'M4 20V10m5.5 10V4M15 20v-7m5 7v-4',
  git: 'M6 4a2 2 0 100 4 2 2 0 000-4zm0 12a2 2 0 100 4 2 2 0 000-4zm12-10a2 2 0 100 4 2 2 0 000-4zM6 8v8m12-8c0 4-3 5-6 6-2 .6-4 1-4 4',
  phone: 'M8 3h8a1.5 1.5 0 011.5 1.5v15A1.5 1.5 0 0116 21H8a1.5 1.5 0 01-1.5-1.5v-15A1.5 1.5 0 018 3zm3 15h2',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
  mail: 'M4 6h16v12H4zm0 0l8 6 8-6',
  home: 'M4 11l8-7 8 7v9h-5v-6h-6v6H4z',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-5a4 4 0 100-8 4 4 0 000 8zm0-4h.01',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zm3 5h6m-6 4h6m-6 4h4',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zm0-15v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM21 21l-5-5',
  download: 'M12 3v12m-5-5l5 5 5-5M4 19h16',
  external: 'M14 4h6v6m0-6L10 14M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L2.5 18a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  bot: 'M12 3v3m-6 3h12a2 2 0 012 2v7a2 2 0 01-2 2H6a2 2 0 01-2-2v-7a2 2 0 012-2zm3 5h.01M15 14h.01M9 17h6',
  play: 'M7 5l12 7-12 7z',
};

export function Icon({ name, size = 20, ...rest }: { name: keyof typeof PATHS | string; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="icon" {...rest}><path d={PATHS[name] ?? ''} /></svg>;
}

/** The wordmark's mark: three rails and a point held on the line. The two points carry a class each so they can slide along their rails on hover. */
export const Mark = () => <span className="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M4 7h11M4 12h16M4 17h8" /><circle className="p1" cx="19" cy="7" r="2" fill="currentColor" stroke="none" /><circle className="p2" cx="16" cy="17" r="2" fill="currentColor" stroke="none" /></svg></span>;
