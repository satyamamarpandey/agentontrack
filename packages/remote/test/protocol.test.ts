import { describe, expect, it } from 'vitest';
import { createIdentity, exportIdentity, fingerprint, importIdentity, newId, open, OpenError, pairKey, seal, type Envelope, type Meta } from '../src/index.js';

const ctx = { uid: 'u1', cid: 'c1', did: 'd1' };
const NOW = 1_800_000_000_000;
const meta = (over: Partial<Meta> = {}): Meta => ({ v: 1, ...ctx, rid: newId(), kind: 'prompt.submit', ctr: 1, iat: NOW, exp: NOW + 60_000, ...over });

async function pair() {
  const phone = await createIdentity();
  const computer = await createIdentity();
  const phoneKey = await pairKey(phone, computer.pub.agree, ctx);
  const computerKey = await pairKey(computer, phone.pub.agree, ctx);
  return { phone, computer, phoneKey, computerKey };
}
const why = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof OpenError ? e.reason : `other:${(e as Error).message}`; } };

describe('a request from a phone to a computer', () => {
  it('is read by the computer exactly as it was sent', async () => {
    const { phone, computer, phoneKey, computerKey } = await pair();
    const env = await seal({ action: 'run.stop', params: { id: 'run_1' } }, meta(), phoneKey, phone.signing.privateKey);
    expect(await open(env, ctx, computerKey, phone.pub.sign, NOW)).toEqual({ action: 'run.stop', params: { id: 'run_1' } });
    expect(JSON.stringify(env)).not.toContain('run_1');
    expect(computer.pub.sign).not.toBe(phone.pub.sign);
  });

  it('is refused if any byte of the content, or any field it is bound to, was changed in transit', async () => {
    const { phone, phoneKey, computerKey } = await pair();
    const env = await seal({ action: 'x' }, meta(), phoneKey, phone.signing.privateKey);
    const flip = (s: string) => `${s.slice(0, 4)}${s[4] === 'A' ? 'B' : 'A'}${s.slice(5)}`;
    const cases: [string, Envelope][] = [['ciphertext', { ...env, ct: flip(env.ct) }], ['iv', { ...env, iv: flip(env.iv) }], ['request id', { ...env, rid: 'other' }], ['kind', { ...env, kind: 'approval.decide' }], ['counter', { ...env, ctr: 2 }], ['expiry', { ...env, exp: env.exp + 1000 }], ['signature', { ...env, sig: flip(env.sig) }]];
    for (const [what, tampered] of cases) expect(await why(open(tampered, ctx, computerKey, phone.pub.sign, NOW)), what).toBe('bad-signature');
  });

  it('is refused if signed by any key but the trusted device\'s, even with a perfectly valid encryption', async () => {
    const { phone, phoneKey, computerKey } = await pair();
    const thief = await createIdentity();
    const forged = await seal({ action: 'run.stop' }, meta(), phoneKey, thief.signing.privateKey);
    expect(await why(open(forged, ctx, computerKey, phone.pub.sign, NOW))).toBe('bad-signature');
  });

  it('cannot be read with another pair\'s key, and a signature alone does not make it readable', async () => {
    const { phone, phoneKey } = await pair();
    const other = await pair();
    const env = await seal({ action: 'x' }, meta(), phoneKey, phone.signing.privateKey);
    expect(await why(open(env, ctx, other.computerKey, phone.pub.sign, NOW))).toBe('cannot-decrypt');
  });

  it('is refused for another computer, another account or another device', async () => {
    const { phone, phoneKey, computerKey } = await pair();
    const env = await seal({ action: 'x' }, meta(), phoneKey, phone.signing.privateKey);
    for (const wrong of [{ ...ctx, cid: 'c2' }, { ...ctx, uid: 'u2' }, { ...ctx, did: 'd2' }]) expect(await why(open(env, wrong, computerKey, phone.pub.sign, NOW))).toBe('wrong-recipient');
  });

  it('is refused after it expires, before it was made, and if it claims to live longer than ten minutes', async () => {
    const { phone, phoneKey, computerKey } = await pair();
    const env = await seal({ action: 'x' }, meta(), phoneKey, phone.signing.privateKey);
    expect(await why(open(env, ctx, computerKey, phone.pub.sign, NOW + 61_000))).toBe('expired');
    expect(await why(open(env, ctx, computerKey, phone.pub.sign, NOW - 5 * 60_000))).toBe('from-the-future');
    expect(await why(open(env, ctx, computerKey, phone.pub.sign, NOW - 60_000))).toBe('ok');
    await expect(seal({ action: 'x' }, meta({ exp: NOW + 11 * 60_000 }), phoneKey, phone.signing.privateKey)).rejects.toThrow(/ten minutes/);
    await expect(seal({ action: 'x' }, meta({ exp: NOW }), phoneKey, phone.signing.privateKey)).rejects.toThrow(/ten minutes/);
  });

  it('is refused if its structure is wrong, and a huge message is refused before it is sent', async () => {
    const { phone, phoneKey, computerKey } = await pair();
    const env = await seal({ action: 'x' }, meta(), phoneKey, phone.signing.privateKey);
    for (const bad of [{ ...env, v: 2 }, { ...env, ct: '' }, { ...env, ctr: -1 }, { ...env, ctr: 1.5 }, { ...env, iat: NaN }, { ...env, kind: undefined as unknown as string }]) expect(await why(open(bad as Envelope, ctx, computerKey, phone.pub.sign, NOW))).toBe('malformed');
    await expect(seal({ blob: 'x'.repeat(200_000) }, meta(), phoneKey, phone.signing.privateKey)).rejects.toThrow(/too large/);
  });
});

describe('a snapshot read after it has expired', () => {
  it('can be shown as the last known state, but only if it is genuine, and never as a command', async () => {
    const { phone, computer, phoneKey, computerKey } = await pair();
    const snap = await seal({ generatedAt: 'then', phases: [] }, meta({ kind: 'snapshot', ctr: 0, rid: 'proj1', exp: NOW + 60_000 }), computerKey, computer.signing.privateKey);
    expect(await why(open(snap, ctx, phoneKey, computer.pub.sign, NOW + 3_600_000))).toBe('expired');
    expect(await open(snap, ctx, phoneKey, computer.pub.sign, NOW + 3_600_000, { allowExpired: true })).toEqual({ generatedAt: 'then', phases: [] });
    // Still refused when forged, tampered with, or dated in the future.
    const forged = await seal({ generatedAt: 'now' }, meta({ kind: 'snapshot', ctr: 0, rid: 'proj1' }), phoneKey, phone.signing.privateKey);
    expect(await why(open(forged, ctx, phoneKey, computer.pub.sign, NOW + 3_600_000, { allowExpired: true }))).toBe('bad-signature');
    expect(await why(open({ ...snap, ct: snap.ct.slice(0, 5) + (snap.ct[5] === 'A' ? 'B' : 'A') + snap.ct.slice(6) }, ctx, phoneKey, computer.pub.sign, NOW, { allowExpired: true }))).toBe('bad-signature');
    expect(await why(open(snap, ctx, phoneKey, computer.pub.sign, NOW - 10 * 60_000, { allowExpired: true }))).toBe('from-the-future');
  });
});

describe('a response from a computer to a phone', () => {
  it('is signed by the computer and unreadable to anyone else, and cannot be passed off by a phone', async () => {
    const { phone, computer, phoneKey, computerKey } = await pair();
    const res = await seal({ ok: true, result: { status: 'running' } }, meta({ kind: 'response', ctr: 0, rid: 'req-1' }), computerKey, computer.signing.privateKey);
    expect(await open(res, ctx, phoneKey, computer.pub.sign, NOW)).toEqual({ ok: true, result: { status: 'running' } });
    const fake = await seal({ ok: true }, meta({ kind: 'response', ctr: 0, rid: 'req-1' }), phoneKey, phone.signing.privateKey);
    expect(await why(open(fake, ctx, phoneKey, computer.pub.sign, NOW))).toBe('bad-signature');
  });
});

describe('identities and fingerprints', () => {
  it('a fingerprint is stable, depends on both keys, and differs between identities', async () => {
    const a = await createIdentity(); const b = await createIdentity();
    expect(await fingerprint(a.pub)).toBe(await fingerprint(a.pub));
    expect(await fingerprint(a.pub)).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
    expect(await fingerprint(a.pub)).not.toBe(await fingerprint(b.pub));
    expect(await fingerprint({ ...a.pub, agree: b.pub.agree })).not.toBe(await fingerprint(a.pub));
  });
  it('a stored identity works the same after it is saved and loaded, and a phone\'s keys can be kept unreadable', async () => {
    const original = await createIdentity(true);
    const stored = await exportIdentity(original);
    const again = await importIdentity(JSON.parse(JSON.stringify(stored)));
    const peer = await createIdentity();
    const k2 = await pairKey(again, peer.pub.agree, ctx);
    const peerKey = await pairKey(peer, original.pub.agree, ctx);
    const env = await seal({ a: 1 }, meta(), k2, again.signing.privateKey);
    expect(await open(env, ctx, peerKey, original.pub.sign, NOW)).toEqual({ a: 1 });
    const locked = await createIdentity(false);
    await expect(exportIdentity(locked)).rejects.toThrow();
  });
});
