import type { Envelope, PublicIdentity } from '@agentontrack/remote';

/** The firebase project's public web identifiers, plus, for tests, where the emulators are. */
export interface FirebaseConfig { apiKey: string; projectId: string; authDomain?: string; appId?: string }
export interface Emulators { auth: string; firestoreHost: string; firestorePort: number }
export interface TransportConfig { firebase: FirebaseConfig; uid: string; cid: string; email: string; password: string; emulators?: Emulators }

export interface PendingDevice { did: string; name: string; pub: PublicIdentity; status: string }
export interface TransportEvents {
  onRequest(env: Envelope): void;
  onDevices(list: PendingDevice[]): void;
  onError(e: Error): void;
}

/** The channel the host talks through. Nothing on it has authority: it carries sealed envelopes and little else. */
export interface Transport {
  start(h: TransportEvents): Promise<void>;
  respond(env: Envelope): Promise<void>;
  snapshot(id: string, env: Envelope): Promise<void>;
  removeRequest(rid: string): Promise<void>;
  setDeviceStatus(did: string, status: 'trusted' | 'revoked'): Promise<void>;
  heartbeat(version: string): Promise<void>;
  stop(): Promise<void>;
}

/** Firestore, through the Firebase SDK, signed in as the computer's own limited account, never as the person. */
export class FirestoreTransport implements Transport {
  private unsub: (() => void)[] = [];
  private fs?: typeof import('firebase/firestore');
  private db?: import('firebase/firestore').Firestore;
  private app?: import('firebase/app').FirebaseApp;
  constructor(private cfg: TransportConfig) {}

  private col(...path: string[]) { return this.fs!.collection(this.db!, 'users', this.cfg.uid, 'computers', this.cfg.cid, ...path); }
  private ref(...path: string[]) { return this.fs!.doc(this.db!, 'users', this.cfg.uid, 'computers', this.cfg.cid, ...path); }

  async start(h: TransportEvents): Promise<void> {
    const [{ initializeApp, getApps, deleteApp }, auth, fs] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
    this.fs = fs;
    const name = `aot-computer-${this.cfg.cid}`;
    for (const a of getApps()) if (a.name === name) await deleteApp(a);
    this.app = initializeApp(this.cfg.firebase, name);
    const a = auth.getAuth(this.app);
    if (this.cfg.emulators) auth.connectAuthEmulator(a, this.cfg.emulators.auth, { disableWarnings: true });
    await auth.signInWithEmailAndPassword(a, this.cfg.email, this.cfg.password);
    this.db = fs.getFirestore(this.app);
    if (this.cfg.emulators) fs.connectFirestoreEmulator(this.db, this.cfg.emulators.firestoreHost, this.cfg.emulators.firestorePort);
    // Requests are read as they appear. Only what is still alive is handed on, and the host does the real checking.
    this.unsub.push(fs.onSnapshot(this.col('requests'), (snap) => {
      for (const c of snap.docChanges()) if (c.type !== 'removed') h.onRequest(c.doc.data() as Envelope);
    }, (e) => h.onError(e)));
    this.unsub.push(fs.onSnapshot(this.col('devices'), (snap) => {
      h.onDevices(snap.docs.map((d) => ({ did: d.id, name: String(d.data().name ?? ''), pub: d.data().pub as PublicIdentity, status: String(d.data().status ?? '') })));
    }, (e) => h.onError(e)));
  }

  async respond(env: Envelope) { await this.fs!.setDoc(this.ref('responses', env.rid), { ...env, expireAt: new Date(env.exp + 3_600_000) }); }
  async snapshot(id: string, env: Envelope) { await this.fs!.setDoc(this.ref('snapshots', id), env); }
  async removeRequest(rid: string) { await this.fs!.deleteDoc(this.ref('requests', rid)); }
  async setDeviceStatus(did: string, status: 'trusted' | 'revoked') { await this.fs!.updateDoc(this.ref('devices', did), { status }); }
  async heartbeat(version: string) { await this.fs!.setDoc(this.ref('presence', 'main'), { lastSeen: this.fs!.serverTimestamp(), version }); }

  async stop() {
    for (const u of this.unsub.splice(0)) { try { u(); } catch { /* already closed */ } }
    try { if (this.fs && this.db) await this.fs.terminate(this.db); } catch { /* closing */ }
    try { const { deleteApp } = await import('firebase/app'); if (this.app) await deleteApp(this.app); } catch { /* closing */ }
  }
}
