import { Article, ReleaseNotice, Term } from '../content';
import Link from '../link';
import { assetName, assetUrl, ISSUES, INSTALL_PS1, INSTALL_SH, NOTICE, PLATFORMS, RELEASE_PUBLISHED, RELEASE_VERSION, RELEASES } from '../../lib/release';

export const metadata = { title: 'Install' };

const v = RELEASE_PUBLISHED ? RELEASE_VERSION : '<version>';
const Unpublished = () => <span className="btn small disabled" aria-disabled="true" data-testid="download-unavailable">Not published yet</span>;

export default function Install() {
  return (
    <Article title="Install AgentOnTrack" intro="For one user, with no administrator rights and nothing else required: the download includes its own runtime. The installer checks each file against the published checksum, and installs nothing if they differ.">
      <ReleaseNotice />

      <h2 id="linux-macos">Linux and macOS</h2>
      <Term label="Install command for Linux and macOS">{INSTALL_SH}</Term>
      <p className="muted small">Needs <code>curl</code>, <code>tar</code>, and <code>sha256sum</code> or <code>shasum</code>. Glibc only: Alpine and other musl systems are not supported. Installs to <code>~/.agentontrack/app</code> and adds it to your PATH. To read the script first, save <code>install.sh</code>, read it, then run it with <code>sh</code>. Options: <code>--version</code>, <code>--from</code>, <code>--no-path</code>.</p>

      <h2 id="windows">Windows</h2>
      <Term label="Install command for Windows PowerShell">{INSTALL_PS1}</Term>
      <p className="muted small">In PowerShell. Installs to <code>.agentontrack\app</code> in your user folder and adds it to your user PATH. Options go through the environment: <code>AOT_VERSION</code>, <code>AOT_FROM</code>, <code>AOT_NO_PATH=1</code>. Windows on Arm uses the x64 build through emulation, which has not been tested.</p>

      <h2 id="download">Manual download</h2>
      {RELEASE_PUBLISHED ? null : <p className="alert" role="note">{NOTICE} The files do not exist yet, so nothing in this table is a link.</p>}
      <div className="table-wrap" tabIndex={0}><table>
        <thead><tr><th scope="col">System</th><th scope="col">File</th><th scope="col">Download</th></tr></thead>
        <tbody>
          {PLATFORMS.map((p) => {
            const file = assetName(p.id, p.ext, v);
            return <tr key={p.id}><th scope="row">{p.label}</th><td><code>{file}</code></td><td>{RELEASE_PUBLISHED ? <a className="btn small" data-testid="download" href={assetUrl(file)}>Download</a> : <Unpublished />}</td></tr>;
          })}
          <tr><th scope="row">Checksums</th><td><code>SHA256SUMS</code></td><td>{RELEASE_PUBLISHED ? <a className="btn small" data-testid="download" href={assetUrl('SHA256SUMS')}>Download</a> : <Unpublished />}</td></tr>
        </tbody>
      </table></div>
      {RELEASE_PUBLISHED ? <p>Every release: <a href={RELEASES}>GitHub Releases</a>.</p> : null}
      <h3>Check the file, then install from it</h3>
      <p>Put the archive, <code>SHA256SUMS</code> and the install script in one folder, then run these in it.</p>
      <Term label="Verify and install on Linux and macOS">{`sha256sum -c --ignore-missing SHA256SUMS      # Linux
shasum -a 256 -c --ignore-missing SHA256SUMS  # macOS
sh install.sh --from .`}</Term>
      <Term label="Verify and install on Windows">{`(Get-FileHash agentontrack-${v}-windows-x64.zip -Algorithm SHA256).Hash.ToLower()
Select-String windows-x64 SHA256SUMS   # the two hashes must match
$env:AOT_FROM = (Get-Location).Path; .\\install.ps1`}</Term>
      <p className="muted small">A checksum shows the file matches <code>SHA256SUMS</code>. Both come from the same place, so it catches a damaged download, not a compromised release.</p>

      <h2 id="quick-start">Quick start</h2>
      <p>In a project folder, with your agent already installed and logged in:</p>
      <ol>
        <li><b>Setup.</b> Finds your agents, connects their hooks, tests them, and offers to set a goal and first task. <Term label="Setup">agentontrack setup</Term></li>
        <li><b>Goal.</b> If you skipped it in setup, approve one from a file. See <Link href="/docs#files">the file formats</Link>. <Term label="Goal and task">{`agentontrack goal set --file goal.json
agentontrack task create --file task.json`}</Term></li>
        <li><b>Run.</b> Start your agent through AgentOnTrack, which refuses to start it if the hook self-test fails. This matters most on Codex, which runs actions anyway if its hook is missing. <Term label="Run">{`agentontrack run claude-code
agentontrack run codex`}</Term></li>
        <li><b>Approve.</b> Consequential actions wait. The agent reports an id, and you decide in your own terminal. <Term label="Approve">{`agentontrack approvals
agentontrack approve <id>    # or: agentontrack deny <id>`}</Term></li>
        <li><b>Verify.</b> AgentOnTrack runs your checks itself. A weak check withholds VERIFIED until you strengthen it or accept it. <Term label="Verify">agentontrack verify</Term></li>
        <li><b>Dashboard.</b> The local address it prints is the one that always works. <Term label="Dashboard">{`agentontrack dashboard                      # local address
agentontrack dashboard --allow-public-site  # also this site's dashboard, with codes`}</Term></li>
      </ol>
      <p className="muted small"><code>agentontrack doctor</code> says what is and is not enforced at any point.</p>

      <h2 id="manage">Upgrade, roll back, uninstall</h2>
      <Term label="Upgrade, rollback and uninstall">{`agentontrack self status
agentontrack self upgrade             # or --version <v>, or --from <folder>
agentontrack self rollback            # back to the previous installed version
agentontrack self uninstall           # removes the program, keeps your records
agentontrack self uninstall --purge   # also deletes every project's record`}</Term>
      <p className="muted small">Run <code>agentontrack uninstall claude-code</code> or <code>agentontrack uninstall codex</code> in each project first. If hooks stay behind with the program gone, Claude Code blocks the actions they gate, and Codex runs them unchecked.</p>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <p><b>"could not download", or a 404 from the installer.</b> {RELEASE_PUBLISHED ? 'Check your connection, and that the version exists on GitHub Releases.' : 'Expected today: no release is published.'}</p>
      <p><b>"agentontrack" is not found after installing.</b> Open a new terminal, so the PATH change applies.</p>
      <p><b>"checksum mismatch".</b> Nothing was installed. Try again. If it repeats, do not work around it: <a href={`${ISSUES}/new?title=Checksum%20mismatch`}>report it</a>.</p>
      <p><b>PowerShell refuses to run a saved <code>install.ps1</code>.</b> Your execution policy blocks saved scripts. For that one run: <code>powershell -ExecutionPolicy Bypass -File .\install.ps1</code>.</p>
      <p><b>"the bundled program would not start".</b> On Linux, this is usually a musl system or a very old glibc.</p>
      <p><b>"Refusing to start": the hook self-test failed.</b> Run <code>agentontrack doctor</code>, then <code>agentontrack setup</code> again. Codex also skips a new hook until you trust it with <code>/hooks</code>.</p>
      <p><b>"Refused: needs an interactive terminal".</b> Human commands will not run from an agent's tool call. Run them in your own terminal.</p>
      <p><b>This site's dashboard cannot reach your machine.</b> See <Link href="/docs#connect">connecting this website</Link>. The local address <code>agentontrack dashboard</code> prints does not depend on any browser rule about public pages.</p>
    </Article>
  );
}
