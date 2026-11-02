import { useCallback, useEffect, useState, type ReactNode } from 'react';

const STATUS_CLASS: Record<string, string> = { VERIFIED: 'good', FAILED: 'bad', NEEDS_HUMAN_APPROVAL: 'warn', IMPLEMENTED_UNVERIFIED: 'warn', pending: 'warn', approved: 'good', denied: 'bad', revoked: 'bad', expired: 'muted', consumed: 'muted', allow: 'good', deny: 'bad', request_approval: 'warn', pass: 'good', fail: 'bad', stale: 'warn', missing: 'muted', open: 'warn', accepted: 'good', rejected: 'bad', enforced: 'good', partial: 'warn', 'observed-only': 'warn', none: 'bad' };
export const Badge = ({ value }: { value: string }) => <span className={`badge ${STATUS_CLASS[value] ?? ''}`}>{value.replace(/_/g, ' ')}</span>;

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => { load().then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export const Loading = ({ error }: { error?: string }) => (error ? <div className="alert bad" role="alert">{error}</div> : <p className="muted" role="status">Loading…</p>);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Page = ({ title, intro, actions, children }: { title: string; intro?: string; actions?: ReactNode; children: ReactNode }) => (
  <>
    <header className="page-head">
      <div><h1>{title}</h1>{intro ? <p className="muted">{intro}</p> : null}</div>
      {actions}
    </header>
    {children}
  </>
);
