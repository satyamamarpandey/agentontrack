'use client';
import { useState } from 'react';
import { Icon } from '../ui/icons';
import { OS_OPTIONS } from '../../lib/early-access';
import type { TesterFeedback } from '../../lib/accounts';
import type { Api } from '../sign-in/panel';

const KINDS: [TesterFeedback['kind'], string][] = [['bug', 'Bug report'], ['feature', 'Feature request'], ['ui', 'Interface feedback'], ['connector', 'Connector compatibility'], ['experience', 'Overall experience']];
const CONNECTORS = ['Claude Code', 'Codex', 'Hermes', 'Gemini CLI', 'Cursor', 'Copilot', 'Devin', 'OpenCode', 'Kiro', 'Cline', 'Local model server', 'Other'];

/** For approved testers: structured feedback with the facts the maintainer needs, and diagnostics only when the tester pastes them in and ticks the box. */
export function TesterFeedbackForm({ api, email }: { api: Api; email: string | null }) {
  const [kind, setKind] = useState<TesterFeedback['kind']>('bug');
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState('');
  const [os, setOs] = useState('');
  const [connector, setConnector] = useState('');
  const [diagnostics, setDiagnostics] = useState('');
  const [includeDiag, setIncludeDiag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) return <p className="panel" role="status" data-testid="feedback-sent">Thank you. Your feedback reached the maintainer. <button type="button" className="link" onClick={() => { setSent(false); setMessage(''); setDiagnostics(''); setIncludeDiag(false); setRating(0); }}>Send another</button></p>;
  return (
    <form className="form" data-testid="tester-feedback-form" onSubmit={async (e) => {
      e.preventDefault(); setError('');
      const m = message.trim();
      if (!m) { setError('Write a message first.'); return; }
      setBusy(true);
      try {
        const f: TesterFeedback = { kind, message: m };
        if (rating) f.rating = rating;
        if (version.trim()) f.version = version.trim();
        if (os) f.os = os as TesterFeedback['os'];
        if (connector) f.connector = connector;
        if (includeDiag && diagnostics.trim()) f.diagnostics = diagnostics.trim();
        await api.sendTesterFeedback(f);
        setSent(true);
      } catch (err) { setError(api.explain(err)); } finally { setBusy(false); }
    }}>
      <fieldset>
        <legend>What is this about?</legend>
        <div className="choices">{KINDS.map(([id, label]) => <label key={id} className="choice"><input type="radio" name="kind" value={id} checked={kind === id} onChange={() => setKind(id)} />{label}</label>)}</div>
      </fieldset>
      {kind === 'experience' ? (
        <fieldset>
          <legend>How is it going overall?<small>1 is poor, 5 is excellent.</small></legend>
          <div className="row" role="radiogroup" aria-label="Rating out of five">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={`btn small ${rating >= n ? 'primary' : ''}`} role="radio" aria-checked={rating === n} aria-label={`${n} out of 5`} onClick={() => setRating(n)}>{rating >= n ? '★' : '☆'}</button>)}</div>
        </fieldset>
      ) : null}
      <label>Your message<textarea rows={6} value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={4000} placeholder={kind === 'bug' ? 'What you did, what you expected, what happened instead.' : ''} /></label>
      <div className="two">
        <label>AgentOnTrack version<span className="hint">From <code>agentontrack self status</code>.</span><input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={40} placeholder="1.0.0-rc.7" /></label>
        <label>Operating system<select value={os} onChange={(e) => setOs(e.target.value)}><option value="">Choose one</option>{OS_OPTIONS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></label>
      </div>
      {kind === 'connector' || kind === 'bug' ? <label>Connector or agent involved<select value={connector} onChange={(e) => setConnector(e.target.value)}><option value="">Not about one agent</option>{CONNECTORS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label> : null}
      <details className="small">
        <summary>Attach diagnostics (optional)</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <p className="muted">Paste the output of <code>agentontrack doctor</code>, or the error text. Read it first: remove paths, names or anything private that you do not want the maintainer to see. Nothing is collected automatically.</p>
          <textarea rows={6} value={diagnostics} onChange={(e) => setDiagnostics(e.target.value)} maxLength={6000} aria-label="Diagnostics" />
          <label className="check"><input type="checkbox" checked={includeDiag} onChange={(e) => setIncludeDiag(e.target.checked)} /> I have read what I pasted and agree to send it with this report.</label>
        </div>
      </details>
      {error ? <p className="alert bad" role="alert">{error}</p> : null}
      <p className="muted small">Sent to Firebase, where only the maintainer reads it, together with your account id{email ? ` and ${email}` : ''} so they can reply. Version, system and connector help reproduce what you saw.</p>
      <div><button className="btn primary" type="submit" disabled={busy}><Icon name="arrow-right" size={16} />{busy ? 'Sending…' : 'Send feedback'}</button></div>
    </form>
  );
}
