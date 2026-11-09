// Codex app-server resume and failure handling through the real companion, with a script that speaks the protocol.
// It proves AgentOnTrack's side (session id read from the record, a crash or a sign-in error ends the run as failed and never hangs).
// It is not Codex: resume and sign-in errors against a real Codex are NOT TESTED until the owner signs in (scripts/live-codex.mjs).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const FAKE = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const mode = process.env.FAKE_MODE;
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    appendFileSync(process.env.FAKE_LOG, m.method + ' ' + JSON.stringify(m.params) + '\\n');
    if (mode === 'unauth') return out({ id: m.id, error: { code: -32000, message: 'Not signed in. Run codex login.' } });
    return out({ id: m.id, result: { thread: { id: m.params.threadId ?? '${THREAD}' } } });
  }
  if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 't1' } } });
    if (mode === 'crash') process.exit(3);
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } });
    out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
  }
});
`;

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
let dir: string; let c: Companion; let origin: string;
const setup = async (mode: string) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-appsrv-r-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  process.env.FAKE_LOG = join(dir, 'log.txt');
  process.env.FAKE_MODE = mode;
  const root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(dir, 'fake-appserver.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), codexCommand: [process.execPath, join(dir, 'fake-appserver.mjs')] });
  origin = c.url.slice(0, -1);
};
afterEach(async () => {
  await c.close();
  delete process.env.FAKE_MODE;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ }
});
const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const start = async (s: S, extra: object = {}) => api(s, '/api/runs', { runtime: 'codex', prompt: 'Do it', model: 'gpt-test', maxBudgetUsd: 0.1, ...extra, ...(await proof(s)) });
const settle = async (s: S) => { for (let i = 0; i < 300; i++) { const r = (await (await api(s, '/api/runs')).json()) as any[]; if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };
const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, 'utf8') : '');

describe('codex app-server resume and failure', () => {
  it('resumes the earlier thread, read from the project record', async () => {
    await setup('ok');
    const s = await pair();
    const first = await (await start(s)).json();
    await settle(s);
    expect(log()).toMatch(/^thread\/start/m);
    const r = await start(s, { resumeRunId: first.id });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const runs = await settle(s);
    expect(runs.every((x: any) => x.status === 'finished')).toBe(true);
    expect(log()).toMatch(new RegExp(`thread/resume .*${THREAD}`));
  });

  it('ends the run as failed when Codex dies mid-turn', async () => {
    await setup('crash');
    const s = await pair();
    expect((await start(s)).status).toBe(200);
    const [run] = await settle(s);
    expect(run.status).toBe('failed');
  });

  it('ends the run as failed, with the reason, when Codex is not signed in', async () => {
    await setup('unauth');
    const s = await pair();
    expect((await start(s)).status).toBe(200);
    const [run] = await settle(s);
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run)).toMatch(/Not signed in|codex login/i);
  });
});
