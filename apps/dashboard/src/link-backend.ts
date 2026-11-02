// Desktop side of the phone link, in the browser: the signed-in person makes the computer's own limited account and registers its key.
// Loaded only when someone presses the button, and only in a build with accounts.
import { deleteApp, getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import { protect } from './app-check';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, indexedDBLocalPersistence, initializeAuth, signOut } from 'firebase/auth';
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDocs, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

const EMULATORS = import.meta.env.VITE_FIREBASE_EMULATORS === '1';

function primary(config: string) {
  const fresh = getApps().length === 0;
  const opts = JSON.parse(config) as FirebaseOptions;
  const app = fresh ? initializeApp(opts) : getApp();
  if (fresh) protect(app, EMULATORS);
  const auth = fresh ? initializeAuth(app, { persistence: indexedDBLocalPersistence }) : getAuth(app);
  const db = getFirestore(app);
  if (fresh && EMULATORS) { connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFirestoreEmulator(db, '127.0.0.1', 8080); }
  return { app, auth, db, opts };
}

const random = (n: number) => btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(n)))).replace(/[+/=]/g, 'x');

export async function whoAmI(config: string): Promise<{ uid: string; email: string | null } | null> {
  const { auth } = primary(config);
  await auth.authStateReady();
  return auth.currentUser ? { uid: auth.currentUser.uid, email: auth.currentUser.email } : null;
}

export interface Prepared { computerId: string; name: string; pub: { sign: string; agree: string }; fingerprint: string }
export interface LinkInfo { uid: string; computerUid: string; email: string; password: string; firebase: { apiKey: string; projectId: string; authDomain?: string; appId?: string } }

/**
 * Makes the computer its own account, so what it may write is told apart from what the person's account may write, and records its public key.
 * It signs the new account out again at once: only the companion ever holds that password.
 */
export async function createComputerAccount(config: string, prepared: Prepared): Promise<LinkInfo> {
  const { auth, db, opts } = primary(config);
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in on the account page first.');
  const email = `computer-${prepared.computerId.toLowerCase()}@agentontrack.invalid`;
  const password = random(30);
  const second = initializeApp(opts, `aot-computer-maker-${Date.now()}`);
  try {
    const sa = getAuth(second);
    if (EMULATORS) connectAuthEmulator(sa, 'http://127.0.0.1:9099', { disableWarnings: true });
    const made = await createUserWithEmailAndPassword(sa, email, password);
    await signOut(sa);
    // Linking again replaces an earlier registration of this computer: the old one is removed first, since a registered key never changes.
    await deleteDoc(doc(db, 'users', user.uid, 'computers', prepared.computerId)).catch(() => undefined);
    await setDoc(doc(db, 'users', user.uid, 'computers', prepared.computerId), { name: prepared.name, computerUid: made.user.uid, pub: prepared.pub, fingerprint: prepared.fingerprint, createdAt: serverTimestamp() });
    return { uid: user.uid, computerUid: made.user.uid, email, password, firebase: { apiKey: opts.apiKey!, projectId: opts.projectId!, ...(opts.authDomain ? { authDomain: opts.authDomain } : {}), ...(opts.appId ? { appId: opts.appId } : {}) } };
  } finally { await deleteApp(second).catch(() => undefined); }
}

export async function listMyComputers(config: string): Promise<{ id: string; name: string; fingerprint: string }[]> {
  const { auth, db } = primary(config);
  await auth.authStateReady();
  if (!auth.currentUser) return [];
  const snap = await getDocs(collection(db, 'users', auth.currentUser.uid, 'computers'));
  return snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? ''), fingerprint: String(d.data().fingerprint ?? '') }));
}

export async function forgetComputer(config: string, computerId: string): Promise<void> {
  const { auth, db } = primary(config);
  await auth.authStateReady();
  if (auth.currentUser) await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'computers', computerId));
}
