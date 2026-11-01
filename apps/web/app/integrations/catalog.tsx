'use client';
import { useMemo, useState } from 'react';

export interface Entry {
  id: string; name: string; kind: string; status: string; evidence: string; version: string; install: string;
  capabilities: string; ifGateFails: string; limitations: string; proof: string;
}

const STATUS_TEXT: Record<string, string> = {
  NATIVE_ENFORCEMENT_VERIFIED: 'Enforcement verified',
  OBSERVATION_VERIFIED: 'Observation verified',
  MCP_VERIFIED: 'MCP verified, no enforcement',
  RESEARCH_API_VERIFIED: 'Research API verified, no enforcement',
  PARTIAL: 'Partial',
  BLOCKED: 'Blocked: not tested',
  NOT_TESTED: 'Not tested',
};

export function Catalog({ entries }: { entries: Entry[] }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? entries.filter((e) => Object.values(e).join(' ').toLowerCase().includes(t)) : entries;
  }, [q, entries]);
  return (
    <>
      <label htmlFor="integration-search">Search integrations</label>
      <input id="integration-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cursor, MCP, blocked…" data-testid="integration-search" autoComplete="off" />
      <p role="status" className="muted small">{shown.length} of {entries.length} shown</p>
      <div className="table-wrap" tabIndex={0}><table data-testid="runtime-table">
        <thead><tr><th scope="col">Platform</th><th scope="col">Status</th><th scope="col">Tested version and evidence</th><th scope="col">Install</th><th scope="col">What it does here</th><th scope="col">If the gate fails</th><th scope="col">Limits</th></tr></thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.id} data-testid={`integration-${e.id}`} data-status={e.status}>
              <th scope="row"><span aria-hidden="true" className="monogram">{e.name.slice(0, 2)}</span> {e.name}<br /><span className="muted small">{e.kind}</span></th>
              <td><b>{STATUS_TEXT[e.status] ?? e.status}</b><br /><code className="small">{e.status}</code></td>
              <td>{e.version}<br /><span className="muted small">{e.evidence}</span>{e.proof ? <><br /><code className="small">{e.proof}</code></> : null}</td>
              <td><code>{e.install}</code></td>
              <td>{e.capabilities}</td>
              <td>{e.ifGateFails}</td>
              <td>{e.limitations}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}
