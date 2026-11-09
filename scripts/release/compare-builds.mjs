// Compares two release builds by what is inside them, not by the archive bytes (zip and tar.gz headers carry timestamps, so archive hashes differ).
//   node scripts/release/compare-builds.mjs <dirA> <dirB>      each a directory made by `node scripts/release/package.mjs --out <dir>`
// Extracts every .zip, .tar.gz and .vsix in each directory into its own new temp folder, hashes every file, and lists any file that differs or is missing.
// Exit 0 only if every archive in A has an identical-content twin in B. This shows the build is repeatable on one machine; it is not an attestation.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [a, b] = process.argv.slice(2).map((p) => resolve(p));
if (!a || !b) { console.error('usage: compare-builds.mjs <dirA> <dirB>'); process.exit(2); }
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const hashes = (dir) => Object.fromEntries(walk(dir).map((p) => [p.slice(dir.length + 1).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(p)).digest('hex')]));
const extract = (file) => {
  const out = mkdtempSync(join(tmpdir(), 'aot-cmp-'));
  const r = spawnSync(TAR, ['-xf', file, '-C', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not extract ${file}: ${r.stderr}`);
  return out;
};
const archives = (d) => readdirSync(d).filter((n) => /\.(zip|tar\.gz|vsix)$/.test(n)).sort();
let bad = 0;
const names = archives(a);
if (!names.length) { console.error('no archives in', a); process.exit(2); }
for (const n of names) {
  if (!archives(b).includes(n)) { console.log(`MISSING in B: ${n}`); bad++; continue; }
  const [xa, xb] = [extract(join(a, n)), extract(join(b, n))];
  const [ha, hb] = [hashes(xa), hashes(xb)];
  const diff = [...new Set([...Object.keys(ha), ...Object.keys(hb)])].filter((k) => ha[k] !== hb[k]);
  console.log(`${diff.length ? 'DIFFERS' : 'same contents'}: ${n} (${Object.keys(ha).length} files)${diff.length ? ' -> ' + diff.slice(0, 10).join(', ') : ''}`);
  bad += diff.length;
  rmSync(xa, { recursive: true, force: true }); rmSync(xb, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
