import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { uninstallHooks } from '@agentontrack/adapters';
import { agentontrackHome, loadRegistry } from '@agentontrack/core';

export const VERSION = '1.0.0-rc.3';
const REPO = 'satyamamarpandey/agentontrack';
const win = process.platform === 'win32';
const appDir = () => join(agentontrackHome(), 'app');
const current = () => join(appDir(), 'current');
const versionsDir = () => join(appDir(), 'versions');
const statePath = () => join(appDir(), 'install.json');
const PATH_MARKER = '# agentontrack path';
const DATA_ITEMS = ['projects', 'witness', 'registry.json', 'settings.json', 'feedback.jsonl'];

/** A version becomes a folder name, so it must not be able to name anything else. */
function checkVersion(v: string): string {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) || v.includes('..')) throw new Error(`Not a version: ${v.slice(0, 40)}`);
  return v;
}

interface InstallState { current: string; previous: string | null }
const loadState = (): InstallState | null => { try { return JSON.parse(readFileSync(statePath(), 'utf8')); } catch { return null; } };

/** Hooks stay valid across upgrades and rollbacks: inside an install they go through the stable current link. */
export function stableCommand(execPath: string, script: string): string {
  const stable = (p: string) => p.replace(/\\/g, '/').replace(/\/app\/versions\/[^/]+\//, '/app/current/');
  return `"${stable(execPath)}" "${stable(script)}"`;
}

function pointCurrentAt(version: string): void {
  const link = current();
  const target = join(versionsDir(), checkVersion(version));
  if (!existsSync(target)) throw new Error(`Version ${version} is not installed`);
  if (lstatSync(link, { throwIfNoEntry: false })) {
    if (win) spawnSync('cmd', ['/c', 'rmdir', link]); else unlinkSync(link);
  }
  symlinkSync(target, link, win ? 'junction' : 'dir');
}

function writeLaunchers(): void {
  const bin = join(appDir(), 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agentontrack'), `#!/bin/sh\nd="$(cd "$(dirname "$0")/.." && pwd)/current"\nif [ -x "$d/node/bin/node" ]; then exec "$d/node/bin/node" "$d/lib/cli.mjs" "$@"; else exec "$d/node/node.exe" "$d/lib/cli.mjs" "$@"; fi\n`, { mode: 0o755 });
  // Batch only for the clean-up: PowerShell cmdlets may not load when this was started from PowerShell 7.
  if (win) writeFileSync(join(bin, 'agentontrack.cmd'), [
    '@echo off',
    'set AOT_LAUNCHER=cmd',
    '"%~dp0..\\current\\node\\node.exe" "%~dp0..\\current\\lib\\cli.mjs" %*',
    'set AOT_EXIT=%ERRORLEVEL%',
    'if not exist "%~dp0..\\uninstall-pending" exit /b %AOT_EXIT%',
    'rmdir "%~dp0..\\current" 2>nul',
    'rmdir /s /q "%~dp0..\\versions" 2>nul',
    'if exist "%~dp0..\\uninstall-purge" (',
    '  for %%i in (projects witness) do rmdir /s /q "%~dp0..\\..\\%%i" 2>nul',
    '  for %%i in (registry.json settings.json feedback.jsonl) do del /q "%~dp0..\\..\\%%i" 2>nul',
    ')',
    '(goto) 2>nul & rmdir /s /q "%~dp0.." & rmdir "%~dp0..\\.." 2>nul & ver>nul',
    '',
  ].join('\r\n'));
}

function activate(version: string): void {
  const before = loadState();
  // A leftover from an uninstall that never finished must not fire through the new launcher.
  for (const n of ['uninstall-pending', 'uninstall-purge']) rmSync(join(appDir(), n), { force: true });
  pointCurrentAt(version);
  writeLaunchers();
  const previous = before && before.current !== version ? before.current : before?.previous ?? null;
  writeFileSync(statePath(), JSON.stringify({ current: version, previous } satisfies InstallState, null, 2));
}

const assetName = (version: string) => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const os = win ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return `agentontrack-${version}-${os}-${arch}.${win ? 'zip' : 'tar.gz'}`;
};

async function download(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(600_000), headers: { 'user-agent': 'agentontrack' } });
  if (!r.ok) throw new Error(`Could not download ${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Installs from a release, or from a folder holding the same files. The checksum must match before anything unpacks. */
async function installVersion(version: string, from?: string): Promise<void> {
  checkVersion(version);
  const name = assetName(version);
  const sums = from ? readFileSync(join(from, 'SHA256SUMS'), 'utf8') : (await download(`https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS`)).toString('utf8');
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, '') === name)?.[0];
  if (!want) throw new Error(`${name} is not listed in SHA256SUMS, so it cannot be trusted`);
  const data = from ? readFileSync(join(from, name)) : await download(`https://github.com/${REPO}/releases/download/v${version}/${name}`);
  const got = createHash('sha256').update(data).digest('hex');
  if (got !== want) throw new Error(`Checksum mismatch for ${name}: expected ${want}, got ${got}. Nothing was installed.`);
  const tmp = mkdtempSync(join(tmpdir(), 'aot-up-'));
  try {
    const file = join(tmp, name);
    writeFileSync(file, data);
    // Unpacks beside the versions it will join, so the final rename cannot fail half way across disks.
    mkdirSync(versionsDir(), { recursive: true });
    const incoming = mkdtempSync(join(versionsDir(), '.incoming-'));
    try {
    // On Windows the system tar reads zip. A tar from Git Bash, which may come first on PATH, does not.
    const tar = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const t = spawnSync(tar, ['-xf', file, '-C', incoming], { encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`Could not unpack ${name}: ${t.stderr}`);
    const inner = join(incoming, readdirSync(incoming)[0]!);
    // Nothing replaces what works until the new build has actually started.
    const trial = spawnSync(join(inner, 'node', win ? 'node.exe' : join('bin', 'node')), [join(inner, 'lib', 'cli.mjs'), '--version'], { encoding: 'utf8', timeout: 60_000 });
    if (trial.status !== 0) throw new Error(`The new build would not start, so nothing changed: ${`${trial.stderr ?? ''}${trial.error?.message ?? ''}`.slice(0, 200)}`);
    const dest = join(versionsDir(), version);
    rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    renameSync(inner, dest);
    } finally {
      rmSync(incoming, { recursive: true, force: true, maxRetries: 3 });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
  activate(version);
}

function removePathEntries(): string[] {
  const touched: string[] = [];
  if (win) {
    const script = "$b=Join-Path $env:AGENTONTRACK_APP 'bin';$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true);$p=$k.GetValue('Path','','DoNotExpandEnvironmentNames');if($p){$k.SetValue('Path',(($p -split ';' | Where-Object {$_ -and $_ -ne $b}) -join ';'),'ExpandString')};[Environment]::SetEnvironmentVariable('AOT_PATH_REFRESH',$null,'User')";
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, AGENTONTRACK_APP: appDir() } });
    return ['user PATH'];
  }
  for (const f of ['.profile', '.bashrc', '.zshrc', '.bash_profile']) {
    const p = join(homedir(), f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    if (!text.includes(PATH_MARKER)) continue;
    writeFileSync(p, text.split('\n').filter((l) => !l.includes(PATH_MARKER)).join('\n'));
    touched.push(f);
  }
  return touched;
}

function uninstall(purge: boolean): void {
  // A running program cannot delete itself on Windows, so only the launcher can finish the job.
  if (win && !process.env.AOT_LAUNCHER) throw new Error('On Windows, run this from PowerShell or Command Prompt, so it can finish after the program exits.');
  const say = (s: string) => console.log(s);
  for (const r of loadRegistry()) {
    if (!existsSync(r.root)) { say(`Skipped ${r.root}: folder is missing, so any hook file there is untouched`); continue; }
    for (const rt of ['claude-code', 'codex'] as const) if (uninstallHooks(rt, r.root)) say(`Removed ${rt} hooks from ${r.root}`);
  }
  say(`PATH cleaned: ${removePathEntries().join(', ') || 'nothing to clean'}`);
  say('If you added AgentOnTrack hooks to a Hermes config.yaml, remove them yourself. With fail_closed: true, Hermes would otherwise block every action.');
  const home = agentontrackHome();
  const target = appDir();
  say(purge ? `Deleting all data in ${home}, including every project's record` : `Keeping your records in ${home}. Add --purge to delete them too.`);
  if (win) {
    // A running program cannot delete itself on Windows, so the launcher runs this after the program exits.
    writeFileSync(join(appDir(), 'uninstall-pending'), '');
    if (purge) writeFileSync(join(appDir(), 'uninstall-purge'), '');
  } else {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    if (purge) {
      // Only what AgentOnTrack made, so a home folder pointed somewhere shared loses nothing else.
      for (const item of DATA_ITEMS) rmSync(join(home, item), { recursive: true, force: true, maxRetries: 3 });
      try { rmdirSync(home); } catch { say(`Left ${home} in place, since it holds other files.`); }
    }
  }
  say('AgentOnTrack is uninstalled. Agents in other shells may still have the old PATH until they restart.');
}

export async function runSelf(sub: string | undefined, a: { opt: (n: string) => string | undefined; has: (n: string) => boolean; confirm: (action: string) => Promise<void> }): Promise<void> {
  const say = (s: string) => console.log(s);
  switch (sub) {
    case 'activate': {
      const v = checkVersion(a.opt('version') ?? basename(dirname(dirname(process.argv[1] ?? ''))));
      activate(v);
      say(`AgentOnTrack ${v} is active.`);
      return;
    }
    case 'status':
    case undefined: {
      const s = loadState();
      say(JSON.stringify({ running: VERSION, installed: s, versions: existsSync(versionsDir()) ? readdirSync(versionsDir()) : [], home: agentontrackHome() }, null, 2));
      return;
    }
    case 'rollback': {
      const s = loadState();
      if (!s?.previous) throw new Error('No earlier version to roll back to');
      activate(s.previous);
      say(`Rolled back to ${s.previous}.`);
      return;
    }
    case 'upgrade': {
      let v = a.opt('version');
      if (!v) {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'agentontrack' } });
        if (!r.ok) throw new Error(`Could not ask GitHub for the latest release: HTTP ${r.status}. Use --version to name one.`);
        v = String(((await r.json()) as { tag_name: string }).tag_name).replace(/^v/, '');
      }
      if (v === loadState()?.current && !a.has('force')) { say(`Already on ${v}.`); return; }
      await installVersion(v, a.opt('from'));
      say(`Now on ${v}. Roll back with: agentontrack self rollback`);
      return;
    }
    case 'uninstall':
      if (a.has('purge')) {
        const home = agentontrackHome();
        if (home === homedir() || dirname(home) === home) throw new Error(`Refusing to purge ${home}: it is not a folder of ours`);
        await a.confirm(`Delete every AgentOnTrack project record in ${home}. This cannot be undone`);
      }
      uninstall(a.has('purge'));
      return;
    default:
      throw new Error('Usage: agentontrack self status|upgrade [--version v] [--from dir]|rollback|uninstall [--purge]');
  }
}
