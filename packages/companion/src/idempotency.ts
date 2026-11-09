// Idempotency for requests that start something, so a retry after a lost reply never starts it twice. The phone makes one key per intention and reuses it on every retry;
// the host records the key BEFORE it starts anything (state "starting") and the outcome after (state "done"). Persisted in its own small file (not remote.json, which the remote
// host rewrites whole), written atomically with the owner's permissions only.
//   begin  -> new      : nobody has used this key; the caller may start, then must call finish (or abandon if it provably started nothing)
//          -> done     : the same request already ran; hand back the SAME result and start nothing
//          -> mismatch : the key was used for a DIFFERENT request; refuse (a buggy or hostile client), start nothing
//          -> in-doubt : an earlier attempt began and never recorded an outcome (a crash). It may or may not have started something, so nothing is started again
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type IdemBegin = { kind: 'new' } | { kind: 'done'; result: unknown } | { kind: 'mismatch' } | { kind: 'in-doubt' };
interface Entry { sha: string; state: 'starting' | 'done' | 'refused'; result?: unknown; code?: string; at: number }
/** What a status question may see of an entry: never the request itself. */
export type IdemPeek = { state: 'starting' } | { state: 'done'; result: unknown } | { state: 'refused'; code: string };
interface FileShape { v: 1; entries: Record<string, Entry> }

export class IdempotencyUnavailable extends Error {}

export class IdempotencyStore {
  constructor(private readonly path: string, private readonly ttlMs = 24 * 3_600_000, private readonly max = 500) {}

  private load(): FileShape {
    if (!existsSync(this.path)) return { v: 1, entries: {} };
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); } catch { throw new IdempotencyUnavailable('The record of recent requests could not be read, so nothing was started.'); }
    const f = parsed as FileShape;
    if (!f || f.v !== 1 || typeof f.entries !== 'object' || f.entries === null) throw new IdempotencyUnavailable('The record of recent requests is not in the expected form, so nothing was started.');
    return f;
  }
  private save(f: FileShape): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* not supported on this file system */ }
    renameSync(tmp, this.path);
  }
  private prune(f: FileShape, now: number): void {
    for (const [k, e] of Object.entries(f.entries)) if (now - e.at > this.ttlMs) delete f.entries[k];
    // Oldest first, but a 'refused' marker (which holds no started session) always goes before a record that might matter.
    const order = (a: string, b: string) => (f.entries[a]!.state === 'refused' ? 0 : 1) - (f.entries[b]!.state === 'refused' ? 0 : 1) || f.entries[a]!.at - f.entries[b]!.at;
    // Over the cap: take from the device holding the MOST records, so one phone flooding the store cannot push another phone's records out.
    const deviceOf = (k: string) => k.slice(0, k.lastIndexOf(':'));
    for (let keys = Object.keys(f.entries); keys.length > this.max; keys = Object.keys(f.entries)) {
      const count = new Map<string, number>();
      for (const k of keys) count.set(deviceOf(k), (count.get(deviceOf(k)) ?? 0) + 1);
      const biggest = [...count.entries()].sort((x, y) => y[1] - x[1])[0]![0];
      delete f.entries[keys.filter((k) => deviceOf(k) === biggest).sort(order)[0]!];
    }
  }

  begin(did: string, key: string, sha: string, now = Date.now()): IdemBegin {
    const f = this.load();
    this.prune(f, now);
    const k = `${did}:${key}`;
    const e = f.entries[k];
    if (e) {
      if (e.state === 'refused') { f.entries[k] = { sha, state: 'starting', at: now }; this.save(f); return { kind: 'new' }; } // refused before anything started: the key is free again, for any request
      if (e.sha !== sha) return { kind: 'mismatch' };
      return e.state === 'done' ? { kind: 'done', result: e.result } : { kind: 'in-doubt' };
    }
    f.entries[k] = { sha, state: 'starting', at: now };
    this.prune(f, now); // again, so the cap holds counting the entry just added; the newest is never the one dropped
    this.save(f);
    return { kind: 'new' };
  }

  finish(did: string, key: string, result: unknown, now = Date.now()): void {
    const f = this.load();
    const k = `${did}:${key}`;
    const e = f.entries[k];
    if (!e) return;
    f.entries[k] = { ...e, state: 'done', result, at: now };
    this.save(f);
  }

  /** The attempt provably started nothing (it was refused before any process was created), so the same key may be tried again. */
  abandon(did: string, key: string, code?: string, now = Date.now()): void {
    const f = this.load();
    const k = `${did}:${key}`;
    const e = f.entries[k];
    if (e?.state !== 'starting') return;
    // With a reason, a small marker stays (until it ages out) so a phone asking what happened to its request can be told it was refused before anything started.
    if (code) f.entries[k] = { sha: e.sha, state: 'refused', code: code.slice(0, 40), at: now }; else delete f.entries[k];
    this.save(f);
  }

  /** Read only: what is recorded for this device's key, or null if it was never seen, was abandoned without a reason, or has aged out. Never changes anything. */
  peek(did: string, key: string, now = Date.now()): IdemPeek | null {
    const e = this.load().entries[`${did}:${key}`];
    if (!e || now - e.at > this.ttlMs) return null;
    if (e.state === 'done') return { state: 'done', result: e.result };
    if (e.state === 'refused') return { state: 'refused', code: e.code ?? 'refused' };
    return { state: 'starting' };
  }
}
