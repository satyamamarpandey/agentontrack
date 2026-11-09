// Per-run limits that do not depend on the provider (a time limit), the dollar cap only under paid API mode, and what happens when a provider says its usage limit
// was reached. The "agents" are scripts that print what the CLI prints; this does not test Claude Code, Codex or any model.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, agentFailureText, isUsageLimitText, type Companion } from '../src/index.js';

const SID = 'a1b2c3d4-0000-4000-8000-0123456789ab';
const FAKE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', session_id: '${SID}', slash_commands: [] }));
if (process.env.FAKE_LIMIT) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, session_id: '${SID}', result: process.env.FAKE_LIMIT }));
  process.exit(1);
}
await new Promise((ok) => setTimeout(ok, Number(process.env.FAKE_SLEEP_MS ?? 0)));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: '${SID}', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, modelUsage: {} }));`;

let dir: string; let root: string; let c: Companion; let origin: string; let args: string;
const boot = async (extra: { mode?: 'api-key' | 'subscription'; paid?: boolean; minuteMs?: number } = {}) => {
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')], allowPaidApi: extra.paid ?? false, detectedAuthMode: () => extra.mode ?? 'subscription', ...(extra.minuteMs ? { minuteMsForTests: extra.minuteMs } : {}) });
  origin = c.url.slice(0, -1);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-lim-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  args = join(dir, 'args.json'); process.env.ARGS_FILE = args;
  root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } }); p.close();
  installHooks('claude-code', root, 'agentontrack');
});
afterEach(async () => { await c.close(); for (const k of ['ARGS_FILE', 'FAKE_LIMIT', 'FAKE_SLEEP_MS']) delete process.env[k]; try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const runOf = async (s: S, id: string) => ((await (await api(s, '/api/runs')).json()) as { id: string; status: string; events: string[] }[]).find((r) => r.id === id)!;
const settled = async (s: S, id: string) => { for (let i = 0; i < 150; i++) { const r = await runOf(s, id); if (r.status !== 'running') return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('run did not end'); };
const start = async (s: S, extra: object = {}) => { const r = await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'go', model: 'm1', ...extra }); expect(r.status, JSON.stringify(await r.clone().json())).toBe(200); return (await r.json()).id as string; };
const argv = () => JSON.parse(readFileSync(args, 'utf8')) as string[];

describe('time limit', () => {
  it('stops a run that outlives its limit and records why', async () => {
    process.env.FAKE_SLEEP_MS = '30000';
    await boot({ minuteMs: 300 });
    const s = await pair();
    const t0 = Date.now();
    const id = await start(s, { maxMinutes: 1 });
    const r = await settled(s, id);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.status).toBe('stopped');
    expect(r.events).toContain('Stopped: the time limit of 1 minutes was reached');
  });
  it('lets a run that finishes in time finish, and bounds the field to 1..240', async () => {
    await boot({ minuteMs: 300 });
    const s = await pair();
    expect((await settled(s, await start(s, { maxMinutes: 5 }))).status).toBe('finished');
    for (const bad of [0, 241, 1.5]) expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'go', maxMinutes: bad })).status).toBe(400);
  });
});

describe('dollar cap', () => {
  it('is not passed or recorded for a subscription sign-in, and a client that still sends it is not broken', async () => {
    await boot({ mode: 'subscription', paid: false });
    const s = await pair();
    await settled(s, await start(s, { maxBudgetUsd: 0.4 }));
    expect(argv()).not.toContain('--max-budget-usd');
    const p = new Project(root);
    expect(p.store.byType(['run.started']).every((e: any) => e.payload.maxBudgetUsd === undefined && e.payload.maxMinutes === 30)).toBe(true);
    p.close();
  });
  it('is passed under an API-key sign-in with paid API mode on', async () => {
    await boot({ mode: 'api-key', paid: true });
    const s = await pair();
    await settled(s, await start(s, { maxBudgetUsd: 0.4 }));
    const a = argv();
    expect(a[a.indexOf('--max-budget-usd') + 1]).toBe('0.4');
  });
  it('is not passed for an API-key sign-in while paid API mode is off, or an unknown sign-in', async () => {
    await boot({ mode: 'api-key', paid: false });
    let s = await pair();
    await settled(s, await start(s, { maxBudgetUsd: 0.4 }));
    expect(argv()).not.toContain('--max-budget-usd');
    await c.close();
    await boot({ mode: 'unknown' as never, paid: true });
    s = await pair();
    await settled(s, await start(s));
    expect(argv()).not.toContain('--max-budget-usd');
  });
  it('is only offered to the dashboard for an agent that is in API-key mode with paid mode on', async () => {
    await boot({ mode: 'subscription', paid: false });
    let s = await pair();
    expect(((await (await api(s, '/api/runtimes')).json()) as { dollarCap: boolean }[]).every((r) => r.dollarCap === false)).toBe(true);
    await c.close();
    await boot({ mode: 'api-key', paid: true });
    s = await pair();
    expect(((await (await api(s, '/api/runtimes')).json()) as { id: string; dollarCap: boolean }[]).find((r) => r.id === 'claude-code')!.dollarCap).toBe(true);
  });
});

describe('usage limit', () => {
  it('names the limit plainly, keeps the session resumable and does not call it a crash', async () => {
    process.env.FAKE_LIMIT = 'Claude AI usage limit reached|1760000000. You can try again at 5pm. key sk-ant-abcdefghijklmnopqrstuvwxyz0123 in C:\\Users\\bob\\proj\\file.ts';
    await boot();
    const s = await pair();
    const r = await settled(s, await start(s));
    expect(r.status).toBe('stopped');
    const line = r.events.find((e) => e.startsWith('error:'))!;
    expect(line).toBe('error: Claude Code says its usage limit was reached. Your session and context are kept: resume it later, or start the same task with another connected agent.');
    expect(JSON.stringify(r.events)).not.toMatch(/sk-ant|Users|bob/);
    const list = (await (await api(s, '/api/agent-sessions')).json()).sessions as { status: string; canResume: boolean }[];
    expect(list[0]).toMatchObject({ status: 'stopped', canResume: true });
    const p = new Project(root);
    expect(p.store.byType(['run.finished']).at(-1)!.payload).toMatchObject({ status: 'stopped', limitReached: true });
    p.close();
  });
  it('matches the usual wordings, and leaves other errors alone', () => {
    for (const t of ['You have hit your usage limit', 'rate limit exceeded', 'Weekly limit reached', 'Please try again at 3:00 PM', 'HTTP 429', 'quota exceeded', 'too many requests']) expect(isUsageLimitText(t), t).toBe(true);
    for (const t of ['Could not parse the file', 'not logged in', 'Exceeded USD budget (0.5)']) expect(isUsageLimitText(t), t).toBe(false);
    expect(agentFailureText('codex', 'ChatGPT usage limit reached, try again at 9am')).toMatch(/^Codex says its usage limit was reached\./);
    expect(agentFailureText('claude-code', 'Please log in')).toMatch(/not signed in/);
  });
});
