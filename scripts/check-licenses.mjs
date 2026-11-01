// Walks production dependencies through pnpm's own output. Fails on anything outside the allow-list or with no licence.
import { spawnSync } from 'node:child_process';

const ALLOW = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'MPL-2.0', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT', 'Python-2.0', 'CC-BY-4.0']);
// Next.js pulls an optional image library for platforms it runs on. LGPL dynamic-linked binaries, optional, not modified.
const NOTED = new Map([['@img/sharp-libvips', 'LGPL-3.0-or-later: optional dependency of next/image, not used by this project']]);

const r = spawnSync('pnpm', ['licenses', 'list', '--prod', '--recursive', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
let data = {};
try { data = JSON.parse(r.stdout); } catch { console.error('pnpm licenses gave no JSON:', r.stdout.slice(0, 300), r.stderr.slice(0, 300)); process.exit(1); }
const counts = {};
const problems = [];
const mpl = [];
for (const [license, pkgs] of Object.entries(data)) {
  counts[license] = pkgs.length;
  for (const p of pkgs) {
    if (license === 'MPL-2.0') mpl.push(p.name);
    if (!ALLOW.has(license) && ![...NOTED.keys()].some((k) => p.name.startsWith(k))) problems.push(`${p.name}: ${license}`);
  }
}
console.log(JSON.stringify({ counts, mpl, noted: [...NOTED.values()] }, null, 2));
if (problems.length) { console.error('Not allowed:\n' + problems.join('\n')); process.exit(1); }
