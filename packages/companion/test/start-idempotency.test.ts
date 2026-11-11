// The duplicate-start contract, through the real companion with REAL child processes. There is no "same text within five seconds" guard: an identical request is an
// intentional second run. What makes a retry safe is an optional Idempotency-Key header: same key and same request returns the ORIGINAL answer and starts nothing; the same key
// for a different request is a 409; a refused or failed start is not recorded, so the same key can be tried again. Also: the 4-agent cap holds under parallel requests on every route.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { MAX_CONCURRENT_RUNS, startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
// Every start writes one file named after its prompt, so a test can count the processes that really started.
const FAKE = `
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const name = /(slow|quick)-[\\w]+/.exec(prompt)?.[0] ?? 'run';
const dir = process.env.GATE_DIR;
writeFileSync(dir + '/' + name + '.' + process.pid + '.started', '1');
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', session_id: 'sess-' + name + '-' + process.pid }));
if (name.startsWith('slow')) { while (!existsSync(dir + '/release')) await new Promise((ok) => setTimeout(ok, 20)); }
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-' + name + '-' + process.pid, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));
`;

let dir: string; let root: string; let gate: string; let c: Companion; let origin: string;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return; await sleep(20); } throw new Error(`timed out waiting for: ${what}`); };
afterEach(async () => {
  try { writeFileSync(join(gate, 'release'), '1'); } catch { /* gone */ }
  await c.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* a just-killed process can hold its folder for a moment */ }
});

const setup = async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-idem-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  gate = join(dir, 'gate'); mkdirSync(gate); process.env.GATE_DIR = gate;
  root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof setup>>;
const api = (s: S, path: string, body?: unknown, key?: string) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const runBody = (name: string, extra: object = {}) => ({ runtime: 'claude-code', prompt: `go ${name}`, model: 'haiku', maxBudgetUsd: 0.1, ...extra });
const started = (prefix = '') => readdirSync(gate).filter((f) => f.endsWith('.started') && f.startsWith(prefix));
const runsList = async (s: S) => (await (await api(s, '/api/runs')).json()) as { id: string; status: string }[];
let n = 0;
const key = () => `key${String(++n).padStart(6, '0')}abcdefghijklmnopqrstuvwxyz`; // 22+ characters

describe('Idempotency-Key on POST /api/runs', () => {
  it('simultaneous requests with one key start exactly one child process and all get the same answer', async () => {
    const s = await setup();
    const k = key();
    const rs = await Promise.all(Array.from({ length: 12 }, () => api(s, '/api/runs', runBody('slow-par'), k)));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(rs.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(rs.filter((r) => r.headers.get('idempotent-replay') === 'true')).toHaveLength(11);
    await until('the process to start', () => started('slow-par').length >= 1);
    await sleep(300);
    expect(started('slow-par')).toHaveLength(1);
    expect(await runsList(s)).toHaveLength(1);
  });

  it('a retry after a lost response returns the original result and starts nothing', async () => {
    const s = await setup();
    const k = key();
    const first = await (await api(s, '/api/runs', runBody('quick-lost'), k)).json();
    await until('the run to end', async () => (await runsList(s)).every((r) => r.status !== 'running'));
    const retry = await api(s, '/api/runs', runBody('quick-lost'), k);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replay')).toBe('true');
    expect(await retry.json()).toEqual(first); // the ORIGINAL answer, including its status then
    await sleep(200);
    expect(started('quick-lost')).toHaveLength(1);
    expect(await runsList(s)).toHaveLength(1);
  });

  it('the same key for a different request is a 409 and starts nothing', async () => {
    const s = await setup();
    const k = key();
    expect((await api(s, '/api/runs', runBody('quick-a'), k)).status).toBe(200);
    const other = await api(s, '/api/runs', runBody('quick-b'), k);
    expect(other.status).toBe(409);
    expect((await other.json()).error).toMatch(/different request/);
    const sameKeyOtherRoute = await api(s, '/api/agent-sessions', runBody('quick-a'), k);
    expect(sameKeyOtherRoute.status).toBe(409);
    await sleep(200);
    expect(started('quick-b')).toHaveLength(0);
    expect(await runsList(s)).toHaveLength(1);
  });

  it('identical text without a key, or with a new key each time, is an intentional repeat and starts again', async () => {
    const s = await setup();
    expect((await api(s, '/api/runs', runBody('quick-rep'))).status).toBe(200);
    expect((await api(s, '/api/runs', runBody('quick-rep'))).status).toBe(200);
    expect((await api(s, '/api/runs', runBody('quick-rep'), key())).status).toBe(200);
    expect((await api(s, '/api/runs', runBody('quick-rep'), key())).status).toBe(200);
    await until('four starts', () => started('quick-rep').length === 4);
    expect(await runsList(s)).toHaveLength(4);
  });

  it('a start refused for capacity is not recorded: the same key succeeds once a slot is free', async () => {
    const s = await setup();
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) expect((await api(s, '/api/runs', runBody(`slow-fill${i}`))).status).toBe(200);
    const k = key();
    const refused = await api(s, '/api/runs', runBody('quick-after'), k);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/busy/);
    writeFileSync(join(gate, 'release'), '1');
    await until('slots free', async () => (await runsList(s)).every((r) => r.status !== 'running'));
    const retry = await api(s, '/api/runs', runBody('quick-after'), k);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replay')).toBeNull(); // a real new start, not a replay
    await until('it started', () => started('quick-after').length === 1);
  });

  it('a failed start (an agent that cannot be started) is not recorded either, and a malformed key is a 400', async () => {
    const s = await setup();
    const k = key();
    const bad = await api(s, '/api/runs', { ...runBody('quick-x'), runtime: 'hermes' }, k);
    expect(bad.status).toBe(409);
    expect((await api(s, '/api/runs', runBody('quick-x'), k)).status).toBe(200); // the key was never bound to the failed attempt
    expect((await api(s, '/api/runs', runBody('quick-y'), 'short')).status).toBe(400);
    expect((await api(s, '/api/runs', runBody('quick-y'), 'has spaces and is long enough!!')).status).toBe(400);
    expect(started('quick-y')).toHaveLength(0);
  });

  it('a validation error is not recorded', async () => {
    const s = await setup();
    const k = key();
    expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: '-bad' }, k)).status).toBe(400);
    expect((await api(s, '/api/runs', runBody('quick-ok'), k)).status).toBe(200);
  });
});

describe('Idempotency-Key on agent sessions and resume', () => {
  it('POST /api/agent-sessions: one key, one session, one process; a retry returns the same session', async () => {
    const s = await setup();
    const k = key();
    const rs = await Promise.all(Array.from({ length: 6 }, () => api(s, '/api/agent-sessions', runBody('quick-ses'), k)));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.sessionId)).size).toBe(1);
    await until('the process to start', () => started('quick-ses').length >= 1);
    await sleep(300);
    expect(started('quick-ses')).toHaveLength(1);
  });

  it('POST /api/agent-sessions/:id/resume: the same key returns the same run; a new key resumes again', async () => {
    const s = await setup();
    const a = await (await api(s, '/api/agent-sessions', runBody('quick-first'))).json();
    await until('idle', async () => (await runsList(s)).every((r) => r.status !== 'running'));
    const k = key();
    const body = { prompt: 'go quick-again', model: 'haiku', maxBudgetUsd: 0.1 };
    const r1 = await (await api(s, `/api/agent-sessions/${a.sessionId}/resume`, body, k)).json();
    const r2 = await (await api(s, `/api/agent-sessions/${a.sessionId}/resume`, body, k)).json();
    expect(r2).toEqual(r1);
    await until('idle', async () => (await runsList(s)).every((r) => r.status !== 'running'));
    const r3 = await (await api(s, `/api/agent-sessions/${a.sessionId}/resume`, body, key())).json();
    expect(r3.runId).not.toBe(r1.runId);
    await until('both resumes started', () => started('quick-again').length === 2);
  });
});

describe('Idempotency-Key on plan phases', () => {
  const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
  it('POST /api/plan/phases/start: a retry with the same key returns the same run and starts one agent', async () => {
    const s = await setup();
    const v = await (await api(s, '/api/plan/draft', { goal: 'Fix the crash when the date is empty' })).json();
    expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) })).status).toBe(200);
    const id = (await (await api(s, '/api/plan')).json()).plan.phases[0].id;
    const k = key();
    const rs = await Promise.all([1, 2, 3].map(() => api(s, '/api/plan/phases/start', { phaseId: id }, k)));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(await runsList(s)).toHaveLength(1);
    // And the cap applies to a plan start like any other. The phase's own run must have finished first: while it still counts as running, the
    // fourth slow start is refused by that very cap, and the four could never all be running (seen on a slow Linux runner).
    await until('the phase run to finish', async () => (await runsList(s)).every((r) => r.status !== 'running'));
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await api(s, '/api/runs', runBody(`slow-plancap${i}`));
    await until('full', async () => (await runsList(s)).filter((r) => r.status === 'running').length >= MAX_CONCURRENT_RUNS);
  });
});

describe('the cap of four running agents is race-safe on every start route', () => {
  it('parallel starts across /api/runs and /api/agent-sessions start exactly four processes', async () => {
    const s = await setup();
    const reqs = [
      ...Array.from({ length: 6 }, (_, i) => api(s, '/api/runs', runBody(`slow-race${i}`))),
      ...Array.from({ length: 6 }, (_, i) => api(s, '/api/agent-sessions', runBody(`slow-sesrace${i}`))),
    ];
    const rs = await Promise.all(reqs);
    const statuses = rs.map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(MAX_CONCURRENT_RUNS);
    expect(statuses.filter((x) => x === 409)).toHaveLength(12 - MAX_CONCURRENT_RUNS);
    await until('four processes', () => started('slow-').length === MAX_CONCURRENT_RUNS);
    await sleep(300);
    expect(started('slow-')).toHaveLength(MAX_CONCURRENT_RUNS);
    expect((await runsList(s)).filter((r) => r.status === 'running')).toHaveLength(MAX_CONCURRENT_RUNS);
  });

  it('a plan phase start is refused while four agents run', async () => {
    const s = await setup();
    const v = await (await api(s, '/api/plan/draft', { goal: 'Fix the crash when the date is empty' })).json();
    const ch = await (await api(s, '/api/challenge', {})).json();
    expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, challengeId: ch.challengeId, confirm: ch.code })).status).toBe(200);
    const id = (await (await api(s, '/api/plan')).json()).plan.phases[0].id;
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) expect((await api(s, '/api/runs', runBody(`slow-full${i}`))).status).toBe(200);
    const r = await api(s, '/api/plan/phases/start', { phaseId: id });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/busy/);
  });
});
