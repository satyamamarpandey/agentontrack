import { Article } from '../content';

export const metadata = { title: 'Privacy' };

export default function Privacy() {
  return (
    <Article title="Privacy" intro="Plain terms. Draft pending legal review.">
      <h2>The program</h2>
      <p>Nothing leaves your machine. Source code, prompts, transcripts, commands, records and credentials stay local. There are no accounts, no analytics, no telemetry and no server of ours to send anything to.</p>
      <p>Three things use the network, and only when you ask:</p>
      <ul>
        <li><code>agentontrack self upgrade</code> and the installers download release files from GitHub.</li>
        <li><code>agentontrack anchor push</code>, if you configured an anchor, sends the log's latest hash, sequence number and time to the git remote you chose. Not its contents.</li>
        <li><code>agentontrack probe</code> calls the model address you give it.</li>
      </ul>
      <p>Your agent talks to its own provider, under its own login and terms. AgentOnTrack does not see, proxy or store that login.</p>
      <h2>This website</h2>
      <p>The site is static, served by GitHub Pages. It makes no third-party requests, sets no cookies and runs no analytics. GitHub, which hosts it, may keep its own server logs.</p>
      <p>The dashboard page keeps your light or dark choice in this browser. Once paired, it talks only to the companion on your own computer, and holds the session token in this tab. Nothing goes through this website.</p>
      <h2>Feedback</h2>
      <p>Feedback opens a prefilled GitHub issue. Nothing is sent until you submit it there, and an issue is public under your GitHub account. The dashboard's own feedback form saves on your machine only.</p>
    </Article>
  );
}
