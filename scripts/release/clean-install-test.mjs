// A new user's first run, on a machine with no checkout of this project: the release files are all it has.
// The hook call here is a real hook process with a test request. It is not a live agent, and the report says so.
// Usage: node clean-install-test.mjs <folder with release files>
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const release = resolve(process.argv[2]);
const win = process.platform === 'win32';
const results = [];
// If something ends this process from outside, the log still says how far it got.
process.on('exit', (code) => { if (code !== 0) console.log(`Test process ending with code ${code} after: ${results.at(-1)?.name ?? 'nothing'}`); });
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 500) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); };

const dir = mkdtempSync(join(tmpdir(), 'aot clean é-'));
const user = join(dir, 'user');
mkdirSync(user);
const home = join(user, '.agentontrack');
// Only what a fresh user has. In particular no token, and a PATH without any Node of ours.
const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, PATHEXT: process.env.PATHEXT, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE, SystemDrive: process.env.SystemDrive, windir: process.env.windir, HOME: user, USERPROFILE: user, LOCALAPPDATA: join(user, 'AppData') };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 300_000, ...opts });
const install = (from, extra = {}) => (win
  ? sh('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(release, 'install.ps1')], { env: { ...env, AOT_FROM: from, AOT_NO_PATH: '1', ...extra } })
  : sh('sh', [join(release, 'install.sh'), '--from', from], { env: { ...env, ...extra } }));
const launcher = join(home, 'app', 'bin', win ? 'agentontrack.cmd' : 'agentontrack');
const q = (x) => (win ? `"${x}"` : x);
const aot = (args, cwd = user, opts = {}) => sh(q(launcher), win ? args.map(q) : args, { cwd, shell: win, ...opts });

// A corrupted download must install nothing.
const names = readdirSync(release);
const asset = names.find((n) => (win ? /windows-x64\.zip$/ : new RegExp(`${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}\\.tar\\.gz$`)).test(n));
check('Release has a build for this machine', asset, names.join(', '));
const bad = join(dir, 'bad');
mkdirSync(bad);
for (const n of ['SHA256SUMS', asset]) copyFileSync(join(release, n), join(bad, n));
writeFileSync(join(bad, asset), Buffer.concat([readFileSync(join(bad, asset)), Buffer.from('tamper')]));
const tampered = install(bad);
check('Tampered download is refused, and nothing is installed', tampered.status !== 0 && /checksum/i.test(`${tampered.stdout}${tampered.stderr}`) && !existsSync(join(home, 'app', 'current')), `${tampered.status} ${tampered.stderr}`);

const inst = install(release);
check('Installer succeeds with no administrator rights', inst.status === 0, `${inst.stdout}${inst.stderr}`);
check('Checksum was verified', /Checksum verified/.test(inst.stdout), inst.stdout);
if (!win) check('PATH line added to the shell profile', readFileSync(join(user, '.profile'), 'utf8').includes('# agentontrack path'));

const v = aot(['--version']);
const version = v.stdout.trim();
check('A failing command reports failure to the shell', aot(['no-such-command']).status === 1);
check('Installed command runs on the bundled runtime', v.status === 0 && /^\d+\.\d+\.\d+/.test(version), `${v.stdout}${v.stderr}`);

const project = join(dir, 'my project');
mkdirSync(project);
sh('git', ['init', '-q'], { cwd: project });
const setup = aot(['setup', '--yes'], project);
check('Setup runs unattended, and detects what is missing rather than faking it', setup.status === 0 && /not installed|found/.test(setup.stdout), `${setup.stdout}${setup.stderr}`);
const installed = aot(['install', 'claude-code'], project);
check('Connects hooks to a project', installed.status === 0 && existsSync(join(project, '.claude', 'settings.local.json')), installed.stderr);
const doc = aot(['doctor', '--json'], project);
const report = JSON.parse(doc.stdout || '{}');
const cc = report.runtimes?.find((r) => r.runtime === 'claude-code');
check('Doctor reports a current runtime and an intact log', report.nodeOk && report.integrity?.ok, doc.stdout.slice(0, 300));
check('The hook program as installed answers its self-test', cc?.hookSelfTest?.ok, JSON.stringify(cc?.hookSelfTest));
check('Doctor states the host failure mode for Codex', report.runtimes?.find((r) => r.runtime === 'codex')?.hostFailMode === 'open');

const hookCommand = () => JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
check('Hook command uses the stable path, so upgrades keep working', /\/app\/current\//.test(hookCommand()), hookCommand());
const callHook = (command) => sh(hookCommand(), { shell: true, cwd: project, input: JSON.stringify({ session_id: 's', cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), env: { ...env, AGENTONTRACK_ROOT: project } });
check('Real hook process (not a live agent) denies a self-approval', /"permissionDecision":"deny"/.test(callHook('agentontrack approve x').stdout));

// Dashboard over a real terminal, since it refuses to start without one.
const helper = join(dirname(fileURLToPath(import.meta.url)), 'pty-helper.mjs');
const inTerminal = (bin, args, cwd, extraEnv = {}) => {
  const spec = { command: win ? 'cmd.exe' : 'sh', args: win ? ['/c', bin, ...args] : [bin, ...args], cwd, env: Object.fromEntries(Object.entries({ ...env, ...extraEnv }).filter(([, x]) => x)) };
  const c = spawn(process.execPath, [helper, JSON.stringify(spec)], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
  const t = { pid: c.pid, screen: '', done: false, write: (x) => c.stdin.write(x), end: () => { try { c.kill(); } catch { /* already gone */ } } };
  c.stdout.setEncoding('utf8').on('data', (d) => { t.screen += d; if (t.screen.includes('__PTY_EXIT__')) t.done = true; });
  c.stderr.setEncoding('utf8').on('data', (d) => { t.screen += d; });
  c.on('close', () => { t.done = true; });
  return t;
};
const term = inTerminal(launcher, ['dashboard'], project);
const until = async (re, ms = 30_000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = re.exec(term.screen); if (m) return m; await new Promise((ok) => setTimeout(ok, 200)); } return null; };
const url = (await until(/http:\/\/127\.0\.0\.1:\d+/))?.[0];
const code = (await until(/Pairing code[^:]*: ([A-Z0-9]+)/))?.[1];
check('Dashboard starts in a terminal and prints a pairing code', url && code, term.screen.slice(-400));
if (url && code) {
  const page = await fetch(`${url}/`);
  check('Dashboard page is served from the install', page.status === 200 && /<title>/.test(await page.text()));
  check('API refuses an unpaired caller', (await fetch(`${url}/api/state`)).status === 401);
  check('A wrong pairing code is refused', (await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"WRONG"}' })).status === 403);
  const paired = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const cookie = paired.headers.get('set-cookie')?.split(';')[0];
  check('The right pairing code works', paired.status === 200 && cookie);
  const st = await fetch(`${url}/api/state`, { headers: { cookie } });
  check('Paired dashboard reads the real record', st.status === 200 && (await st.json()).integrity.ok);
}
// Ctrl+C on Unix, as a person would. A console control event on a Windows runner ended this test from outside, silently, so there it stops the program's own process tree. Ctrl+C on Windows was checked on a desktop machine.
if (win) sh('taskkill', ['/F', '/T', '/PID', String(term.pid)]);
else term.write('\x03');
await new Promise((ok) => setTimeout(ok, 1500));
term.end();
check('Dashboard stops', url ? await fetch(`${url}/api/health`).then(() => false, () => true) : false);

// Upgrade and rollback, with a second version made from the first.
console.log('step: preparing an upgrade');
const next = '9.9.9-test';
const pack = join(dir, 'next');
mkdirSync(pack);
const stem = `agentontrack-${next}-${asset.match(/-(linux|macos|windows)-(x64|arm64)\./).slice(1).join('-')}`;
const src = join(dir, stem);
// The system's copy tool: Node's own recursive copy ended this test silently on a Windows runner's older Node.
const copied = win ? sh('robocopy', [join(home, 'app', 'versions', version), src, '/E', '/NFL', '/NDL', '/NJH', '/NJS']) : sh('cp', ['-R', join(home, 'app', 'versions', version), src]);
console.log(`step: copied, status ${copied.status}`);
const out = `${stem}.${win ? 'zip' : 'tar.gz'}`;
if (win) sh(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-cf', join(pack, out), stem], { cwd: dir });
else sh('tar', ['-czf', join(pack, out), stem], { cwd: dir });
const { createHash } = await import('node:crypto');
writeFileSync(join(pack, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(join(pack, out))).digest('hex')}  ${out}\n`);
console.log('step: upgrading');
console.log(`step: archive ready, ${existsSync(join(pack, out))}`);
const up = aot(['self', 'upgrade', '--version', next, '--from', pack]);
const status = () => JSON.parse(aot(['self', 'status']).stdout || '{}');
check('Upgrade verifies the checksum and activates the new version', up.status === 0 && status().installed?.current === next, `${up.stdout}${up.stderr}`);
check('Hooks still work after the upgrade, with no reinstall', /"permissionDecision":"deny"/.test(callHook('agentontrack approve y').stdout));
const back = aot(['self', 'rollback']);
check('Rollback returns to the earlier version', back.status === 0 && status().installed?.current === version, `${back.stdout}${back.stderr}`);
check('Hooks still work after the rollback', /"permissionDecision":"deny"/.test(callHook('agentontrack approve z').stdout));
const audit = aot(['audit'], project);
check('The project record survived upgrade and rollback', JSON.parse(audit.stdout || '{}').ok === true, audit.stdout.slice(0, 200));

// Uninstall keeps records by default, and purge removes them.
console.log('step: uninstalling');
const un = aot(['self', 'uninstall']);
await new Promise((ok) => setTimeout(ok, win ? 6000 : 300));
check('Uninstall reports success', un.status === 0, `${un.stdout}${un.stderr}`);
check('Uninstall removes the hooks from the project', !/agentontrack|\/lib\/cli/.test(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8')));
check('Uninstall removes the program', !existsSync(join(home, 'app')));
check('Uninstall keeps project records unless asked', existsSync(join(home, 'projects')));
if (!win) check('Uninstall removes the PATH lines', !readFileSync(join(user, '.profile'), 'utf8').includes('# agentontrack path'));
const again = install(release);
check('Reinstall after uninstall works', again.status === 0, again.stderr);
check('Purge refuses without a terminal', aot(['self', 'uninstall', '--purge']).status !== 0 && existsSync(join(home, 'app')));
const typed = /Type ([0-9a-f]{4}) to confirm/;
const purgeIn = async (bin, extraEnv) => {
  const t = inTerminal(bin, ['self', 'uninstall', '--purge'], user, extraEnv);
  for (let i = 0; i < 150 && !typed.test(t.screen); i++) await new Promise((ok) => setTimeout(ok, 200));
  t.write(`${typed.exec(t.screen)?.[1] ?? ''}\r`);
  for (let i = 0; i < 150 && !t.done; i++) await new Promise((ok) => setTimeout(ok, 200));
  await new Promise((ok) => setTimeout(ok, win ? 3000 : 300));
  t.end();
  return t.screen;
};
const ptOut = await purgeIn(launcher);
check('Purge in a terminal removes everything', !existsSync(home), ptOut.slice(-300));
const shared = join(dir, 'shared');
mkdirSync(join(shared, 'mine'), { recursive: true });
writeFileSync(join(shared, 'mine', 'keep.txt'), 'x');
const sharedInstall = install(release, { AGENTONTRACK_HOME: shared });
const sl = join(shared, 'app', 'bin', win ? 'agentontrack.cmd' : 'agentontrack');
const p2 = await purgeIn(sl, { AGENTONTRACK_HOME: shared });
check('Purge leaves files that are not its own', sharedInstall.status === 0 && existsSync(join(shared, 'mine', 'keep.txt')) && !existsSync(join(shared, 'app')), p2.slice(-300));


const failed = results.filter((r) => !r.ok);
writeFileSync(`clean-install-${process.platform}-${process.arch}.json`, JSON.stringify({ os: process.platform, arch: process.arch, runnerNode: process.version, version, runner: process.env.RUNNER_NAME ?? 'local', ranAt: new Date().toISOString(), note: 'Installed from release files only. The hook call is a real hook process with a test request, not a live agent.', passed: results.length - failed.length, failed: failed.length, results }, null, 2));
try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold a handle briefly */ }
console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
