// Measures real hook cost: a real process per call, as the host runs it. Usage: node benchmarks/performance.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { Project } from '../packages/core/dist/index.js';

const CLI = resolve('packages/cli/dist/index.js');
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10; };
const row = (name, xs) => ({ name, n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) });
const rows = [];

function setup(files, events) {
  const dir = mkdtempSync(join(tmpdir(), 'bl-perf-'));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  for (let i = 0; i < files; i++) {
    const sub = join(root, 'src', String(i % 50));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `f${i}.ts`), `export const v = ${i};\n`.repeat(20));
  }
  const p = new Project(root);
  p.human.setGoal({ statement: 'g' });
  p.human.createTask({ id: 't', title: 't' });
  const t0 = performance.now();
  for (let i = 0; i < events; i++) p.store.append({ type: 'filler', actor: { kind: 'system' }, payload: { i, pad: 'x'.repeat(200) } });
  const appendMs = (performance.now() - t0) / Math.max(events, 1);
  p.checkpoint();
  const db = statSync(p.store.path).size;
  p.close();
  return { dir, root, appendMs, db };
}

function hook(root, tool, input, event = 'PreToolUse') {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { cwd: root, encoding: 'utf8', env: { ...process.env, AGENTONTRACK_ROOT: root }, input: JSON.stringify({ session_id: 's', cwd: root, hook_event_name: event, tool_name: tool, tool_input: input }) });
  if (r.status !== 0) throw new Error(r.stderr);
  return performance.now() - t;
}

const base = () => { const t = performance.now(); spawnSync(process.execPath, ['-e', '0']); return performance.now() - t; };
rows.push(row('Bare node startup (floor for any hook)', Array.from({ length: 30 }, base)));

for (const [label, files, events, n] of [['small: 50 files, 100 events', 50, 100, 60], ['medium: 2,000 files, 5,000 events', 2000, 5000, 40], ['large: 10,000 files, 50,000 events', 10000, 50000, 25]]) {
  const s = setup(files, events);
  rows.push({ name: `Event append, ${label}`, n: events, p50: Math.round(s.appendMs * 100) / 100, p95: null, p99: null });
  const measure = (name, fn) => {
    fn(0); // The first call does the cold scan, reported separately below.
    rows.push(row(`${name}, ${label}`, Array.from({ length: n }, (_, i) => fn(i + 1))));
  };
  const coldT = performance.now();
  hook(s.root, 'Bash', { command: 'git status' });
  rows.push({ name: `First scan (cold), ${label}`, n: 1, p50: Math.round(performance.now() - coldT), p95: null, p99: null });
  measure('Read tool, no scan', (i) => hook(s.root, 'Read', { file_path: `src/0/f${i % 50}.ts` }));
  measure('Bash pre-action, cached scan', (i) => hook(s.root, 'Bash', { command: `git log -${i}` }));
  measure('Post-action diff', () => hook(s.root, "Bash", { command: "git status" }, "PostToolUse"));
  const p = new Project(s.root);
  const t = performance.now();
  const q = new Project(s.root);
  q.state();
  rows.push({ name: `Open and load state, with projection, ${label}`, n: 1, p50: Math.round((performance.now() - t) * 10) / 10, p95: null, p99: null });
  q.close();
  const v = performance.now();
  const ok = p.verifyIntegrity().ok;
  rows.push({ name: `Full integrity check, ${label} (ok=${ok})`, n: 1, p50: Math.round(performance.now() - v), p95: null, p99: null });
  rows.push({ name: `Database size in MB, ${label}`, n: 1, p50: Math.round((statSync(p.store.path).size / 1e6) * 10) / 10, p95: null, p99: null, unit: 'MB' });
  p.close();
  rmSync(s.dir, { recursive: true, force: true, maxRetries: 5 });
  console.error(`done ${label}`);
}

// Concurrency: parallel hook processes against one store must keep the chain intact.
{
  const s = setup(50, 0);
  const procs = await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise((ok) => {
    const t = performance.now();
    import('node:child_process').then(({ spawn }) => {
      const c = spawn(process.execPath, [CLI, 'hook', 'claude-code'], { cwd: s.root, env: { ...process.env, AGENTONTRACK_ROOT: s.root } });
      c.stdin.end(JSON.stringify({ session_id: `s${i}`, cwd: s.root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `git log -${i}` } }));
      c.on('close', (code) => ok({ code, ms: performance.now() - t }));
    });
  })));
  rows.push(row('16 parallel hook processes', procs.map((x) => x.ms)));
  const p = new Project(s.root);
  rows.push({ name: `Parallel run: nonzero exits ${procs.filter((x) => x.code !== 0).length}, chain ok ${p.verifyIntegrity().ok}`, n: 16, p50: null, p95: null, p99: null });
  p.close();
  rmSync(s.dir, { recursive: true, force: true, maxRetries: 5 });
}

const out = {
  ranAt: new Date().toISOString(),
  env: `${platform()} ${release()}, ${cpus()[0].model.trim()}, ${Math.round(totalmem() / 1e9)} GB RAM, Node ${process.version}. Times in ms unless noted. One machine, antivirus not excluded.`,
  budgets: { readToolP95Ms: 250, shellHookP95Ms2000Files: 400 },
  rows,
};
writeFileSync('benchmarks/results/performance.json', JSON.stringify(out, null, 2));
for (const r of rows) console.log(`${r.name} | n=${r.n} | p50 ${r.p50} | p95 ${r.p95} | p99 ${r.p99}`);
