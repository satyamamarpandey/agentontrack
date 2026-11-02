// The desktop side of the phone link: who is believed, what is run once, and what is never run. Real keys and real signatures are used on
// both ends. The executor is a recorder, so this tests the decisions the host makes before anything runs. Firestore, and the actions
// themselves, are tested in remote-actions.test.ts and in the emulator job.
import { beforeEach, describe, expect, it } from 'vitest';
import { createIdentity, newId, open, pairKey, seal, type Envelope, type Identity } from '@agentontrack/remote';
import { newRemoteFile, RemoteHost, Refusal, type RemoteFile } from '../src/remote-host.js';

const UID = 'user-1';
let T = 1_800_000_000_000;
let host: RemoteHost; let file: RemoteFile;
let ran: { action: string; params: unknown; did: string }[];
let phone: Identity; let did: string;
let key: CryptoKey; let ctr: number;

beforeEach(async () => {
  T = 1_800_000_000_000;
  ran = [];
  file = await newRemoteFile('My laptop');
  file.link = { uid: UID, firebase: { apiKey: 'k', projectId: 'p' }, computer: { email: 'c@x.invalid', password: 'x' }, linkedAt: 'now' };
  host = await new RemoteHost(file, async (action, params, ctx) => {
    ran.push({ action, params, did: ctx.did });
    if (action === 'plan.continue') throw new Refusal('plan-limit', 'The plan has used its runs.');
    return { done: action };
  }, () => undefined, () => T).init();
  phone = await createIdentity();
  did = 'phone-1';
  await host.trust(did, 'My phone', phone.pub, 'control');
  key = await pairKey(phone, host.pub.agree, { uid: UID, cid: file.computerId, did });
  ctr = 0;
});

const ask = async (action: string, params: unknown = {}, over: { ctr?: number; rid?: string; iat?: number; exp?: number; sign?: Identity; did?: string } = {}): Promise<Envelope> => seal({ action, params }, { v: 1, uid: UID, cid: file.computerId, did: over.did ?? did, rid: over.rid ?? newId(), kind: 'request', ctr: over.ctr ?? ++ctr, iat: over.iat ?? T, exp: over.exp ?? T + 120_000 }, key, (over.sign ?? phone).signing.privateKey);
const answer = async (env: Envelope | null) => (env ? open<{ ok: boolean; result?: any; code?: string; message?: string }>(env, { uid: UID, cid: file.computerId, did }, key, host.pub.sign, T) : null);

describe('a request from a trusted phone', () => {
  it('is run, and the answer is signed by the computer and readable only by that phone', async () => {
    const out = await answer(await host.handle(await ask('projects.list')));
    expect(out).toEqual({ ok: true, result: { done: 'projects.list' } });
    expect(ran).toEqual([{ action: 'projects.list', params: {}, did }]);
  });

  it('is run once, however many times Firestore delivers it, and always gets the same answer', async () => {
    const env = await ask('run.stop', { runId: 'run_1' });
    const first = await host.handle(env);
    const again = await host.handle(env);
    const third = await host.handle(structuredClone(env));
    expect(again).toEqual(first);
    expect(third).toEqual(first);
    expect(ran).toHaveLength(1);
  });

  it('is run once even when two copies arrive at the same moment', async () => {
    const env = await ask('run.stop');
    const [a, b] = await Promise.all([host.handle(env), host.handle(env)]);
    expect(a).toEqual(b);
    expect(ran).toHaveLength(1);
  });

  it('cannot be replayed under a new id with an old counter', async () => {
    await host.handle(await ask('ping', {}, { ctr: 5 }));
    const old = await answer(await host.handle(await ask('run.stop', {}, { ctr: 5 })));
    expect(old).toMatchObject({ ok: false, code: 'replayed' });
    const older = await answer(await host.handle(await ask('run.stop', {}, { ctr: 3 })));
    expect(older).toMatchObject({ ok: false, code: 'replayed' });
    expect(ran.map((r) => r.action)).toEqual(['ping']);
  });

  it('is refused once expired, with a reason, and runs nothing', async () => {
    const env = await ask('run.stop', {}, { exp: T + 60_000 });
    T += 61_000;
    expect(await answer(await host.handle(env))).toMatchObject({ ok: false, code: 'expired' });
    expect(ran).toEqual([]);
  });

  it('is refused if it names an action a phone cannot ask for', async () => {
    for (const bad of ['shell.exec', 'file.write', 'project.create', 'policy.set', 'goal.set', 'team.set', 'plan.approve', 'deploy', '']) {
      expect(await answer(await host.handle(await ask(bad))), bad).toMatchObject({ ok: false, code: expect.stringMatching(/unknown-action|malformed/) });
    }
    expect(ran).toEqual([]);
  });

  it('turns the executor\'s refusal into a plain answer, and does not hide it', async () => {
    expect(await answer(await host.handle(await ask('plan.continue')))).toEqual({ ok: false, code: 'plan-limit', message: 'The plan has used its runs.' });
  });
});

describe('who is believed', () => {
  it('a phone that was never approved gets no answer and runs nothing, even with a valid signature of its own', async () => {
    const stranger = await createIdentity();
    const strangerKey = await pairKey(stranger, host.pub.agree, { uid: UID, cid: file.computerId, did: 'stranger' });
    const env = await seal({ action: 'run.stop', params: {} }, { v: 1, uid: UID, cid: file.computerId, did: 'stranger', rid: newId(), kind: 'request', ctr: 1, iat: T, exp: T + 60_000 }, strangerKey, stranger.signing.privateKey);
    expect(await host.handle(env)).toBeNull();
    expect(ran).toEqual([]);
  });

  it('a message signed with the wrong key, using a trusted phone\'s id, gets no answer', async () => {
    const thief = await createIdentity();
    expect(await host.handle(await ask('run.stop', {}, { sign: thief }))).toBeNull();
    expect(ran).toEqual([]);
  });

  it('a revoked phone stops being believed at once, and its earlier answers are forgotten', async () => {
    await host.handle(await ask('ping'));
    expect(host.revoke(did)).toBe(true);
    expect(await host.handle(await ask('ping'))).toBeNull();
    expect(host.state.cache.filter((c) => c.did === did)).toEqual([]);
    expect(host.revoke(did)).toBe(false);
    expect(ran).toHaveLength(1);
  });

  it('a phone approved only to look cannot control, and can still look', async () => {
    host.setLevel(did, 'view');
    expect(await answer(await host.handle(await ask('run.stop')))).toMatchObject({ ok: false, code: 'view-only' });
    expect(await answer(await host.handle(await ask('project.snapshot')))).toMatchObject({ ok: true });
    expect(ran.map((r) => r.action)).toEqual(['project.snapshot']);
  });

  it('only the desktop can add a phone, at most five at a time', async () => {
    for (let i = 0; i < 4; i++) await host.trust(`extra-${i}`, 'x', (await createIdentity()).pub, 'view');
    await expect(host.trust('one-too-many', 'x', (await createIdentity()).pub, 'view')).rejects.toThrow(/At most 5/);
    host.revoke('extra-0');
    await expect(host.trust('one-too-many', 'x', (await createIdentity()).pub, 'view')).resolves.toBeTruthy();
  });

  it('keeps its state across a restart, including who is trusted and what it already did', async () => {
    const env = await ask('run.stop');
    await host.handle(env);
    const saved = JSON.parse(JSON.stringify(host.state)) as RemoteFile;
    const reopened = await new RemoteHost(saved, async (a) => { ran.push({ action: a, params: null, did }); return {}; }, () => undefined, () => T).init();
    expect(reopened.pub).toEqual(host.pub);
    await reopened.handle(env);
    expect(ran).toHaveLength(1);
  });
});
