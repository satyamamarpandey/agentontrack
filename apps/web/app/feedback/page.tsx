'use client';
import { useEffect, useState } from 'react';
import Link from '../link';
import { ACCOUNTS_ENABLED, loadAccounts, SIGNED_IN_FLAG } from '../../lib/accounts-config';
import { cleanFeedback, MAX_CONTACT, MAX_MESSAGE, type Rating } from '../../lib/feedback';
import type { Access } from '../../lib/accounts';
import type { Api } from '../sign-in/panel';
import { TesterFeedbackForm } from './tester-form';

const ISSUES = 'https://github.com/satyamamarpandey/agentontrack/issues/new';

export default function FeedbackPage() {
  const [rating, setRating] = useState<Rating>(null);
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tester, setTester] = useState<{ api: Api; access: Access } | null>(null);
  const [checked, setChecked] = useState(!ACCOUNTS_ENABLED);

  // A signed-in tester gets the structured form. Nobody else loads Firebase before pressing Send.
  useEffect(() => {
    if (!loadAccounts || localStorage.getItem(SIGNED_IN_FLAG) !== '1') { setChecked(true); return; }
    loadAccounts().then(async (a) => { const access = await a.access(); if (access.member === 'active' || access.admin) setTester({ api: a, access }); }).catch(() => undefined).finally(() => setChecked(true));
  }, []);

  return (
    <article className="wrap article">
      <h1>Feedback</h1>
      {tester ? <>
        <p className="lead">You are an early-access tester. Bugs, ideas, rough edges and how it feels overall: all of it helps, and all of it reaches the maintainer directly.</p>
        <TesterFeedbackForm api={tester.api} email={tester.access.email} />
      </> : <>
        <p className="lead">Was AgentOnTrack helpful? Your feedback helps improve the tool. It is optional.</p>
        {!checked ? <p className="muted" role="status">One moment…</p> : null}
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
          <div className="seg" role="group" aria-label="Rating">
            <button type="button" aria-pressed={rating === 'helpful'} onClick={() => setRating('helpful')}>Helpful</button>
            <button type="button" aria-pressed={rating === 'not-helpful'} onClick={() => setRating('not-helpful')}>Not helpful</button>
          </div>
          <label>{rating === 'helpful' ? 'What worked well?' : rating === 'not-helpful' ? 'What should we improve?' : 'Your message'}<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} required maxLength={MAX_MESSAGE} /></label>
          <label>Contact (optional)<input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={MAX_CONTACT} autoComplete="off" name="contact" /></label>
          {error ? <p className="alert bad" role="alert">{error}</p> : null}
          {ACCOUNTS_ENABLED
            ? <p className="muted small">Send stores your message, rating and any contact in Firebase, on Google&apos;s servers, where only the maintainer can read them. No account is needed. Sending loads Firebase from Google, and nothing before that. Leave out anything private, such as code or paths. Early-access testers get a fuller form once they are signed in on the <Link href="/account">account page</Link>.</p>
            : <p className="muted small">Send opens a public GitHub issue with your message, and any contact you gave, for you to review and submit. It needs a GitHub account. Nothing is sent from this page. Leave out anything private, such as code or paths.</p>}
          <div><button className="btn primary" type="submit" disabled={busy}>Send</button></div>
        </form>}
      </>}
    </article>
  );
}
