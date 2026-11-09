// A vs B on one small matched task, real Claude Code on the signed-in subscription, smallest model, N trials each.
//   A: `claude -p` directly, with the same permission flags the companion uses, in a fresh repo with no hooks.
//   B: the same prompt through the companion, with its hooks installed.
// It measures tokens (as reported by Claude Code), wall-clock time and whether the file was written correctly. It does NOT measure variant C:
// no token-saving change has been built, so there is nothing to compare. A trial count this small shows overhead, not a significant difference.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { startCompanion } from '../packages/companion/dist/index.js';

const N = Number(process.env.TRIALS ?? 3);
const PROMPT = 'Create a file named hello.txt containing exactly the text: hi. Then reply with the single word done.';
const ok = (root) => existsSync(join(root, 'hello.txt')) && readFileSync(join(root, 'hello.txt'), 'utf8').trim() === 'hi';
const dir = mkdtempSync(join(tmpdir(), 'aot-bench-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const result = { date: new Date().toISOString().slice(0, 10), what: 'Real Claude Code on the signed-in subscription. Script: scripts/bench-overhead.mjs', task: PROMPT, trialsEach: N, model: 'haiku', A: [], B: [], notes: [] };

const fresh = (name) => { const r = join(dir, name); mkdirSync(r); spawnSync('git', ['init', '-q'], { cwd: r }); writeFileSync(join(r, 'README.md'), '# t\n'); return r; };

for (let i = 0; i < N; i++) {
  const root = fresh(`a${i}`);
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', PROMPT, '--model', 'haiku', '--output-format', 'json', '--allowedTools', 'Bash,Write,Edit,Read,Grep,Glob', '--permission-mode', 'acceptEdits'], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  let j = {}; try { j = JSON.parse(r.stdout); } catch { /* keep empty */ }
  const mu = Object.values(j.modelUsage ?? {})[0] ?? {};
  result.A.push({ seconds: +((Date.now() - t0) / 1000).toFixed(1), correct: ok(root), input: mu.inputTokens ?? null, output: mu.outputTokens ?? null, cacheRead: mu.cacheReadInputTokens ?? null, cacheCreate: mu.cacheCreationInputTokens ?? null, turns: j.num_turns ?? null });
  console.log('A', i, JSON.stringify(result.A.at(-1)));
}

const root = fresh('b');
const p = new Project(root); p.human.setGoal({ statement: 'Create hello.txt', scope: { include: ['**'] } }); p.close();
installHooks('claude-code', root, `"${process.execPath}" "${join(process.cwd(), 'packages/cli/dist/index.js')}"`);
const c = await startCompanion({ root, uiDir: join(dir, 'ui') });
const origin = c.url.slice(0, -1);
const pr = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
const s = { cookie: pr.headers.get('set-cookie').split(';')[0], csrf: (await pr.json()).csrf };
const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
for (let i = 0; i < N; i++) {
  rmSync(join(root, 'hello.txt'), { force: true });
  const t0 = Date.now();
  const st = await api('/api/runs', { runtime: 'claude-code', prompt: PROMPT, model: 'haiku', maxBudgetUsd: 0.2 });
  const id = (await st.json()).id;
  let last; for (let k = 0; k < 240; k++) { const rs = await (await api('/api/runs')).json(); last = rs.find((x) => x.id === id); if (last && last.status !== 'running') break; await new Promise((o) => setTimeout(o, 500)); }
  const seconds = +((Date.now() - t0) / 1000).toFixed(1);
  const q = new Project(root);
  const u = q.store.all().filter((e) => e.type === 'usage.recorded' && e.payload.source === 'provider-reported').at(-1)?.payload ?? {};
  const actions = q.store.all().filter((e) => e.type === 'action.requested').length;
  q.close();
  result.B.push({ seconds, correct: ok(root), status: last?.status, input: u.inputTokens ?? null, output: u.outputTokens ?? null, cacheRead: u.cacheReadTokens ?? null, cacheCreate: u.cacheCreationTokens ?? null, actionsGatedSoFar: actions });
  console.log('B', i, JSON.stringify(result.B.at(-1)));
}
await c.close();
const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
for (const k of ['seconds', 'input', 'output', 'cacheRead', 'cacheCreate']) result[`median_${k}`] = { A: med(result.A.map((x) => x[k])), B: med(result.B.map((x) => x[k])) };
result.correct = { A: result.A.filter((x) => x.correct).length, B: result.B.filter((x) => x.correct).length, of: N };
result.notes.push('Variant C (improved AgentOnTrack) is not measured: no token-saving change exists to compare. N is too small for a significance claim. B includes the companion, its hooks and --setting-sources project,local; A does not.');
writeFileSync(join(process.cwd(), 'benchmarks/results/bench-overhead.json'), JSON.stringify(result, null, 2));
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(JSON.stringify({ correct: result.correct, seconds: result.median_seconds, input: result.median_input, output: result.median_output, cacheRead: result.median_cacheRead }));
