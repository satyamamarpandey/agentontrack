import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError, get, post } from './api';
import { Icon } from './icons';
import { useHuman } from './human';

export interface Entry { name: string; path: string; type: 'dir' | 'file' | 'link'; size: number }
export interface Buffer { path: string; content: string; saved: string; hash: string | null; language: string; error?: string; conflict?: string | null; protectedFile?: boolean; notice?: string }

const enc = encodeURIComponent;

/**
 * Source code is the most sensitive thing the helper can read, so a page on the public site may read it only after you allow it from your
 * terminal, for a short time. This page shows why, and asks.
 */
export function GrantFiles({ onGranted }: { onGranted: () => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="alert warn stack" role="status" data-testid="grant-files">
      <p><b>Allow this page to read the files in this project?</b> It is on a website, so your terminal will ask you to confirm. The permission lasts 30 minutes, covers this project only, and you can withdraw it any time.</p>
      {err ? <p role="alert">{err}</p> : null}
      <div><button className="btn small primary" disabled={busy} onClick={async () => { setBusy(true); setErr(''); try { await post('/api/files/grant', { minutes: 30 }); onGranted(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>Allow for 30 minutes</button></div>
    </div>
  );
}

/** The project's folders, read from the companion one folder at a time. Dot-folders such as .git are not offered. */
export function FileTree({ onOpen, current, onLoaded }: { onOpen: (path: string) => void; current: string | null; onLoaded: (files: string[]) => void }) {
  const [dirs, setDirs] = useState<Record<string, Entry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']));
  const [error, setError] = useState('');
  const [needsGrant, setNeedsGrant] = useState(false);
  const [filter, setFilter] = useState('');
  const load = (dir: string) => get<{ entries: Entry[] }>(`/api/files?dir=${enc(dir)}`).then((r) => { setNeedsGrant(false); setDirs((d) => ({ ...d, [dir]: r.entries ?? [] })); }).catch((e) => { if ((e as ApiError).data?.needsGrant) setNeedsGrant(true); else setError(e.message); });
  useEffect(() => { void load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onLoaded(Object.values(dirs).flat().filter((e) => e.type === 'file').map((e) => e.path)); }, [dirs]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (e: Entry) => {
    const next = new Set(open);
    if (next.has(e.path)) next.delete(e.path); else { next.add(e.path); if (!dirs[e.path]) void load(e.path); }
    setOpen(next);
  };
  const flat = useMemo(() => Object.values(dirs).flat().filter((e) => e.type === 'file' && e.name.toLowerCase().includes(filter.toLowerCase())), [dirs, filter]);
  const row = (e: Entry, depth: number): ReactNode => (
    <li key={e.path}>
      {e.type === 'dir' ? <>
        <button className="tree-item" style={{ paddingLeft: 8 }} aria-expanded={open.has(e.path)} onClick={() => toggle(e)}><Icon name={open.has(e.path) ? 'chevronDown' : 'chevron'} size={14} /><Icon name="folder" /><span className="name">{e.name}</span></button>
        {open.has(e.path) ? <ul>{(dirs[e.path] ?? []).map((c) => row(c, depth + 1))}{dirs[e.path] === undefined ? <li className="muted small" style={{ padding: '2px 8px' }}>Loading…</li> : null}</ul> : null}
      </> : <button className={`tree-item ${current === e.path ? 'on' : ''}`} aria-current={current === e.path ? 'true' : undefined} disabled={e.type === 'link'} title={e.type === 'link' ? 'Links are not opened here' : e.path} onClick={() => onOpen(e.path)}><span style={{ width: 14 }} /><Icon name="file" /><span className="name">{e.name}</span></button>}
    </li>
  );
  return (
    <div className="stack" style={{ gap: 6 }}>
      {needsGrant ? <GrantFiles onGranted={() => { setNeedsGrant(false); setDirs({}); void load(''); }} /> : null}
      <label className="sr-only" htmlFor="ws-filter">Filter loaded files</label>
      <input id="ws-filter" type="search" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} name="ws-filter" />
      {error ? <div className="alert bad" role="alert">{error}</div> : null}
      {filter ? (flat.length ? <ul className="tree" aria-label="Matching files">{flat.map((e) => row(e, 0))}</ul> : <p className="muted small">No loaded file matches. Open folders to load more.</p>)
        : <ul className="tree" aria-label="Project files">{(dirs[''] ?? []).map((e) => row(e, 0))}</ul>}
      {dirs[''] && dirs[''].length === 0 ? <p className="muted small">This folder is empty.</p> : null}
    </div>
  );
}

/** A small, safe Markdown view: headings, lists, code and paragraphs, built as elements. It never writes HTML. */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('```')) { const body: string[] = []; i++; while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!); out.push(<pre key={i}><code>{body.join('\n')}</code></pre>); continue; }
    const h = /^(#{1,3})\s+(.*)/.exec(l);
    if (h) { const Tag = `h${h[1]!.length}` as 'h1'; out.push(<Tag key={i}>{h[2]}</Tag>); continue; }
    if (/^\s*[-*]\s+/.test(l)) { const items: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, '')); i--; out.push(<ul key={i}>{items.map((x, n) => <li key={n}>{x}</li>)}</ul>); continue; }
    if (l.trim()) out.push(<p key={i}>{l}</p>);
  }
  return <div className="preview" tabIndex={0} role="region" aria-label="Preview" data-testid="md-preview">{out}</div>;
}

export function Editor({ buf, onChange, onSaved, onReload }: { buf: Buffer; onChange: (content: string) => void; onSaved: (hash: string, saved: string) => void; onReload: () => void }) {
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const gutter = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = buf.content !== buf.saved;
  const { ask, dialog } = useHuman(onReload);
  const lines = useMemo(() => Array.from({ length: buf.content.split('\n').length }, (_, i) => i + 1).join('\n'), [buf.content]);
  const isMd = buf.language === 'markdown' || /\.mdx?$/i.test(buf.path);

  const save = async (baseHash: string | null = buf.hash) => {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await post<{ hash: string }>('/api/file', { path: buf.path, content: buf.content, baseHash });
      onSaved(r.hash, buf.content);
      setMsg('Saved.');
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) setMsg(`conflict:${err.data?.currentHash ?? ''}`);
      else if (err.status === 403 && /protected/i.test(err.message)) setMsg('protected');
      else setMsg(err.message);
    } finally { setBusy(false); }
  };
  const [spec, setSpec] = useState<any>(null);
  const checkSpecNow = async () => { try { setSpec(await get(`/api/spec/check?path=${enc(buf.path)}`)); } catch (e) { setMsg((e as Error).message); } };
  const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } };
  const conflict = msg.startsWith('conflict:') ? msg.slice(9) : null;

  return (
    <div className="stack" style={{ gap: 0, flex: 1, minHeight: 0 }} onKeyDown={onKey}>
      {dialog}
      <div className="ws-bar">
        <span className="mono small grow clip" style={{ minWidth: 0 }} title={buf.path}>{buf.path}</span>
        {isMd ? <div className="row" role="group" aria-label="View">
          <button className={`chip ${view === 'edit' ? 'on' : ''}`} aria-pressed={view === 'edit'} onClick={() => setView('edit')}>Edit</button>
          <button className={`chip ${view === 'preview' ? 'on' : ''}`} aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
        </div> : null}
        {isMd ? <button className="btn small" disabled={dirty} title={dirty ? 'Save first: the check reads the saved file' : 'Check that paths, data structures and signatures are written down'} onClick={() => void checkSpecNow()} data-testid="ws-spec-check">Check spec</button> : null}
        <button className="btn small primary" disabled={!dirty || busy} onClick={() => void save()} data-testid="ws-save"><Icon name="save" size={14} />Save</button>
      </div>
      {conflict !== null ? <div className="alert warn" role="alert" data-testid="ws-conflict">
        <b>This file changed on disk since you opened it.</b> Your edit was not saved.
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => { setMsg(''); onReload(); }}>Discard mine and reload</button>
          <button className="btn small" onClick={() => { setMsg(''); void save(conflict || null); }}>Overwrite with mine</button>
        </div>
      </div> : null}
      {msg === 'protected' ? <div className="alert warn" role="alert" data-testid="ws-protected">
        <b>This is a protected file</b> (goals, safety and instruction files, agent hooks). It changes only through the confirmation path.
        <div style={{ marginTop: 6 }}><button className="btn small" onClick={() => ask({ title: `Save protected file ${buf.path}`, detail: <p className="alert warn">Agents read this file as instructions. Check the change before you confirm.</p>, path: '/api/file/protected', body: { path: buf.path, content: buf.content, baseHash: buf.hash } })}>Save protected file…</button></div>
      </div> : null}
      {msg && msg !== 'protected' && conflict === null && msg !== 'Saved.' ? <div className="alert bad" role="alert">{msg}</div> : null}
      {spec ? <div className={`alert ${spec.verdict === 'go' ? 'good' : 'warn'}`} role="status" data-testid="ws-spec-result">
        <b>Structure check: {spec.verdict === 'go' ? 'go' : 'no-go'}.</b> {spec.limits}
        {spec.findings.length ? <ul className="small">{spec.findings.map((f: any, i: number) => <li key={i}>{f.message}{f.line ? ` (line ${f.line})` : ''}</li>)}</ul> : <p className="small">Everything it looks for is written down.</p>}
        <button className="link small" onClick={() => setSpec(null)}>Dismiss</button>
      </div> : null}
      {view === 'preview' && isMd ? <Markdown text={buf.content} /> : (
        <div className="editor-wrap">
          <div className="gutter" ref={gutter} aria-hidden="true">{lines}</div>
          <textarea ref={area} className="editor" aria-label={`Editing ${buf.path}`} spellCheck={false} value={buf.content} data-testid="ws-editor"
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }} />
        </div>
      )}
      <div className="statusbar" role="status">
        <span>{buf.language}</span><span>{buf.content.split('\n').length} lines</span>
        <span style={{ marginLeft: 'auto' }}>{msg === 'Saved.' && !dirty ? 'Saved' : dirty ? 'Unsaved changes' : 'No changes'}</span>
      </div>
    </div>
  );
}

/** Before and after for one file of an agent's worktree. */
export function DiffView({ wt, path }: { wt: string; path: string }) {
  const [d, setD] = useState<{ before: string | null; after: string | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { get(`/api/worktrees/diff?id=${enc(wt)}&path=${enc(path)}`).then(setD).catch((e) => setError(e.message)); }, [wt, path]);
  const rows = useMemo(() => {
    if (!d) return [];
    const a = (d.before ?? '').split('\n'); const b = (d.after ?? '').split('\n');
    // A plain line diff by longest common subsequence: enough to read a change, and exact.
    const n = a.length; const m = b.length;
    if (n * m > 4_000_000) return [{ k: 'ctx', t: 'This change is too large to compare here. Open the files to review it.' }];
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    const out: { k: string; t: string }[] = [];
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ k: 'ctx', t: `  ${a[i]}` }); i++; j++; }
      else if (t[i + 1]![j]! >= t[i]![j + 1]!) out.push({ k: 'del', t: `- ${a[i++]}` });
      else out.push({ k: 'add', t: `+ ${b[j++]}` });
    }
    while (i < n) out.push({ k: 'del', t: `- ${a[i++]}` });
    while (j < m) out.push({ k: 'add', t: `+ ${b[j++]}` });
    return out;
  }, [d]);
  if (error) return <div className="alert bad" role="alert">{error}</div>;
  if (!d) return <p className="muted" role="status">Loading…</p>;
  return (
    <>
      <div className="ws-bar"><span className="mono small grow">{path}</span><span className="badge">{d.before === null ? 'new file' : d.after === null ? 'deleted' : 'changed'}</span></div>
      <div className="diff" role="region" aria-label={`Changes to ${path}`} tabIndex={0} data-testid="ws-diff">{rows.map((r, i) => <div key={i} className={r.k === 'add' ? 'add' : r.k === 'del' ? 'del' : ''}>{r.t || ' '}</div>)}</div>
    </>
  );
}
