// Tests the VERSION-PINNED install path end to end, before a release exists, without touching GitHub or the machine's real home.
//   node scripts/release/pinned-install-test.mjs <release folder> <version, e.g. 1.0.0-rc.5>
// A local server serves the release files at the same paths GitHub uses for a release download (/<owner>/<repo>/releases/download/v<version>/<file>).
// A COPY of the real installer, with only the base URL changed, is run inside a throwaway home with a clean environment (no tokens). Checks:
//   1. a pinned install downloads only from /releases/download/v<version>/ (never the "latest" path), verifies the checksum, and installs that version;
//   2. the installed program reports that version, and uninstall removes it;
//   3. a pinned version that is not published fails and installs nothing;
//   4. a file changed after the checksum list was made is refused, and nothing is installed.
// It tests the installer's logic and the files' integrity, not GitHub's CDN: the real download is only possible after publication (public-install workflow).
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Async, because the server below lives in this process and must keep answering while the installer runs.
const exec = (cmd, args, opts) => new Promise((ok) => {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => c.kill(), opts.timeout ?? 300_000);
  c.on('close', (status) => { clearTimeout(t); ok({ status, stdout: out, stderr: err }); });
  c.on('error', (e) => { clearTimeout(t); ok({ status: 1, stdout: out, stderr: String(e) }); });
});

const [relArg, version] = process.argv.slice(2);
if (!relArg || !version) { console.error('usage: pinned-install-test.mjs <release folder> <version>'); process.exit(2); }
const release = resolve(relArg);
const win = process.platform === 'win32';
const REPO = 'satyamamarpandey/agentontrack';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + String(detail).slice(0, 300)}`); };

const dir = mkdtempSync(join(tmpdir(), 'aot-pinned-'));
const requests = [];
let tamper = false;
const server = createServer((req, res) => {
  requests.push(req.url);
  const m = new RegExp(`^/${REPO}/releases/download/v([^/]+)/([^/]+)$`).exec(req.url ?? '');
  if (!m || m[1] !== version || m[2].includes('..') || !existsSync(join(release, m[2]))) { res.statusCode = 404; res.end('not found'); return; }
  let body = readFileSync(join(release, m[2]));
  if (tamper && /\.(zip|tar\.gz)$/.test(m[2])) body = Buffer.concat([body, Buffer.from('x')]);
  res.end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const user = join(dir, 'user'); mkdirSync(user);
const home = join(user, '.agentontrack');
const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, PATHEXT: process.env.PATHEXT, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE, SystemDrive: process.env.SystemDrive, windir: process.env.windir, HOME: user, USERPROFILE: user, LOCALAPPDATA: join(user, 'AppData') };

// The installer copy: only the GitHub base URL is replaced, so everything else is the shipped code.
const inst = join(dir, win ? 'install.ps1' : 'install.sh');
const original = readFileSync(join(release, win ? 'install.ps1' : 'install.sh'), 'utf8');
if (!original.includes('https://github.com/')) { console.error('installer has no github URL to redirect'); process.exit(1); }
writeFileSync(inst, original.replaceAll('https://github.com/', base));
const run = (v) => (win
  ? exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inst], { env: { ...env, AOT_VERSION: v, AOT_NO_PATH: '1' } })
  : exec('sh', [inst, '--version', v, '--no-path'], { env }));
const launcher = join(home, 'app', 'bin', win ? 'agentontrack.cmd' : 'agentontrack');
const aot = (args) => exec(win ? `"${launcher}"` : launcher, args, { env, shell: win, cwd: user, timeout: 120_000 });
const installed = () => existsSync(join(home, 'app', 'versions')) && readdirSync(join(home, 'app', 'versions')).length > 0;

// 1 and 2
let r = await run(version);
check('pinned install succeeds', r.status === 0, r.stdout + r.stderr);
check('only /releases/download/v<version>/ paths were requested, never "latest"', requests.length > 0 && requests.every((u) => u.startsWith(`/${REPO}/releases/download/v${version}/`)), requests.join(' '));
check('the checksum list was fetched, then the archive for this system', requests[0]?.endsWith('/SHA256SUMS') && requests.length === 2, requests.join(' '));
const v = await aot(['--version']);
check(`the installed program reports ${version}`, (v.stdout + v.stderr).includes(version), v.stdout + v.stderr);
const u = await aot(['self', 'uninstall']);
check('uninstall succeeds and removes the program', u.status === 0 && !existsSync(join(home, 'app', 'versions', version)), u.stdout + u.stderr);

// 3
requests.length = 0;
rmSync(home, { recursive: true, force: true });
r = await run('9.9.9-not-published');
check('an unpublished pinned version fails', r.status !== 0, r.stdout + r.stderr);
check('and installs nothing', !installed());

// 4
tamper = true; requests.length = 0;
r = await run(version);
check('a changed archive is refused with a checksum message', r.status !== 0 && /checksum mismatch/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
check('and installs nothing', !installed());

server.close();
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const bad = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
