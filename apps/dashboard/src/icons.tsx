// A small stroke-icon set (24px grid, 1.75 stroke), drawn for this product. No icon dependency.
const PATHS = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  chevron: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  home: 'm3 11 9-8 9 8M5 10v10h14V10',
  layers: 'm12 3 9 5-9 5-9-5zm-9 9 9 5 9-5m-18 4 9 5 9-5',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  bot: 'M12 4v3M5 9h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zm4 4v2m6-2v2',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zm14 0-3 7a3 3 0 0 0 6 0zM8 21h8',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6m-6 4h6',
  shield: 'M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z',
  check: 'm5 12 5 5 9-10',
  checkCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-4 9 3 3 5-6',
  flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3M7.5 15h9',
  leaf: 'M5 19c0-9 5-14 15-14 0 10-5 15-14 15m0 0 7-7',
  message: 'M4 5h16v11H9l-5 4z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-.7a6 6 0 0 0-.5-1.2l1-1.9-2-2-1.9 1a6 6 0 0 0-1.2-.5L12.7 4h-2.8l-.7 2a6 6 0 0 0-1.2.5l-1.9-1-2 2 1 1.9a6 6 0 0 0-.5 1.2L4 12.7v2.8l2 .7c.1.4.3.8.5 1.2l-1 1.9 2 2 1.9-1c.4.2.8.4 1.2.5l.7 2h2.8l.7-2c.4-.1.8-.3 1.2-.5l1.9 1 2-2-1-1.9c.2-.4.4-.8.5-1.2l2-.7z',
  play: 'M7 5v14l12-7z',
  stop: 'M6 6h12v12H6z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  git: 'M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0c0 5-6 3-12 6',
  branch: 'M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v1a4 4 0 0 1-4 4H9',
  handoff: 'M4 8h13m0 0-4-4m4 4-4 4M20 16H7m0 0 4-4m-4 4 4 4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-6 9a6 6 0 0 1 12 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6 6 0 0 1 3 6',
  terminal: 'm5 8 4 4-4 4m7 0h7M3 4h18v16H3z',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  alert: 'M12 4 2.5 20h19zM12 10v4m0 3v.01',
  panelLeft: 'M3 5h18v14H3zM9 5v14',
  panelRight: 'M3 5h18v14H3zM15 5v14',
  panelBottom: 'M3 5h18v14H3zM3 14h18',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  external: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  refresh: 'M20 11a8 8 0 0 0-14-4L4 9m0-5v5h5M4 13a8 8 0 0 0 14 4l2-2m0 5v-5h-5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
