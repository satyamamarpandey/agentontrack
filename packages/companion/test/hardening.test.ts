// Backend limits and honest failures, through the real companion with a REAL child process: transcript retention covers the answer text in the record, a cap on agents running
// at once, a cap on in-memory output lines, agents stopped when the companion closes, a rate and size limit on plan drafts, a plain message when an agent is missing or signed
// out, and that an identical start sent twice is an ordinary second start (only an Idempotency-Key makes a retry safe; see start-idempotency.test.ts). It tests the companion, not Claude Code.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { MAX_CONCURRENT_RUNS, MAX_RUN_EVENT_LINES, RUN_LINES_DROPPED_MARKER, agentFailureText, newRunLines, startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const FAKE = `
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const name = /(slow|quick|authfail)-\\w+/.exec(prompt)?.[0] ?? 'run';
const dir = process.env.GATE_DIR;
writeFileSync(dir + '/' + name + '.pid', String(process.pid));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', session_id: 'sess-' + name }));
if (name.startsWith('authfail')) {
  process.stderr.write('Failed to read C:\\\\Users\\\\bob\\\\.claude\\\\creds token sk-' + 'ant-abcdefghijklmnopqrstuvwxyz0123456789\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key - Please run /login', session_id: 'sess-' + name }));
  process.exit(1);
}
if (name.startsWith('slow')) { while (!existsSync(dir + '/release')) await new Promise((ok) => setTimeout(ok, 20)); }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done ' + name }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-' + name, result: 'The answer mentions zebra-marker-' + name, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));
`;

let dir: string; let root: string; let gate: string; let c: Companion; let origin: string;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return; await sleep(20); } throw new Error(`timed out waiting for: ${what}`); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (name: string) => Number(readFileSync(join(gate, `${name}.pid`), 'utf8'));

afterEach(async () => {
  try { writeFileSync(join(gate, 'release'), '1'); } catch { /* gone */ }
  await c.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* a just-killed process can hold its folder for a moment */ }
});

const boot = async (claudeCommand?: string[]) => {
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: claudeCommand ?? [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof boot>>;
const setup = async (claudeCommand?: string[]) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-hard-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  gate = join(dir, 'gate'); mkdirSync(gate); process.env.GATE_DIR = gate;
  root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  return boot(claudeCommand);
};
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const start = (s: S, name: string) => api(s, '/api/runs', { runtime: 'claude-code', prompt: `go ${name}`, model: 'haiku', maxBudgetUsd: 0.1 });
const runStatus = async (s: S, id: string) => ((await (await api(s, '/api/runs')).json()) as any[]).find((r) => r.id === id);
const finishedPayload = (runId: string) => { const p = new Project(root); try { return p.store.byType(['run.finished']).find((e) => e.payload.id === runId)!.payload; } finally { p.close(); } };

describe('transcript retention covers the answer text kept with the run', () => {
  it('keeps no answer text in the record when retention is off, only its length', async () => {
    const s = await setup();
    const id = ((await (await start(s, 'quick-off')).json()) as any).id;
    await until('finish', async () => (await runStatus(s, id))?.status === 'finished');
    await sleep(100);
    const f = finishedPayload(id);
    expect(f.resultText).toBeNull();
    expect(f.resultChars).toBeGreaterThan(10);
    const p = new Project(root); try { expect(JSON.stringify(p.store.all())).not.toContain('zebra-marker'); } finally { p.close(); }
  });

  it('keeps the answer text when the owner turned retention on', async () => {
    const s = await setup();
    expect((await api(s, '/api/settings', { keepTranscripts: true })).status).toBe(200);
    const id = ((await (await start(s, 'quick-on')).json()) as any).id;
    await until('finish', async () => (await runStatus(s, id))?.status === 'finished');
    await sleep(100);
    expect(finishedPayload(id).resultText).toContain('zebra-marker-quick-on');
  });
});

describe('caps on agents and output', () => {
  it('refuses a fifth agent while four are running, from every way of starting one, and allows it once one ends', async () => {
    const s = await setup();
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) expect((await start(s, `slow-${i}`)).status).toBe(200);
    const over = await start(s, 'slow-extra');
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatch(/busy/);
    const viaSession = await api(s, '/api/agent-sessions', { runtime: 'claude-code', prompt: 'go slow-viasession', model: 'haiku', maxBudgetUsd: 0.1 });
    expect(viaSession.status).toBe(409);
    writeFileSync(join(gate, 'release'), '1');
    await until('slots free', async () => ((await (await api(s, '/api/runs')).json()) as any[]).every((r) => r.status !== 'running'));
    expect((await start(s, 'quick-after')).status).toBe(200);
  });

  it('keeps only the most recent output lines of a run in memory', () => {
    const lines = newRunLines();
    for (let i = 0; i < MAX_RUN_EVENT_LINES + 500; i++) lines.push(`line ${i}`);
    expect(lines).toHaveLength(MAX_RUN_EVENT_LINES);
    expect(lines.at(-1)).toBe(`line ${MAX_RUN_EVENT_LINES + 499}`);
    // Once lines are dropped the first line says so, exactly once, and it is not itself counted as output.
    expect(lines[0]).toBe(RUN_LINES_DROPPED_MARKER);
    expect(lines.filter((l) => l === RUN_LINES_DROPPED_MARKER)).toHaveLength(1);
    expect(lines[1]).toBe('line 501');
    const short = newRunLines(); short.push('a', 'b');
    expect(short).toEqual(['a', 'b']); // nothing dropped, no marker
  });
});

describe('closing the companion', () => {
  it('stops the agents it started', async () => {
    const s = await setup();
    expect((await start(s, 'slow-closing')).status).toBe(200);
    await until('child started', () => existsSync(join(gate, 'slow-closing.pid')));
    const pid = pidOf('slow-closing');
    expect(alive(pid)).toBe(true);
    await c.close();
    await until('child gone', () => !alive(pid));
  });
});

describe('plan drafts from outside the local page', () => {
  it('are limited per minute and by size', async () => {
    const s = await setup();
    const big = await api(s, '/api/plan/draft', { plan: { filler: 'x'.repeat(120_000) } });
    expect(big.status).toBe(413);
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await api(s, '/api/plan/draft', { goal: `Fix the crash number ${i}` })).status);
    expect(codes.slice(0, 5)).not.toContain(429);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('what a person sees when an agent is missing or signed out', () => {
  it('says plainly that a missing program was not found, without a folder path', async () => {
    const s = await setup(['C:\\nope-secret-folder\\claude-missing.exe']);
    const id = ((await (await start(s, 'quick-missing')).json()) as any).id;
    await until('failed', async () => (await runStatus(s, id))?.status === 'failed');
    const text = (await runStatus(s, id)).events.join('\n');
    expect(text).toMatch(/was not found on this computer/);
    expect(text).not.toMatch(/nope-secret-folder/);
  });

  it('says a signed-out agent is not signed in, and shows no path or token from its output', async () => {
    const s = await setup();
    const id = ((await (await start(s, 'authfail-x')).json()) as any).id;
    await until('failed', async () => (await runStatus(s, id))?.status === 'failed');
    const text = (await runStatus(s, id)).events.join('\n');
    expect(text).toMatch(/not signed in, or its sign-in expired/);
    expect(text).not.toMatch(/bob|sk-ant|abcdefghijklmnop/);
  });

  it('removes paths and token-like strings from any other failure text', () => {
    const out = agentFailureText('codex', 'boom at C:\\Users\\bob\\x\\y.ts and /home/bob/work/z.ts token abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toMatch(/bob|abcdefghijkl/);
  });
});

describe('the same start sent twice', () => {
  it('is NOT refused without an Idempotency-Key: an identical request is an intentional second run', async () => {
    const s = await setup();
    expect((await start(s, 'slow-dup')).status).toBe(200);
    expect((await start(s, 'slow-dup')).status).toBe(200);
  });
});
