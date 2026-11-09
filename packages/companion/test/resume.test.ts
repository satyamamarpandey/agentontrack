// Resume through the real companion: the session id comes from the project record, so it survives a restart, and a resume must be the same
// agent in the same project. The agents are scripts that print what each CLI is documented to print and record their arguments: this tests
// AgentOnTrack's side of resume, not the agents'. Resume against a real Claude Code or Codex session is NOT TESTED here.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const REC = `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');`;
const CLAUDE = `${REC}
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: process.env.FAKE_NO_SESSION ? undefined : 'sess-claude-0001', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, modelUsage: {} }));`;
const CODEX = `${REC}
console.log(JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));`;

let dir: string; let root: string; let c: Companion; let origin: string; let calls: string;
const boot = async () => {
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')], codexMode: 'exec', codexCommand: [process.execPath, join(dir, 'fake-codex.mjs')] });
  origin = c.url.slice(0, -1);
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-resume-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  calls = join(dir, 'calls.jsonl');
  process.env.CALLS = calls;
  writeFileSync(calls, '');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), CLAUDE);
  writeFileSync(join(dir, 'fake-codex.mjs'), CODEX);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  await boot();
});
afterEach(async () => { delete process.env.CALLS; delete process.env.FAKE_NO_SESSION; await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const settle = async (s: S) => { for (let i = 0; i < 200; i++) { const r = (await (await api(s, '/api/runs')).json()) as any[]; if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };
const start = async (s: S, runtime: string, extra: object = {}) => api(s, '/api/runs', { runtime, prompt: 'go on', model: 'm1', maxBudgetUsd: 0.1, ...extra });
const argv = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const firstRun = async (s: S, runtime: string) => { const resp = await start(s, runtime); const r = await resp.json(); if (resp.status !== 200) throw new Error(JSON.stringify(r)); await settle(s); return r.id as string; };

describe('resume', () => {
  it('resumes a Claude run with the session the first run left, read from the record', async () => {
    const s = await pair();
    const id = await firstRun(s, 'claude-code');
    expect((await start(s, 'claude-code', { resumeRunId: id })).status).toBe(200);
    await settle(s);
    const second = argv()[1]!;
    expect(second).toContain('--resume');
    expect(second[second.indexOf('--resume') + 1]).toBe('sess-claude-0001');
  });

  it('resumes a Codex run with `codex exec resume <thread>`', async () => {
    const s = await pair();
    const id = await firstRun(s, 'codex');
    expect((await start(s, 'codex', { resumeRunId: id })).status).toBe(200);
    await settle(s);
    const second = argv()[1]!;
    expect(second.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second).toContain('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });

  it('still resumes after the companion is restarted, because the session is in the project record', async () => {
    const s = await pair();
    const id = await firstRun(s, 'claude-code');
    await c.close();
    await boot();
    const s2 = await pair();
    expect((await start(s2, 'claude-code', { resumeRunId: id })).status).toBe(200);
    await settle(s2);
    expect(argv().at(-1)).toContain('sess-claude-0001');
  });

  it('refuses to resume across agents, and points to a handoff', async () => {
    const s = await pair();
    const id = await firstRun(s, 'claude-code');
    const r = await start(s, 'codex', { resumeRunId: id });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/handoff/);
    expect(argv()).toHaveLength(1);
  });

  it('refuses an unknown run, a run that left no session, and a malformed id', async () => {
    const s = await pair();
    expect((await start(s, 'claude-code', { resumeRunId: 'run_doesnotexist' })).status).toBe(404);
    process.env.FAKE_NO_SESSION = '1';
    const id = await firstRun(s, 'claude-code');
    delete process.env.FAKE_NO_SESSION;
    expect((await start(s, 'claude-code', { resumeRunId: id })).status).toBe(409);
    expect((await start(s, 'claude-code', { resumeRunId: '--resume' })).status).toBe(400);
    appendFileSync(calls, '');
  });
});
