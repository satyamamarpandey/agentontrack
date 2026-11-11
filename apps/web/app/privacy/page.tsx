import { ACCOUNTS_ENABLED, INSTALL_GATED } from '../../lib/accounts-config';
import { Article } from '../content';

export const metadata = { title: 'Privacy' };

export default function Privacy() {
  return (
    <Article title="Privacy" intro="Plain terms. Draft pending legal review.">
      <h2>The program</h2>
      <p>No AgentOnTrack account is required for local use. AgentOnTrack does not upload your local project records: source code, prompts, transcripts, commands, records and credentials stay on your machine unless you choose to send them. Apart from the optional cloud features described below, the program sends no project data to any server of ours, and it has no analytics.</p>
      <p>Your agent talks to its own provider, under its own login and terms. When you use Claude Code or Codex, what the agent reads, writes and runs is processed by that provider. AgentOnTrack does not see, proxy or store that login.</p>
      <p>Three things use the network, and only when you ask:</p>
      <ul>
        <li><code>agentontrack self upgrade</code> and the installers download release files from GitHub.</li>
        <li><code>agentontrack anchor push</code>, if you configured an anchor, sends the log's latest hash, sequence number and time to the git remote you chose. Not its contents.</li>
        <li><code>agentontrack probe</code> calls the model address you give it.</li>
      </ul>
      {ACCOUNTS_ENABLED
        ? <p>Separately, this site has optional cloud features that can send data if you choose to use them: applying for early access, signing in, saving a project summary, controlling a project from a phone, sending tester feedback, and sharing anonymous usage counts (off unless you turn it on, with a preview of exactly what would be sent). They are <b>experimental</b>. The account, application and invitation features run on a real Firebase project; the phone link has been tested against local emulators and has not been run on a physical phone. They are described under Early access, Feedback and Optional accounts and cloud features below.</p>
        : <p>This build of the site has no optional cloud features.</p>}
      <h2>This website</h2>
      <p>The site is static, served by GitHub Pages over HTTPS. {ACCOUNTS_ENABLED ? 'For a visitor who does not apply, sign in or send feedback, it makes no third-party requests.' : 'It makes no third-party requests.'} It sets no cookies and runs no analytics. Its fonts are served from the site's own files. GitHub, which hosts it, may keep its own server logs.</p>
      <p>The dashboard page keeps your light or dark choice in this browser. Once paired, it talks only to the companion on your own computer, and holds the session token in this tab. Nothing goes through this website.</p>
      {ACCOUNTS_ENABLED ? <>
        <h2>Early access</h2>
        <p><b>Applying.</b> The early-access form asks for your name and email, and optionally your organization and role; the operating systems and agent tools you use; what you want AgentOnTrack for; how often you use coding agents; your biggest challenge; and why you want early access. Submitting it loads Firebase, a Google service, and stores those answers there, where only the maintainer can read them. They are used to choose and invite testers and to decide which connectors to build next, and for nothing else. They are not sold or shared. One application is kept per address. Agreeing to occasional product updates is a separate, optional tick; nothing is pre-ticked, and we do not send email from the site at all: any message comes from the maintainer personally.</p>
        <p><b>Invitations.</b> If you are chosen, the maintainer sends you a personal link. The site stores a one-way hash of that link's code, the address it is for, when it was made and when it expires, and later whether it was used. Using it needs an account with that address, confirmed. That creates a membership record: your address, your account id, which invitation you used, and the date.</p>
        <p><b>Testers.</b> Approved testers can send structured feedback (the kind of report, a rating, a message, and optionally the version, operating system and connector involved, and diagnostics you paste in yourself and agree to send). It is stored with your account id and address so the maintainer can reply.</p>
        <p><b>Administration.</b> The maintainer's reviewing actions (approve, reject, invite, revoke, notes, exports) are written to an audit log that cannot be edited from a browser. The maintainer can export the applications to a file on their own computer.</p>
        <p><b>Withdrawing.</b> You can delete your application yourself by signing in with the same address on the account page, and delete your account there too. Your application is deleted by you or on your request; membership and audit records are kept while early access lasts, so that access stays accountable, and are then removed. To ask for anything to be removed, use the <a href="../feedback/">feedback page</a>.</p>
        {INSTALL_GATED ? <p><b>Access.</b> While early access lasts, the install steps and this site's dashboard connection step are shown to approved testers. The source code and releases are public on GitHub regardless.</p> : null}
      </> : null}
      <h2>Feedback</h2>
      {ACCOUNTS_ENABLED
        ? <p>Feedback on this site is stored in Firebase, a Google service, with your rating, your message and any contact you give. No account is needed, and only the maintainer can read it. Pressing Send loads Firebase, so Google receives your address as it would from any site. The dashboard's own feedback form saves on your machine only.</p>
        : <p>Feedback opens a prefilled GitHub issue. Nothing is sent until you submit it there, and an issue is public under your GitHub account. The dashboard's own feedback form saves on your machine only.</p>}
      {ACCOUNTS_ENABLED ? <>
        <h2>Optional accounts and cloud features (experimental)</h2>
        <p>You never need an account to use the program. Everything in it works without one. An account on this site is for early access and the cloud features below. If you sign in with Google, Google and Firebase become third parties for you. For anyone who does not sign in, they are not, unless you apply or send feedback as described above.</p>
        <p><b>What is stored,</b> in Firebase on Google's servers, under your own account: your name and email, your theme, feedback you send while signed in, and any project summary you choose to save.</p>
        <p><b>A project summary</b> is off by default, shows a preview first, and holds only a label you type, totals and pass rates. Code, prompts, paths, commands and project records are never sent.</p>
        <p><b>Phone control</b> is off unless you link a computer from the dashboard. When you do, the computer makes a limited Firebase sign-in of its own, and project status, files and diffs you open from the phone, and the prompts and controls you send, travel through Firebase as messages that are signed and encrypted with keys Firebase never sees. Google holds sealed messages and can see when they exist and how large they are, not what is in them. Firebase has no authority to run anything: your computer checks every request itself. Revoke the phone or unlink the computer to stop it. This design has been tested against local emulators only. It has not been reviewed independently and has not been run on a physical phone.</p>
        <p><b>Anonymous usage counts</b> are separate from any account and off unless you turn them on in the dashboard. At most once a week they would send the week, the version, the names of the agent programs you have connected, how many tasks were verified and how many exist, and how many days you used it, with a random id made in your browser that is not tied to you, your computer or an account. They never include code, prompts, paths, goals, commands, conversations or credentials, and the dashboard shows exactly what would be sent before you agree. They are stored in Firebase. Once sent, nobody can read, change or delete them from the site, and they are not linked to you. Turning the setting off deletes the random id from your browser, so they stay as anonymous counts. Nothing is sent from a site built without the cloud setup.</p>
        <p><b>Export or delete</b> your account's data (your name, email, theme, feedback sent while signed in, and any saved project summary) on <a href="../account/">the account page</a>. Deleting removes those records and your sign-in. This does not cover anonymous usage counts, which cannot be deleted once sent, or the short-lived sealed phone messages (requests last at most ten minutes, and status snapshots are replaced by newer ones). Feedback sent while signed out is not linked to you, so ask through the <a href="../feedback/">feedback page</a> or a GitHub issue to have it removed.</p>
      </> : null}
    </Article>
  );
}
