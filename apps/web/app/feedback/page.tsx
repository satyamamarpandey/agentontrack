'use client';
import { useState } from 'react';
import { ACCOUNTS_ENABLED, loadAccounts } from '../../lib/accounts-config';
import { cleanFeedback, MAX_CONTACT, MAX_MESSAGE, type Rating } from '../../lib/feedback';

const ISSUES = 'https://github.com/satyamamarpandey/agentontrack/issues/new';

export default function FeedbackPage() {
  const [rating, setRating] = useState<Rating>(null);
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <article className="wrap article">
      <h1>Feedback</h1>
      <p className="lead">Was AgentOnTrack helpful? Your feedback helps improve the tool. It is optional.</p>
      {sent ? <p className="panel" role="status" data-testid="feedback-sent">Thank you. Your feedback was saved.</p> : <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          const f = cleanFeedback(rating, body, contact);
          if (loadAccounts) {
            setBusy(true);
            await (await loadAccounts()).sendFeedback(f);
            setSent(true);
            return;
          }
          // With no accounts on this build, feedback goes to a GitHub issue, which is public and needs a GitHub account.
          const text = `${f.rating ? `Rating: ${f.rating}\n\n` : ''}${f.message}${f.contact ? `\n\nContact: ${f.contact}` : ''}`;
          window.location.href = `${ISSUES}?title=${encodeURIComponent(`Feedback: ${f.rating ?? 'general'}`)}&body=${encodeURIComponent(text)}`;
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}>
        <div className="row" role="group" aria-label="Rating">
          <button type="button" className={`btn small ${rating === 'helpful' ? 'primary' : ''}`} aria-pressed={rating === 'helpful'} onClick={() => setRating('helpful')}>Helpful</button>
          <button type="button" className={`btn small ${rating === 'not-helpful' ? 'primary' : ''}`} aria-pressed={rating === 'not-helpful'} onClick={() => setRating('not-helpful')}>Not helpful</button>
        </div>
        <label>{rating === 'helpful' ? 'What worked well?' : rating === 'not-helpful' ? 'What should we improve?' : 'Your message'}<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} required maxLength={MAX_MESSAGE} /></label>
        <label>Contact (optional)<input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={MAX_CONTACT} autoComplete="off" name="contact" /></label>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        {ACCOUNTS_ENABLED
          ? <p className="muted small">Send stores your message, rating and any contact in Firebase, on Google&apos;s servers, where only the maintainer can read them. No sign-in is needed. Sending loads Firebase from Google, and nothing before that. Leave out anything private, such as code or paths.</p>
          : <p className="muted small">Send opens a public GitHub issue with your message, and any contact you gave, for you to review and submit. It needs a GitHub account. Nothing is sent from this page. Leave out anything private, such as code or paths.</p>}
        <div><button className="btn primary" type="submit" disabled={busy}>Send</button></div>
      </form>}
    </article>
  );
}
