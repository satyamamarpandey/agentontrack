import Link from './link';
import { Counter } from './counter';
import { ReleaseNotice, Term } from './content';
import { EarlyAccessAutoPopup, EarlyAccessButton } from './early-access/launcher';
import { Tour } from './tour';
import { Icon } from './ui/icons';
import { ACCOUNTS_ENABLED, INSTALL_GATED } from '../lib/accounts-config';
import { readResult } from '../lib/results';
import { INSTALL_PS1, INSTALL_SH, RELEASE_PUBLISHED, RELEASE_VERSION, REPO } from '../lib/release';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const STEPS: [string, string, string][] = [
  ['target', 'Goal', 'You approve a goal with a scope, exclusions and acceptance checks. It gets a version number.'],
  ['shield', 'Authorize', 'Each action is checked against the current goal, task and policy before it runs. Consequential ones wait for you.'],
  ['terminal', 'Execute', 'Your own agent does the work, under its own login and your own model plan.'],
  ['git', 'Observe', 'The workspace is compared afterwards with what was authorized. Differences are recorded.'],
  ['receipt', 'Verify', 'AgentOnTrack runs your checks itself. "Done" from the agent counts for nothing.'],
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
// Captured from the real dashboard in demo mode by scripts/capture-media.mjs; the demo banner is in every one of them.
const SHOTS: [string, string, string][] = [
  ['/shots/project-workflow.png', 'A project\'s workflow', 'Goal, task, every action, what was held and approved, and the verification, in order.'],
  ['/shots/workspace.png', 'The workspace', 'Files, the agent feed and composer, approvals and handoffs beside each other, with the record along the bottom.'],
  ['/shots/approvals.png', 'Approvals', 'Consequential actions wait here, bound to one effect, task and goal version. Single-use by default.'],
];
const EARLY: [string, string, string][] = [
  ['layers', 'What you get', 'The desktop preview for Windows, macOS and Linux, the install steps, and a direct line to the maintainer when something is wrong.'],
  ['users', 'Who it is for', 'People who run Claude Code or Codex most days and want a goal, approvals and evidence around them, on their own machine.'],
  ['spark', 'How places are given', 'By hand, in small groups balanced across operating systems and agents. Every application is read. An invitation works once, for your address.'],
];

export default function Home() {
  const held = readResult('heldout.json');
  const full = held?.results?.['C agentontrack full'];
  return (
    <>
      <EarlyAccessAutoPopup />
      <section className="hero wrap">
        <div className="hero-bg" aria-hidden="true" />
        <div>
          {INSTALL_GATED
            ? <p className="pill"><span className="status-dot on" aria-hidden="true" />Early access · invitation only</p>
            : <p className="eyebrow">Free · Local-first · Bring your own agent</p>}
          <h1>Agents that finish the <em className="display">right</em> task, inside the lines you set.</h1>
          <p className="lead">AgentOnTrack is a control layer for AI coding agents. You set the goal and approve what matters. Your agent does the work, on your machine, under its own login. Independent checks decide when it is done.</p>
          <div className="cta">
            <EarlyAccessButton className="btn primary big" testId="hero-early-access">Request early access<Icon name="arrow-right" size={18} /></EarlyAccessButton>
            <a className="btn big" href={`${BASE}/dashboard/?demo=1`}>See the live demo</a>
            {INSTALL_GATED ? null : <Link className="btn big" href="/install#download" data-testid="home-download">{RELEASE_PUBLISHED ? `Download ${RELEASE_VERSION}` : 'Download: not published yet'}</Link>}
          </div>
          <ul className="facts" aria-label="In short">
            <li><Icon name="check" size={16} />Runs on your machine</li>
            <li><Icon name="check" size={16} />Your agents, your logins</li>
            <li><Icon name="check" size={16} />Open source, Apache-2.0</li>
            <li><Icon name="check" size={16} />No analytics</li>
          </ul>
        </div>
        <div className="frame reveal">
          <div className="frame-bar" aria-hidden="true"><i /><i /><i /><span>agentontrack · terminal</span></div>
          <pre className="term" tabIndex={0} aria-label="Example terminal session"><code><span className="cmd">$ agentontrack setup</span>{'\n'}<span className="cmd">$ agentontrack goal set --file goal.json</span>{'\n'}<span className="ok">Goal v1 approved.</span>{'\n\n'}<span className="dim"># the agent tries to push:</span>{'\n'}<span className="hold">AgentOnTrack needs human approval: vcs.push requires human approval.</span>{'\n'}Ask the user to run: agentontrack approve apr_5dfc47af1da5{'\n\n'}<span className="cmd">$ agentontrack verify</span>{'\n'}{'{ "status": "VERIFIED", "progress": { "passed": 1, "total": 1 } }'}</code></pre>
          <p className="small muted" style={{ padding: '8px 14px 10px', margin: 0 }}>Example output shape. Approval IDs and results vary.</p>
        </div>
      </section>

      <section className="wrap" aria-label="Product tour">
        <Tour poster="/shots/projects.png" video="/shots/tour.webm" caption="Projects, one project's workflow, the workspace, approvals and safety, in about twenty seconds." />
      </section>

      {INSTALL_GATED ? (
        <section className="wrap band" data-testid="early-access-band">
          <header><p className="eyebrow">Early access</p><h2>A small group first, then everyone.</h2><p className="section-lead">AgentOnTrack is being tested by invited people before it opens up. Anyone can apply; the maintainer chooses a balanced group and sends each person a personal link.</p></header>
          <div className="grid3">
            {EARLY.map(([icon, t, d]) => <div key={t} className="tile reveal"><span className="step-icon"><Icon name={icon} /></span><h3>{t}</h3><p className="muted" style={{ marginBottom: 0 }}>{d}</p></div>)}
          </div>
          <div className="cta"><EarlyAccessButton className="btn primary" testId="band-early-access">Apply for early access</EarlyAccessButton><Link className="btn" href="/early-access">Read what testers get</Link></div>
        </section>
      ) : null}

      <section className="wrap band">
        <div className="projects-entry reveal" data-testid="projects-entry">
          <div>
            <h2>Every project, in one place</h2>
            <p className="section-lead">The dashboard opens on your projects. Click one to see how its work went. It reads the companion on your own machine, so your records do not come to this website. The demo shows invented data, and says so.</p>
            <div className="cta">
              <a className="btn primary" href={`${BASE}/dashboard/#projects`} data-testid="open-projects">Open your projects</a>
              <a className="btn" href={`${BASE}/dashboard/?demo=1#projects`} data-testid="demo-projects">See the demo projects</a>
            </div>
          </div>
          <ul className="entry-list">{PROJECT_VIEW.map(([t, d]) => <li key={t}><b>{t}</b> <span className="muted">{d}</span></li>)}</ul>
        </div>
      </section>

      <section className="wrap band" data-testid="every-agent">
        <header><h2>One workspace for every agent you use</h2>
        <p className="section-lead">Give Claude the coding and Codex the review, or the other way round. Every agent works under the same goal, the same approvals and one evidence record, and a handoff carries verified context from one to the next. Each keeps its own login and its own model: AgentOnTrack never asks for provider credentials.</p></header>
        <div className="table-wrap reveal" tabIndex={0}><table>
          <thead><tr><th scope="col">Agent</th><th scope="col">Models</th><th scope="col">What has really been run</th></tr></thead>
          <tbody>{AGENTS.map(([a, m, d]) => <tr key={a}><th scope="row">{a}</th><td>{m}</td><td>{d}</td></tr>)}</tbody>
        </table></div>
        <p className="small muted" style={{ marginTop: 12 }}>AgentOnTrack does not route one prompt across models, and it does not make an agent&apos;s model better. It governs the agents you already use. <Link href="/integrations">See the integrations page for what has really been run →</Link></p>
      </section>

      <section className="wrap band" id="how">
        <header><h2>From goal to evidence</h2><p className="section-lead">Five steps, every time, with a record you can read afterwards.</p></header>
        <ol className="steps">{STEPS.map(([icon, t, d], i) => <li key={t} className="reveal"><span className="step-icon"><Icon name={icon} /></span><span className="num">0{i + 1}</span><h3>{t}</h3><p>{d}</p></li>)}</ol>
      </section>

      <section className="wrap band" data-testid="closer-look">
        <header><h2>A closer look</h2><p className="section-lead">Three screens from the dashboard, as recorded in demo mode. The real thing reads the companion on your own machine.</p></header>
        <div className="shots">
          {SHOTS.map(([src, t, d]) => <figure key={src} className="shot reveal" style={{ margin: 0 }}><div className="frame"><span className="frame-note">Demo data</span><img src={`${BASE}${src}`} alt={`${t}, in the AgentOnTrack dashboard with demo data`} width={1440} height={900} loading="lazy" decoding="async" /></div><figcaption><h3>{t}</h3><p>{d}</p></figcaption></figure>)}
        </div>
      </section>

      <section className="wrap band">
        <header><h2>Measured, including the misses</h2>
        {full ? <p className="section-lead">On {held.scenarios} held-out scenarios of fixed action traces with no model in the loop, AgentOnTrack stopped or caught {full.prevented + full.detectedAfter} of {full.unauthorized} unauthorized actions: {full.prevented} prevented, {full.detectedAfter} detected afterwards, {full.missed} missed, with {full.falseBlocks} false blocks.</p> : <p className="section-lead">No results available.</p>}</header>
        {full ? (
          <div className="kpis reveal" aria-label="Held-out results">
            <div className="kpi"><span className="kpi-value good"><Counter value={full.prevented} /></span><span className="kpi-label">prevented before they ran</span></div>
            <div className="kpi"><span className="kpi-value warn"><Counter value={full.detectedAfter} /></span><span className="kpi-label">detected afterwards</span></div>
            <div className="kpi"><span className="kpi-value bad"><Counter value={full.missed} /></span><span className="kpi-label">missed</span></div>
            <div className="kpi"><span className="kpi-value"><Counter value={full.falseBlocks} /></span><span className="kpi-label">false blocks</span></div>
          </div>
        ) : null}
        <p className="muted small">From scenarios recorded under the product&apos;s earlier working name. Self-authored and self-run. No independent evaluator has reproduced this. It does not measure live task success. <Link href="/benchmarks">See the comparisons, including where it costs more →</Link></p>
      </section>

      <section className="wrap band">
        <header><h2>Compared with an agent on its own</h2></header>
        <div className="table-wrap reveal" tabIndex={0}><table>
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
        <div className="tile reveal">
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
        <div className="tile reveal">
          <h2>Your code stays on your machine</h2>
          <p>Code, prompts, transcripts and credentials stay local. Your agent keeps its own login. {ACCOUNTS_ENABLED ? 'An account on this site is used only for early access and optional cloud features; it holds no code or records.' : 'There are no accounts, and AgentOnTrack has no server to send anything to.'}</p>
          <Link href="/privacy">Privacy details →</Link>
        </div>
      </section>

      {INSTALL_GATED ? (
        <section className="wrap band">
          <div className="tile accent reveal" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 20, alignItems: 'center' }}>
            <div><h2 style={{ marginTop: 0 }}>Ready to try it?</h2><p className="section-lead" style={{ marginBottom: 0 }}>Apply in about two minutes. If you are chosen, your invitation arrives by email with everything you need to install the preview and connect your agents.</p></div>
            <EarlyAccessButton className="btn primary big" testId="foot-early-access">Request early access</EarlyAccessButton>
          </div>
        </section>
      ) : (
        <section className="wrap band">
          <h2 id="install">Install</h2>
          <ReleaseNotice />
          <div className="install-grid">
            <Term label="Install command for Linux and macOS">{INSTALL_SH}</Term>
            <Term label="Install command for Windows PowerShell">{INSTALL_PS1}</Term>
          </div>
          <p className="small muted">Manual download, checksums, upgrade and troubleshooting: <Link href="/install">the install page</Link>. Source: <a href={REPO}>GitHub</a>.</p>
        </section>
      )}
    </>
  );
}
