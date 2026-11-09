// The client is driven by a script that speaks the app-server protocol as documented. It proves this client's handling (handshake, streaming,
// approvals answered one time only, decline on anything odd, interrupt, resume), not that a real Codex behaves this way.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServer, mapNotification, parseApprovalRequest, type AppServerEvent, type ApprovalRequest } from '../src/index.js';

const FAKE = `
import { createInterface } from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const mode = process.env.FAKE_MODE ?? 'normal';
let nextId = 100; const waiting = new Map();
const ask = (method, params) => new Promise((res) => { const id = nextId++; waiting.set(id, res); out({ id, method, params }); });
createInterface({ input: process.stdin }).on('line', async (l) => {
  const m = JSON.parse(l);
  if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m); return; }
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    out({ id: m.id, result: { thread: { id: m.params.threadId ?? '0199a213-81c0-7800-8aa1-bbab2a035a53' } } });
    return;
  }
  if (m.method === 'turn/interrupt') { out({ id: m.id, result: {} }); out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'interrupted' } } }); return; }
  if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 't1' } } });
    out({ method: 'turn/started', params: { turn: { id: 't1' } } });
    if (mode === 'hang') return;
    out({ method: 'item/agentMessage/delta', params: { delta: 'hel' } });
    const r = await ask('item/commandExecution/requestApproval', { threadId: 'x', itemId: 'i1', command: mode === 'badrequest' ? undefined : 'rm -rf build', cwd: '/w' });
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'decision=' + r.result?.decision } } });
    out({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 7, reasoningOutputTokens: 1 } } } });
    out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
  }
});
`;

let dir: string;
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp */ } });

type Opts = ConstructorParameters<typeof CodexAppServer>[0];
const run = (mode: string, answer: (r: ApprovalRequest) => Promise<'accept' | 'decline'>, extra: Partial<Opts> = {}) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-app-'));
  writeFileSync(join(dir, 'fake.mjs'), FAKE);
  const events: AppServerEvent[] = [];
  const s = new CodexAppServer({ command: [process.execPath, join(dir, 'fake.mjs')], cwd: dir, env: { ...process.env, FAKE_MODE: mode }, onApproval: answer, onEvent: (e) => events.push(e), ...extra });
  return { s, events };
};

describe('codex app-server client', () => {
  it('never accepts an approval in a read-only run, even when the callback says accept, and does not even ask it', async () => {
    let asked = 0;
    const { s, events } = run('normal', async () => { asked++; return 'accept'; }, { sandbox: 'read-only' });
    await s.start();
    await s.turn({ prompt: 'go' });
    s.kill();
    expect(asked).toBe(0);
    expect(events.find((e) => e.kind === 'message')).toMatchObject({ text: 'decision=decline' });
    expect(events.find((e) => e.kind === 'approval')).toMatchObject({ answer: 'decline' });
  });
  it('streams, asks for approval, sends a one-time accept, and reports usage', async () => {
    const seen: ApprovalRequest[] = [];
    const { s, events } = run('normal', async (r) => { seen.push(r); return 'accept'; });
    expect(await s.start()).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
    expect(await s.turn({ prompt: 'go' })).toBe('completed');
    s.kill();
    expect(seen).toEqual([{ kind: 'command', threadId: 'x', itemId: 'i1', command: 'rm -rf build', cwd: '/w' }]);
    expect(events.find((e) => e.kind === 'message')).toMatchObject({ text: 'decision=accept' });
    expect(events.find((e) => e.kind === 'delta')).toMatchObject({ text: 'hel' });
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 7 });
    expect(events.find((e) => e.kind === 'approval')).toMatchObject({ answer: 'accept' });
  });
  it('declines when the callback declines, throws, or returns something else', async () => {
    for (const cb of [async () => 'decline' as const, async () => { throw new Error('x'); }, async () => 'acceptForSession' as never]) {
      const { s, events } = run('normal', cb);
      await s.start(); await s.turn({ prompt: 'go' }); s.kill();
      expect(events.find((e) => e.kind === 'message')).toMatchObject({ text: 'decision=decline' });
    }
  });
  it('declines a request it cannot understand, without asking the person', async () => {
    let asked = 0;
    const { s, events } = run('badrequest', async () => { asked++; return 'accept'; });
    await s.start(); await s.turn({ prompt: 'go' }); s.kill();
    expect(asked).toBe(0);
    expect(events.find((e) => e.kind === 'message')).toMatchObject({ text: 'decision=decline' });
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });
  it('declines on timeout, so a forgotten approval never runs', async () => {
    const { s, events } = run('normal', () => new Promise(() => {}), { approvalTimeoutMs: 50 });
    await s.start(); await s.turn({ prompt: 'go' }); s.kill();
    expect(events.find((e) => e.kind === 'message')).toMatchObject({ text: 'decision=decline' });
  });
  it('interrupts a running turn', async () => {
    const { s } = run('hang', async () => 'decline');
    await s.start();
    const t = s.turn({ prompt: 'go' });
    await new Promise((r) => setTimeout(r, 300));
    await s.interrupt(200);
    expect(await t).toBe('interrupted');
  });
  it('resumes by id and refuses option-like ids and model names', async () => {
    const { s } = run('normal', async () => 'decline');
    expect(await s.start('0199a213-81c0-7800-8aa1-bbab2a035a99')).toBe('0199a213-81c0-7800-8aa1-bbab2a035a99');
    s.kill();
    await expect(run('normal', async () => 'decline').s.start('--last')).rejects.toThrow();
    await expect(run('normal', async () => 'decline', { model: '--yolo' }).s.start()).rejects.toThrow();
  });
  it('fails when the server never answers the handshake', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aot-app-'));
    writeFileSync(join(dir, 'silent.mjs'), 'setInterval(()=>{},1000)');
    const s = new CodexAppServer({ command: [process.execPath, join(dir, 'silent.mjs')], cwd: dir, onApproval: async () => 'decline', onEvent: () => {}, rpcTimeoutMs: 150 });
    await expect(s.start()).rejects.toThrow(/did not answer/);
    s.kill();
  });
});

describe('protocol mapping', () => {
  it('ignores unknown notifications and odd shapes', () => {
    expect(mapNotification('mystery', {})).toEqual([]);
    expect(mapNotification('thread/tokenUsage/updated', { tokenUsage: 5 })).toEqual([]);
    expect(mapNotification('thread/started', { thread: { id: '--last' } })).toEqual([]);
    expect(mapNotification('item/completed', { item: { type: 'reasoning', text: 'private' } })).toEqual([]);
  });
  it('reads file-change approvals and refuses nonsense', () => {
    expect(parseApprovalRequest('item/fileChange/requestApproval', { threadId: 't', itemId: 'i', changes: [{ path: 'a.ts' }], grantRoot: '/etc' })).toMatchObject({ kind: 'file', paths: ['a.ts', '/etc'] });
    expect(parseApprovalRequest('item/commandExecution/requestApproval', null)).toBeNull();
    expect(parseApprovalRequest('item/other/requestApproval', { command: 'x' })).toBeNull();
  });
});

describe('a command that did not work is not shown as one that did', () => {
  const done = (item: object) => mapNotification('item/completed', { item: { type: 'commandExecution', command: 'x', ...item } });
  it('reports status, exit code and the tail of the output on a completed command', () => {
    expect(done({ status: 'failed', exitCode: 1, aggregatedOutput: 'Access denied' })).toEqual([{ kind: 'tool', tool: 'shell', summary: 'x', phase: 'completed', outcome: { status: 'failed', exitCode: 1, output: 'Access denied' } }]);
  });
  it('reports a declined command', () => {
    expect((done({ status: 'declined' })[0] as any).outcome).toEqual({ status: 'declined' });
  });
  it('gives no outcome when a command starts', () => {
    expect((mapNotification('item/started', { item: { type: 'commandExecution', command: 'x' } })[0] as any).outcome).toBeUndefined();
  });
});
