import { Article, ReleaseNotice, Term } from '../content';
import Link from '../link';

export const metadata = { title: 'Documentation' };

export default function Docs() {
  return (
    <Article title="Documentation" intro="Get running, then look things up.">
      <h2 id="install">Install</h2>
      <ReleaseNotice />
      <p>Commands for each system, manual download, checksums, upgrade, rollback and uninstall are on <Link href="/install">the install page</Link>. The dashboard demo on this site works with no install.</p>
      <Term label="First run in a project">{`cd your-project
agentontrack setup
agentontrack doctor`}</Term>
      <h2 id="connect">Connect this website to your machine</h2>
      <p>The dashboard on this site can talk to the companion on your own computer. Nothing goes through this website. It is off until you ask for it, and needs a one-time code:</p>
      <Term label="Allow this site">{`agentontrack dashboard --allow-public-site
# prints a pairing code; open the Dashboard link above and enter it`}</Term>
      <p>Each change you make from this site then asks for another code, shown only in that terminal. The terminal also describes the request: check it before typing the code. <Link href="/security#outside-origin">Why it works this way</Link>.</p>
      <p><b>If your browser blocks it.</b> Your browser may ask to allow local network access, which this connection needs. If you deny it, allow it again in the browser's site settings, or use the local address <code>agentontrack dashboard</code> prints, such as <code>http://127.0.0.1:47631/</code>. That address always remains available, and needs no permission. Safari blocks a secure page from reaching a local address, so Safari users need that local address.</p>
      <h2 id="commands">Commands</h2>
      <div className="table-wrap" tabIndex={0}><table><tbody>
        <tr><th scope="row"><code>agentontrack setup</code></th><td>First run: connect agents, test hooks, set a goal</td></tr>
        <tr><th scope="row"><code>agentontrack doctor</code></th><td>See what is and is not enforced</td></tr>
        <tr><th scope="row"><code>agentontrack install claude-code [--sandbox]</code></th><td>Connect Claude Code. <code>--sandbox</code>: Linux and macOS only. Verified on macOS, not on Linux</td></tr>
        <tr><th scope="row"><code>agentontrack install codex | hermes</code></th><td>Connect Codex, or show the Hermes config to add</td></tr>
        <tr><th scope="row"><code>agentontrack run codex | claude-code</code></th><td>Test the hook, then start the agent. Codex runs in its sandbox, with network off unless you add <code>--allow-network</code></td></tr>
        <tr><th scope="row"><code>agentontrack goal set --file g.json</code></th><td>Approve a goal</td></tr>
        <tr><th scope="row"><code>agentontrack goal proposals | diff | accept | reject</code></th><td>Review what agents proposed</td></tr>
        <tr><th scope="row"><code>agentontrack task create --file t.json</code></th><td>Create a task with acceptance checks</td></tr>
        <tr><th scope="row"><code>agentontrack task accept-weak &lt;id&gt; [--note why]</code></th><td>Accept checks flagged as weak, so they no longer withhold VERIFIED</td></tr>
        <tr><th scope="row"><code>agentontrack approve | deny | revoke &lt;id&gt;</code></th><td>Decide a request</td></tr>
        <tr><th scope="row"><code>agentontrack verify</code></th><td>Run the checks and record evidence</td></tr>
        <tr><th scope="row"><code>agentontrack policy profile strict</code></th><td>Require approval for opaque programs and reverse unauthorized file changes</td></tr>
        <tr><th scope="row"><code>agentontrack dashboard [--allow-public-site]</code></th><td>Open the local dashboard</td></tr>
        <tr><th scope="row"><code>agentontrack audit [--recover]</code></th><td>Check the record, or recover from damage</td></tr>
        <tr><th scope="row"><code>agentontrack anchor config --remote &lt;git url&gt;</code></th><td>Optional: set a remote that holds log hashes. Then <code>anchor push</code> and <code>anchor verify</code></td></tr>
        <tr><th scope="row"><code>agentontrack self upgrade | rollback | uninstall [--purge]</code></th><td>Manage the installed program</td></tr>
      </tbody></table></div>
      <h2 id="files">File formats</h2>
      <h3>Goal file</h3>
      <Term label="Goal file">{`{ "statement": "Fix the parser", "scope": { "include": ["src/**"] }, "prohibit": ["deploy"] }`}</Term>
      <h3>Task file</h3>
      <Term label="Task file">{`{ "title": "Fix parser bug", "criteria": [{ "id": "tests", "description": "tests pass", "kind": "command", "command": "npm test" }] }`}</Term>
      <h2 id="troubleshooting">Troubleshooting</h2>
      <p><b>"Refused: needs an interactive terminal".</b> Human commands will not run from an agent's tool call. Run them in your own terminal.</p>
      <p><b>"Approvals are suspended".</b> The log failed an integrity check. Run <code>agentontrack audit</code>, then <code>agentontrack audit --recover</code>.</p>
      <p><b>A task stays unverified.</b> Run <code>agentontrack status</code>: it lists stale evidence, unresolved changes, test changes that need review, and weak checks.</p>
      <p>Install problems: <Link href="/install#troubleshooting">the install page</Link>.</p>
    </Article>
  );
}
