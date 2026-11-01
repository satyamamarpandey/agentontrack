import { Article } from '../content';
import { ADVISORY } from '../../lib/release';

export const metadata = { title: 'Security' };

export default function Security() {
  return (
    <Article title="Security" intro="What is protected, against whom, and where it stops. Reports are welcome.">
      <h2>What it does, by outcome</h2>
      <p>Protected means the action never ran. Detected means it already happened. They are never merged.</p>
      <div className="table-wrap" tabIndex={0}><table data-testid="coverage-table">
        <thead><tr><th scope="col">Situation</th><th scope="col">Outcome</th><th scope="col">Note</th></tr></thead>
        <tbody>
          <tr><th scope="row">Recognised consequential commands: push, deploy, publish, upload</th><td>Protected</td><td>Held until you approve. Bound to one effect, task, goal version, policy version and runtime</td></tr>
          <tr><th scope="row">File writes through file tools, and most shell commands</th><td>Protected</td><td>Checked against the goal's scope first</td></tr>
          <tr><th scope="row">Opaque programs, in the strict profile</th><td>Protected</td><td>Held for approval. Strict mode blocks a lot: 17 block candidates in 21 benchmark runs</td></tr>
          <tr><th scope="row">An agent approving itself</th><td>Protected</td><td>No MCP tool grants approval. Human commands need a terminal, and the passphrase if enrolled</td></tr>
          <tr><th scope="row">An outside web page changing anything</th><td>Protected</td><td>Needs a pairing code, then a fresh code shown only in your terminal for each change</td></tr>
          <tr><th scope="row">File changes by scripts inside the project</th><td>Detected</td><td>After they happen. Reversed in the strict profile</td></tr>
          <tr><th scope="row">Changes to a short list of sensitive files outside the project</th><td>Detected</td><td>After they happen</td></tr>
          <tr><th scope="row">Edits to the log that miss the witness file</th><td>Detected</td><td>Approvals are suspended until recovery</td></tr>
          <tr><th scope="row">A weak check, such as a placeholder test</th><td>Detected</td><td>Recognisable weak checks withhold VERIFIED until strengthened or accepted by a human. It is a heuristic: a check it does not recognise can still pass</td></tr>
          <tr><th scope="row">Network and process effects of a script, in the standard profile</th><td><b>Not covered</b></td><td>Not seen and not stopped without an OS sandbox</td></tr>
          <tr><th scope="row">A same-user program that rewrites both the log and the witness</th><td><b>Not covered</b></td><td>Unless you set up the optional external anchor</td></tr>
          <tr><th scope="row">A test hollowed out while keeping its counts</th><td><b>Not covered</b></td><td></td></tr>
          <tr><th scope="row">Tools a runtime does not route through hooks</th><td><b>Not covered</b></td><td></td></tr>
          <tr><th scope="row">A determined program running as you</th><td><b>Not covered</b></td><td>This is not a security boundary against that</td></tr>
        </tbody>
      </table></div>

      <h2 id="host-failure">If the hook program cannot run</h2>
      <p>This is decided by the agent runtime, not by AgentOnTrack.</p>
      <div className="table-wrap" tabIndex={0}><table data-testid="failure-table">
        <thead><tr><th scope="col">Runtime</th><th scope="col">Failure mode</th><th scope="col">Evidence</th></tr></thead>
        <tbody>
          <tr><th scope="row">Claude Code 2.1.316</th><td>Fails closed: the action is blocked</td><td>Observed on the real host, with <code>onFailure: block</code>. With <code>onFailure: continue</code>, as a control, it failed open</td></tr>
          <tr><th scope="row">Codex 0.166.0</th><td><b>FAILS OPEN: the action runs anyway</b></td><td>Observed on the real host. Codex has no documented fail-closed setting. <code>agentontrack run codex</code> tests the hook before starting it, which does not help if the hook breaks later</td></tr>
          <tr><th scope="row">Hermes 0.22.5</th><td>Blocks, with <code>fail_closed: true</code></td><td>Observed on the real program, with a scripted model. Its default fails open</td></tr>
        </tbody>
      </table></div>

      <h2>Scripts and the network</h2>
      <p>In the standard profile, a script's network activity is not seen or stopped. Containment needs an OS sandbox, or the strict profile, which holds scripts for approval instead.</p>
      <ul>
        <li><b>Claude Code on Linux and macOS:</b> <code>agentontrack install claude-code --sandbox</code>. <b>Verified on macOS</b>: an ordinary command ran, and a script's network use and write to the home folder were blocked. <b>Not verified on Linux</b>: it could not start on the test runner. Claude Code has no OS sandbox on native Windows.</li>
        <li><b>Codex:</b> <code>agentontrack run codex</code> starts it in its own workspace sandbox, with network off unless you add <code>--allow-network</code>, and <code>/tmp</code> closed. Verified on Linux.</li>
        <li><b>Hermes:</b> none.</li>
      </ul>

      <h2>External anchor</h2>
      <p>Optional. <code>agentontrack anchor config --remote &lt;git url&gt;</code>, then <code>anchor push</code> and <code>anchor verify</code>. It is the only way to catch a same-user rewrite of both log and witness, and it proves little unless the remote refuses force-pushes.</p>

      <h2>Verification</h2>
      <p>VERIFIED means your checks passed on the current code, and is only as good as those checks. Recognisable weak checks withhold it. A human can accept them with <code>agentontrack task accept-weak</code>, or in the dashboard, and that is recorded.</p>

      <h2>Local dashboard</h2>
      <p>It listens on loopback only. Knowing the port grants nothing: it checks Host and Origin, needs a pairing code that works once, a strict HttpOnly cookie and a CSRF token, and each human action needs a fresh confirmation code.</p>

      <h2 id="outside-origin">This website and your machine</h2>
      <p>The site is static, with no account and no server. Its dashboard connects only to a companion you started with <code>--allow-public-site</code> and paired with a code. That setting trusts the origins <code>pandeysatyam.com</code> and <code>satyamamarpandey.github.io</code>, which everything else on those origins shares.</p>
      <p>So a session from an outside origin gets no confirmation codes. Every change it asks for shows a code in your terminal, tied to that exact request, and describes the request there. Check it before typing the code. A compromised page can read what a paired session can read, but it cannot change anything alone.</p>

      <h2>Reporting</h2>
      <p>Report vulnerabilities through <a href={ADVISORY}>a private GitHub security advisory</a>.</p>
    </Article>
  );
}
