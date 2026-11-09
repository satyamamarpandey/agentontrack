// Builds and checks a BINARY-ONLY distribution folder from a release folder (the files `package.mjs` writes, or the `release` artifact of a release.yml run).
// Publishes nothing and talks to no network. The output is what an owner would attach to a release; it contains no source tree.
//   node scripts/release/binary-distribution.mjs <release folder> <new empty output folder>
// Checks, each one a hard failure: every file in SHA256SUMS exists and matches; the expected five archives, the VS Code extension and the two installers are present;
// each archive and the extension are unpacked into a temp folder and must carry the licence files, no source (.ts, src/, tests, maps), no e.env, no credential-shaped
// strings and no local paths. The bundled Node binary is skipped by the string scan (it is Node's own file) and is checked against Node's published checksums at build time.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [src, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!src || !out) { console.error('usage: binary-distribution.mjs <release folder> <new output folder>'); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error('The output folder must be new or empty.'); process.exit(2); }
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const problems = [];
const bad = (m) => { problems.push(m); console.log('FAIL', m); };
const ok = (m) => console.log('ok  ', m);

// 1. The checksum list matches the files.
const sumsFile = join(src, 'SHA256SUMS');
if (!existsSync(sumsFile)) { console.error('No SHA256SUMS in', src); process.exit(1); }
const sums = Object.fromEntries(readFileSync(sumsFile, 'utf8').split('\n').filter(Boolean).map((l) => { const [h, n] = l.split(/\s+/); return [n, h]; }));
for (const [name, h] of Object.entries(sums)) {
  if (!existsSync(join(src, name))) bad(`${name} is in SHA256SUMS but missing`);
  else if (sha(join(src, name)) !== h) bad(`${name} does not match SHA256SUMS`);
}
for (const n of readdirSync(src)) if (n !== 'SHA256SUMS' && !sums[n]) bad(`${n} is not listed in SHA256SUMS`);
const archives = Object.keys(sums).filter((n) => /^agentontrack-.+-(linux|macos|windows)-(x64|arm64)\.(tar\.gz|zip)$/.test(n));
const VERSION = /^agentontrack-(.+?)-(linux|macos|windows)/.exec(archives[0] ?? '')?.[1] ?? 'unknown';
for (const t of ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64']) if (!archives.some((a) => a.includes(`-${t}.`))) bad(`no archive for ${t}`);
for (const n of ['agentontrack-vscode.vsix', 'install.sh', 'install.ps1']) if (!sums[n]) bad(`${n} is missing`);
if (!problems.length) ok(`${Object.keys(sums).length} files match SHA256SUMS; 5 platform archives, extension and installers present (version ${VERSION})`);

// 2. Contents of each archive.
const SECRETS = [/sk-ant-[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9]{32,}/, /AIza[0-9A-Za-z_-]{35}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY/];
const PRIVATE = [/[A-Za-z]:[\\/]+Users[\\/]+(?!runner\b|Public\b)\w+/, /\/Users\/(?!runner\b)[a-z]\w+\//, /D:[\\/]+Standalone/, new RegExp(['piyu', 'sha'].join(''), 'i'), new RegExp(['7satyam', 'pandey'].join(''), 'i'), new RegExp(['agentontrack', '-core'].join(''))];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const report = { version: VERSION, checkedAt: new Date().toISOString(), archives: {} };
for (const name of [...archives, 'agentontrack-vscode.vsix'].filter((n) => sums[n])) {
  const tmp = mkdtempSync(join(tmpdir(), 'aot-dist-'));
  const r = spawnSync(TAR, ['-xf', join(src, name), '-C', tmp], { encoding: 'utf8' });
  if (r.status !== 0) { bad(`${name}: could not be unpacked (${(r.stderr || '').slice(0, 120)})`); rmSync(tmp, { recursive: true, force: true }); continue; }
  const files = walk(tmp);
  const rel = files.map((f) => relative(tmp, f).replaceAll('\\', '/'));
  const here = [];
  const vsix = name.endsWith('.vsix');
  if (!vsix) for (const need of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'VERSION']) if (!rel.some((f) => f.endsWith('/' + need) || f === need)) here.push(`missing ${need}`);
  if (vsix && !rel.some((f) => /license/i.test(f))) here.push('missing licence file');
  for (const f of rel) {
    if (/(^|\/)(src|test|tests|e2e)\//.test(f) || /\.(ts|tsx|map)$/.test(f) && !f.endsWith('.d.ts')) here.push(`source-like file: ${f}`);
    if (/(^|\/)e\.env(\.|$)/.test(f) && !f.endsWith('.example')) here.push(`env file: ${f}`);
  }
  for (const f of files) {
    if (/(^|[\\/])node(\.exe)?$/.test(f) && statSync(f).size > 20_000_000) continue; // Node's own binary
    const text = readFileSync(f).toString('latin1');
    for (const re of SECRETS) if (re.test(text)) here.push(`credential-shaped string in ${relative(tmp, f)}`);
    for (const re of PRIVATE) if (re.test(text)) here.push(`private path or name in ${relative(tmp, f)}`);
  }
  report.archives[name] = { files: rel.length, sha256: sums[name], problems: here };
  if (here.length) for (const h of [...new Set(here)].slice(0, 8)) bad(`${name}: ${h}`); else ok(`${name}: ${rel.length} files, licences present, no source, no credentials, no private paths`);
  rmSync(tmp, { recursive: true, force: true });
}

// 3. Assemble the binary-only folder, but only if nothing failed.
if (problems.length) { console.log(`\n${problems.length} problem(s). Nothing assembled.`); process.exit(1); }
mkdirSync(join(out, 'assets'), { recursive: true });
for (const n of Object.keys(sums)) cpSync(join(src, n), join(out, 'assets', n));
cpSync(sumsFile, join(out, 'assets', 'SHA256SUMS'));
const root = process.cwd();
for (const [from, to] of [['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE'], ['SECURITY.md', 'SECURITY.md'], ['docs/release/NOTES.md', 'RELEASE_NOTES.md'], ['docs/release/BINARY_README.md', 'README.md']]) {
  if (existsSync(join(root, from))) cpSync(join(root, from), join(out, to)); else console.log('note: no', from);
}
// The documents travel alone, so they must not point at private files or carry private names.
for (const d of ['README.md', 'RELEASE_NOTES.md', 'SECURITY.md']) {
  if (!existsSync(join(out, d))) continue;
  const t = readFileSync(join(out, d), 'utf8');
  const hit = [...PRIVATE, ...SECRETS].some((re) => re.test(t)) || /docs\/(PRODUCT_READINESS|release\/CERTIFICATION|STATE)/.test(t);
  if (hit) bad(`${d}: mentions a private name, a credential-shaped string or a repository-only file`);
}
if (problems.length) { console.log('\nA document is not fit to ship. Nothing kept.'); rmSync(out, { recursive: true, force: true }); process.exit(1); }
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version: VERSION, builtFromPrivateSource: true, files: Object.fromEntries(Object.entries(sums).map(([n, h]) => [n, { sha256: h, bytes: statSync(join(src, n)).size }])) }, null, 2));
writeFileSync(join(out, 'verification.json'), JSON.stringify(report, null, 2));
console.log(`\nAssembled ${basename(out)}: ${readdirSync(join(out, 'assets')).length} assets, no source tree. Publishes nothing.`);
