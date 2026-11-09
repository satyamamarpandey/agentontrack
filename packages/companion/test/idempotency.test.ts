// A retry must never start a second session. The store is checked directly, including a crash between "begin" and "finish", a reused key, expiry and a damaged file.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdempotencyStore, IdempotencyUnavailable } from '../src/idempotency.js';

let dir = '';
const file = () => join(dir, 'idem.json');
const store = (ttl?: number, max?: number) => { dir ||= mkdtempSync(join(tmpdir(), 'aot-idem-')); return new IdempotencyStore(file(), ttl, max); };
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); dir = ''; });
const KEY = 'k'.repeat(24);

describe('IdempotencyStore', () => {
  it('one device flooding the store cannot push another device\'s completed entry out (so that device\'s retry cannot start a second session)', () => {
    const s = store(undefined, 500);
    s.begin('dev1', KEY, 'sha-a'); s.finish('dev1', KEY, { runId: 'run_1' });
    for (let i = 0; i < 700; i++) { const k = `f${String(i).padStart(22, '0')}`; s.begin('dev2', k, `sha-${i}`); }
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'done', result: { runId: 'run_1' } });
  });
  it('drops refused markers before records that might hold a started session', () => {
    const s = store(undefined, 10);
    s.begin('dev1', KEY, 'sha-a'); s.finish('dev1', KEY, { runId: 'run_1' });
    for (let i = 0; i < 20; i++) { const k = `r${String(i).padStart(22, '0')}`; s.begin('dev1', k, 'x'); s.abandon('dev1', k, 'busy'); }
    expect(s.begin('dev1', KEY, 'sha-a')).toMatchObject({ kind: 'done' });
  });
  it('lets the first request through, and hands the SAME result back to a repeat without starting anything', () => {
    const s = store();
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'new' });
    s.finish('dev1', KEY, { runId: 'run_1', sessionId: 'ses_1' });
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'done', result: { runId: 'run_1', sessionId: 'ses_1' } });
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'done', result: { runId: 'run_1', sessionId: 'ses_1' } });
  });

  it('refuses the same key used for a different request', () => {
    const s = store();
    s.begin('dev1', KEY, 'sha-a'); s.finish('dev1', KEY, { runId: 'run_1' });
    expect(s.begin('dev1', KEY, 'sha-b')).toEqual({ kind: 'mismatch' });
  });

  it('keeps devices apart: the same key from another device is a new request', () => {
    const s = store();
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'new' });
    expect(s.begin('dev2', KEY, 'sha-a')).toEqual({ kind: 'new' });
  });

  it('says "in doubt" for an attempt that began and never recorded an outcome (a crash), and starts nothing', () => {
    const before = store();
    expect(before.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'new' });
    // The process dies here. A new process, a new store object, the same file.
    const after = new IdempotencyStore(file());
    expect(after.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'in-doubt' });
  });

  it('survives a restart: a finished request is still remembered by a new store object', () => {
    const a = store();
    a.begin('dev1', KEY, 'sha-a'); a.finish('dev1', KEY, { runId: 'run_9' });
    expect(new IdempotencyStore(file()).begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'done', result: { runId: 'run_9' } });
  });

  it('lets a request that provably started nothing be tried again with the same key, but never forgets a finished one', () => {
    const s = store();
    s.begin('dev1', KEY, 'sha-a');
    s.abandon('dev1', KEY);
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'new' });
    s.finish('dev1', KEY, { runId: 'run_1' });
    s.abandon('dev1', KEY);
    expect(s.begin('dev1', KEY, 'sha-a')).toEqual({ kind: 'done', result: { runId: 'run_1' } });
  });

  it('forgets requests after they expire, so a very old key can be used again', () => {
    const s = store(1000);
    s.begin('dev1', KEY, 'sha-a', 0); s.finish('dev1', KEY, { runId: 'run_1' }, 0);
    expect(s.begin('dev1', KEY, 'sha-a', 500).kind).toBe('done');
    expect(s.begin('dev1', KEY, 'sha-a', 5000)).toEqual({ kind: 'new' });
  });

  it('keeps no more than its cap, dropping the oldest', () => {
    const s = store(1e12, 3);
    for (let i = 0; i < 6; i++) { s.begin('d', `key-${i}`.padEnd(24, 'x'), 'sha', i); s.finish('d', `key-${i}`.padEnd(24, 'x'), { i }, i); }
    const kept = Object.keys(JSON.parse(readFileSync(file(), 'utf8')).entries);
    expect(kept.length).toBeLessThanOrEqual(3);
    expect(kept.some((k) => k.includes('key-5'))).toBe(true);
    expect(kept.some((k) => k.includes('key-0'))).toBe(false);
  });

  it('fails closed on a damaged or unexpected file: it starts nothing and says why, instead of forgetting every key', () => {
    const s = store();
    s.begin('dev1', KEY, 'sha-a');
    writeFileSync(file(), '{ not json');
    expect(() => s.begin('dev1', KEY, 'sha-a')).toThrow(IdempotencyUnavailable);
    writeFileSync(file(), JSON.stringify({ v: 2, entries: {} }));
    expect(() => s.begin('dev1', KEY, 'sha-a')).toThrow(IdempotencyUnavailable);
    writeFileSync(file(), JSON.stringify({ v: 1, entries: null }));
    expect(() => s.begin('dev1', KEY, 'sha-a')).toThrow(IdempotencyUnavailable);
  });

  it('writes its file for its owner only (where the file system supports it) and leaves no temporary file', () => {
    const s = store();
    s.begin('dev1', KEY, 'sha-a');
    expect(existsSync(file())).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o077).toBe(0);
    expect(existsSync(`${file()}.${process.pid}.tmp`)).toBe(false);
  });
});

describe('IdempotencyStore status and cleanup', () => {
  it('peek is read only, scoped to the device, and shows only state, never the request hash', () => {
    const s = store();
    expect(s.peek('dev1', KEY)).toBeNull();
    s.begin('dev1', KEY, 'sha-a');
    expect(s.peek('dev1', KEY)).toEqual({ state: 'starting' });
    expect(s.peek('dev2', KEY)).toBeNull();
    s.finish('dev1', KEY, { runId: 'run_1' });
    expect(s.peek('dev1', KEY)).toEqual({ state: 'done', result: { runId: 'run_1' } });
    expect(JSON.stringify(s.peek('dev1', KEY))).not.toContain('sha-a');
  });

  it('abandon with a reason leaves a refused marker that allows the key again; without a reason it leaves nothing', () => {
    const s = store();
    s.begin('dev1', KEY, 'sha-a'); s.abandon('dev1', KEY, 'busy');
    expect(s.peek('dev1', KEY)).toEqual({ state: 'refused', code: 'busy' });
    expect(s.begin('dev1', KEY, 'sha-b')).toEqual({ kind: 'new' });
    s.abandon('dev1', KEY);
    expect(s.peek('dev1', KEY)).toBeNull();
  });

  it('cleans up: entries older than the retention (including refused markers) are gone from the file and from peek', () => {
    const s = store(1000);
    s.begin('dev1', KEY, 'a', 1000); s.finish('dev1', KEY, { r: 1 }, 1000);
    s.begin('dev1', 'm'.repeat(24), 'b', 1000); s.abandon('dev1', 'm'.repeat(24), 'busy', 1000);
    expect(s.peek('dev1', KEY, 1500)).not.toBeNull();
    expect(s.peek('dev1', KEY, 2500)).toBeNull();
    expect(s.peek('dev1', 'm'.repeat(24), 2500)).toBeNull();
    s.begin('dev1', 'n'.repeat(24), 'c', 2500); // any later begin prunes the file itself
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')).entries)).toEqual(['dev1:' + 'n'.repeat(24)]);
  });

  it('caps the number kept, dropping the oldest', () => {
    const s = store(1e9, 3);
    for (let i = 0; i < 5; i++) s.begin('dev1', String(i).repeat(24), 'x', Date.now() + i);
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')).entries)).toHaveLength(3);
    expect(s.peek('dev1', '0'.repeat(24))).toBeNull();
    expect(s.peek('dev1', '4'.repeat(24))).toEqual({ state: 'starting' });
  });
});
