'use client';
import { useState } from 'react';

const ISSUES = 'https://github.com/satyamamarpandey/agentontrack/issues/new';

export default function FeedbackPage() {
  const [rating, setRating] = useState<'helpful' | 'not-helpful' | null>(null);
  const [body, setBody] = useState('');
  return (
    <article className="wrap article">
      <h1>Feedback</h1>
      <p className="lead">Was AgentOnTrack helpful? Your feedback helps improve the tool. It is optional.</p>
      <form className="form" onSubmit={(e) => {
        e.preventDefault();
        // This site has no backend, so feedback goes to a GitHub issue, which is public and needs a GitHub account.
        const text = `${rating ? `Rating: ${rating}\n\n` : ''}${body}`;
        window.location.href = `${ISSUES}?title=${encodeURIComponent(`Feedback: ${rating ?? 'general'}`)}&body=${encodeURIComponent(text)}`;
      }}>
        <div className="row" role="group" aria-label="Rating">
          <button type="button" className={`btn small ${rating === 'helpful' ? 'primary' : ''}`} aria-pressed={rating === 'helpful'} onClick={() => setRating('helpful')}>Helpful</button>
          <button type="button" className={`btn small ${rating === 'not-helpful' ? 'primary' : ''}`} aria-pressed={rating === 'not-helpful'} onClick={() => setRating('not-helpful')}>Not helpful</button>
        </div>
        <label>{rating === 'helpful' ? 'What worked well?' : rating === 'not-helpful' ? 'What should we improve?' : 'Your message'}<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} required /></label>
        <p className="muted small">Send opens a public GitHub issue with your message, for you to review and submit. It needs a GitHub account. Nothing is sent from this page. Leave out anything private, such as code or paths.</p>
        <button className="btn primary" type="submit">Send</button>
      </form>
    </article>
  );
}
