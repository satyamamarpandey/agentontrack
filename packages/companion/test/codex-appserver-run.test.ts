// Codex started through the app-server path, with a script that speaks the protocol. It proves what AgentOnTrack does with each approval Codex
// asks for (decline a denied one, hold one that needs a person, accept only after a person approves, decline after a denial); it is not Codex.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const FAKE = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const cmds = JSON.parse(process.env.FAKE_CMDS);
let nextId = 100; const waiting = new Map();
const ask = (command) => new Promise((res) => { const id = nextId++; waiting.set(id, res); out({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'x', itemId: 'i' + id, command, cwd: process.cwd() } }); });
createInterface({ input: process.stdin }).on('line', async (l) => {
  const m = JSON.parse(l);
  if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m); return; }
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') { appendFileSync(process.env.FAKE_LOG, m.method + ' ' + JSON.stringify(m.params) + '\\n'); return out({ id: m.id, result: { thread: { id: m.params.threadId ?? '0199a213-81c0-7800-8aa1-bbab2a035a53' } } }); }
  if (m.method === 'turn/interrupt') { out({ id: m.id, result: {} }); out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'interrupted' } } }); return; }
  if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 't1' } } });
    out({ method: 'turn/started', params: { turn: { id: 't1' } } });
    for (const c of cmds) { const r = await ask(c); appendFileSync(process.env.FAKE_LOG, 'answer ' + c + ' => ' + r.result.decision + '\\n'); out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: c + ' => ' + r.result.decision } } }); }
    out({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 500, cachedInputTokens: 400, outputTokens: 30, reasoningOutputTokens: 0 } } } });
    out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
  }
});
`;

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
let dir: string; let root: string; let c: Companion; let origin: string;
const setup = async (cmds: string[]) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-appsrv-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  process.env.FAKE_LOG = join(dir, 'log.txt');
  process.env.FAKE_CMDS = JSON.stringify(cmds);
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(dir, 'fake-appserver.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.human.createTask({ id: 't', title: 't', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(0)"' }] });
  p.close();
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), codexCommand: [process.execPath, join(dir, 'fake-appserver.mjs')], codexApprovalPollMs: 50, codexApprovalWaitMs: 15_000 });
  origin = c.url.slice(0, -1);
};
afterEach(async () => {
  await c.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ }
});
const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const start = async (s: S) => api(s, '/api/runs', { runtime: 'codex', prompt: 'Do it', model: 'gpt-test', maxBudgetUsd: 0.1, ...(await proof(s)) });
const runs = async (s: S) => (await (await api(s, '/api/runs')).json()) as any[];
const settle = async (s: S) => { for (let i = 0; i < 300; i++) { const r = await runs(s); if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };
const pending = async (s: S) => { for (let i = 0; i < 100; i++) { const st = await (await api(s, '/api/state')).json(); const a = (st.approvals ?? []).find((x: any) => x.view === 'pending'); if (a) return a; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('no approval appeared: ' + JSON.stringify(await runs(s)) + log()); };
const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, 'utf8') : '');

describe('codex app-server run', () => {
  it('declines a protected-path write, accepts a harmless command, and records usage', async () => {
    await setup(['echo hi', 'echo x > .claude/settings.json']);
    const s = await pair();
    const r = await start(s);
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const [run] = await settle(s);
    expect(run.status).toBe('finished');
    expect(log()).toMatch(/answer echo hi => accept/);
    expect(log()).toMatch(/answer echo x > \.claude\/settings\.json => decline/);
    expect(log()).toMatch(/"approvalPolicy":"untrusted"/);
    const p = new Project(root);
    const usage = p.store.all().filter((e: any) => e.type === 'usage.recorded').map((e: any) => e.payload);
    p.close();
    expect(usage[0]).toMatchObject({ runtime: 'codex', inputTokens: 100, cacheReadTokens: 400, outputTokens: 30 });
  });

  it('a read-only run is started with the read-only sandbox and has every approval declined, even a harmless command that a standard run accepts', async () => {
    await setup(['echo hi']);
    const s = await pair();
    const r = await api(s, '/api/runs', { runtime: 'codex', prompt: 'Look only', model: 'gpt-test', maxBudgetUsd: 0.1, policy: 'read-only', ...(await proof(s)) });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    await settle(s);
    expect(log()).toMatch(/thread\/start .*"sandbox":"read-only"/);
    expect(log()).toMatch(/answer echo hi => decline/);
    expect(log()).not.toMatch(/=> accept/);
  });

  it('holds an action that needs a person, and accepts it only after the person approves', async () => {
    await setup(['git push origin main']);
    const s = await pair();
    expect((await start(s)).status).toBe(200);
    const a = await pending(s);
    expect(log()).not.toMatch(/answer git push/);
    const r = await api(s, '/api/approvals/approve', { id: a.id, ...(await proof(s)) });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const [run] = await settle(s);
    expect(run.status).toBe('finished');
    expect(log()).toMatch(/answer git push origin main => accept/);
  });

  it('declines after the person denies', async () => {
    await setup(['git push origin main']);
    const s = await pair();
    await start(s);
    const a = await pending(s);
    await api(s, '/api/approvals/deny', { id: a.id, note: 'no', ...(await proof(s)) });
    await settle(s);
    expect(log()).toMatch(/answer git push origin main => decline/);
  });
});
