import { PREVIEW_PUBLISHED, PREVIEW_VERSION, RELEASE_VERSION } from '../../lib/release';
import { Article } from '../content';

export const metadata = { title: 'Changelog' };

export default function Changelog() {
  return (
    <Article title="Changelog" intro="Changes that matter to users.">
      <p className="alert" role="note" data-testid="changelog-state">The stable download on this site is {RELEASE_VERSION}. Newer versions below are pre-releases and are not what the plain installer installs.</p>
      {PREVIEW_PUBLISHED ? <>
        <h2>{PREVIEW_VERSION} (preview, published as a pre-release)</h2>
        <ul>
          <li>Desktop only. Phone control is switched off in this build.</li>
          <li>Running several phases in a row, repeating a phase until its checks pass, and phone-started runs are refused for agents signed in with a subscription by the program itself; they need your own API key in paid API mode and a time-limited grant created with the terminal confirmation code.</li>
          <li>Sessions pane with New session, resume and history for sessions AgentOnTrack started, with Claude Code and Codex, read-only sessions, and image, PDF (Claude Code only) and text attachments.</li>
          <li>Stopping a run ends the agent and the programs it started; at most 4 agents at once; running agents stop when the dashboard is closed; plain messages for a missing or signed-out agent.</li>
          <li>Not verified: voice dictation with a real microphone, a physical phone, a real Firebase project. Provider terms for automated use are not confirmed. Not equal to Claude Code or Codex (no fork, effort choice, steering or queueing, native audio, subagent management).</li>
        </ul>
      </> : null}
      <h2>1.0.0-rc.5 (pre-release)</h2>
      <ul><li>Codex runs through its own app-server, with approvals, resume, an isolated-worktree run and a Claude Code and Codex cross-review; Claude Code and Codex attachments; managed goal and phase loops. Published as a pre-release; the stable download did not change.</li></ul>
      <h2>1.0.0-rc.4 (never published)</h2>
      <p className="muted small">This version was never released. Its changes first shipped in 1.0.0-rc.5. The phone remote control listed here is switched off in 1.0.0-rc.6 and was only ever tested against local emulators.</p>
      <ul>
        <li>Phone remote control for projects already on a computer you authorized: signed and encrypted end to end, approved device by device at the computer, with no terminal and no code editing, installable as an app. Plans with limits, a bounded loop, agent and model discovery from what the computer reports, commands sent only if the agent reported them, and next-prompt suggestions. Verified against the Firebase emulators, not a real Firebase project, and with device profiles, not physical phones.</li>
        <li>A new first screen: choose to continue on this computer, use an optional account (Google, GitHub or email, once the site's owner switches accounts on), or look at a labelled demo. An account never gives the website access to your computer.</li>
        <li>Connecting a computer is a guided step. The page looks for AgentOnTrack on your computer by itself, shows how to get and start it if it is not there, and asks for the one-time code from your terminal. If the computer stops answering, a clear screen offers Retry, Connect again, Download and the local dashboard.</li>
        <li>Projects registered on your computer appear as soon as it is connected, with search, sort, archive, and a way to find Git repositories inside one folder you name, import a folder, or copy a GitHub repository.</li>
        <li>A searchable catalog of 18 agents, editors, model servers and research tools, each with its maker's install page, how it connects, what has really been tested, and what it can and cannot do. Only agents that can really be started from AgentOnTrack show a Run control, decided by the helper.</li>
        <li>Six places to go: Projects, Workspace, Agents, Activity, Analytics, Settings. A Results and evidence center, with an exportable receipts file.</li>
        <li>Reading source files from the public site now needs a short permission you give in your terminal. The dashboard page has a Content-Security-Policy. <code>agentontrack dashboard --allow-origin</code> takes a dedicated hostname.</li>
        <li>Optional anonymous usage counts, off by default, with a preview of exactly what would be sent.</li>
        <li>Not changed or not claimed: accounts are written and tested against emulators only, and is off until the owner creates a Firebase project. Only Claude Code starts from the product. AgentOnTrack still used more tokens and time than the agent alone in its own benchmarks.</li>
      </ul>
      <h2>1.0.0-rc.3</h2>
      <ul>
        <li>A redesigned dashboard and site, with a command palette, light and dark themes, and dialogs that trap focus</li>
        <li>A Workspace screen: files with a hash-checked editor, a prompt composer with live output for Claude Code, team roles, approvals, handoffs, isolated git worktrees with diffs, and verification receipts</li>
        <li>A VS Code extension, in the release as <code>agentontrack-vscode.vsix</code>. It confirms nothing by itself and only reads in an untrusted workspace</li>
        <li>Team workflows including <code>spec-review</code>, and a handoff that never carries approvals over</li>
        <li>Not changed: in its own benchmarks AgentOnTrack still used more tokens and time than the agent alone. Only Claude Code starts from the product. Cursor and Antigravity are not tested</li>
      </ul>
      <h2>1.0.0-rc.2</h2>
      <ul>
        <li>Adapters over the same engine. Verified on the real programs with a scripted model: Copilot CLI, Gemini CLI, OpenCode and Cline CLI</li>
        <li>Cursor, Devin and Kiro adapters are written from their docs, and have never run on the real programs</li>
        <li>State over MCP for Continue, with no enforcement. Optional Perplexity config, on your own key</li>
        <li>A pre-action hook that cannot read a request now refuses it</li>
      </ul>
      <h2>1.0.0-rc.1</h2>
      <ul>
        <li>Installers and release archives for Linux, macOS and Windows, with checksums, and no prerequisites</li>
        <li><code>agentontrack setup</code>, a first-run path, and a hook self-test in <code>doctor</code></li>
        <li><code>agentontrack run codex</code>: refuses to start if the hook fails its test, and starts Codex in its own sandbox</li>
        <li><code>agentontrack self upgrade</code>, <code>rollback</code> and <code>uninstall [--purge]</code></li>
        <li>Recognisable weak checks now withhold VERIFIED, until strengthened or accepted with <code>task accept-weak</code> or in the dashboard</li>
        <li>Optional external log anchor: <code>anchor config</code>, <code>push</code>, <code>verify</code></li>
        <li><code>install claude-code --sandbox</code> on Linux and macOS. Not tested</li>
        <li>A session from an outside web page gets no confirmation codes: each change needs a code from your terminal</li>
        <li>The dashboard shows what each runtime does if its hook cannot run, and what contains its scripts</li>
        <li><b>Removed:</b> hosted accounts and sync. The website is static, and there is no server</li>
      </ul>
      <h2>0.2.0 (unreleased)</h2><ul><li>Local dashboard with secure pairing, and real agent runs</li><li>Witness file, approver passphrase and log recovery</li><li>Approval denial, expiry and duplicate handling</li><li>Goal proposal review, and test-weakening detection</li><li>Strict profile with file-change reversal</li><li>Hermes adapter and local-model probe</li></ul>
      <h2>0.1.0 (unreleased)</h2><ul><li>Core engine, Claude Code and Codex hooks, MCP server, CLI</li></ul>
    </Article>
  );
}
