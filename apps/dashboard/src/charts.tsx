import { useState, type CSSProperties, type ReactNode } from 'react';
import { isDemo } from './api';

export type DataKind = 'actual' | 'record' | 'transcript' | 'benchmark' | 'estimated' | 'demo' | 'unavailable';

const KIND_TEXT: Record<DataKind, string> = {
  actual: 'Actual: provider-reported',
  record: 'Actual: local record',
  transcript: 'Derived from local transcript',
  benchmark: 'Controlled benchmark',
  estimated: 'Estimated',
  demo: 'Demo data',
  unavailable: 'Unavailable',
};

export const Provenance = ({ kind, note }: { kind: DataKind; note?: string }) => (
  <span className={`prov prov-${isDemo() && kind !== 'benchmark' && kind !== 'unavailable' ? 'demo' : kind}`} title={note}>{isDemo() && kind !== 'benchmark' && kind !== 'unavailable' ? KIND_TEXT.demo : KIND_TEXT[kind]}</span>
);

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : Intl.NumberFormat('en', { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
export const fmtMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
};

export interface Series { key: string; label: string; color: string }

export function ChartFrame({ title, kind, note, children, table }: { title: string; kind: DataKind; note?: string; children: ReactNode; table?: ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="card chart">
      <figcaption>
        <h3>{title}</h3>
        <Provenance kind={kind} {...(note ? { note } : {})} />
        {table ? <button className="link" onClick={() => setShowTable(!showTable)}>{showTable ? 'Show chart' : 'Show table'}</button> : null}
      </figcaption>
      {note ? <p className="muted small">{note}</p> : null}
      {showTable ? <div className="table-wrap">{table}</div> : children}
    </figure>
  );
}

export const Legend = ({ series }: { series: Series[] }) => (
  series.length < 2 ? null : (
    <ul className="legend">
      {series.map((s) => <li key={s.key}><i style={{ background: s.color }} />{s.label}</li>)}
    </ul>
  )
);

/** Stacked vertical bars on a single axis, with a per-column hover readout. */
export function StackedBars({ rows, x, series, label, tick = (v) => v.slice(5) }: { rows: any[]; x: string; series: Series[]; label: string; tick?: (v: string) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640; const H = 220; const L = 48; const B = 26; const T = 8;
  const totals = rows.map((r) => series.reduce((n, s) => n + (r[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const band = (W - L) / Math.max(rows.length, 1);
  const bw = Math.min(40, band * 0.58);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((t) => t * max);
  return (
    <div className="plot">
      <Legend series={series} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="tick">{fmt(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          let acc = 0;
          const cx = L + band * i + band / 2;
          return (
            <g key={r[x]} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${r[x]}: ${series.map((s) => `${s.label} ${fmt(r[s.key] ?? 0)}`).join(', ')}`}>
              <rect x={L + band * i} y={T} width={band} height={H - T - B} fill="transparent" />
              {series.map((s) => {
                const v = r[s.key] ?? 0;
                if (!v) return null;
                const top = y(acc + v);
                const h = Math.max(1.5, y(acc) - top - 2);
                acc += v;
                return <rect key={s.key} className="bar" style={{ '--i': i } as CSSProperties} x={cx - bw / 2} y={top} width={bw} height={h} fill={s.color} />;
              })}
              <text x={cx} y={H - 8} textAnchor="middle" className="tick">{tick(String(r[x]))}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover] ? (
        <div className="readout" role="status">
          <b>{rows[hover][x]}</b>
          {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}: {fmt(rows[hover][s.key] ?? 0)}</span>)}
        </div>
      ) : <div className="readout muted small">Hover or focus a column for values.</div>}
    </div>
  );
}

/** Horizontal bars: labelled directly, so identity never depends on colour. */
export function HBars({ rows, unit = '', color = 'var(--s1)', onSelect }: { rows: { label: string; value: number | null; note?: string; key?: string }[]; unit?: string; color?: string; onSelect?: (key: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.label}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track">{r.value === null ? null : <i style={{ width: `${(r.value / max) * 100}%`, background: color }} />}</span>
          <span className="hbar-value">{r.value === null ? 'Unavailable' : `${fmt(r.value)}${unit}`}{r.note ? <em> {r.note}</em> : null}</span>
          {onSelect && r.key ? <button className="link small" onClick={() => onSelect(r.key!)}>source</button> : null}
        </div>
      ))}
    </div>
  );
}

export const Stat = ({ label, value, sub, kind }: { label: string; value: ReactNode; sub?: string; kind?: DataKind }) => (
  <div className="stat">
    <span className="stat-label">{label}</span>
    <span className="stat-value">{value}</span>
    {sub ? <span className="muted small">{sub}</span> : null}
    {kind ? <Provenance kind={kind} /> : null}
  </div>
);
