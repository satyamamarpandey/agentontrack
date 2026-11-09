import { DictationButton } from './dictation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { get, isDemo, post, postStart } from './api';
import { Icon } from './icons';
import { ModelField, useDiscovery } from './model-field';
import { FORK_UNSUPPORTED, STATUS_INFO, groupSessions, makeDrafts, resumeBlock, sourceLabel, statusOf, type SessionRow } from './sessions-model';
import { Empty, Loading, useLoad } from './ui';
import { DEFAULT_LIMITS, LimitFields, limitsBody, type RunLimits } from './limits';

/** One store for the page's life, backed by the tab's session storage: switching sessions, tabs or reloading keeps unsent text. */
const drafts = makeDrafts(typeof sessionStorage === 'undefined' ? null : sessionStorage);
const NEW = 'new';
const when = (ts: string) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
interface Detail extends SessionRow { runs: { id: string; status: string | null; events: string[] }[]; transcript: { kind: 'prompt' | 'message'; text: string; at: string }[] }
type Mode = 'standard' | 'read-only';

const StatusBadge = ({ s }: { s: SessionRow }) => { const k = statusOf(s); const i = STATUS_INFO[k]; return <span className={`badge ${i.tone}`} data-testid="sess-status" data-status={k} title={i.text}>{i.label}</span>; };

/** A draft that lives in the store: typing writes through, so an unmount (switching sessions) loses nothing. */
function useDraft(key: string) {
  const [text, setText] = useState(() => drafts.get(key));
  return [text, (v: string) => { setText(v); drafts.set(key, v); }, () => { setText(''); drafts.clear(key); }] as const;
}

function ModeField({ value, onChange, name }: { value: Mode; onChange: (m: Mode) => void; name: string }) {
  return (
    <span className="stack">
      <label>Mode
        <select value={value} onChange={(e) => onChange(e.target.value as Mode)} name={name} aria-describedby={`${name}-note`}>
          <option value="standard">Standard</option><option value="read-only">Read-only</option>
        </select>
      </label>
      <span id={`${name}-note`} className="muted small">{value === 'read-only' ? 'The agent may look but not change files.' : 'The agent works inside your approved goal.'}</span>
    </span>
  );
}

function NewSession({ projectName, onStarted, onClose }: { projectName: string; onStarted: (id: string) => void; onClose: () => void }) {
  const runtimes = useLoad<any[]>(() => get('/api/runtimes'), []);
  const disc = useDiscovery();
  const [prompt, setPrompt, clearPrompt] = useDraft(NEW);
  const [title, setTitle] = useState('');
  const [runtime, setRuntime] = useState('claude-code');
  const [model, setModel] = useState('haiku');
  const [mode, setMode] = useState<Mode>('standard');
  const [limits, setLimits] = useState<RunLimits>(DEFAULT_LIMITS);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const startable = (runtimes.data ?? []).filter((r) => r.canStart);
  const chosen = (runtimes.data ?? []).find((r) => r.id === runtime);
  useEffect(() => { if (runtimes.data && !chosen?.canStart && startable[0]) setRuntime(startable[0].id); }, [runtimes.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const can = !!chosen?.canStart && !!prompt.trim() && !busy;
  const send = async () => {
    if (!can) return;
    if (prompt.startsWith('-')) { setMsg('A prompt cannot start with a hyphen.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await postStart<{ sessionId: string }>('/api/agent-sessions', { runtime, prompt, model: model || undefined, ...limitsBody(limits, !!chosen?.dollarCap), policy: mode, ...(title.trim() ? { title: title.trim() } : {}) });
      clearPrompt(); onStarted(r.sessionId);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); } else if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
  return (
    <form className="sess-new stack" aria-label="New session" data-testid="sess-new-form" onSubmit={(e) => { e.preventDefault(); void send(); }} onKeyDown={key}>
      <h3>New session</h3>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      <div className="row wrap">
        <label>Project<input value={projectName} readOnly aria-readonly="true" name="sess-project" style={{ width: 170 }} /></label>
        <label>Agent
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)} name="sess-runtime">
            {(runtimes.data ?? []).length === 0 ? <option value="claude-code">Claude Code</option> : null}
            {(runtimes.data ?? []).map((r) => <option key={r.id} value={r.id} disabled={!r.canStart}>{r.name}{r.canStart ? '' : ' (not available here)'}</option>)}
          </select>
        </label>
        <ModelField agent={runtime} value={model} onChange={setModel} name="sess-model" models={disc.data?.models} width={140} placeholder="haiku" />
        <ModeField value={mode} onChange={setMode} name="sess-mode" />
        <LimitFields value={limits} onChange={setLimits} dollarCap={!!chosen?.dollarCap} name="sess" usdLabel="Budget (USD)" width={90} />
      </div>
      <label>Title (optional)<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} name="sess-title" /></label>
      <label>Prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} name="sess-prompt" required placeholder="What should the agent do? It works inside the goal you approved." aria-describedby="sess-new-hint" /></label><DictationButton onText={(t) => setPrompt((prompt && !/\s$/.test(prompt) ? prompt + ' ' : prompt) + t)} />
      <p id="sess-new-hint" className="muted small">Ctrl or Cmd + Enter sends. Esc closes this form and keeps what you typed.{chosen?.canStart === false ? ` ${chosen.reason ?? 'This agent cannot be started from here.'}` : ''}</p>
      <div className="row end"><button type="button" className="btn small" onClick={onClose}>Close</button><button type="submit" className="btn small primary" disabled={!can} data-testid="sess-start">{busy ? 'Starting…' : 'Start session'}</button></div>
    </form>
  );
}

function SessionDetail({ s, reload, listRef }: { s: SessionRow; reload: () => void; listRef: RefObject<HTMLElement | null> }) {
  const d = useLoad<Detail>(() => get(`/api/agent-sessions/${s.id}`), [s.id, s.updatedAt, s.status]);
  const agents = useLoad<any[]>(() => get('/api/runtimes'), []);
  const agentNow = (agents.data ?? []).find((r) => r.id === s.runtime);
  // A different connected agent that can be started: the reviewer for the manual two-step review.
  const reviewer = (agents.data ?? []).find((r) => r.id !== s.runtime && r.canStart);
  const [reviewModel, setReviewModel] = useState('');
  const disc = useDiscovery();
  const [prompt, setPrompt, clearPrompt] = useDraft(s.id);
  const [model, setModel] = useState(s.model ?? '');
  const [mode, setMode] = useState<Mode>('standard');
  const [limits, setLimits] = useState<RunLimits>(DEFAULT_LIMITS);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.title);
  const k = statusOf(s);
  const block = resumeBlock(s);
  const update = async (body: object) => { setMsg(''); try { await post(`/api/agent-sessions/${s.id}/update`, body); reload(); return true; } catch (e) { setMsg((e as Error).message); return false; } };
  const resume = async () => {
    if (block || !prompt.trim() || busy) return;
    setBusy(true); setMsg(''); setNote('');
    try {
      const r = await postStart<{ runId: string }>(`/api/agent-sessions/${s.id}/resume`, { prompt, ...(model ? { model } : {}), ...limitsBody(limits, !!agentNow?.dollarCap), policy: mode });
      clearPrompt(); setNote(`Continuing: run ${r.runId} started.`); reload(); d.reload();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const review = async () => {
    if (!s.lastRunId || !reviewer || busy) return;
    setBusy(true); setMsg(''); setNote('');
    try {
      const r = await postStart<{ runId: string; note: string }>('/api/workflows/review', { runId: s.lastRunId, reviewer: reviewer.id, ...(reviewModel ? { model: reviewModel } : {}) });
      setNote(`${r.note} Look for it in the session list.`); reload();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const reviewWhy = s.status === 'running' ? 'Wait for this run to finish.' : !s.lastRunId ? 'There is no run to review.' : !reviewer ? 'Review needs a second agent that can be started here. Connect one in the Agents tab.' : null;
  const lastRun = d.data?.runs.at(-1);
  const out = lastRun?.events.join('\n') ?? '';
  const sendKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void resume(); }
    else if (e.key === 'Escape') { e.stopPropagation(); (e.target as HTMLElement).blur(); listRef.current?.focus(); }
  };
  const bad = k === 'failed' || k === 'unknown';
  const limitLine = out.split('\n').find((l) => /says its usage limit was reached/.test(l))?.replace(/^error:\s*/, '');
  const timeLine = out.split('\n').find((l) => l.startsWith('Stopped: the time limit of '));
  return (
    <section className="sess-detail stack" aria-label={`Session ${s.title}`} data-testid="sess-detail" data-session={s.id}>
      <header className="row wrap">
        {renaming ? (
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void update({ title: name.trim() }).then((ok) => { if (ok) setRenaming(false); }); }}>
            <label className="grow">Session name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus name="sess-rename" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false); setName(s.title); } }} /></label>
            <button className="btn small primary end-self" type="submit" disabled={!name.trim()}>Save</button>
          </form>
        ) : <h3 className="grow clip" style={{ margin: 0 }}>{s.pinned ? <span title="Pinned">★ </span> : null}{s.title}</h3>}
        <StatusBadge s={s} />
      </header>
      <p className={`small ${bad ? 'alert bad' : 'muted'}`} data-testid="sess-status-text">{STATUS_INFO[k].text}</p>
      <dl className="sess-meta small">
        <dt>Agent</dt><dd>{s.runtime}{s.model ? ` · ${s.model}` : ''}</dd>
        <dt>Started from</dt><dd>{sourceLabel(s.source)}</dd>
        <dt>Last activity</dt><dd>{when(s.updatedAt)}</dd>
        <dt>Runs</dt><dd>{s.runIds.length}</dd>
        <dt>Where</dt><dd>{s.worktreeId ? <span className="badge" data-testid="sess-worktree" title={s.worktreeId}>isolated worktree</span> : 'project folder'}</dd>
      </dl>
      <div className="row wrap" role="group" aria-label="Session actions">
        <button className="btn small" onClick={() => { setName(s.title); setRenaming(true); }} disabled={renaming} data-testid="sess-rename">Rename</button>
        <button className="btn small" aria-pressed={s.pinned} onClick={() => void update({ pinned: !s.pinned })} data-testid="sess-pin">{s.pinned ? 'Unpin' : 'Pin'}</button>
        <button className="btn small" onClick={() => void update({ archived: !s.archived })} data-testid="sess-archive">{s.archived ? 'Unarchive' : 'Archive'}</button>
        <button className="btn small" onClick={() => void review()} disabled={!!reviewWhy || busy} aria-describedby="sess-review-why" data-testid="sess-review">Review this run</button>
        <button className="btn small" disabled aria-describedby="sess-fork-why" data-testid="sess-fork">Fork</button>
      </div>
      <p id="sess-review-why" className="muted small" data-testid="sess-review-why">{reviewWhy ?? `Review this run: ${reviewer?.name ?? 'another agent'} reads a handoff from the last run and reports problems. It is one run that you start now; nothing follows it. Automatic build-then-review needs your own API key in paid API mode and a grant.`}</p>
      {reviewer ? <ModelField agent={reviewer.id} value={reviewModel} onChange={setReviewModel} name="sess-review-model" models={disc.data?.models} width={140} placeholder="reviewer default" /> : null}
      <p id="sess-fork-why" className="muted small" data-testid="sess-fork-why">Fork: {FORK_UNSUPPORTED}</p>
      {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
      {limitLine ? <div className="alert warn" role="status" data-testid="sess-limit">{limitLine}</div> : null}
      {timeLine ? <div className="alert warn" role="status" data-testid="sess-time-limit">{timeLine}. The session is kept: resume it with a longer limit if the work is not done.</div> : null}
      {note ? <div className="alert good" role="status">{note}</div> : null}
      {d.data?.transcript?.length ? <div className="stack" aria-label="Stored prompts and replies"><h4>Conversation (kept on this computer)</h4>{d.data.transcript.map((t, i) => <p key={i} className="small sess-t"><b>{t.kind === 'prompt' ? 'You' : 'Agent'}:</b> {t.text}</p>)}</div> : null}
      {out ? <div><h4>{k === 'failed' ? 'Last output before it failed' : 'Last output'}</h4><pre className="sess-out" tabIndex={0} aria-label="Last output of the latest run" data-testid="sess-output">{out}</pre></div>
        : k === 'failed' ? <p className="small" data-testid="sess-no-output">No output was kept for the failed run, so the reason is not available here.</p> : null}
      <form className="stack sess-resume" onSubmit={(e) => { e.preventDefault(); void resume(); }} aria-label="Continue this session">
        <label>Next prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} name="sess-resume-prompt" disabled={s.archived} onKeyDown={sendKey} aria-describedby="sess-resume-why" placeholder="What should the agent do next?" /></label><DictationButton onText={(t) => setPrompt((prompt && !/\s$/.test(prompt) ? prompt + ' ' : prompt) + t)} />
        <div className="row wrap">
          <ModelField agent={s.runtime} value={model} onChange={setModel} name="sess-resume-model" models={disc.data?.models} width={140} placeholder="agent default" />
          <ModeField value={mode} onChange={setMode} name="sess-resume-mode" />
          <LimitFields value={limits} onChange={setLimits} dollarCap={!!agentNow?.dollarCap} name="sess-resume" usdLabel="Budget (USD)" width={90} />
          <button className="btn small primary end-self" type="submit" disabled={!!block || !prompt.trim() || busy || s.archived} aria-describedby="sess-resume-why" data-testid="sess-resume">Resume <kbd>Ctrl ↵</kbd></button>
        </div>
        <p id="sess-resume-why" className="muted small" data-testid="sess-resume-why">{s.archived ? 'Unarchive this session to continue it.' : block ?? 'Sends the next prompt into the agent’s own session. Ctrl or Cmd + Enter sends; Esc leaves the box. Unsent text is kept for this session.'}</p>
      </form>
    </section>
  );
}

function Section({ id, label, items, empty, sel, onPick }: { id: string; label: string; items: SessionRow[]; empty: string; sel: string | null; onPick: (id: string) => void }) {
  return (
    <section aria-labelledby={`sess-h-${id}`} data-testid={`sess-section-${id}`}>
      <h3 id={`sess-h-${id}`} className="sess-h">{label} <span className="muted small">({items.length})</span></h3>
      {items.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="list sess-list">{items.map((s) => (
          <li key={s.id}>
            <button type="button" className="sess-row" aria-current={s.id === sel ? 'true' : undefined} onClick={() => onPick(s.id)} data-testid="sess-item" data-session={s.id}>
              <span className="row"><b className="grow clip">{s.pinned ? '★ ' : ''}{s.title}</b><StatusBadge s={s} /></span>
              <span className="muted small clip">{s.runtime}{s.model ? ` · ${s.model}` : ''} · {when(s.updatedAt)} · from {sourceLabel(s.source)}{s.worktreeId ? ' · worktree' : ''}</span>
              {s.match ? <span className="small clip" data-testid="sess-match">{s.match.where}: {s.match.snippet}</span> : null}
            </button>
          </li>))}</ul>)}
    </section>
  );
}

/** Every agent session of this project in one place. The status comes from the companion; nothing here turns an unknown or failed run into a success. */
export function SessionsPane({ tick, projectName }: { tick: number; projectName: string }) {
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState('');
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => { const t = setTimeout(() => setQd(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const list = useLoad<{ keepTranscripts: boolean; sessions: SessionRow[] }>(() => get(`/api/agent-sessions?archived=1${qd ? `&q=${encodeURIComponent(qd)}` : ''}`), [tick, qd]);
  useEffect(() => { const t = setInterval(list.reload, 3000); return () => clearInterval(t); }, [list.reload]);
  const groups = useMemo(() => groupSessions(list.data?.sessions ?? []), [list.data]);
  const current = list.data?.sessions.find((s) => s.id === sel) ?? null;
  const setKeep = async (on: boolean) => { setMsg(''); try { await post('/api/settings', { keepTranscripts: on }); list.reload(); } catch (e) { setMsg((e as Error).message); } };
  const pick = (id: string) => { setSel(id); setShowNew(false); };

  if (!list.data) return <div style={{ padding: 16 }}><Loading error={list.error} /></div>;
  return (
    <div className="sess-wrap" data-testid="sessions-pane">
      <div className="sess">
        <section className="sess-side stack" aria-label="Sessions" ref={listRef} tabIndex={-1}>
          <div className="row">
            <h2 className="grow" style={{ margin: 0 }}>Sessions</h2>
            <button className="btn small primary" onClick={() => { setShowNew(true); setSel(null); }} data-testid="sess-new" disabled={isDemo()} title={isDemo() ? 'Not available in the demo' : undefined}><Icon name="play" size={12} />New session</button>
          </div>
          <label>Search sessions<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={list.data.keepTranscripts ? 'Titles, prompts and replies' : 'Titles'} name="sess-search" data-testid="sess-search" /></label>
          {list.error ? <div className="alert bad" role="alert">{list.error}</div> : null}
          {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
          <label className="check small"><input type="checkbox" checked={list.data.keepTranscripts} onChange={(e) => void setKeep(e.target.checked)} name="sess-keep" /> Keep prompts and replies on this computer, so search can read them</label>
          {!list.data.keepTranscripts ? <p className="muted small">Off: prompts and replies are not stored, so search only covers titles, and a session shows only the last output the companion still has.</p> : null}
          {qd && list.data.sessions.length === 0 ? <Empty>No session matches &quot;{qd}&quot;.</Empty> : null}
          {!qd && list.data.sessions.length === 0 ? <Empty>No sessions yet. Start one, from here or from your phone, and it appears here with its status.</Empty> : null}
          <Section id="active" label="Active" items={groups.active} empty="Nothing is running." sel={sel} onPick={pick} />
          <Section id="recent" label="Recent" items={groups.recent} empty="No other sessions." sel={sel} onPick={pick} />
          <Section id="archived" label="Archived" items={groups.archived} empty="Nothing archived." sel={sel} onPick={pick} />
        </section>
        <div className="sess-main">
          {showNew ? <NewSession projectName={projectName} onClose={() => setShowNew(false)} onStarted={(id) => { setShowNew(false); setSel(id); list.reload(); }} />
            : current ? <SessionDetail key={current.id} s={current} reload={list.reload} listRef={listRef} />
              : <Empty>Select a session to read its status and continue it, or start a new one.</Empty>}
        </div>
      </div>
    </div>
  );
}
