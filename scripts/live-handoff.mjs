// REAL Claude Code and REAL Codex, both signed in with their own subscriptions, through the real companion: a cross-review in both orders.
//   node scripts/live-handoff.mjs [claudeModel] [codexModel]
// Run it only after `codex login` and `claude` are signed in. It refuses to start (writes nothing) if either agent is missing, not signed in,
// or billed by use. It never reads a login file and never sets an API key. One trial per order: it shows the path works, not how often.
// Result: benchmarks/results/live-handoff.json. Verdict PASS only if every check below is true in both orders.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { startCompanion } from '../packages/companion/dist/index.js';

const claudeModel = process.argv[2] ?? 'haiku';
const codexModel = process.argv[3];
const shell = process.platform === 'win32';
const have = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell }).status === 0;
if (!have('claude', ['--version'])) { console.log('NOT RUN: claude is not installed.'); process.exit(1); }
if (!have('codex', ['--version'])) { console.log('NOT RUN: codex is not installed. See docs/codex-setup.md'); process.exit(1); }
if (!have('codex', ['login', 'status'])) { console.log('NOT RUN: codex is not signed in. Run `codex login` (Sign in with ChatGPT).'); process.exit(1); }

const out = { date: new Date().toISOString(), what: 'Real Claude Code and real Codex, cross-review both orders. Script: scripts/live-handoff.mjs', orders: [] };
const dir = mkdtempSync(join(tmpdir(), 'aot-livehand-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], { cwd, encoding: 'utf8' });

for (const [builder, reviewer] of [['claude-code', 'codex'], ['codex', 'claude-code']]) {
  process.env.AGENTONTRACK_HOME = join(dir, `home-${builder}`); // one registry per order, so each order is its own project
  const root = join(dir, `repo-${builder}`); mkdirSync(root);
  git(root, 'init', '-q'); writeFileSync(join(root, 'README.md'), '# t\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
  const p = new Project(root);
  p.human.setGoal({ statement: 'Create small files as asked', scope: { include: ['**'] } });
  p.human.recordDecision('Keep changes to the one file asked for', 'Live handoff test');
  p.human.createTask({ id: 't', title: 'Make hello.txt', criteria: [{ id: 'c', description: 'hello.txt says hello', kind: 'command', command: 'node -e "process.exit(require(\'fs\').readFileSync(\'hello.txt\',\'utf8\').trim()===\'hello\'?0:1)"' }] });
  p.close();
  const cli = `"${process.execPath}" "${join(process.cwd(), 'packages/cli/dist/index.js')}"`;
  installHooks('claude-code', root, cli); installHooks('codex', root, cli);
  const c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  const origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  const s = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf };
  const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const rts = await (await api('/api/runtimes')).json();
  const modes = Object.fromEntries(['claude-code', 'codex'].map((id) => [id, rts.find((x) => x.id === id)?.authMode]));
  const entry = { builder, reviewer, authModes: modes, checks: {} };
  out.orders.push(entry);
  if (modes['claude-code'] === 'api-key' || modes.codex === 'api-key') { entry.verdict = 'REFUSED: a sign-in bills by use'; await c.close(); continue; }
  const resp = await api('/api/workflows/cross-review', { builder, reviewer, taskId: 't', maxUsd: 0.3, builderModel: builder === 'claude-code' ? claudeModel : (codexModel ?? 'default'), reviewerModel: reviewer === 'claude-code' ? claudeModel : (codexModel ?? 'default'),
    prompt: 'Create a file named hello.txt containing exactly the word hello. Do nothing else.' });
  const events = () => { const q = new Project(root); try { return q.store.all().filter((e) => String(e.type).startsWith('workflow.')).map((e) => ({ type: e.type, ...e.payload })); } finally { q.close(); } };
  if (resp.status !== 200) { entry.verdict = 'FAIL'; entry.error = (await resp.json()).error; await c.close(); continue; }
  let ev = [];
  // This script plays the person: it approves what the agents are held for, through the real approval endpoint, and lists every approval in the result.
  entry.approvedByHarness = [];
  for (let i = 0; i < 1800 && !ev.some((e) => e.type === 'workflow.ended'); i++) {
    await new Promise((ok) => setTimeout(ok, 1000)); ev = events();
    try {
      const st = await (await api('/api/state')).json();
      for (const a of (st.approvals ?? []).filter((x) => x.view === 'pending').slice(0, 3)) {
        if (entry.approvedByHarness.length >= 12) break;
        const ch = await (await api('/api/challenge', {})).json();
        const ok = await api('/api/approvals/approve', { id: a.id, challengeId: ch.challengeId, confirm: ch.code });
        entry.approvedByHarness.push({ id: a.id, runtime: a.runtime, effect: JSON.stringify(a.effect ?? a).slice(0, 160), status: ok.status });
      }
    } catch { /* try again next second */ }
  }
  console.error('workflow ended, collecting', builder);
  const q = new Project(root);
  const all = q.store.all();
  // Diagnostics, added after a Codex-builder trial failed with no explanation in the record: the workflow events and what each run said.
  entry.workflowEvents = ev.map((e) => JSON.stringify(e).slice(0, 300));
  try { entry.runs = (await (await api('/api/runs')).json()).map((x) => ({ runtime: x.runtime, status: x.status, events: (x.events ?? []).slice(-8).map((t) => String(t).slice(0, 240)) })); } catch { /* diagnostics only */ }
  entry.gateEvents = all.filter((e) => /^(action|approval|decision)/.test(String(e.type))).map((e) => JSON.stringify({ type: e.type, actor: e.actor?.runtime ?? e.actor?.kind, p: e.payload }).slice(0, 400));
  entry.checks.workflowFinished = ev.find((e) => e.type === 'workflow.ended')?.status === 'finished';
  entry.checks.steps = JSON.stringify(ev.filter((e) => e.type === 'workflow.step').map((e) => e.step)) === JSON.stringify(['build', 'changes', 'handoff', 'review', 'checks']);
  entry.checks.fileBuilt = existsSync(join(root, 'hello.txt'));
  entry.checks.reviewerAcceptedHandoff = all.some((e) => e.type === 'handoff.accepted' && e.actor?.runtime === reviewer);
  // Actions are recorded per agent. For Claude Code they come from its hooks; for Codex (app-server) they come from the approval path, not hooks.
  entry.actionsByRuntime = {}; for (const e of all.filter((x) => x.type === 'action.requested')) { const r = e.actor?.runtime ?? e.payload.runtime ?? 'unknown'; entry.actionsByRuntime[r] = (entry.actionsByRuntime[r] ?? 0) + 1; }
  entry.checks.actionsRecordedForBothAgents = (entry.actionsByRuntime['claude-code'] ?? 0) > 0 && (entry.actionsByRuntime.codex ?? 0) > 0;
  entry.checks.checksPassed = q.state().receipts.some((x) => x.taskId === 't' && x.passed);
  entry.usageRows = all.filter((e) => e.type === 'usage.recorded').map((e) => ({ runtime: e.payload.runtime, input: e.payload.inputTokens, output: e.payload.outputTokens }));
  q.close();
  console.error('collected', builder);
  entry.verdict = Object.values(entry.checks).every(Boolean) ? 'PASS' : 'FAIL';
  await c.close();
  console.error('closed', builder);
}
out.verdict = out.orders.length === 2 && out.orders.every((o) => o.verdict === 'PASS') ? 'PASS' : 'FAIL';
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync('benchmarks/results/live-handoff.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ verdict: out.verdict, orders: out.orders.map((o) => ({ builder: o.builder, verdict: o.verdict, checks: o.checks, error: o.error })) }, null, 2));
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp */ }
process.exit(out.verdict === 'PASS' ? 0 : 1);
