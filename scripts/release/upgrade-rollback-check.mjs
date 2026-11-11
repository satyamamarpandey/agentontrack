// Upgrade and rollback through the PUBLISHED installer, against the real GitHub release downloads, inside a throwaway home (no PATH change, no
// tokens, nothing touched in the real profile): install the older version, upgrade to the newer one, roll back to the older one, uninstall.
// After each step the installed program must report the expected version. Prints a JSON record; exit code 1 if any check fails.
//   node scripts/release/upgrade-rollback-check.mjs [--from 1.0.0-rc.6] [--to 1.0.0-rc.7]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const FROM = opt('--from', '1.0.0-rc.6');
const TO = opt('--to', '1.0.0-rc.7');
const REPO = 'satyamamarpandey/agentontrack';
const win = process.platform === 'win32';

const exec = (cmd, args, opts = {}) => new Promise((ok) => {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => c.kill(), opts.timeout ?? 300_000);
  c.on('close', (status) => { clearTimeout(t); ok({ status, stdout: out, stderr: err }); });
  c.on('error', (e) => { clearTimeout(t); ok({ status: 1, stdout: out, stderr: String(e) }); });
});

mkdirSync('.local', { recursive: true });
const dir = mkdtempSync(resolve('.local', 'upgrade-check-'));
const user = join(dir, 'user'); mkdirSync(user);
const home = join(user, '.agentontrack');
const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, PATHEXT: process.env.PATHEXT, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE, SystemDrive: process.env.SystemDrive, windir: process.env.windir, HOME: user, USERPROFILE: user, LOCALAPPDATA: join(user, 'AppData') };

// The installer as published with the newer release (it takes a pinned version through AOT_VERSION / --version).
const instUrl = `https://github.com/${REPO}/releases/download/v${TO}/${win ? 'install.ps1' : 'install.sh'}`;
const inst = join(dir, win ? 'install.ps1' : 'install.sh');
writeFileSync(inst, await (await fetch(instUrl)).text());
const run = (v) => (win
  ? exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inst], { env: { ...env, AOT_VERSION: v, AOT_NO_PATH: '1' } })
  : exec('sh', [inst, '--version', v, '--no-path'], { env }));
const launcher = join(home, 'app', 'bin', win ? 'agentontrack.cmd' : 'agentontrack');
const aot = (args) => exec(win ? `"${launcher}"` : launcher, args, { env, shell: win, cwd: user, timeout: 120_000 });
const versionsDir = join(home, 'app', 'versions');
const versions = () => (existsSync(versionsDir) ? readdirSync(versionsDir) : []);

const record = { installer: instUrl, from: FROM, to: TO, steps: [], ok: true };
const step = async (name, v) => {
  const t0 = Date.now();
  const r = await run(v);
  const rep = await aot(['--version']);
  const reported = (rep.stdout + rep.stderr).trim().split('\n').pop() ?? '';
  const ok = r.status === 0 && reported.includes(v);
  record.steps.push({ name, version: v, installExit: r.status, reported, versionsOnDisk: versions(), seconds: Math.round((Date.now() - t0) / 1000), ok, note: ok ? undefined : (r.stdout + r.stderr).slice(-400) });
  if (!ok) record.ok = false;
};
await step('install the older version', FROM);
await step('upgrade to the newer version', TO);
await step('roll back to the older version', FROM);
const u = await aot(['self', 'uninstall']);
const gone = !versions().length;
record.steps.push({ name: 'uninstall', uninstallExit: u.status, versionsOnDisk: versions(), ok: u.status === 0 && gone, note: u.status === 0 && gone ? undefined : (u.stdout + u.stderr).slice(-400) });
if (!(u.status === 0 && gone)) record.ok = false;
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(JSON.stringify(record, null, 2));
process.exit(record.ok ? 0 : 1);
