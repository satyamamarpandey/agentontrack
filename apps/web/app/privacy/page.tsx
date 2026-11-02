import { ACCOUNTS_ENABLED } from '../../lib/accounts-config';
import { Article } from '../content';

export const metadata = { title: 'Privacy' };

export default function Privacy() {
  return (
    <Article title="Privacy" intro="Plain terms. Draft pending legal review.">
      <h2>The program</h2>
      <p>Nothing leaves your machine. Source code, prompts, transcripts, commands, records and credentials stay local. The program has no accounts, no analytics, no telemetry and no server of ours to send anything to.</p>
      <p>Three things use the network, and only when you ask:</p>
      <ul>
        <li><code>agentontrack self upgrade</code> and the installers download release files from GitHub.</li>
        <li><code>agentontrack anchor push</code>, if you configured an anchor, sends the log's latest hash, sequence number and time to the git remote you chose. Not its contents.</li>
        <li><code>agentontrack probe</code> calls the model address you give it.</li>
      </ul>
      <p>Your agent talks to its own provider, under its own login and terms. AgentOnTrack does not see, proxy or store that login.</p>
      <h2>This website</h2>
      <p>The site is static, served by GitHub Pages. {ACCOUNTS_ENABLED ? 'For a visitor who does not sign in or send feedback, it makes no third-party requests.' : 'It makes no third-party requests.'} It sets no cookies and runs no analytics. GitHub, which hosts it, may keep its own server logs.</p>
      <p>The dashboard page keeps your light or dark choice in this browser. Once paired, it talks only to the companion on your own computer, and holds the session token in this tab. Nothing goes through this website.</p>
      <h2>Feedback</h2>
      {ACCOUNTS_ENABLED
        ? <p>Feedback on this site is stored in Firebase, a Google service, with your rating, your message and any contact you give. No sign-in is needed, and only the maintainer can read it. Pressing Send loads Firebase, so Google receives your address as it would from any site. The dashboard's own feedback form saves on your machine only.</p>
        : <p>Feedback opens a prefilled GitHub issue. Nothing is sent until you submit it there, and an issue is public under your GitHub account. The dashboard's own feedback form saves on your machine only.</p>}
      {ACCOUNTS_ENABLED ? <>
        <h2>Optional accounts</h2>
        <p>You never need an account. Everything on this site and in the program works without one. If you sign in with Google, Google and Firebase become third parties for you. For anyone who does not sign in, they are not, unless you send feedback as described above.</p>
        <p><b>What is stored,</b> in Firebase on Google's servers, under your own account: your name and email from Google, your theme, feedback you send while signed in, and any project summary you choose to save.</p>
        <p><b>A project summary</b> is off by default, shows a preview first, and holds only a label you type, totals and pass rates. Code, prompts, paths, commands and project records are never sent.</p>
        <p><b>Export or delete</b> all of it on <a href="../account/">the account page</a>. Deleting removes those records and your sign-in. Feedback sent while signed out is not linked to you, so ask through the <a href="../feedback/">feedback page</a> or a GitHub issue to have it removed.</p>
      </> : null}
    </Article>
  );
}
