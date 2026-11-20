import { useMemo, useState, type KeyboardEvent } from 'react';
import { get, isDemo, postStart } from './api';
import { Icon } from './icons';
import { DictationButton } from './dictation';
import { DEFAULT_LIMITS, LimitFields, limitsBody, type RunLimits } from './limits';
import { mayUseCredits, useDiscovery } from './model-field';
import { useLoad } from './ui';
import './home.css';

type Project = { id: string; name: string; missing?: boolean; archived?: boolean; goal?: string | null };
type Runtime = { id: string; name: string; canStart: boolean; reason?: string | null; dollarCap?: boolean };
type Session = { id: string; title?: string; runtime?: string; status?: string; updatedAt?: string };
type SessionList = { sessions: Session[] };

/** Examples only: choosing one fills the box. Nothing is sent until the person presses Start. */
const STARTERS = ['Explain how this project is organised', 'Find the cause of the failing test and fix it', 'Review my uncommitted changes and list problems', 'Write tests for the code I changed last'];

export function Home({
  projects,
  selectedProject,
  tick,
  onProject,
  onStarted,
  onSessions,
  onProjects,
  onAgents,
  onWorkspace,
}: {
  projects: Project[];
  selectedProject: string;
  tick: number;
  onProject: (id: string) => void;
  onStarted: (id: string) => void;
  onSessions: (id: string) => void;
  onProjects: () => void;
  onAgents: () => void;
  onWorkspace: () => void;
}) {
  const runtimes = useLoad<Runtime[]>(() => get('/api/runtimes'), [tick]);
  const discovery = useDiscovery(tick);
  const sessions = useLoad<SessionList>(() => get('/api/agent-sessions?archived=1'), [tick]);
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntime] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<'standard' | 'read-only'>('standard');
  const [limits, setLimits] = useState<RunLimits>(DEFAULT_LIMITS);
  const [acceptCredits, setAcceptCredits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = (runtimes.data ?? []).filter((r) => r.canStart);
  const selectedRuntime = runtime || available[0]?.id || '';
  const selected = (runtimes.data ?? []).find((r) => r.id === selectedRuntime);
  const models = useMemo(() => (discovery.data?.models ?? []).filter((m) => m.agent === selectedRuntime), [discovery.data, selectedRuntime]);
  const needsCredits = mayUseCredits(selectedRuntime, model);
  const validProject = projects.some((p) => p.id === selectedProject && !p.missing);
  const cannotSend = busy || !prompt.trim() || !validProject || !selected?.canStart || isDemo() || (needsCredits && !acceptCredits);
  const recent = (sessions.data?.sessions ?? []).slice(0, 4);
  const noAgent = !runtimes.error && runtimes.data !== null && available.length === 0;
  const send = async () => {
    if (cannotSend) return;
    if (prompt.trimStart().startsWith('-')) { setError('A prompt cannot begin with a hyphen.'); return; }
    setBusy(true); setError('');
    try {
      const r = await postStart<{ sessionId: string }>('/api/agent-sessions', {
        runtime: selectedRuntime,
        prompt: prompt.trim(),
        ...(model ? { model } : {}),
        policy: mode,
        ...limitsBody(limits, !!selected?.dollarCap),
        acceptUsageCredits: needsCredits && acceptCredits,
      });
      setPrompt(''); setAcceptCredits(false);
      onStarted(r.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The session could not start.');
    } finally { setBusy(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); }
  };
  return (
    <div className="aot-home" data-testid="home-screen">
      <div className="aot-home-center">
        <div className="aot-home-mark" aria-hidden="true"><Icon name="target" size={28} /></div>
        <h1>What are you working on?</h1>
        <p className="aot-home-intro">One project. Your choice of agents. Every important action stays under your control.</p>

        {projects.length === 0 ? (
          <section className="aot-home-empty">
            <h2>Start with a project</h2>
            <p>Connect a folder or create a project to give your agents a place to work.</p>
            <button className="btn primary" onClick={onProjects}>Add a project</button>
          </section>
        ) : (
          <form className="aot-home-composer" aria-label="Start an AI agent task" data-testid="home-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="aot-home-prompt">What should your agent do?</label>
            <textarea id="aot-home-prompt" name="home-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={key} placeholder="Ask your agent to build, fix, research, or review something…" />
            {error ? <p className="alert bad" role="alert">{error}</p> : null}
            <div className="aot-home-tools">
              <label className="aot-home-picker">Project
                <select value={selectedProject} onChange={(e) => onProject(e.target.value)} name="home-project" aria-label="Choose project">
                  {projects.filter((p) => !p.missing && !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="aot-home-picker">Agent
                <select value={selectedRuntime} onChange={(e) => { setRuntime(e.target.value); setModel(''); setAcceptCredits(false); }} name="home-agent" aria-label="Choose agent">
                  {available.length === 0 ? <option value="">None connected</option> : null}
                  {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label className="aot-home-picker">Model
                <select value={model} onChange={(e) => { setModel(e.target.value); setAcceptCredits(false); }} name="home-model" aria-label="Choose model">
                  <option value="">Auto</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.entitlement === 'worked' ? ' · tested' : ' · availability unverified'}</option>)}
                </select>
              </label>
              <button type="submit" className="btn primary aot-home-send" disabled={cannotSend} data-testid="home-start">{busy ? 'Starting…' : 'Start'} <Icon name="play" size={14} /></button>
            </div>
            {needsCredits ? <label className="aot-home-credits"><input type="checkbox" checked={acceptCredits} onChange={(e) => setAcceptCredits(e.target.checked)} /> This model may charge additional usage credits. I agree for this run only.</label> : null}
            <details className="aot-home-more">
              <summary>More options</summary>
              <div className="aot-home-options">
                <label>Task permissions
                  <select value={mode} onChange={(e) => setMode(e.target.value as 'standard' | 'read-only')} name="home-mode">
                    <option value="standard">Allow work within approved goal</option>
                    <option value="read-only">Read-only planning</option>
                  </select>
                </label>
                <LimitFields value={limits} onChange={setLimits} dollarCap={!!selected?.dollarCap} name="home" />
              </div>
            </details>
            {noAgent && !isDemo() ? <p className="aot-home-noagent" role="status" data-testid="home-no-agent">No agent on this computer is ready to start work. <button type="button" className="link" onClick={onAgents}>Open Agents</button> to see what is installed and the official install steps.</p> : null}
            <div className="aot-home-hint">
              <span>{isDemo() ? 'Demo mode cannot start real agents.' : !selected?.canStart ? 'Connect an agent to start.' : !validProject ? 'Choose an available project.' : 'Ctrl or Cmd + Enter to start. Consequential actions require approval.'}</span>
              <div className="aot-home-mic"><DictationButton onText={(text) => setPrompt((p) => p + (p && !/\s$/.test(p) ? ' ' : '') + text)} /></div>
            </div>
          </form>
        )}

        {projects.length > 0 ? <div className="aot-home-starters" aria-label="Example prompts" data-testid="home-starters">
          {STARTERS.map((s) => <button key={s} type="button" onClick={() => setPrompt(s)}>{s}</button>)}
        </div> : null}

        <div className="aot-home-quick" aria-label="Quick actions">
          {recent[0] ? <button onClick={() => onSessions(recent[0]!.id)} data-testid="home-continue"><Icon name="play" size={15} /> Continue last session</button> : null}
          <button onClick={onProjects}><Icon name="folder" size={15} /> My projects</button>
          <button onClick={onWorkspace}><Icon name="terminal" size={15} /> Open workspace</button>
          <button onClick={onAgents}><Icon name="bot" size={15} /> Connect an agent</button>
        </div>

        <section className="aot-home-recents" aria-label="Recent sessions">
          <div className="aot-home-recents-head">
            <h2>Recent sessions</h2>
            <button className="link" onClick={() => onSessions('')}>View all</button>
          </div>
          {recent.length > 0 ? <ul>{recent.map((s) => (
            <li key={s.id}>
              <button onClick={() => onSessions(s.id)}>
                <Icon name="message" size={15} />
                <span>{s.title || 'Untitled session'}</span>
                <small>{s.status || 'Recorded'}</small>
              </button>
            </li>
          ))}</ul> : <p className="muted small">{sessions.error ? 'Recent sessions are unavailable. Open the workspace to continue.' : 'Your tasks will appear here after you start a session.'}</p>}
        </section>
      </div>
    </div>
  );
}
