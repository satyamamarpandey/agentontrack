import Link from './link';
import { ReleaseNotice, Term } from './content';
import { ACCOUNTS_ENABLED } from '../lib/accounts-config';
import { readResult } from '../lib/results';
import { INSTALL_PS1, INSTALL_SH, RELEASE_PUBLISHED, RELEASE_VERSION, REPO } from '../lib/release';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const STEPS = [
  ['Goal', 'You approve a goal with a scope, exclusions and acceptance checks. It gets a version number.'],
  ['Authorize', 'Each action is checked against the current goal, task and policy before it runs. Consequential ones wait for you.'],
  ['Execute', 'Your own agent does the work, under its own login and your own model plan.'],
  ['Observe', 'The workspace is compared afterwards with what was authorized. Differences are recorded.'],
  ['Verify', 'AgentOnTrack runs your checks itself. "Done" from the agent counts for nothing.'],
];
const PROJECT_VIEW = [
  ['Workflow', 'goal, task, actions, what was held and approved, and verification, in order'],
  ['Usage', 'tokens, time and list-price cost as recorded. A saving appears only against a baseline you enter'],
  ['Verification', 'the share of your own checks with current passing evidence'],
  ['Environment', 'Unavailable, unless you supply the factors. Then it is labelled an estimate'],
];

// What each agent really is here. "Live-tested" is only ever Claude Code. The integrations page has the evidence for the rest.
const AGENTS: [string, string, string][] = [
  ['Claude Code', 'Anthropic', 'Live-tested. Start runs from the workspace.'],
  ['Codex', 'OpenAI models', 'Hooks tested against the real program; also run for real, logged in through ChatGPT, on one Windows machine. Can be started from AgentOnTrack.'],
  ['Hermes', 'Nous Research', 'Real program, scripted model. Starts in its own terminal.'],
  ['Gemini CLI, Cursor, Copilot, Devin, OpenCode, Kiro, Cline', 'Several vendors', "Adapters written from each tool's documented hooks. Not yet run on the real programs."],
];

export default function Home() {
  const held = readResult('heldout.json');
  const full = held?.results?.['C agentontrack full'];
  return (
    <>
      <section className="hero wrap">
        <div>
          <p className="eyebrow">Free · Local-first · Bring your own agent · No account needed</p>
          <h1>Agents that finish the right task, inside the lines you set.</h1>
          <p className="lead">AgentOnTrack is a control layer for AI coding agents. You set the goal and approve what matters. Your agent does the work. Independent checks decide when it is done.</p>
          <div className="cta">
            <Link className="btn primary" href="/install">Install</Link>
            <a className="btn" href={`${BASE}/dashboard/?demo=1`}>Try the dashboard demo</a>
            <Link className="btn" href="/install#download" data-testid="home-download">{RELEASE_PUBLISHED ? `Download ${RELEASE_VERSION}` : 'Download: not published yet'}</Link>
            <a className="btn" href={REPO}>GitHub</a>
          </div>
        </div>
        <div>
          <pre className="term" tabIndex={0} aria-label="Example terminal session"><code>{`$ agentontrack setup
$ agentontrack goal set --file goal.json
Goal v1 approved.

# the agent tries to push:
AgentOnTrack needs human approval: vcs.push requires human approval.
Ask the user to run: agentontrack approve apr_5dfc47af1da5

$ agentontrack verify
{ "status": "VERIFIED", "progress": { "passed": 1, "total": 1 } }`}</code></pre>
          <p className="small muted">Example output shape. Approval IDs and results vary.</p>
        </div>
      </section>

      <section className="wrap band">
        <div className="projects-entry" data-testid="projects-entry">
          <div>
            <h2>Every project, in one place</h2>
            <p className="section-lead">The dashboard opens on your projects. Click one to see how its work went. It reads the companion on your own machine, so your records do not come to this website. The demo shows invented data, and says so.</p>
            <div className="cta">
              <a className="btn primary" href={`${BASE}/dashboard/#projects`} data-testid="open-projects">Open your projects</a>
              <a className="btn" href={`${BASE}/dashboard/?demo=1#projects`} data-testid="demo-projects">See the demo projects</a>
            </div>
          </div>
          <ul className="entry-list">{PROJECT_VIEW.map(([t, d]) => <li key={t}><b>{t}:</b> <span className="muted">{d}</span></li>)}</ul>
        </div>
      </section>

      <section className="wrap band" data-testid="every-agent">
        <h2>One workspace for every agent you use</h2>
        <p className="section-lead">Give Claude the coding and Codex the review, or the other way round. Every agent works under the same goal, the same approvals and one evidence record, and a handoff carries verified context from one to the next. Each keeps its own login and its own model: AgentOnTrack never asks for provider credentials.</p>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col">Agent</th><th scope="col">Models</th><th scope="col">What has really been run</th></tr></thead>
          <tbody>{AGENTS.map(([a, m, d]) => <tr key={a}><th scope="row">{a}</th><td>{m}</td><td>{d}</td></tr>)}</tbody>
        </table></div>
        <p className="small muted">AgentOnTrack does not route one prompt across models, and it does not make an agent&apos;s model better. It governs the agents you already use. <Link href="/integrations">See the integrations page for what has really been run →</Link></p>
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
        <div className="tile">
          <h2>Measured, including the misses</h2>
          {full ? <>
            <p>On {held.scenarios} held-out scenarios of fixed action traces with no model in the loop, AgentOnTrack stopped or caught {full.prevented + full.detectedAfter} of {full.unauthorized} unauthorized actions: {full.prevented} prevented, {full.detectedAfter} detected afterwards, {full.missed} missed, with {full.falseBlocks} false blocks.</p>
            <p className="muted small">From scenarios recorded under the product&apos;s earlier working name. Self-authored and self-run. No independent evaluator has reproduced this. It does not measure live task success.</p>
          </> : <p>No results available.</p>}
          <Link href="/benchmarks">See the comparisons, including where it costs more →</Link>
        </div>
        <div className="tile">
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
        <div className="tile">
          <h2>Your code stays on your machine</h2>
          <p>Code, prompts, transcripts and credentials stay local. Your agent keeps its own login. {ACCOUNTS_ENABLED ? 'Accounts on this site are optional, hold no code or records, and nothing needs one.' : 'There are no accounts, and AgentOnTrack has no server to send anything to.'}</p>
          <Link href="/privacy">Privacy details →</Link>
        </div>
      </section>

      <section className="wrap band">
        <h2 id="install">Install</h2>
        <ReleaseNotice />
        <div className="install-grid">
          <Term label="Install command for Linux and macOS">{INSTALL_SH}</Term>
          <Term label="Install command for Windows PowerShell">{INSTALL_PS1}</Term>
        </div>
        <p className="small muted">Manual download, checksums, upgrade and troubleshooting: <Link href="/install">the install page</Link>.</p>
      </section>
    </>
  );
}
