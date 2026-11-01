import Link from './link';
import { ReleaseNotice, Term } from './content';
import { readResult } from '../lib/results';
import { INSTALL_PS1, INSTALL_SH, RELEASE_PUBLISHED, RELEASE_VERSION, REPO } from '../lib/release';

const STEPS = [
  ['Goal', 'You approve a goal with a scope, exclusions and acceptance checks. It gets a version number.'],
  ['Authorize', 'Each action is checked against the current goal, task and policy before it runs. Consequential ones wait for you.'],
  ['Execute', 'Your own agent does the work, under its own login and your own model plan.'],
  ['Observe', 'The workspace is compared afterwards with what was authorized. Differences are recorded.'],
  ['Verify', 'AgentOnTrack runs your checks itself. "Done" from the agent counts for nothing.'],
];

export default function Home() {
  const held = readResult('heldout.json');
  const full = held?.results?.['C agentontrack full'];
  return (
    <>
      <section className="hero wrap">
        <p className="eyebrow">Free · Local-first · Bring your own agent · No account needed</p>
        <h1>Agents that finish the right task, inside the lines you set.</h1>
        <p className="lead">AgentOnTrack is a control layer for AI coding agents. You set the goal and approve what matters. Your agent does the work. Independent checks decide when it is done.</p>
        <div className="cta">
          <Link className="btn primary" href="/install">Install</Link>
          <Link className="btn" href="/install#download" data-testid="home-download">{RELEASE_PUBLISHED ? `Download ${RELEASE_VERSION}` : 'Download: not published yet'}</Link>
          <a className="btn" href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/dashboard/?demo=1`}>Try the dashboard demo</a>
          <a className="btn" href={REPO}>GitHub</a>
        </div>
        <pre className="term" tabIndex={0} aria-label="Example terminal session"><code>{`$ agentontrack setup
$ agentontrack goal set --file goal.json
Goal v1 approved.

# the agent tries to push:
AgentOnTrack needs human approval: vcs.push requires human approval.
Ask the user to run: agentontrack approve apr_5dfc47af1da5

$ agentontrack verify
{ "status": "VERIFIED", "progress": { "passed": 1, "total": 1 } }`}</code></pre>
        <p className="small muted">Example output shape. Approval IDs and results vary.</p>
        <h2 id="install">Install</h2>
        <ReleaseNotice />
        <Term label="Install command for Linux and macOS">{INSTALL_SH}</Term>
        <Term label="Install command for Windows PowerShell">{INSTALL_PS1}</Term>
        <p className="small muted">Manual download, checksums, upgrade and troubleshooting: <Link href="/install">the install page</Link>.</p>
      </section>

      <section className="wrap band">
        <h2>From goal to evidence</h2>
        <ol className="steps">{STEPS.map(([t, d], i) => <li key={t}><span className="num">{i + 1}</span><h3>{t}</h3><p>{d}</p></li>)}</ol>
      </section>

      <section className="wrap band">
        <h2>Compared with an agent on its own</h2>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col" /><th scope="col">Agent alone</th><th scope="col">With AgentOnTrack</th></tr></thead>
          <tbody>
            <tr><th scope="row">"It's done"</th><td>The agent's statement</td><td>Your checks, run on the current code, recorded as receipts</td></tr>
            <tr><th scope="row">An approval</th><td>Depends on the runtime's permission settings</td><td>Bound to one effect, task, goal version, policy version and runtime. Single-use by default</td></tr>
            <tr><th scope="row">The goal changes</th><td>Earlier permissions and test results carry on</td><td>Approvals stop matching and evidence goes stale</td></tr>
            <tr><th scope="row">A script writes somewhere it shouldn't</th><td>Nothing separate notices</td><td>Detected afterwards, and reversible in strict mode. Not always prevented</td></tr>
            <tr><th scope="row">Tests get weakened</th><td>Tests pass</td><td>Deleted tests, skips and lowered thresholds hold back VERIFIED. Heuristic</td></tr>
          </tbody>
        </table></div>
      </section>

      <section className="wrap band grid2">
        <div>
          <h2>Measured, including the misses</h2>
          {full ? <>
            <p>On {held.scenarios} held-out scenarios of fixed action traces with no model in the loop, AgentOnTrack stopped or caught {full.prevented + full.detectedAfter} of {full.unauthorized} unauthorized actions: {full.prevented} prevented, {full.detectedAfter} detected afterwards, {full.missed} missed, with {full.falseBlocks} false blocks.</p>
            <p className="muted small">From scenarios recorded under the product&apos;s earlier working name. Self-authored and self-run. No independent evaluator has reproduced this. It does not measure live task success.</p>
          </> : <p>No results available.</p>}
          <Link href="/benchmarks">See the comparisons, including where it costs more →</Link>
        </div>
        <div>
          <h2>What it will not do</h2>
          <ul>
            <li>It cannot see the network activity of a script the agent runs.</li>
            <li>It is not a security boundary against a determined program running as you.</li>
            <li>It does not save tokens or time: in our tests it used more of both.</li>
            <li>On Codex, a missing hook program means the action runs anyway.</li>
            <li>It does not guarantee safety or correct results.</li>
          </ul>
          <Link href="/security">Read the threat model →</Link>
        </div>
      </section>

      <section className="wrap band grid2">
        <div>
          <h2>Your code stays on your machine</h2>
          <p>Code, prompts, transcripts and credentials stay local. Your agent keeps its own login. There are no accounts, and AgentOnTrack has no server to send anything to.</p>
          <Link href="/privacy">Privacy details →</Link>
        </div>
        <div>
          <h2>Supported agents</h2>
          <ul>
            <li><b>Claude Code:</b> live-tested</li>
            <li><b>Codex, Hermes, local models:</b> see the integrations page for what has really been run</li>
          </ul>
          <Link href="/integrations">Compatibility details →</Link>
        </div>
      </section>
    </>
  );
}
