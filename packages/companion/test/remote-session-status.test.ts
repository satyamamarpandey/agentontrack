// `session.status`: what became of a session.new whose answer never reached the phone. Real projects (real event logs), a real idempotency store, doubles only for what starts a process.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, Project, sha256, type Registered } from '@agentontrack/core';
import { IdempotencyStore } from '../src/idempotency.js';
import { makeExecutor } from '../src/remote-actions.js';
import { READ_ACTIONS, Refusal, type HostContext, type TrustedDevice } from '../src/remote-host.js';

const ID_A = 'a'.repeat(24);
const KEY = 'k1_'.padEnd(26, 'x');
const dev = (did: string, fingerprint: string) => ({ did, device: { did, name: did, fingerprint, level: 'control' } as TrustedDevice }) as HostContext;
const ctx = dev('d1', 'AAAA-BBBB'); const other = dev('d2', 'CCCC-DDDD');
let dir = ''; let root = ''; let p: Project; let reg: Registered[]; let known: Set<string>; let persistEvent: boolean; let failFinish: boolean; let idem: IdempotencyStore; let exec: ReturnType<typeof makeExecutor>; let starts: number;
const params = (over: object = {}) => ({ v: 1, idemKey: KEY, project: ID_A, agent: 'claude-code', model: 'haiku', policy: 'standard', prompt: 'SECRET payroll prompt', ...over });
const status = (c = ctx, key = KEY) => exec('session.status', { v: 1, idemKey: key }, c) as Promise<any>;
const build = () => makeExecutor({
  registry: () => reg, projectFor: () => ({ entry: reg[0]!, p }), isRunning: () => false, stopRun: () => false, recentRuns: () => [],
  startPhase: () => ({ id: 'x', status: 'r' }), startPrompt: () => ({ id: 'x', status: 'r' }), loopPhase: () => ({ started: true, note: '' }), continuePlan: () => ({ started: true, note: '' }), cancelContinue: () => true,
  models: async () => [], agents: async () => [{ id: 'claude-code', canStart: true }], maxUsdPerRun: () => 1, allowMobileExecution: () => true, version: 't',
  startSession: () => { starts++; const n = String(starts).padStart(12, '0'); if (persistEvent) known.add(`ses_${n}`); return { runId: `run_${starts}`, sessionId: `ses_${n}`, status: 'running' }; },
  sessionDetail: (_p, sid) => (known.has(sid) ? { id: sid, status: 'running', title: 'T', runtime: 'claude-code', canResume: false, linked: true, runs: [] } : null),
  idem: { begin: (...a) => idem.begin(...a), finish: (...a) => { if (failFinish) throw new Error('disk'); idem.finish(...a); }, abandon: (...a) => idem.abandon(...a), peek: (...a) => idem.peek(...a) },
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-rss-')); process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'private-folder-name'); mkdirSync(root); p = new Project(root);
  reg = [{ id: ID_A, name: 'Project A', root } as Registered]; known = new Set(); persistEvent = true; failFinish = false; starts = 0;
  idem = new IdempotencyStore(join(dir, 'idem.json')); exec = build();
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const sha = () => sha256(canonical({ v: 1, project: ID_A, agent: 'claude-code', model: 'haiku', policy: 'standard', prompt: 'SECRET payroll prompt', maxUsd: null }));
const refusal = async (f: () => Promise<unknown>) => { try { await f(); return 'ran'; } catch (e) { return e instanceof Refusal ? e.code : 'error'; } };

describe('session.status', () => {
  it('is a read action (a view-only phone may ask) and is announced by ping', async () => {
    expect(READ_ACTIONS).toContain('session.status');
    expect(((await exec('ping', {}, ctx)) as any).ops).toContain('session.status@1');
  });

  it('lost acknowledgement then status: reports started with the session, project and run, and never the prompt or a path', async () => {
    await exec('session.new', params(), ctx); // the answer is "lost": the phone never saw it
    const s = await status();
    expect(s).toMatchObject({ v: 1, state: 'started', sessionId: 'ses_000000000001', runId: 'run_1', project: { id: ID_A, name: 'Project A' } });
    expect(JSON.stringify(s)).not.toMatch(/payroll|private-folder-name/);
    expect(starts).toBe(1); // asking started nothing
    expect(await status()).toEqual(s); // and is repeatable
  });

  it('a key never seen is "unknown-request"', async () => {
    expect(await status()).toMatchObject({ state: 'unknown-request' });
  });

  it('a request refused before anything started is "refused-before-start", and the key can then be used again', async () => {
    await expect(exec('session.new', params({ agent: 'codex' }), ctx)).rejects.toMatchObject({ code: 'agent-unavailable' });
    expect(await status()).toMatchObject({ state: 'refused-before-start', code: 'agent-unavailable' });
    expect(((await exec('session.new', params({ agent: 'codex' }), ctx).catch((e) => e)) as Refusal).code).toBe('agent-unavailable'); // same key, refused again, not "mismatch"
    expect(await refusal(() => exec('session.new', params(), ctx))).toBe('ran'); // a refused marker never blocks a key
    expect(await status()).toMatchObject({ state: 'started' });
  });

  it('crash between begin and finish: NOT started, honestly "starting-indeterminate"', async () => {
    idem.begin('d1', KEY, sha());
    expect(await status()).toMatchObject({ state: 'starting-indeterminate' });
    expect(starts).toBe(0);
  });

  it('a failed write of the result leaves it indeterminate unless the event log proves the session', async () => {
    failFinish = true; persistEvent = false;
    await exec('session.new', params(), ctx);
    expect(await status()).toMatchObject({ state: 'starting-indeterminate' }); // the audit event says started, but the log has no such session
    persistEvent = true; known.clear(); idem = new IdempotencyStore(join(dir, 'idem2.json'));
    await exec('session.new', params(), ctx); // finish fails; the event is recorded and the session is in the log
    expect(await status()).toMatchObject({ state: 'started', sessionId: 'ses_000000000002' });
  });

  it('in doubt is upgraded to started only by this phone\'s own event naming that key and a session the log really has', async () => {
    idem.begin('d1', KEY, sha());
    const ev = (over: object) => p.store.append({ type: 'remote.session.requested', actor: { kind: 'system', runtime: 'agentontrack' }, payload: { fingerprint: 'AAAA-BBBB', idemKey: KEY, outcome: 'started', projectId: ID_A, runId: 'run_9', sessionId: 'ses_0000000000aa', ...over } });
    ev({ fingerprint: 'CCCC-DDDD' }); ev({ idemKey: 'z'.repeat(24) }); ev({ outcome: 'deduped' });
    known.add('ses_0000000000aa');
    expect(await status()).toMatchObject({ state: 'starting-indeterminate' }); // events that are not this phone's, this key's, or a start prove nothing
    ev({});
    expect(await status()).toMatchObject({ state: 'started', sessionId: 'ses_0000000000aa', runId: 'run_9' });
    known.clear();
    expect(await status()).toMatchObject({ state: 'starting-indeterminate' }); // an event for a session the log does not have proves nothing
  });

  it('a stored result whose session is not in the project log (e.g. a restored store) is not reported started', async () => {
    idem.begin('d1', KEY, sha()); idem.finish('d1', KEY, { runId: 'run_1', sessionId: 'ses_0000000000bb', project: { id: ID_A, name: 'Project A' } });
    expect(await status()).toMatchObject({ state: 'starting-indeterminate' });
  });

  it('another device cannot read the status of a key it did not make', async () => {
    await exec('session.new', params(), ctx);
    expect(await status(other)).toMatchObject({ state: 'unknown-request' });
    idem.begin('d1', 'q'.repeat(24), sha());
    expect(await status(other, 'q'.repeat(24))).toMatchObject({ state: 'unknown-request' });
  });

  it('is strict: extra fields, a wrong version, and a bad key are refused', async () => {
    for (const bad of [{ v: 1, idemKey: KEY, project: ID_A }, { v: 1, idemKey: KEY, sessionId: 'ses_aaaaaaaaaaaa' }, { v: 2, idemKey: KEY }, { idemKey: KEY }, { v: 1, idemKey: 'short' }, { v: 1 }, { v: 1, idemKey: 'a b'.padEnd(30, 'x') }]) expect(await refusal(() => exec('session.status', bad, ctx))).toBe('bad-request');
  });

  it('is unavailable (not a guess) when the computer cannot start sessions', async () => {
    const bare = makeExecutor({ registry: () => reg, projectFor: () => ({ entry: reg[0]!, p }), isRunning: () => false, stopRun: () => false, recentRuns: () => [], startPhase: () => ({ id: 'x', status: 'r' }), startPrompt: () => ({ id: 'x', status: 'r' }), loopPhase: () => ({ started: true, note: '' }), continuePlan: () => ({ started: true, note: '' }), cancelContinue: () => true, models: async () => [], agents: async () => [], maxUsdPerRun: () => 1, allowMobileExecution: () => true, version: 't' });
    expect(await refusal(() => bare('session.status', { v: 1, idemKey: KEY }, ctx))).toBe('unavailable');
  });
});

describe('request key rules still hold alongside status', () => {
  it('replay returns the same session, marked deduped; changed fields cannot reuse the key', async () => {
    const first = await exec('session.new', params(), ctx) as any;
    expect(await exec('session.new', params(), ctx)).toMatchObject({ sessionId: first.sessionId, deduped: true });
    expect(await refusal(() => exec('session.new', params({ prompt: 'different' }), ctx))).toBe('idem-mismatch');
    expect(starts).toBe(1);
  });
});
