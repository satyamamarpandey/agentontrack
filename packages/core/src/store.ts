import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HUMAN_ONLY_EVENTS, type Actor, type StoredEvent } from './types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const GENESIS = '0'.repeat(64);

export interface NewEvent {
  type: string;
  actor: Actor;
  taskId?: string | null;
  goalVersion?: number | null;
  policyVersion?: number | null;
  payload?: unknown;
}

const rowToEvent = (r: any): StoredEvent => ({
  seq: r.seq, ts: r.ts, type: r.type, actor: JSON.parse(r.actor), taskId: r.task_id, goalVersion: r.goal_version,
  policyVersion: r.policy_version, payload: JSON.parse(r.payload), prevHash: r.prev_hash, hash: r.hash,
});

/**
 * Append-only, hash-chained event log. The triggers and chain expose casual edits only: a same-user attacker
 * can drop the triggers and recompute the chain. integrity.ts adds what can be added on top of that.
 */
export class EventStore {
  private db: DatabaseSync;
  private depth = 0;
  private pending: StoredEvent[] = [];
  onCommit: ((e: StoredEvent) => void) | undefined;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 15000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, task_id TEXT,
        goal_version INTEGER, policy_version INTEGER, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_type ON events(type, seq);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
      CREATE TABLE IF NOT EXISTS projection (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL);
    `);
  }

  /** Runs fn in one write transaction, so a check and its dependent append cannot interleave with another process. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      this.depth = 0;
      const done = this.pending;
      this.pending = [];
      for (const e of done) this.onCommit?.(e);
      return out;
    } catch (err) {
      this.depth = 0;
      this.pending = [];
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  append(e: NewEvent): StoredEvent {
    if (HUMAN_ONLY_EVENTS.has(e.type) && e.actor.kind !== 'human') {
      throw new Error(`Event ${e.type} requires a human actor`);
    }
    return this.tx(() => {
      const last = this.head();
      const body = {
        seq: (last?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        type: e.type,
        actor: e.actor,
        taskId: e.taskId ?? null,
        goalVersion: e.goalVersion ?? null,
        policyVersion: e.policyVersion ?? null,
        payload: e.payload ?? {},
        prevHash: last?.hash ?? GENESIS,
      };
      const hash = sha256(canonical(body));
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        body.seq, body.ts, body.type, JSON.stringify(body.actor), body.taskId, body.goalVersion,
        body.policyVersion, JSON.stringify(body.payload), body.prevHash, hash,
      );
      const stored = { ...body, hash };
      this.pending.push(stored);
      return stored;
    });
  }

  head(): { seq: number; hash: string } | undefined {
    return this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
  }

  all(): StoredEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY seq').all() as any[]).map(rowToEvent);
  }

  since(seq: number): StoredEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(seq) as any[]).map(rowToEvent);
  }

  byType(types: string[], limit = 100_000): StoredEvent[] {
    const marks = types.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM (SELECT * FROM events WHERE type IN (${marks}) ORDER BY seq DESC LIMIT ?) ORDER BY seq`).all(...types, limit) as any[]).map(rowToEvent);
  }

  eventAt(seq: number): StoredEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq);
    return r ? rowToEvent(r) : undefined;
  }

  loadProjection(): { seq: number; hash: string; state: string } | undefined {
    return this.db.prepare('SELECT seq, hash, state FROM projection WHERE id = 1').get() as any;
  }

  saveProjection(seq: number, hash: string, state: string): void {
    this.db.prepare('INSERT OR REPLACE INTO projection VALUES (1, ?, ?, ?)').run(seq, hash, state);
  }

  /** Detects inconsistent records. A valid chain says nothing about whether an observation was truthful. */
  verifyChain(): { ok: boolean; events: number; firstBadSeq?: number } {
    let prev = GENESIS;
    let expectSeq = 1;
    let events = 0;
    for (const row of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
      const { hash, ...body } = rowToEvent(row);
      events++;
      if (body.seq !== expectSeq || body.prevHash !== prev || sha256(canonical(body)) !== hash) {
        return { ok: false, events, firstBadSeq: body.seq };
      }
      prev = hash;
      expectSeq += 1;
    }
    return { ok: true, events };
  }

  /** Recovery: writes the valid prefix to a new file. The caller quarantines the old one. */
  exportPrefix(toPath: string, beforeSeq: number): void {
    const out = new DatabaseSync(toPath);
    out.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, task_id TEXT,
      goal_version INTEGER, policy_version INTEGER, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`);
    const ins = out.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of this.db.prepare('SELECT * FROM events WHERE seq < ? ORDER BY seq').iterate(beforeSeq) as Iterable<any>) {
      ins.run(r.seq, r.ts, r.type, r.actor, r.task_id, r.goal_version, r.policy_version, r.payload, r.prev_hash, r.hash);
    }
    out.close();
  }

  close(): void {
    this.db.close();
  }
}
