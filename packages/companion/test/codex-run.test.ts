// Codex started by the companion, through the real companion, the real hook install and the real hook self-test. The "agent" is a script that prints
// what `codex exec --json` is documented to print: this tests what AgentOnTrack does with those events, not Codex and not any model.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const FAKE = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.FAKE_ARGS_FILE + '.env', JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, codex: process.env.CODEX_API_KEY ?? null }));
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
out({ type: 'turn.started' });
out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'all done' } });
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20, reasoning_output_tokens: 0 } });
`;

let dir: string; let root: string; let c: Companion; let origin: string;
const setup = async (hooks: boolean) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-codex-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  process.env.FAKE_ARGS_FILE = join(dir, 'args.json');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(dir, 'fake-codex.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  if (hooks) installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), codexMode: 'exec', codexCommand: [process.execPath, join(dir, 'fake-codex.mjs')] });
  origin = c.url.slice(0, -1);
};
afterEach(async () => {
  delete process.env.FAKE_HANG;
  await c.close();
  // On Windows a just-killed process can hold its working directory for a moment; the folder is a throwaway in the OS temp directory.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* left for the OS to clean */ }
});

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const start = async (s: S, prompt = 'Say hello') => api(s, '/api/runs', { runtime: 'codex', prompt, model: 'gpt-test', maxBudgetUsd: 0.1, ...(await proof(s)) });
const runs = async (s: S) => (await (await api(s, '/api/runs')).json()) as any[];
const settle = async (s: S) => { for (let i = 0; i < 200; i++) { const r = await runs(s); if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };

describe('codex run', () => {
  it('is refused when Codex has no hooks in the project', async () => {
    await setup(false);
    const r = await start(await pair());
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Connect Codex/);
  });

  it('is refused when the hook program cannot run, because Codex would then run actions unchecked', async () => {
    await setup(true);
    writeFileSync(join(root, '.codex', 'hooks.json'), readFileSync(join(root, '.codex', 'hooks.json'), 'utf8').replaceAll(CLI.replaceAll('\\', '\\\\'), join(dir, 'missing.js').replaceAll('\\', '\\\\')));
    const r = await start(await pair());
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Codex was not started/);
    expect(await runs(await pair())).toEqual([]);
  });

  it('starts, streams events, and records usage with cached input kept apart', async () => {
    await setup(true);
    const s = await pair();
    const r = await start(s);
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const [run] = await settle(s);
    expect(run.status).toBe('finished');
    expect(run.events.join('\n')).toMatch(/\[tool shell\] ls/);
    expect(run.events.join('\n')).toMatch(/all done/);
    const args = JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE!, 'utf8')) as string[];
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('workspace-write');
    expect(args.join(' ')).not.toMatch(/yolo|bypass|danger/);
    const p = new Project(root);
    const usage = p.store.all().filter((e: any) => e.type === 'usage.recorded').map((e: any) => e.payload);
    p.close();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ runtime: 'codex', inputTokens: 100, cacheReadTokens: 900, outputTokens: 20, source: 'provider-reported' });
  });

  it('hides API keys from the agent, so it cannot fall back to metered billing', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-reach-agent';
    try {
      await setup(true);
      const s = await pair();
      expect((await start(s)).status).toBe(200);
      await settle(s);
      expect(JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE + '.env', 'utf8'))).toEqual({ openai: null, codex: null });
      const agents = await (await api(s, '/api/runtimes')).json();
      expect(agents.find((a: any) => a.id === 'codex').apiKeyVarsInEnvironment).toContain('OPENAI_API_KEY');
      expect(JSON.stringify(agents)).not.toContain('sk-should-not');
    } finally { delete process.env.OPENAI_API_KEY; }
  });

  it('refuses a slash command, since Codex has reported no commands to AgentOnTrack', async () => {
    await setup(true);
    const r = await start(await pair(), '/goal ship it');
    expect(r.status).toBe(409);
  });

  it('gives codex exec a read-only sandbox when the policy is read-only, and the standard one otherwise', async () => {
    await setup(true);
    const s = await pair();
    const go = async (extra: object) => { const r = await api(s, '/api/runs', { runtime: 'codex', prompt: 'Say hello', model: 'gpt-test', maxBudgetUsd: 0.1, ...extra, ...(await proof(s)) }); expect(r.status).toBe(200); await settle(s); return JSON.parse(readFileSync(process.env.FAKE_ARGS_FILE!, 'utf8')) as string[]; };
    const standard = await go({});
    expect(standard[standard.indexOf('--sandbox') + 1]).toBe('workspace-write');
    const readOnly = await go({ policy: 'read-only' });
    expect(readOnly[readOnly.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('refuses to resume a Codex exec session under a read-only policy, because that transport cannot take the sandbox flag on resume', async () => {
    await setup(true);
    const s = await pair();
    expect((await start(s)).status).toBe(200);
    const first = (await settle(s))[0];
    const r = await api(s, '/api/runs', { runtime: 'codex', prompt: 'And again', model: 'gpt-test', maxBudgetUsd: 0.1, resumeRunId: first.id, policy: 'read-only', ...(await proof(s)) });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/read-only policy cannot be enforced/);
  });

  it('can be stopped, and is then recorded as stopped and not finished', async () => {
    process.env.FAKE_HANG = '1';
    await setup(true);
    const s = await pair();
    expect((await start(s)).status).toBe(200);
    let run: any;
    for (let i = 0; i < 200 && !(run = (await runs(s))[0])?.events.length; i++) await new Promise((ok) => setTimeout(ok, 100));
    const stop = await api(s, `/api/runs/${run.id}/stop`, { ...(await proof(s)) });
    expect(stop.status).toBeLessThan(300);
    expect((await settle(s))[0].status).toBe('stopped');
  });
});
