// REAL Codex (ChatGPT sign-in) as the builder, alone: the half of live-handoff.mjs that failed twice in 13 trials (no file written, run "finished").
//   node scripts/live-codex-builder.mjs [trials=8]    Result: benchmarks/results/live-codex-builder.json
// Same setup as the handoff: a git repo, hooks for both agents, the companion's app-server transport, approvals answered as a person through the real endpoint.
// For every trial it keeps the run's events (including a command that did not succeed) and the gate events, so a failure explains itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { startCompanion } from '../packages/companion/dist/index.js';

const shell = process.platform === 'win32';
if (spawnSync('codex', ['login', 'status'], { shell }).status !== 0) { console.log('NOT RUN: codex missing or not signed in'); process.exit(1); }
const trials = Number(process.argv[2] ?? 8);
const out = { date: new Date().toISOString(), what: 'Real Codex as builder, alone. Script: scripts/live-codex-builder.mjs', trials: [] };
const dir = mkdtempSync(join(tmpdir(), 'aot-livebuild-'));
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], { cwd, encoding: 'utf8' });

for (let n = 1; n <= trials; n++) {
  process.env.AGENTONTRACK_HOME = join(dir, `home-${n}`);
  const root = join(dir, `repo-${n}`); mkdirSync(root);
  git(root, 'init', '-q'); writeFileSync(join(root, 'README.md'), '# t\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
  const p = new Project(root);
  p.human.setGoal({ statement: 'Create small files as asked', scope: { include: ['**'] } });
  p.human.recordDecision('Keep changes to the one file asked for', 'Live builder test');
  p.close();
  const cli = `"${process.execPath}" "${join(process.cwd(), 'packages/cli/dist/index.js')}"`;
  installHooks('claude-code', root, cli); installHooks('codex', root, cli);
  const c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  const origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  const s = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf };
  const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = { n, approvedByHarness: [] };
  out.trials.push(t);
  const start = await api('/api/runs', { runtime: 'codex', model: 'default', prompt: 'Create a file named hello.txt containing exactly the word hello. Do nothing else.' });
  const j = await start.json();
  if (start.status !== 200) { t.verdict = 'FAIL'; t.error = j.error; await c.close(); continue; }
  let last;
  for (let i = 0; i < 240; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    last = (await (await api('/api/runs')).json()).find((x) => x.id === j.id);
    try {
      const st = await (await api('/api/state')).json();
      for (const a of (st.approvals ?? []).filter((x) => x.view === 'pending').slice(0, 3)) {
        const ch = await (await api('/api/challenge', {})).json();
        const ok = await api('/api/approvals/approve', { id: a.id, challengeId: ch.challengeId, confirm: ch.code });
        t.approvedByHarness.push({ id: a.id, effect: JSON.stringify(a.effect ?? a).slice(0, 160), status: ok.status });
      }
    } catch { /* next second */ }
    if (last && last.status !== 'running') break;
  }
  t.status = last?.status;
  t.events = (last?.events ?? []).map((e) => String(e).slice(0, 400));
  t.fileExists = existsSync(join(root, 'hello.txt'));
  t.fileContent = t.fileExists ? readFileSync(join(root, 'hello.txt'), 'utf8').slice(0, 40) : null;
  const q = new Project(root);
  t.gateEvents = q.store.all().filter((e) => /^(action|approval|decision)/.test(String(e.type))).map((e) => JSON.stringify({ type: e.type, p: e.payload }).slice(0, 400));
  q.close();
  t.verdict = last?.status === 'finished' && t.fileExists && t.fileContent.trim() === 'hello' ? 'PASS' : 'FAIL';
  console.log(n, t.verdict, last?.status, t.fileExists, t.events.filter((e) => /did not succeed|declined|waiting/.test(e)).join(' | ').slice(0, 200));
  await c.close();
}
out.passed = out.trials.filter((x) => x.verdict === 'PASS').length;
out.verdict = out.passed === out.trials.length ? 'PASS' : 'FAIL';
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync('benchmarks/results/live-codex-builder.json', JSON.stringify(out, null, 2));
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp */ }
console.log(`${out.passed}/${out.trials.length} passed`);
process.exit(out.verdict === 'PASS' ? 0 : 1);
