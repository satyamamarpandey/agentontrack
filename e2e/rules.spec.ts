// The phone-link Firestore rules, against the Firebase EMULATOR, with two separate accounts, each with its own computer principal.
// This tests what the rules refuse (the content is sealed by keys Firestore never sees, so the rules only keep accounts and roles apart and bound size and lifetime).
// It says nothing about a real Firebase project: the same rules still need to be deployed and checked there by the owner.
import { expect, test } from '@playwright/test';
import { grantMembership } from './emulator-helpers';

const PROJECT = 'demo-agentontrack';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const STORE = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const DOCS = `http://${STORE}/v1/${DB}`;

test.skip(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Needs the Firebase emulators.');
test.describe.configure({ mode: 'serial' });

interface Who { token: string; uid: string }
const signUp = async (email: string): Promise<Who> => {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'not-a-secret-1', returnSecureToken: true }) });
  expect(r.status).toBe(200);
  const b = await r.json() as { idToken: string; localId: string };
  return { token: b.idToken, uid: b.localId };
};

const val = (v: unknown): object => typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, val(x)])) } };
const fieldsOf = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]));

/** A write, with server-time fields where the rules ask for request.time. */
const write = (who: Who | null, path: string, data: Record<string, unknown>, serverTime: string[] = [], mask?: string[]) => fetch(`${DOCS}:commit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) },
  body: JSON.stringify({ writes: [{ update: { name: `${DB}/${path}`, fields: fieldsOf(data) }, ...(mask ? { updateMask: { fieldPaths: mask } } : {}), updateTransforms: serverTime.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }] }),
});
const read = (who: Who | null, path: string) => fetch(`${DOCS}/${path}`, { headers: who ? { authorization: `Bearer ${who.token}` } : {} });
const del = (who: Who, path: string) => fetch(`${DOCS}/${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${who.token}` } });

const PUB = { sign: 'c2lnbi1wdWI', agree: 'YWdyZWUtcHVi' };
const envelope = (uid: string, cid: string, rid: string, over: Record<string, unknown> = {}) => {
  const iat = Date.now();
  return { v: 1, uid, cid, did: 'dev1', rid, kind: 'request', ctr: 1, iat, exp: iat + 300_000, iv: 'aXY', ct: 'Y2lwaGVydGV4dA', sig: 'c2ln', ...over };
};

let alice: Who; let aliceComputer: Who; let bob: Who; let bobComputer: Who;
const A = () => `users/${alice.uid}/computers/c1`;

test.beforeAll(async () => {
  alice = await signUp('alice@example.com'); aliceComputer = await signUp('computer-a@agentontrack.invalid');
  bob = await signUp('bob@example.com'); bobComputer = await signUp('computer-b@agentontrack.invalid');
  // Early access: a person's account documents exist only while they are a member. The computers' limited accounts are not members and need not be.
  await grantMembership('alice@example.com');
  await grantMembership('bob@example.com');
});

test('a person who is not a member has no account documents at all, and a revoked member loses theirs', async () => {
  const carol = await signUp('carol@example.com');
  const doc = { name: 'Carol laptop', computerUid: aliceComputer.uid, pub: PUB, fingerprint: 'EEEE' };
  expect((await write(carol, `users/${carol.uid}/computers/c1`, doc, ['createdAt'])).status, 'not a member').toBe(403);
  expect((await write(carol, `users/${carol.uid}`, { profile: { name: 'Carol', email: 'carol@example.com' } }, ['updatedAt'])).status, 'not a member: profile').toBe(403);
  await grantMembership('carol@example.com');
  expect((await write(carol, `users/${carol.uid}`, { profile: { name: 'Carol', email: 'carol@example.com' } }, ['updatedAt'])).status, 'member: profile').toBe(200);
  await grantMembership('carol@example.com', { status: 'revoked' });
  expect((await read(carol, `users/${carol.uid}`)).status, 'revoked: read').toBe(403);
  expect((await write(carol, `users/${carol.uid}/computers/c1`, doc, ['createdAt'])).status, 'revoked: link a computer').toBe(403);
});

test('a computer record is made by its owner only, with its key fixed afterwards', async () => {
  const doc = { name: 'Alice laptop', computerUid: aliceComputer.uid, pub: PUB, fingerprint: 'AAAA-BBBB-CCCC' };
  expect((await write(bob, A(), doc, ['createdAt'])).status, 'another account').toBe(403);
  expect((await write(null, A(), doc, ['createdAt'])).status, 'signed out').toBe(403);
  expect((await write(alice, A(), { ...doc, extra: 'x' }, ['createdAt'])).status, 'extra field').toBe(403);
  expect((await write(alice, A(), { ...doc, pub: { sign: 'x', agree: 'y', more: 'z' } }, ['createdAt'])).status, 'bad key shape').toBe(403);
  expect((await write(alice, A(), doc, ['createdAt'])).status, 'owner').toBe(200);
  expect((await write(alice, A(), { name: 'Renamed' }, [], ['name'])).status, 'rename').toBe(200);
  expect((await write(alice, A(), { computerUid: bobComputer.uid }, [], ['computerUid'])).status, 'swap the computer principal').toBe(403);
  expect((await write(alice, A(), { pub: { sign: 'evil', agree: 'evil' } }, [], ['pub'])).status, 'swap the key').toBe(403);
  expect((await read(alice, A())).status).toBe(200);
  expect((await read(aliceComputer, A())).status, 'its own computer').toBe(200);
  expect((await read(bob, A())).status, 'another account').toBe(403);
  expect((await read(bobComputer, A())).status, 'another account\'s computer').toBe(403);
  await write(bob, `users/${bob.uid}/computers/c1`, { name: 'Bob', computerUid: bobComputer.uid, pub: PUB, fingerprint: 'DDDD' }, ['createdAt']);
});

test('a phone asks to be trusted, and neither it nor another account can grant itself trust', async () => {
  const d = (over: Record<string, unknown> = {}) => ({ name: 'Pixel', pub: PUB, status: 'pending', ...over });
  expect((await write(alice, `${A()}/devices/p1`, d({ status: 'trusted' }), ['createdAt'])).status, 'born trusted').toBe(403);
  expect((await write(alice, `${A()}/devices/p1`, d({ role: 'admin' }), ['createdAt'])).status, 'extra field').toBe(403);
  expect((await write(bob, `${A()}/devices/p1`, d(), ['createdAt'])).status, 'another account').toBe(403);
  expect((await write(aliceComputer, `${A()}/devices/p1`, d(), ['createdAt'])).status, 'the computer cannot invent a phone').toBe(403);
  expect((await write(alice, `${A()}/devices/p1`, d(), ['createdAt'])).status, 'owner asks').toBe(200);
  expect((await write(alice, `${A()}/devices/p2`, d({ name: 'Second phone' }), ['createdAt'])).status, 'a second device').toBe(200);
  expect((await write(alice, `${A()}/devices/p1`, { status: 'trusted' }, [], ['status'])).status, 'the phone approves itself').toBe(403);
  expect((await write(bobComputer, `${A()}/devices/p1`, { status: 'trusted' }, [], ['status'])).status, 'another account\'s computer').toBe(403);
  expect((await write(aliceComputer, `${A()}/devices/p1`, { status: 'admin' }, [], ['status'])).status, 'a made-up status').toBe(403);
  expect((await write(aliceComputer, `${A()}/devices/p1`, { name: 'renamed' }, [], ['name'])).status, 'other fields').toBe(403);
  expect((await write(aliceComputer, `${A()}/devices/p1`, { status: 'trusted' }, [], ['status'])).status, 'the computer trusts it').toBe(200);
  expect((await write(aliceComputer, `${A()}/devices/p2`, { status: 'revoked' }, [], ['status'])).status, 'and revokes another').toBe(200);
  expect((await read(bob, `${A()}/devices/p1`)).status).toBe(403);
});

test('requests: the owner writes them, bounded in life and shape; no computer and no other account can', async () => {
  const path = (rid: string) => `${A()}/requests/${rid}`;
  expect((await write(alice, path('r1'), envelope(alice.uid, 'c1', 'r1'))).status, 'valid').toBe(200);
  expect((await write(aliceComputer, path('r2'), envelope(alice.uid, 'c1', 'r2'))).status, 'the computer cannot write requests').toBe(403);
  expect((await write(bob, path('r3'), envelope(alice.uid, 'c1', 'r3'))).status, 'another account').toBe(403);
  expect((await write(alice, path('r4'), envelope(alice.uid, 'c1', 'r4', { exp: Date.now() + 3_600_000 }))).status, 'lives over ten minutes').toBe(403);
  expect((await write(alice, path('r5'), envelope(alice.uid, 'c1', 'r5', { iat: Date.now() - 600_000, exp: Date.now() - 60_000 }))).status, 'already expired').toBe(403);
  expect((await write(alice, path('r6'), envelope(alice.uid, 'c1', 'other-id'))).status, 'id does not match the document').toBe(403);
  expect((await write(alice, path('r7'), envelope(alice.uid, 'c1', 'r7', { iat: Date.now() + 3_600_000, exp: Date.now() + 3_900_000 }))).status, 'dated far ahead').toBe(403);
  expect((await write(alice, path('r8'), envelope(alice.uid, 'c1', 'r8', { cid: 'someone-elses' }))).status, 'names another computer').toBe(403);
  expect((await write(alice, path('r9'), envelope(alice.uid, 'c1', 'r9', { extra: 'x' }))).status, 'extra field').toBe(403);
  expect((await write(alice, path('r10'), envelope(alice.uid, 'c1', 'r10', { ct: 'A'.repeat(300_000) }))).status, 'too large').toBe(403);
  expect((await read(aliceComputer, path('r1'))).status, 'the computer reads it').toBe(200);
  expect((await read(bob, path('r1'))).status, 'another account').toBe(403);
  expect((await read(bobComputer, path('r1'))).status, 'another account\'s computer').toBe(403);
});

test('responses, snapshots and presence: only the computer writes them, and only within bounds', async () => {
  const resp = `${A()}/responses/r1`;
  expect((await write(alice, resp, envelope(alice.uid, 'c1', 'r1', { kind: 'response' }))).status, 'the phone cannot forge an answer').toBe(403);
  expect((await write(bob, resp, envelope(alice.uid, 'c1', 'r1', { kind: 'response' }))).status, 'another account').toBe(403);
  expect((await write(bobComputer, resp, envelope(alice.uid, 'c1', 'r1', { kind: 'response' }))).status, 'another account\'s computer').toBe(403);
  expect((await write(aliceComputer, resp, envelope(alice.uid, 'c1', 'r1', { kind: 'response' }))).status, 'the computer').toBe(200);
  expect((await read(alice, resp)).status).toBe(200);
  expect((await read(bob, resp)).status).toBe(403);

  const snap = (who: Who, extra: Record<string, unknown> = {}) => write(who, `${A()}/snapshots/p1__abc`, envelope(alice.uid, 'c1', 'snap', { kind: 'snapshot', ...extra }));
  expect((await snap(alice)).status, 'the phone cannot forge a snapshot').toBe(403);
  expect((await snap(aliceComputer, { uid: bob.uid })).status, 'names another account').toBe(403);
  expect((await snap(aliceComputer, { extra: 'x' })).status, 'extra field').toBe(403);
  expect((await snap(aliceComputer)).status, 'the computer').toBe(200);
  expect((await read(alice, `${A()}/snapshots/p1__abc`)).status).toBe(200);
  expect((await read(bob, `${A()}/snapshots/p1__abc`)).status).toBe(403);

  const presence = (who: Who, serverTime: string[]) => write(who, `${A()}/presence/main`, { version: 'x', ...(serverTime.length ? {} : { lastSeen: 0 }) }, serverTime.length ? ['lastSeen'] : []);
  expect((await presence(alice, ['lastSeen'])).status, 'the phone cannot say the computer is online').toBe(403);
  expect((await presence(aliceComputer, [])).status, 'a made-up time').toBe(403);
  expect((await presence(aliceComputer, ['lastSeen'])).status, 'server time').toBe(200);
  expect((await read(alice, `${A()}/presence/main`)).status).toBe(200);
  expect((await read(bob, `${A()}/presence/main`)).status).toBe(403);
});

test('two accounts stay apart, an owner can delete everything, and removing a computer cuts off its principal', async () => {
  const B = `users/${bob.uid}/computers/c1`;
  expect((await read(alice, B)).status, 'alice reads bob').toBe(403);
  expect((await write(alice, `${B}/requests/x1`, envelope(bob.uid, 'c1', 'x1'))).status, 'alice writes into bob').toBe(403);
  expect((await write(aliceComputer, `${B}/responses/x1`, envelope(bob.uid, 'c1', 'x1', { kind: 'response' }))).status, 'alice\'s computer writes into bob').toBe(403);
  expect((await write(bobComputer, `${B}/responses/x1`, envelope(bob.uid, 'c1', 'x1', { kind: 'response' }))).status, 'bob\'s own computer').toBe(200);
  expect((await del(bob, `${A()}/requests/r1`)).status, 'bob deletes alice\'s request').toBe(403);
  expect((await del(alice, `${A()}/requests/r1`)).status, 'alice deletes her request').toBe(200);
  for (const sub of ['devices/p1', 'devices/p2', 'responses/r1', 'snapshots/p1__abc', 'presence/main']) expect((await del(alice, `${A()}/${sub}`)).status, sub).toBe(200);
  expect((await del(alice, A())).status, 'the computer record').toBe(200);
  // With the record gone, the computer principal has nothing it may write or read.
  expect((await write(aliceComputer, `${A()}/presence/main`, { version: 'x' }, ['lastSeen'])).status, 'after removal').toBe(403);
  expect((await read(aliceComputer, `${A()}/devices/p1`)).status, 'after removal').toBe(403);
});
