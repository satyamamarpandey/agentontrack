import { Article } from '../content';

export const metadata = { title: 'Changelog' };

export default function Changelog() {
  return (
    <Article title="Changelog" intro="Changes that matter to users.">
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
