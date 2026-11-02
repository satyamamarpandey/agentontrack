// The phone's half of the link. Loaded only on the phone screens, and only in a build with accounts.
import { getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, indexedDBLocalPersistence, initializeAuth, signOut as fbSignOut } from 'firebase/auth';
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDocs, getFirestore, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { createIdentity, fingerprint, newId, open, pairKey, seal, snapshotKey, type Envelope, type Identity, type PublicIdentity } from '@agentontrack/remote';

const EMULATORS = import.meta.env.VITE_FIREBASE_EMULATORS === '1';

/* ---------- Where the device's keys live ---------- */
const kv = (() => {
  let db: Promise<IDBDatabase> | null = null;
  const open_ = () => (db ??= new Promise((ok, fail) => { const r = indexedDB.open('aot-mobile', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); }));
  const run = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => { const d = await open_(); return new Promise((ok, fail) => { const r = fn(d.transaction('kv', mode).objectStore('kv')); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); }); };
  return { get: <T,>(k: string) => run<T | undefined>('readonly', (s) => s.get(k)), set: (k: string, v: unknown) => run('readwrite', (s) => s.put(v, k)), del: (k: string) => run('readwrite', (s) => s.delete(k)) };
})();

interface StoredDevice { did: string; name: string; identity: Identity; fingerprint: string }
import { RemoteError } from './remote-error';
export { RemoteError };
export interface ComputerRow { id: string; name: string; fingerprint: string; pub: PublicIdentity }
export type DeviceStatus = 'none' | 'pending' | 'trusted' | 'revoked';
export interface Snapshot<T = any> { body: T; generatedAt: string; stale: boolean }

export async function openBackend(config: string) {
  const fresh = getApps().length === 0;
  const opts = JSON.parse(config) as FirebaseOptions;
  const app = fresh ? initializeApp(opts) : getApp();
  const auth = fresh ? initializeAuth(app, { persistence: indexedDBLocalPersistence }) : getAuth(app);
  const db = getFirestore(app);
  if (fresh && EMULATORS) { connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFirestoreEmulator(db, '127.0.0.1', 8080); }
  await auth.authStateReady();

  const uid = () => { if (!auth.currentUser) throw new RemoteError('signed-out', 'Sign in first.'); return auth.currentUser.uid; };
  const cdoc = (cid: string, ...p: string[]) => doc(db, 'users', uid(), 'computers', cid, ...p);

  const device = async (): Promise<StoredDevice> => {
    let d = await kv.get<StoredDevice>('device');
    if (!d) {
      const identity = await createIdentity(false);
      const ua = navigator.userAgent;
      d = { did: newId(9).replace(/[^A-Za-z0-9]/g, 'x'), name: /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : 'This device', identity, fingerprint: await fingerprint(identity.pub) };
      await kv.set('device', d);
    }
    return d;
  };

  const pinned = (cid: string) => kv.get<PublicIdentity>(`pin:${cid}`);
  const nextCtr = async (cid: string) => { const last = (await kv.get<number>(`ctr:${cid}`)) ?? 0; const n = Math.max(last + 1, Date.now()); await kv.set(`ctr:${cid}`, n); return n; };
  const keyFor = async (cid: string, theirs: PublicIdentity) => { const d = await device(); return pairKey(d.identity, theirs.agree, { uid: uid(), cid, did: d.did }); };

  return {
    user: () => (auth.currentUser ? { uid: auth.currentUser.uid, email: auth.currentUser.email } : null),
    signOut: async () => { await fbSignOut(auth); },
    device,
    rename: async (name: string) => { const d = await device(); d.name = name.slice(0, 60); await kv.set('device', d); },

    async computers(): Promise<ComputerRow[]> {
      const snap = await getDocs(collection(db, 'users', uid(), 'computers'));
      return snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? ''), fingerprint: String(d.data().fingerprint ?? ''), pub: d.data().pub as PublicIdentity }));
    },
    pinned,
    /** The person has compared this computer's fingerprint with the one on its screen, so its key is remembered, and changes to it are refused. */
    async pin(cid: string, pub: PublicIdentity) { await kv.set(`pin:${cid}`, pub); },
    async forget(cid: string) { await kv.del(`pin:${cid}`); await kv.del(`ctr:${cid}`); await deleteDoc(cdoc(cid, 'devices', (await device()).did)).catch(() => undefined); },

    async askToConnect(cid: string) {
      const d = await device();
      await setDoc(cdoc(cid, 'devices', d.did), { name: d.name, pub: d.identity.pub, status: 'pending', createdAt: serverTimestamp() });
    },
    watchDevice(cid: string, cb: (s: DeviceStatus) => void): () => void {
      let stop = () => undefined as void;
      void device().then((d) => { stop = onSnapshot(cdoc(cid, 'devices', d.did), (s) => cb(!s.exists() ? 'none' : (s.data()!.status as DeviceStatus)), () => cb('none')); });
      return () => stop();
    },
    watchPresence(cid: string, cb: (lastSeen: number | null) => void): () => void {
      return onSnapshot(cdoc(cid, 'presence', 'main'), (s) => cb(s.exists() ? (s.data()!.lastSeen?.toMillis?.() ?? null) : null), () => cb(null));
    },

    /** The latest snapshot, shown at once from what is stored if the network is slow, and replaced by what the computer last wrote. */
    watchSnapshot<T = any>(cid: string, name: string, cb: (s: Snapshot<T> | null) => void): () => void {
      let off = false;
      const show = async (env: Envelope, fromCache: boolean) => {
        const pin = await pinned(cid);
        if (!pin || off) return;
        try {
          const d = await device();
          const body = await open<any>(env, { uid: uid(), cid, did: d.did }, await keyFor(cid, pin), pin.sign, Date.now(), { allowExpired: true });
          if (!off) cb({ body, generatedAt: String(body.generatedAt ?? ''), stale: fromCache });
          if (!fromCache) await kv.set(`snap:${cid}:${name}`, env);
        } catch { if (!off) cb(null); }
      };
      void (async () => { const c = await kv.get<Envelope>(`snap:${cid}:${name}`); if (c) await show(c, true); })();
      let stop = () => undefined as void;
      void device().then(async (d) => { stop = onSnapshot(cdoc(cid, 'snapshots', `${d.did}__${name}`), (s) => { if (s.exists()) void show(s.data() as Envelope, false); }, () => undefined); });
      return () => { off = true; stop(); };
    },
    snapshotKey: (cid: string, projectId: string) => snapshotKey(cid, projectId),

    /** Sends one request to a computer and waits for its signed answer. A computer that is off, or that refuses, is said plainly. */
    async call<T = any>(cid: string, action: string, params: object = {}, waitMs = 60_000): Promise<T> {
      const pin = await pinned(cid);
      if (!pin) throw new RemoteError('not-trusted', 'This computer is not connected yet.');
      const d = await device();
      const key = await keyFor(cid, pin);
      const rid = newId();
      const iat = Date.now();
      const env = await seal({ action, params }, { v: 1, uid: uid(), cid, did: d.did, rid, kind: 'request', ctr: await nextCtr(cid), iat, exp: iat + 5 * 60_000 }, key, d.identity.signing.privateKey);
      const answer = new Promise<T>((ok, fail) => {
        const timer = setTimeout(() => { stop(); fail(new RemoteError('offline', 'The computer did not answer. It may be off, asleep or offline, so nothing was changed.')); }, waitMs);
        const stop = onSnapshot(cdoc(cid, 'responses', rid), (s) => {
          if (!s.exists()) return;
          void open<{ ok: boolean; result?: T; code?: string; message?: string }>(s.data() as Envelope, { uid: uid(), cid, did: d.did }, key, pin.sign).then((r) => {
            clearTimeout(timer); stop();
            void deleteDoc(cdoc(cid, 'responses', rid)).catch(() => undefined);
            if (r.ok) ok(r.result as T); else fail(new RemoteError(r.code ?? 'refused', r.message ?? 'The computer refused.'));
          }).catch(() => undefined);
        }, () => undefined);
      });
      await setDoc(cdoc(cid, 'requests', rid), env);
      return answer;
    },
  };
}
export type Backend = Awaited<ReturnType<typeof openBackend>>;
