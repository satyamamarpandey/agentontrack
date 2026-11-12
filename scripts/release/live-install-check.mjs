// The install path an early-access tester takes, against the LIVE site and the REAL GitHub release, inside a throwaway home (nothing in the real profile or PATH changes):
//   1. the live install.ps1 / install.sh is byte-identical to the repository's copy, and the release's SHA256SUMS matches the archive for this system;
//   2. the one-command install pinned to the preview version installs it, and the program reports that version (first launch), runs `doctor` and `setup --help`;
//   3. the MANUAL path: the archive is downloaded and checked by hand, then installed from the folder (AOT_FROM), and reports the same version;
//   4. an archive changed after the checksum list was made is refused and installs nothing;
//   5. uninstall removes the program.
// Not covered here: the PATH edit (needs the real profile; AOT_NO_PATH=1 is used), which the public-install workflow checks on five runners.
//   node scripts/release/live-install-check.mjs [--version 1.0.0-rc.7] [--site https://pandeysatyam.com/agentontrack] [--out <file>]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const VERSION = opt('--version', '1.0.0-rc.7');
const SITE = opt('--site', 'https://pandeysatyam.com/agentontrack').replace(/\/$/, '');
const OUT = opt('--out');
const REPO = 'satyamamarpandey/agentontrack';
const win = process.platform === 'win32';
const plat = win ? 'windows-x64' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64') : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
const ext = win ? 'zip' : 'tar.gz';
const file = `agentontrack-${VERSION}-${plat}.${ext}`;
const rel = `https://github.com/${REPO}/releases/download/v${VERSION}`;
const scriptName = win ? 'install.ps1' : 'install.sh';

const exec = (cmd, args, opts = {}) => new Promise((ok) => {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => c.kill(), opts.timeout ?? 300_000);
  c.on('close', (status) => { clearTimeout(t); ok({ status, stdout: out, stderr: err }); });
  c.on('error', (e) => { clearTimeout(t); ok({ status: 1, stdout: out, stderr: String(e) }); });
});
const sha = (b) => createHash('sha256').update(b).digest('hex');
const get = async (u) => { const r = await fetch(u, { redirect: 'follow' }); if (!r.ok) throw new Error(`${u} -> ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

mkdirSync('.local', { recursive: true });
const dir = mkdtempSync(resolve('.local', 'live-install-'));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const mkHome = (name) => { const user = join(dir, name); mkdirSync(user, { recursive: true }); return { user, home: join(user, '.agentontrack') }; };
const baseEnv = (user) => ({ PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, PATHEXT: process.env.PATHEXT, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE, USERPROFILE: user, HOME: user, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: user, LOCALAPPDATA: join(user, 'AppData', 'Local'), APPDATA: join(user, 'AppData', 'Roaming') });
const runInstaller = (script, user, extra, args = []) => (win
  ? exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { env: { ...baseEnv(user), AOT_NO_PATH: '1', ...extra } })
  : exec('sh', [script, '--no-path', ...args], { env: baseEnv(user) }));
const launcherOf = (home) => join(home, 'app', 'bin', win ? 'agentontrack.cmd' : 'agentontrack');
const aot = (home, user, args, cwd) => exec(win ? `"${launcherOf(home)}"` : launcherOf(home), args, { env: baseEnv(user), shell: win, cwd: cwd ?? user, timeout: 120_000 });
const last = (r) => (r.stdout + r.stderr).trim().split('\n').pop() ?? '';

try {
  // 1. served script = repository script; the release lists the archive's checksum
  const live = await get(`${SITE}/${scriptName}`);
  const repoCopy = readFileSync(join('scripts', 'release', scriptName));
  check(`the live ${scriptName} is the repository's script`, live.equals(repoCopy) || sha(Buffer.from(live.toString().replace(/\r\n/g, '\n'))) === sha(Buffer.from(repoCopy.toString().replace(/\r\n/g, '\n'))), `sha256 ${sha(live).slice(0, 12)}`);
  const sums = (await get(`${rel}/SHA256SUMS`)).toString();
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, '') === file)?.[0];
  check(`SHA256SUMS lists ${file}`, !!want);
  const archive = await get(`${rel}/${file}`);
  check('the downloaded archive matches its published checksum', sha(archive) === want, `${archive.length} bytes, sha256 ${sha(archive).slice(0, 12)}`);

  // 2. the one-command path, pinned to the preview
  const A = mkHome('one-command');
  writeFileSync(join(dir, `live-${scriptName}`), live);
  const r1 = await runInstaller(join(dir, `live-${scriptName}`), A.user, { AOT_VERSION: VERSION }, ['--version', VERSION]);
  check('the pinned one-command install exits 0', r1.status === 0, r1.status === 0 ? last(r1) : (r1.stdout + r1.stderr).slice(-300));
  const v1 = await aot(A.home, A.user, ['--version']);
  check(`first launch reports ${VERSION}`, last(v1).includes(VERSION), last(v1));
  const proj = join(A.user, 'project'); mkdirSync(proj, { recursive: true });
  const d1 = await aot(A.home, A.user, ['doctor'], proj);
  check('doctor runs in an empty project folder', d1.status === 0 || /agent|hook|enforced|not/i.test(d1.stdout + d1.stderr), `exit ${d1.status}: ${(d1.stdout + d1.stderr).trim().split('\n').slice(0, 2).join(' | ').slice(0, 200)}`);
  const s1 = await aot(A.home, A.user, ['setup', '--help'], proj);
  check('setup is available', s1.status === 0 && /setup/i.test(s1.stdout + s1.stderr), `exit ${s1.status}`);
  const un = await aot(A.home, A.user, ['self', 'uninstall']);
  check('uninstall removes the program', un.status === 0 && !existsSync(join(A.home, 'app', 'versions', VERSION)), `exit ${un.status}`);

  // 3. the manual path: files in a folder, checked by hand, installed from it
  const B = mkHome('manual'); const folder = join(dir, 'download'); mkdirSync(folder);
  writeFileSync(join(folder, file), archive); writeFileSync(join(folder, 'SHA256SUMS'), sums); writeFileSync(join(folder, scriptName), live);
  const r2 = await runInstaller(join(folder, scriptName), B.user, { AOT_FROM: folder, AOT_VERSION: VERSION }, ['--from', folder, '--version', VERSION]);
  check('installing from the downloaded folder exits 0', r2.status === 0, r2.status === 0 ? last(r2) : (r2.stdout + r2.stderr).slice(-300));
  const v2 = await aot(B.home, B.user, ['--version']);
  check(`the manually installed program reports ${VERSION}`, last(v2).includes(VERSION), last(v2));
  await aot(B.home, B.user, ['self', 'uninstall']);

  // 4. a changed archive is refused
  const C = mkHome('tampered'); const bad = join(dir, 'tampered-files'); mkdirSync(bad);
  const changed = Buffer.concat([archive, Buffer.from('x')]);
  writeFileSync(join(bad, file), changed); writeFileSync(join(bad, 'SHA256SUMS'), sums); writeFileSync(join(bad, scriptName), live);
  const r3 = await runInstaller(join(bad, scriptName), C.user, { AOT_FROM: bad, AOT_VERSION: VERSION }, ['--from', bad, '--version', VERSION]);
  check('an archive that no longer matches SHA256SUMS is refused', r3.status !== 0 && /checksum/i.test(r3.stdout + r3.stderr), `exit ${r3.status}`);
  check('and nothing was installed', !existsSync(join(C.home, 'app', 'versions', VERSION)));
} catch (e) { check('the check ran to its end', false, String(e?.message ?? e)); }
finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const failed = checks.filter((c) => !c.ok);
  const rec = { version: VERSION, site: SITE, platform: plat, at: new Date().toISOString(), checks, passed: checks.length - failed.length, failed: failed.length };
  console.log(`${rec.passed}/${checks.length} checks passed`);
  if (OUT) { mkdirSync(join(OUT, '..'), { recursive: true }); writeFileSync(OUT, JSON.stringify(rec, null, 2)); }
  process.exit(failed.length ? 1 : 0);
}
