// Attachments through the real companion: what is accepted, and what reaches the agent. The agents are scripts that record their arguments, so
// this tests AgentOnTrack's side. Whether a real Claude Code or Codex reads the attached files is NOT TESTED here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const REC = `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');`;
const CLAUDE = `${REC}\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-claude-0001', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, modelUsage: {} }));`;
const CODEX = `${REC}\nconsole.log(JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }));\nconsole.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));`;

let dir: string; let c: Companion; let origin: string; let calls: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-credit-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  calls = join(dir, 'calls.jsonl');
  process.env.CALLS = calls;
  writeFileSync(calls, '');
  const root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), CLAUDE);
  writeFileSync(join(dir, 'fake-codex.mjs'), CODEX);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')], codexMode: 'exec', codexCommand: [process.execPath, join(dir, 'fake-codex.mjs')] });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { delete process.env.CALLS; await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const settle = async (s: S) => { for (let i = 0; i < 200; i++) { const r = (await (await api(s, '/api/runs')).json()) as any[]; if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };
const argv = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);

describe('usage-credit guard through the companion', () => {
  it('refuses a Fable run without consent, and never starts the agent', async () => {
    const s = await pair();
    const r = await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'hello', model: 'claude-fable-5-2' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toMatch(/usage credits/);
    expect(argv()).toHaveLength(0);
  });
  it('starts it only with consent for that run, and an included model needs none', async () => {
    const s = await pair();
    expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'hello', model: 'fable', acceptUsageCredits: true })).status).toBe(200);
    await settle(s);
    expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'hello', model: 'sonnet' })).status).toBe(200);
    await settle(s);
    expect(argv().length).toBe(2);
  });
});
