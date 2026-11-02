// Agent and model discovery, and the slash-command guard, through the real companion. The "agent" prints what Claude Code prints in its
// session init (a default model and the commands it reports) and finishes: this tests what AgentOnTrack does with those reports, not any model.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const FAKE = `
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-default', slash_commands: ['review', 'help'] }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, duration_api_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'fake-used': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } }));
`;

let dir: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-disc-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, 'agentontrack');
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const settle = async (s: S) => { for (let i = 0; i < 80; i++) { const r = await (await api(s, '/api/runs')).json(); if (r.length && r.every((x: any) => x.status !== 'running')) return; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };
const startRun = async (s: S, prompt: string) => api(s, '/api/runs', { runtime: 'claude-code', prompt, model: 'haiku', maxBudgetUsd: 0.1, ...(await proof(s)) });

describe('discovery', () => {
  it('lists agents with a status, and no model before anything has reported one', async () => {
    const s = await pair();
    const d = await (await api(s, '/api/discovery')).json();
    const claude = d.agents.find((a: any) => a.id === 'claude-code');
    expect(['ready', 'needs-setup', 'missing']).toContain(claude.status);
    expect(claude.commandsSource).toBe('not-reported');
    expect(d.agents.find((a: any) => a.id === 'codex').canStart).toBe(false);
    expect(d.models.filter((m: any) => m.entitlement === 'worked')).toEqual([]);
    expect(d.note).toMatch(/not checked until a run uses it/);
  });

  it('learns the default model and the commands from a real session init, and marks as "worked" only the model a run used', async () => {
    const s = await pair();
    expect((await startRun(s, 'Say hello')).status).toBe(200);
    await settle(s);
    const d = await (await api(s, '/api/discovery')).json();
    const by = Object.fromEntries(d.models.filter((m: any) => m.agent === 'claude-code').map((m: any) => [m.id, m]));
    expect(by['fake-default']).toMatchObject({ source: 'runtime-default', entitlement: 'unknown' });
    expect(by['fake-used']).toMatchObject({ source: 'used-in-a-run', entitlement: 'worked' });
    expect(d.agents.find((a: any) => a.id === 'claude-code')).toMatchObject({ commands: ['review', 'help'], commandsSource: 'reported-by-runtime' });
  });
});

describe('slash commands', () => {
  it('refuses a slash command before the runtime has reported any, and after, one it did not report', async () => {
    const s = await pair();
    const first = await startRun(s, '/goal build everything');
    expect(first.status).toBe(409);
    expect((await first.json()).error).toMatch(/has not told AgentOnTrack/);
    expect((await startRun(s, 'Say hello')).status).toBe(200);
    await settle(s);
    const second = await startRun(s, '/goal build everything');
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/not one of the commands this agent reported/);
    expect((await startRun(s, '/review the change')).status).toBe(200);
    await settle(s);
  });

  it('recommends a managed loop with limits, and a native command only when the runtime reported it', async () => {
    const s = await pair();
    const before = await (await api(s, '/api/orchestrate', { text: 'review this change' })).json();
    expect(before.native).toBeNull();
    expect((await startRun(s, 'Say hello')).status).toBe(200);
    await settle(s);
    const after = await (await api(s, '/api/orchestrate', { text: 'review this change' })).json();
    expect(after.native).toMatchObject({ command: 'review', reportedByRuntime: true });
    expect(after.intent).toBe('review');
  });
});
