// The binary-only distribution check must fail closed: a release folder with a wrong checksum, source, a credential-shaped string or a missing platform is not assembled.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release', 'binary-distribution.mjs');
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64'];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

/** A tiny release folder. `extra` adds files to the linux-x64 archive; `skip` leaves a platform out. */
function release(opts: { extra?: Record<string, string>; skip?: string; corrupt?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aot-bd-')); dirs.push(dir);
  const rel = join(dir, 'rel'); mkdirSync(rel);
  const sums: string[] = [];
  const add = (name: string, buf: Buffer) => { writeFileSync(join(rel, name), buf); sums.push(`${createHash('sha256').update(buf).digest('hex')}  ${name}`); };
  const pack = (name: string, files: Record<string, string>) => {
    const w = join(dir, 'w-' + name); mkdirSync(w);
    for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(w, f)), { recursive: true }); writeFileSync(join(w, f), c); }
    const out = join(dir, name);
    const r = spawnSync(TAR, ['-czf', out, '-C', w, '.']);
    if (r.status !== 0) throw new Error('tar failed');
    add(name, readFileSync(out));
  };
  const base = { 'a/LICENSE': 'MIT', 'a/NOTICE': 'n', 'a/THIRD_PARTY_NOTICES.txt': 't', 'a/VERSION': '1.0.0-rc.9\n', 'a/lib/cli.mjs': 'console.log(1)' };
  for (const p of PLATFORMS) if (p !== opts.skip) pack(`agentontrack-1.0.0-rc.9-${p}.tar.gz`, p === 'linux-x64' ? { ...base, ...opts.extra } : base);
  pack('agentontrack-vscode.vsix', { 'extension/package.json': '{}', 'extension/LICENSE.txt': 'MIT' });
  add('install.sh', Buffer.from('#!/bin/sh\n')); add('install.ps1', Buffer.from('x'));
  if (opts.corrupt) writeFileSync(join(rel, 'install.sh'), 'tampered');
  writeFileSync(join(rel, 'SHA256SUMS'), sums.join('\n') + '\n');
  return { rel, out: join(dir, 'out') };
}
const run = (r: { rel: string; out: string }) => spawnSync(process.execPath, [SCRIPT, r.rel, r.out], { encoding: 'utf8', cwd: ROOT });

describe('binary-only distribution check', () => {
  it('assembles a clean release, with no source folder in the output', () => {
    const r = release(); const res = run(r);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(existsSync(join(r.out, 'assets', 'SHA256SUMS'))).toBe(true);
    expect(existsSync(join(r.out, 'packages'))).toBe(false);
    expect(JSON.parse(readFileSync(join(r.out, 'manifest.json'), 'utf8')).builtFromPrivateSource).toBe(true);
  });
  it('refuses a file that does not match its checksum', () => {
    const r = release({ corrupt: true }); const res = run(r);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/does not match SHA256SUMS/); expect(existsSync(r.out)).toBe(false);
  });
  it('refuses an archive that carries source', () => {
    const res = run(release({ extra: { 'a/src/index.ts': 'export {}' } }));
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/source-like file/);
  });
  it('refuses an archive with a credential-shaped string', () => {
    const res = run(release({ extra: { 'a/lib/x.mjs': 'const k = "sk-ant-' + 'a'.repeat(30) + '"' } }));
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/credential-shaped/);
  });
  it('refuses an archive with an env file or a private path', () => {
    expect(run(release({ extra: { 'a/e.env': 'X=1' } })).stdout).toMatch(/env file/);
    expect(run(release({ extra: { 'a/lib/y.mjs': 'D:\\Standalone AI' } })).stdout).toMatch(/private path/);
  });
  it('refuses a release that lacks a platform', () => {
    const res = run(release({ skip: 'macos-arm64' }));
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/no archive for macos-arm64/);
  });
});
