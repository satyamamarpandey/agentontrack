// Repeats a live-* script N times and keeps each result as its own file under benchmarks/results/repeat/, leaving the canonical record untouched.
//   node scripts/live-repeat.mjs <script> <resultFile> <n> [args...]    e.g. node scripts/live-repeat.mjs live-codex.mjs live-codex-appserver.json 3
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [script, resultFile, nStr, ...args] = process.argv.slice(2);
const n = Number(nStr);
const dir = 'benchmarks/results/repeat';
mkdirSync(dir, { recursive: true });
const canon = `benchmarks/results/${resultFile}`;
const keep = `${canon}.bak-repeat`;
if (existsSync(canon)) copyFileSync(canon, keep);
const tag = (script + (args.length ? '-' + args.join('-') : '')).replace(/\.mjs$/, '');
for (let i = 1; i <= n; i++) {
  const t0 = Date.now();
  if (existsSync(canon)) rmSync(canon); // so a crashed trial cannot be mistaken for the previous record
  const r = spawnSync(process.execPath, [`scripts/${script}`, ...args], { encoding: 'utf8', env: process.env, timeout: 15 * 60_000 });
  let verdict = 'NO RECORD';
  try {
    if (existsSync(canon)) {
      const j = JSON.parse(readFileSync(canon, 'utf8'));
      verdict = j.verdict ?? 'see record';
      copyFileSync(canon, `${dir}/${tag}-${i}.json`);
    }
  } catch { /* keep verdict */ }
  const line = { script, args, trial: i, exit: r.status, verdict, seconds: Math.round((Date.now() - t0) / 1000) };
  writeFileSync(`${dir}/${tag}-${i}.exit.json`, JSON.stringify({ ...line, stdoutTail: (r.stdout ?? '').slice(-1500), stderrTail: (r.stderr ?? '').slice(-500) }, null, 2));
  console.log(JSON.stringify(line));
}
if (existsSync(keep)) renameSync(keep, canon);
