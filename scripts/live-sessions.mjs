// REAL Claude Code, on the signed-in subscription, through the real companion and the new /api/agent-sessions routes. Small runs, the smallest model.
//   node scripts/live-sessions.mjs      Result: benchmarks/results/live-sessions.json (one trial; use scripts/live-repeat.mjs for repeats).
// It refuses to run (and writes nothing) if the sign-in bills by use. Checks: a new session is genuinely new (it does not remember an earlier one), a continue remembers, the provider's
// session is linked, and a READ-ONLY policy really stops a file being written (with a standard-policy control). Nothing here is a fixture.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { startCompanion } from '../packages/companion/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'aot-live-sess-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const root = join(dir, 'repo'); mkdirSync(root);
writeFileSync(join(root, 'README.md'), '# t\n');
spawnSync('git', ['init', '-q'], { cwd: root });
const p = new Project(root); p.human.setGoal({ statement: 'Answer briefly and create small files when asked', scope: { include: ['**'] } }); p.close();
installHooks('claude-code', root, `"${process.execPath}" "${join(process.cwd(), 'packages/cli/dist/index.js')}"`);
const c = await startCompanion({ root, uiDir: join(dir, 'ui') });
const origin = c.url.slice(0, -1);
const r0 = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
const s = { cookie: r0.headers.get('set-cookie').split(';')[0], csrf: (await r0.json()).csrf };
const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const out = { date: new Date().toISOString(), what: 'Real Claude Code through the companion\'s agent-session routes. Script: scripts/live-sessions.mjs', checks: {}, runs: [] };
const ver = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }); out.claudeVersion = ver.stdout.trim();
const rt = (await (await api('/api/runtimes')).json()).find((x) => x.id === 'claude-code');
out.authMode = rt.authMode;
if (rt.authMode === 'api-key' || !rt.canStart) { console.log('NOT RUN: the sign-in bills by use, or Claude Code cannot start here', rt.authMode, rt.reason); await c.close(); process.exit(1); }

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const wait = async (sid, ms = 240_000) => { for (const t = Date.now(); Date.now() - t < ms;) { const v = (await (await api(`/api/agent-sessions/${sid}`)).json()); if (v.status && v.status !== 'running') return v; await sleep(1000); } return null; };
const replyOf = (v) => (v?.runs ?? []).flatMap((r) => r.events).filter((e) => !e.startsWith('[tool') && !e.startsWith('result:')).join(' ');
const startSession = async (label, body) => { const t0 = Date.now(); const r = await api('/api/agent-sessions', { runtime: 'claude-code', model: 'haiku', maxBudgetUsd: 0.2, ...body }); const j = await r.json(); if (r.status !== 200) { out.runs.push({ label, status: r.status, error: j.error }); return null; } const v = await wait(j.sessionId); out.runs.push({ label, sessionId: j.sessionId, status: v?.status, reply: replyOf(v).slice(0, 200), seconds: Math.round((Date.now() - t0) / 1000) }); return { ...j, view: v }; };

try {
  const a = await startSession('1 a new session: remember a word', { prompt: 'Remember this code word: HERON. Reply with only the word stored.' });
  out.checks.firstSessionIdle = a?.view?.status === 'idle';
  out.checks.providerSessionLinked = a?.view?.linked === true && a?.view?.canResume === true;
  const t0 = Date.now();
  const rr = a && await api(`/api/agent-sessions/${a.sessionId}/resume`, { prompt: 'What was the code word I gave you? Reply with only that word.', model: 'haiku', maxBudgetUsd: 0.2 });
  const rj = rr && await rr.json();
  const rv = rj?.sessionId ? await wait(rj.sessionId) : null;
  out.runs.push({ label: '2 continue the same session', sessionId: rj?.sessionId, status: rv?.status, reply: replyOf(rv).slice(-200), seconds: Math.round((Date.now() - t0) / 1000) });
  out.checks.continueKeptTheSameSession = !!a && rj?.sessionId === a.sessionId && rv?.runs?.length === 2;
  out.checks.continueRemembered = /HERON/i.test(replyOf(rv).split(' ').slice(-40).join(' ')) && (rv?.runs?.length ?? 0) === 2;
  const b = await startSession('3 a NEW session must not remember', { prompt: 'What code word did I give you earlier? If you have no earlier conversation, reply with only the word UNKNOWN.' });
  out.checks.newSessionIsDifferent = !!a && !!b && b.sessionId !== a.sessionId;
  out.checks.newSessionDoesNotRemember = /UNKNOWN/i.test(replyOf(b?.view)) && !/HERON/i.test(replyOf(b?.view));
  const ro = await startSession('4 read-only policy: ask for a file', { policy: 'read-only', prompt: 'Create a file named ro.txt containing the word blocked, using your tools, then reply done. If you cannot, say CANNOT.' });
  out.checks.readOnlyRunEnded = ro?.view?.status === 'idle' || ro?.view?.status === 'failed';
  out.checks.readOnlyWroteNothing = !existsSync(join(root, 'ro.txt'));
  const st = await startSession('5 standard policy (control): ask for a file', { prompt: 'Create a file named std.txt containing the word ok, using your tools, then reply done.' });
  out.checks.standardControlWroteTheFile = st?.view?.status === 'idle' && existsSync(join(root, 'std.txt'));
  out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (err) { out.verdict = 'FAIL'; out.error = err.message; }
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync('benchmarks/results/live-sessions.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ verdict: out.verdict, authMode: out.authMode, claude: out.claudeVersion, checks: out.checks, runs: out.runs.map((x) => [x.label, x.status, (x.reply ?? x.error ?? '').slice(0, 70)]) }, null, 2));
await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(out.verdict === 'PASS' ? 0 : 1);
