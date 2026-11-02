import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { get } from './api';
import { useHuman } from './human';
import { Icon, type IconName } from './icons';
import type { Command } from './palette';
import { Badge, Empty, Loading, useLoad } from './ui';
import { DiffView, Editor, FileTree, type Buffer } from './ws-files';
import { AgentTab, BOTTOM_TABS, BottomPanel, RIGHT_TABS, RightPanel, type BottomTab, type RightTab } from './ws-panels';

interface Layout { left: number; right: number; bottom: number; showLeft: boolean; showRight: boolean; showBottom: boolean; leftTab: 'Files' | 'Tasks'; rightTab: RightTab; bottomTab: BottomTab }
const DEFAULT: Layout = { left: 264, right: 320, bottom: 240, showLeft: true, showRight: true, showBottom: true, leftTab: 'Files', rightTab: 'Agents', bottomTab: 'Activity' };
const LIMITS = { left: [180, 520], right: [240, 560], bottom: [120, 640] } as const;
const KEY = 'aot-ws-layout';
type Tab = { key: string; kind: 'agent' } | { key: string; kind: 'file'; path: string } | { key: string; kind: 'diff'; wt: string; path: string };
type View = 'files' | 'editor' | 'agents' | 'panel';

const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, n));
const loadLayout = (): Layout => { try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT; } };

/** A draggable and keyboard-operable divider between panes. */
function Splitter({ cls, label, value, range, axis, grow, onChange }: { cls: string; label: string; value: number; range: readonly [number, number]; axis: 'x' | 'y'; grow: 1 | -1; onChange: (n: number) => void }) {
  const [drag, setDrag] = useState(false);
  const start = useRef(0);
  const down = (e: RPointerEvent) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = (axis === 'x' ? e.clientX : e.clientY) - grow * value; setDrag(true); };
  const move = (e: RPointerEvent) => { if (drag) onChange(clamp(grow * ((axis === 'x' ? e.clientX : e.clientY) - start.current), range)); };
  const key = (e: RKeyboardEvent) => {
    const more = axis === 'x' ? (grow === 1 ? 'ArrowRight' : 'ArrowLeft') : (grow === 1 ? 'ArrowDown' : 'ArrowUp');
    const less = axis === 'x' ? (grow === 1 ? 'ArrowLeft' : 'ArrowRight') : (grow === 1 ? 'ArrowUp' : 'ArrowDown');
    if (e.key === more) { e.preventDefault(); onChange(clamp(value + 16, range)); }
    else if (e.key === less) { e.preventDefault(); onChange(clamp(value - 16, range)); }
    else if (e.key === 'Home') { e.preventDefault(); onChange(range[0]); }
    else if (e.key === 'End') { e.preventDefault(); onChange(range[1]); }
  };
  return <div className={`${cls} ${drag ? 'dragging' : ''}`} role="separator" tabIndex={0} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label} aria-valuenow={value} aria-valuemin={range[0]} aria-valuemax={range[1]} onPointerDown={down} onPointerMove={move} onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)} onKeyDown={key} />;
}

function PaneTabs<T extends string>({ label, tabs, tab, onTab }: { label: string; tabs: readonly T[]; tab: T; onTab: (t: T) => void }) {
  const key = (e: RKeyboardEvent) => {
    const i = tabs.indexOf(tab);
    const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : -1;
    if (to < 0) return;
    e.preventDefault(); onTab(tabs[to]!);
    queueMicrotask(() => (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return <div className="tabs" role="tablist" aria-label={label} onKeyDown={key}>{tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} className={tab === t ? 'on' : ''} onClick={() => onTab(t)}>{t}</button>)}</div>;
}

function TasksPane({ state, reload }: { state: any; reload: () => void }) {
  const { ask, dialog } = useHuman(reload);
  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  return (
    <div className="stack">
      {dialog}
      <div>
        <h2>Goal</h2>
        {state.goal ? <><p>{state.goal.statement}</p><p className="muted small">Version {state.goal.version} · {state.goal.status} · scope {state.goal.scope.include.join(', ')}</p></> : <p className="muted small">No approved goal. Set one under Goals and tasks.</p>}
      </div>
      <h2>Tasks</h2>
      {state.tasks.length === 0 ? <Empty>No tasks yet.</Empty> : <ul className="list" data-testid="ws-tasks">{[...state.tasks].reverse().map((t: any) => (
        <li key={t.id}><div className="row wrap"><b className="grow" style={{ minWidth: 100 }}>{t.title}</b><Badge value={t.evaluation.status} /></div>
          {state.activeTask?.id === t.id ? <span className="badge">active</span> : !t.closed ? <button className="btn small" onClick={() => ask({ title: `Activate ${t.title}`, path: '/api/tasks/activate', body: { id: t.id } })}>Activate…</button> : <span className="badge muted">closed</span>}
        </li>))}</ul>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); ask({ title: 'Create task', detail: command ? <p>This check will run on your machine: <code>{command}</code></p> : <p className="alert warn">With no check, this task can never be VERIFIED.</p>, path: '/api/tasks', body: { title, criteria: command ? [{ id: 'check', description: command, kind: 'command', command }] : [] } }); setTitle(''); setCommand(''); }}>
        <h2>New task</h2>
        <label>Task<input value={title} onChange={(e) => setTitle(e.target.value)} required name="ws-task-title" /></label>
        <label>Acceptance check (command)<input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm test" name="ws-task-check" /></label>
        <button className="btn small primary" type="submit">Review and create…</button>
      </form>
    </div>
  );
}

export function Workspace({ tick, projectName, open, setCommands }: { tick: number; projectName: string; open: (seq: number) => void; setCommands: (c: Command[]) => void }) {
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const setLayout = useCallback((patch: Partial<Layout>) => setLayoutState((l) => { const n = { ...l, ...patch }; localStorage.setItem(KEY, JSON.stringify(n)); return n; }), []);
  const [view, setView] = useState<View>('editor');
  const [tabs, setTabs] = useState<Tab[]>([{ key: 'agent', kind: 'agent' }]);
  const [active, setActive] = useState('agent');
  const [bufs, setBufs] = useState<Record<string, Buffer>>({});
  const [files, setFiles] = useState<string[]>([]);
  const st = useLoad<any>(() => get('/api/state'), [tick]);
  const base = useLoad<any[]>(() => get('/api/agents'), []);
  const prov = useLoad<any[]>(() => get('/api/providers'), []);
  // One list of every agent AgentOnTrack can govern: the three it can set up itself, and the others it has adapters for.
  const ag = { ...base, data: base.data ? [...base.data, ...(prov.data ?? []).filter((p) => !base.data!.some((a) => a.id === p.id)).map((p) => ({ id: p.id, name: p.name, provider: true, installed: !!p.version, version: p.version, hooksInstalled: p.hooksInstalled, connect: p.connect, coverage: { hostFailMode: p.failure?.crash?.toLowerCase().includes('run') ? 'open' : 'closed' }, liveStatus: 'Not found on this machine' }))] : null, reload: () => { base.reload(); prov.reload(); } };
  const [err, setErr] = useState('');

  const openFile = useCallback(async (path: string) => {
    const key = `f:${path}`;
    setTabs((t) => (t.some((x) => x.key === key) ? t : [...t, { key, kind: 'file', path }]));
    setActive(key); setView('editor');
    try {
      const f = await get<{ path: string; content: string; hash: string; language: string }>(`/api/file?path=${encodeURIComponent(path)}`);
      setBufs((b) => (b[path] && b[path]!.content !== b[path]!.saved ? b : { ...b, [path]: { path, content: f.content, saved: f.content, hash: f.hash, language: f.language } }));
    } catch (e) {
      setTabs((t) => t.filter((x) => x.key !== key)); setActive('agent'); setErr((e as Error).message);
    }
  }, []);
  const openDiff = useCallback((wt: string, path: string) => {
    const key = `d:${wt}:${path}`;
    setTabs((t) => (t.some((x) => x.key === key) ? t : [...t, { key, kind: 'diff', wt, path }]));
    setActive(key); setView('editor');
  }, []);
  const close = (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (tab?.kind === 'file') { const b = bufs[tab.path]; if (b && b.content !== b.saved && !window.confirm(`${tab.path} has unsaved changes. Close it and lose them?`)) return; setBufs(({ [tab.path]: _gone, ...rest }) => rest); }
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    if (active === key) setActive(next.at(-1)?.key ?? 'agent');
  };

  // The commands the palette offers while a workspace is open, and the shortcuts that match them.
  const commands = useMemo<Command[]>(() => [
    { id: 'ws-left', label: 'Toggle the files sidebar', group: 'Workspace', hint: 'Ctrl B', run: () => setLayout({ showLeft: !layout.showLeft }) },
    { id: 'ws-right', label: 'Toggle the agents panel', group: 'Workspace', hint: 'Ctrl Shift B', run: () => setLayout({ showRight: !layout.showRight }) },
    { id: 'ws-bottom', label: 'Toggle the bottom panel', group: 'Workspace', hint: 'Ctrl J', run: () => setLayout({ showBottom: !layout.showBottom }) },
    { id: 'ws-agent', label: 'Go to the prompt composer', group: 'Workspace', run: () => { setActive('agent'); setView('editor'); } },
    { id: 'ws-reset', label: 'Reset the panel layout', group: 'Workspace', run: () => setLayout({ ...DEFAULT }) },
    ...RIGHT_TABS.map((t) => ({ id: `ws-r-${t}`, label: `Show ${t.toLowerCase()}`, group: 'Workspace', run: () => { setLayout({ showRight: true, rightTab: t }); setView('agents'); } })),
    ...BOTTOM_TABS.map((t) => ({ id: `ws-b-${t}`, label: `Show ${t.toLowerCase()} panel`, group: 'Workspace', run: () => { setLayout({ showBottom: true, bottomTab: t }); setView('panel'); } })),
    ...files.slice(0, 200).map((f) => ({ id: `file-${f}`, label: f, group: 'Open file', run: () => void openFile(f) })),
  ], [layout.showLeft, layout.showRight, layout.showBottom, files, openFile, setLayout]);
  useEffect(() => { setCommands(commands); return () => setCommands([]); }, [commands, setCommands]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'b' && e.shiftKey) { e.preventDefault(); setLayout({ showRight: !layout.showRight }); }
      else if (k === 'b') { e.preventDefault(); setLayout({ showLeft: !layout.showLeft }); }
      else if (k === 'j') { e.preventDefault(); setLayout({ showBottom: !layout.showBottom }); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [layout.showLeft, layout.showRight, layout.showBottom, setLayout]);

  if (!st.data || !ag.data) return <div style={{ padding: 20 }}><Loading error={st.error || ag.error} /></div>;
  const state = { team: { version: 0, members: [] }, ...st.data };
  const pending = state.approvals.filter((a: any) => a.view === 'pending').length;
  const tab = tabs.find((t) => t.key === active) ?? tabs[0]!;
  const style = { '--left': `${layout.left}px`, '--right': `${layout.right}px`, '--bottom': `${layout.bottom}px` } as CSSProperties;
  const cls = `ws${layout.showLeft ? '' : ' no-left'}${layout.showRight ? '' : ' no-right'}${layout.showBottom ? '' : ' no-bottom'}`;
  const reloadAll = () => { st.reload(); ag.reload(); };
  const toggle = (name: string, icon: IconName, on: boolean, fn: () => void) => <button className="icon-btn" aria-pressed={on} aria-label={name} title={name} onClick={fn}><Icon name={icon} size={16} /></button>;

  return (
    <div className={cls} style={style} data-view={view} data-testid="workspace">
      <aside className="ws-left" aria-label="Files and tasks">
        <div className="pane-head"><PaneTabs label="Sidebar" tabs={['Files', 'Tasks'] as const} tab={layout.leftTab} onTab={(t) => setLayout({ leftTab: t })} /></div>
        <div className="pane-body">{layout.leftTab === 'Files' ? <FileTree onOpen={(p) => void openFile(p)} current={tab.kind === 'file' ? tab.path : null} onLoaded={setFiles} /> : <TasksPane state={state} reload={st.reload} />}</div>
      </aside>
      <Splitter cls="split-v" label="Resize the files sidebar" value={layout.left} range={LIMITS.left} axis="x" grow={1} onChange={(n) => setLayout({ left: n })} />
      <section className="ws-center" aria-label="Work area">
        <div className="ws-bar">
          <div className="crumbs"><Icon name="folder" /> <b>{projectName}</b><span className="muted clip hide-m" title={state.goal?.statement}>{state.goal ? `— ${state.goal.statement}` : '— no goal set'}</span></div>
          {tab.kind !== 'agent' ? <button className="btn small" onClick={() => close(tab.key)} data-testid="ws-close-tab"><Icon name="x" size={14} />Close tab</button> : null}
          {pending ? <button className="btn small" onClick={() => { setLayout({ showRight: true, rightTab: 'Approvals' }); setView('agents'); }} data-testid="ws-pending"><Icon name="alert" size={14} />{pending} waiting</button> : null}
          <span className="hide-m" style={{ display: 'contents' }}>
            {toggle('Files sidebar', 'panelLeft', layout.showLeft, () => setLayout({ showLeft: !layout.showLeft }))}
            {toggle('Bottom panel', 'panelBottom', layout.showBottom, () => setLayout({ showBottom: !layout.showBottom }))}
            {toggle('Agents panel', 'panelRight', layout.showRight, () => setLayout({ showRight: !layout.showRight }))}
          </span>
        </div>
        <div className="editor-tabs" role="tablist" aria-label="Open items">
          {tabs.map((t) => {
            const dirty = t.kind === 'file' && bufs[t.path] && bufs[t.path]!.content !== bufs[t.path]!.saved;
            const name = t.kind === 'agent' ? 'Agent' : t.kind === 'file' ? t.path.split('/').pop()! : `Diff ${t.path.split('/').pop()}`;
            return (
              <button key={t.key} role="tab" className="etab" aria-selected={active === t.key} onClick={() => setActive(t.key)} onAuxClick={(e) => { if (e.button === 1 && t.kind !== 'agent') close(t.key); }} title={t.kind === 'file' ? t.path : undefined}>
                <Icon name={t.kind === 'agent' ? 'bot' : t.kind === 'diff' ? 'branch' : 'file'} size={14} />{name}{dirty ? <><span className="dot" aria-hidden="true" /><span className="sr-only"> unsaved</span></> : null}
              </button>
            );
          })}
        </div>
        {err ? <div className="alert bad" role="alert">{err} <button className="link" onClick={() => setErr('')}>Dismiss</button></div> : null}
        <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {tab.kind === 'agent' ? <AgentTab agents={ag.data} tick={tick} /> : null}
          {tab.kind === 'diff' ? <DiffView wt={tab.wt} path={tab.path} /> : null}
          {tab.kind === 'file' ? (bufs[tab.path] ? <Editor key={tab.path} buf={bufs[tab.path]!}
            onChange={(content) => setBufs((b) => ({ ...b, [tab.path]: { ...b[tab.path]!, content } }))}
            onSaved={(hash, saved) => setBufs((b) => ({ ...b, [tab.path]: { ...b[tab.path]!, hash, saved } }))}
            onReload={() => { setBufs(({ [tab.path]: _gone, ...rest }) => rest); void get<{ content: string; hash: string; language: string }>(`/api/file?path=${encodeURIComponent(tab.path)}`).then((f) => setBufs((b) => ({ ...b, [tab.path]: { path: tab.path, content: f.content, saved: f.content, hash: f.hash, language: f.language } }))); }} /> : <p className="muted" role="status" style={{ padding: 12 }}>Loading…</p>) : null}
        </div>
      </section>
      <Splitter cls="split-h" label="Resize the bottom panel" value={layout.bottom} range={LIMITS.bottom} axis="y" grow={-1} onChange={(n) => setLayout({ bottom: n })} />
      <section className="ws-bottom" aria-label="Output and evidence">
        <div className="pane-head"><PaneTabs label="Bottom panel" tabs={BOTTOM_TABS} tab={layout.bottomTab} onTab={(t) => setLayout({ bottomTab: t })} /></div>
        <div className="pane-body"><BottomPanel tab={layout.bottomTab} state={state} tick={tick} reloadState={st.reload} open={open} openDiff={openDiff} /></div>
      </section>
      <Splitter cls="split-v2" label="Resize the agents panel" value={layout.right} range={LIMITS.right} axis="x" grow={-1} onChange={(n) => setLayout({ right: n })} />
      <aside className="ws-right" aria-label="Agents and approvals">
        <div className="pane-head"><PaneTabs label="Agents panel" tabs={RIGHT_TABS} tab={layout.rightTab} onTab={(t) => setLayout({ rightTab: t })} /></div>
        <div className="pane-body"><RightPanel tab={layout.rightTab} agents={ag.data} state={state} reloadAgents={ag.reload} reloadState={reloadAll} tick={tick} /></div>
      </aside>
      <div className="mobile-tabs" role="group" aria-label="Workspace views">
        {([['files', 'folder', 'Files'], ['editor', 'file', 'Editor'], ['agents', 'users', 'Agents'], ['panel', 'terminal', 'Evidence']] as const).map(([v, icon, label]) => (
          <button key={v} aria-pressed={view === v} onClick={() => setView(v)}><Icon name={icon} size={18} />{label}{v === 'agents' && pending ? ` (${pending})` : ''}</button>))}
      </div>
    </div>
  );
}
