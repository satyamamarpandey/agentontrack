// Whether a stop is reported truthfully. The "children" are fakes, so every way a stop can go wrong is reproduced exactly and quickly, on every operating system:
// a signal that cannot be delivered, one that throws, a process that ignores it, and one that never goes away.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { terminate, type Killable } from '../src/terminate.js';

class Fake extends EventEmitter implements Killable {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: (string | number | undefined)[] = [];
  constructor(private behaviour: (signal: string | number | undefined, self: Fake) => boolean | void) { super(); }
  kill(signal?: NodeJS.Signals | number) { this.signals.push(signal); return this.behaviour(signal, this); }
  end(signal: NodeJS.Signals = 'SIGTERM') { this.signalCode = signal; this.emit('exit', null, signal); }
}
const FAST = { graceMs: 40, killMs: 40 };

describe('terminate', () => {
  it('says "already gone" and sends nothing to a process that has already exited', async () => {
    const f = new Fake(() => true); f.exitCode = 0;
    expect(await terminate(f, FAST)).toEqual({ ok: true, how: 'already-gone' });
    expect(f.signals).toEqual([]);
  });

  it('reports stopped only after the process has exited', async () => {
    let alive = true;
    const f = new Fake((_s, self) => { setTimeout(() => { alive = false; self.end(); }, 10); return true; });
    const r = await terminate(f, FAST);
    expect(r).toEqual({ ok: true, how: 'exited' });
    expect(alive).toBe(false);
    expect(f.signals).toEqual([undefined]);
  });

  it('copes with a process that exits inside the kill call itself', async () => {
    const f = new Fake((_s, self) => { self.end(); return true; });
    expect(await terminate(f, FAST)).toEqual({ ok: true, how: 'exited' });
  });

  it('reports a failure, and does not escalate, when the signal cannot be delivered and the process is still running', async () => {
    const f = new Fake(() => false);
    const r = await terminate(f, FAST);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/could not be delivered/);
    expect(f.signals).toEqual([undefined]);
  });

  it('reports a failure when sending the signal throws', async () => {
    const f = new Fake(() => { throw new Error('EPERM'); });
    const r = await terminate(f, FAST);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/could not be signalled: EPERM/);
  });

  it('escalates to a hard kill for a process that ignores the first signal, and says it escalated', async () => {
    const f = new Fake((signal, self) => { if (signal === 'SIGKILL') setTimeout(() => self.end('SIGKILL'), 5); return true; });
    const r = await terminate(f, FAST);
    expect(r).toEqual({ ok: true, how: 'escalated' });
    expect(f.signals).toEqual([undefined, 'SIGKILL']);
  });

  it('reports a failure, not a stop, for a process that survives even the hard kill', async () => {
    const f = new Fake(() => true);
    const r = await terminate(f, FAST);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/did not exit/);
    expect(f.signals).toEqual([undefined, 'SIGKILL']);
  });

  it('says only "requested" for something that cannot report its exit', async () => {
    let called = 0;
    expect(await terminate({ kill: () => { called++; } }, FAST)).toEqual({ ok: true, how: 'requested' });
    expect(called).toBe(1);
  });

  it('leaves no listener behind, whatever the outcome', async () => {
    const a = new Fake((_s, self) => { self.end(); return true; });
    await terminate(a, FAST);
    expect(a.listenerCount('exit')).toBe(0);
    const b = new Fake(() => true);
    await terminate(b, FAST);
    expect(b.listenerCount('exit')).toBe(0);
  });
});
