// The service that runs the phone link, over an in-memory channel that behaves like Firestore for this purpose: documents, a request
// listener, and the ability to fail with quota. This tests the service's own logic. The real Firestore, with real rules, is exercised in the emulator job.
import { beforeEach, describe, expect, it } from 'vitest';
import { createIdentity, fingerprint, newId, open, pairKey, seal, snapshotKey, type Envelope, type Identity } from '@agentontrack/remote';
import { newRemoteFile, type RemoteFile } from '../src/remote-host.js';
import { RemoteService } from '../src/remote-service.js';
import type { PendingDevice, Transport, TransportEvents } from '../src/remote-transport.js';

const UID = 'u1';
class MemoryTransport implements Transport {
  h!: TransportEvents;
  requests = new Map<string, Envelope>(); responses = new Map<string, Envelope>(); snapshots = new Map<string, Envelope>();
  statuses = new Map<string, string>(); beats = 0; writes = 0; failWith: { code: string } | null = null; stopped = false;
  async start(h: TransportEvents) { this.h = h; }
  private check() { this.writes++; if (this.failWith) throw Object.assign(new Error('boom'), this.failWith); }
  async respond(env: Envelope) { this.check(); this.responses.set(env.rid, env); }
  async snapshot(id: string, env: Envelope) { this.check(); this.snapshots.set(id, env); }
  async removeRequest(rid: string) { this.requests.delete(rid); }
  async setDeviceStatus(did: string, s: 'trusted' | 'revoked') { this.statuses.set(did, s); }
  async heartbeat() { this.check(); this.beats++; }
  async stop() { this.stopped = true; }
  deliver(env: Envelope) { this.requests.set(env.rid, env); this.h.onRequest(env); }
  devices(list: PendingDevice[]) { this.h.onDevices(list); }
}

let T: number; let file: RemoteFile; let tr: MemoryTransport; let svc: RemoteService; let phone: Identity; let key: CryptoKey; let ctr: number;
let projectState: { n: number }; let ran: string[];
const settle = () => new Promise((ok) => setTimeout(ok, 30));

beforeEach(async () => {
  T = 1_800_000_000_000; ctr = 0; ran = []; projectState = { n: 1 };
  file = await newRemoteFile('Laptop');
  file.link = { uid: UID, firebase: { apiKey: 'k', projectId: 'p' }, computer: { email: 'c@x.invalid', password: 'x' }, linkedAt: 'now' };
  tr = new MemoryTransport();
  svc = new RemoteService({ file, save: () => undefined, transport: tr, version: 't', now: () => T, snapshotEveryMs: 3_600_000, heartbeatEveryMs: 3_600_000,
    executor: async (action) => { ran.push(action); return { done: action }; },
    list: () => [{ id: 'proj1', name: 'My project' }], projects: () => [{ id: 'proj1', snapshot: () => ({ project: { id: 'proj1' }, n: projectState.n, generatedAt: 'x' }) }] });
  await svc.start();
  phone = await createIdentity();
  tr.devices([{ did: 'ph1', name: 'My phone', pub: phone.pub, status: 'pending' }]);
  await settle();
  key = await pairKey(phone, svc.host.pub.agree, { uid: UID, cid: file.computerId, did: 'ph1' });
});
const stop = () => svc.stop();
const ask = (action: string, over: { did?: string; sign?: Identity } = {}) => seal({ action, params: {} }, { v: 1, uid: UID, cid: file.computerId, did: over.did ?? 'ph1', rid: newId(), kind: 'request', ctr: ++ctr, iat: T, exp: T + 120_000 }, key, (over.sign ?? phone).signing.privateKey);
const read = (env: Envelope, allowExpired = false) => open<any>(env, { uid: UID, cid: file.computerId, did: 'ph1' }, key, svc.host.pub.sign, T, { allowExpired });

describe('approving a phone', () => {
  it('lists a phone that asked, with the fingerprint the person compares, and trusts nothing until they confirm', async () => {
    const s = await svc.status();
    expect(s.pending).toEqual([{ did: 'ph1', name: 'My phone', fingerprint: await fingerprint(phone.pub) }]);
    expect(s.devices).toEqual([]);
    tr.deliver(await ask('ping'));
    await settle();
    expect(ran).toEqual([]);
    expect(tr.responses.size).toBe(0);
    await stop();
  });

  it('trusts it once the person confirms, tells the channel, and then answers it', async () => {
    await svc.trust('ph1', 'control');
    expect(tr.statuses.get('ph1')).toBe('trusted');
    expect((await svc.status()).pending).toEqual([]);
    tr.deliver(await ask('projects.list'));
    await settle();
    expect(ran).toEqual(['projects.list']);
    const res = [...tr.responses.values()][0]!;
    expect(await read(res)).toEqual({ ok: true, result: { done: 'projects.list' } });
    await stop();
  });

  it('cannot trust a phone that was never listed, and is not fooled by a phone swapping in a different key', async () => {
    await expect(svc.trust('ghost', 'view')).rejects.toThrow(/not waiting/);
    const other = await createIdentity();
    tr.devices([{ did: 'ph1', name: 'My phone', pub: other.pub, status: 'pending' }]);
    await settle();
    // The person sees a different fingerprint from the one on their phone, which is exactly how they would notice.
    expect((await svc.status()).pending[0]!.fingerprint).not.toBe(await fingerprint(phone.pub));
    await stop();
  });
});

describe('the channel', () => {
  beforeEach(async () => { await svc.trust('ph1', 'control'); });

  it('takes a handled request off the channel, so nothing waits there to be replayed', async () => {
    const env = await ask('ping');
    tr.deliver(env);
    await settle();
    expect(tr.requests.size).toBe(0);
    await stop();
  });

  it('answers a request that arrives twice with the same answer, and runs it once', async () => {
    const env = await ask('ping');
    tr.deliver(env); tr.deliver(env);
    await settle();
    tr.deliver(env);
    await settle();
    expect(ran).toEqual(['ping']);
    expect(tr.responses.size).toBe(1);
    await stop();
  });

  it('clears away a request from a phone it does not know, without answering it', async () => {
    const stranger = await createIdentity();
    const k = await pairKey(stranger, svc.host.pub.agree, { uid: UID, cid: file.computerId, did: 'stranger' });
    const env = await seal({ action: 'ping', params: {} }, { v: 1, uid: UID, cid: file.computerId, did: 'stranger', rid: newId(), kind: 'request', ctr: 1, iat: T, exp: T + 60_000 }, k, stranger.signing.privateKey);
    tr.deliver(env);
    await settle();
    expect(ran).toEqual([]);
    expect(tr.responses.size).toBe(0);
    expect(tr.requests.size).toBe(0);
    await stop();
  });

  it('stops answering a phone the moment it is revoked, and says so on the channel', async () => {
    expect(await svc.revoke('ph1')).toBe(true);
    expect(tr.statuses.get('ph1')).toBe('revoked');
    tr.deliver(await ask('ping'));
    await settle();
    expect(ran).toEqual([]);
    expect(tr.responses.size).toBe(0);
    expect((await svc.status()).devices[0]).toMatchObject({ did: 'ph1', revokedAt: expect.any(String) });
    await stop();
  });
});

describe('what a phone is shown', () => {
  beforeEach(async () => { await svc.trust('ph1', 'view'); });

  it('is a signed snapshot per project and one for the list, readable only by that phone, with the time it was made inside', async () => {
    const pk = `ph1__${await snapshotKey(file.computerId, 'proj1')}`;
    expect([...tr.snapshots.keys()].sort()).toEqual(['ph1__list', pk].sort());
    const snap = await read(tr.snapshots.get(pk)!);
    expect(snap).toMatchObject({ n: 1, project: { id: 'proj1' } });
    expect(Date.parse(snap.generatedAt)).toBe(T);
    expect(JSON.stringify([...tr.snapshots.entries()])).not.toContain('proj1');
    // After the computer goes quiet, it is still shown, with its true age.
    T += 3_600_000;
    expect((await read(tr.snapshots.get(pk)!, true)).generatedAt).toBe(new Date(T - 3_600_000).toISOString());
    await stop();
  });

  it('is written again only when something changed', async () => {
    const before = tr.writes;
    await svc.publish(false);
    expect(tr.writes).toBe(before);
    projectState.n = 2;
    await svc.publish(false);
    expect(tr.writes).toBe(before + 1);
    expect((await read(tr.snapshots.get(`ph1__${await snapshotKey(file.computerId, 'proj1')}`)!)).n).toBe(2);
    await stop();
  });

  it('is not written for a phone that was not approved, or one that was revoked', async () => {
    await svc.revoke('ph1');
    const before = tr.writes;
    projectState.n = 3;
    await svc.publish(true);
    expect(tr.writes).toBe(before);
    await stop();
  });
});

describe('when Firebase runs out of quota', () => {
  it('pauses writing, says why, and resumes after the pause, without crashing or losing the link', async () => {
    await svc.trust('ph1', 'control');
    tr.failWith = { code: 'resource-exhausted' };
    projectState.n = 2;
    await svc.publish(false);
    const s = await svc.status();
    expect(s.degraded).toBe('quota');
    expect(s.online).toBe(false);
    expect(s.lastError).toMatch(/quota/);
    tr.failWith = null;
    const during = tr.writes;
    await svc.publish(true);
    expect(tr.writes).toBe(during);
    T += 11 * 60_000;
    await svc.publish(true);
    expect(tr.writes).toBeGreaterThan(during);
    expect((await svc.status()).degraded).toBeNull();
    await stop();
  });
});
