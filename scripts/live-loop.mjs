// Real Claude Code (signed-in subscription, smallest model) driven by AgentOnTrack's managed goal -> plan -> phase loop: a plan is drafted, a person
// (this script, with the terminal code the companion issues) approves it, then the loop runs the agent, runs the phase's check ITSELF, and stops when it passes.
// Result: benchmarks/results/live-loop.json. One trial of one tiny goal: it shows the path works with a real agent, not how often or on hard work.
// Native /goal and /loop commands are NOT used here: they are sent only if the agent reported them, and this checks the managed path.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { startCompanion } from '../packages/companion/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'aot-liveloop-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const root = join(dir, 'repo'); mkdirSync(root);
writeFileSync(join(root, 'README.md'), '# t\n');
writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.js' } }));
const p = new Project(root); p.human.setGoal({ statement: 'Create the file result.txt containing the word ok', scope: { include: ['**'] } }); p.close();
installHooks('claude-code', root, `"${process.execPath}" "${join(process.cwd(), 'packages/cli/dist/index.js')}"`);
const c = await startCompanion({ root, uiDir: join(dir, 'ui') });
const origin = c.url.slice(0, -1);
const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
const s = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf };
const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async () => { const ch = await (await api('/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const out = { date: new Date().toISOString().slice(0, 10), what: 'Real Claude Code through the managed plan/phase loop. Script: scripts/live-loop.mjs', checks: {} };

const rt = (await (await api('/api/runtimes')).json()).find((x) => x.id === 'claude-code');
out.authMode = rt.authMode;
if (rt.authMode === 'api-key') { console.log('REFUSING: this sign-in bills by use.'); process.exit(2); }

const CHECK = `node -e "process.exit(require('fs').existsSync('result.txt') && require('fs').readFileSync('result.txt','utf8').trim()==='ok' ? 0 : 1)"`;
let v = await (await api('/api/plan/draft', { goal: 'Create the file result.txt containing the word ok' })).json();
const plan = structuredClone(v.plan);
plan.phases.forEach((ph, n) => { ph.acceptance = ph.acceptance.filter((x) => x.kind !== 'command'); if (n === 0) { ph.dependsOn = []; ph.acceptance.push({ id: 'file-check', description: 'result.txt contains ok', kind: 'command', command: CHECK }); } });
v = await (await api('/api/plan/draft', { plan, expectVersion: v.version })).json();
out.checks.planApprovedByPerson = (await api('/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof()) })).status === 200;
const view = await (await api('/api/plan')).json();
const id = view.plan.phases[0].id;
const t0 = Date.now();
const started = await api('/api/plan/loop', { phaseId: id, rounds: 2 });
out.checks.loopStarted = started.status === 200;
let status = '';
for (let i = 0; i < 300; i++) { status = (await (await api('/api/plan')).json()).views.find((x) => x.id === id).status; if (['verified', 'failed'].includes(status)) break; await new Promise((ok) => setTimeout(ok, 1000)); }
out.phaseStatus = status; out.seconds = Math.round((Date.now() - t0) / 1000);
out.checks.fileMadeByAgent = existsSync(join(root, 'result.txt')) && readFileSync(join(root, 'result.txt'), 'utf8').trim() === 'ok';
out.checks.checkRunByAgentOnTrack_phaseVerified = status === 'verified';
const runs = await (await api('/api/runs')).json();
out.rounds = runs.length;
const pr = new Project(root);
out.hookDecisions = pr.store.all().filter((e) => e.type === 'action.requested').map((e) => ({ tool: e.payload.tool, decision: e.payload.decision, reasons: e.payload.reasons, effects: e.payload.effects?.map((x) => x.kind + ':' + String(x.target).slice(0, 60)) }));
out.usageRecords = pr.store.all().filter((e) => e.type === 'usage.recorded').map((e) => ({ model: e.payload.model, input: e.payload.inputTokens, output: e.payload.outputTokens, cacheRead: e.payload.cacheReadTokens, source: e.payload.source, runId: e.payload.runId ?? null }));
out.roundReplies = runs.map((x) => ({ id: x.id, status: x.status, events: x.events.slice(-4) }));
pr.close();
out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
console.log(JSON.stringify(out, null, 2));
writeFileSync(join(process.cwd(), 'benchmarks/results/live-loop.json'), JSON.stringify(out, null, 2));
await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp */ }
