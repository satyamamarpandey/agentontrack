// Loaded only through loadAccounts, when someone signs in, sends feedback on a configured site, or was signed in before.
// What this may store is fixed here and in firestore.rules: profile, preferences, feedback, and summaries of counts.
import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, deleteUser, getAuth, GoogleAuthProvider, reauthenticateWithPopup, signInWithPopup, signOut, type User } from 'firebase/auth';
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { SIGNED_IN_FLAG } from './accounts-config';
import type { Feedback } from './feedback';

const EMULATORS = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === '1';

function connect() {
  const fresh = getApps().length === 0;
  const app = fresh ? initializeApp(JSON.parse(process.env.NEXT_PUBLIC_FIREBASE_CONFIG!)) : getApp();
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (fresh && EMULATORS) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return { auth, db };
}

export interface AccountData {
  profile: { name: string; email: string } | null;
  preferences: { theme: string } | null;
  feedback: { id: string; rating: string | null; message: string; contact?: string }[];
  summaries: { id: string; label: string; totals: Record<string, number>; rates: Record<string, number | null> }[];
}

export async function currentUser(): Promise<User | null> {
  const { auth } = connect();
  await auth.authStateReady();
  if (!auth.currentUser) localStorage.removeItem(SIGNED_IN_FLAG);
  return auth.currentUser;
}

/** Only the name and email from Google are kept. Merging keeps an earlier saved preference. */
export async function signIn(theme: string): Promise<User> {
  const { auth, db } = connect();
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
  await setDoc(doc(db, 'users', user.uid), { profile: { name: (user.displayName ?? '').slice(0, 200), email: user.email ?? '' }, updatedAt: serverTimestamp() }, { merge: true });
  const saved = await getDoc(doc(db, 'users', user.uid));
  if (!saved.data()?.preferences) await savePreferences(user.uid, theme);
  localStorage.setItem(SIGNED_IN_FLAG, '1');
  return user;
}

export async function signOutHere(): Promise<void> {
  await signOut(connect().auth);
  localStorage.removeItem(SIGNED_IN_FLAG);
}

export async function savePreferences(uid: string, theme: string): Promise<void> {
  await setDoc(doc(connect().db, 'users', uid), { preferences: { theme }, updatedAt: serverTimestamp() }, { merge: true });
}

export async function loadData(uid: string): Promise<AccountData> {
  const { db } = connect();
  const [user, feedback, summaries] = await Promise.all([getDoc(doc(db, 'users', uid)), getDocs(collection(db, 'users', uid, 'feedback')), getDocs(collection(db, 'users', uid, 'summaries'))]);
  const u = user.data();
  return {
    profile: u?.profile ?? null,
    preferences: u?.preferences ?? null,
    feedback: feedback.docs.map((d) => ({ id: d.id, rating: d.data().rating, message: d.data().message, ...(d.data().contact ? { contact: d.data().contact } : {}) })),
    summaries: summaries.docs.map((d) => ({ id: d.id, label: d.data().label, totals: d.data().totals, rates: d.data().rates })),
  };
}

/** Anyone may send feedback. If signed in, a copy under their account lets them export and delete it. */
export async function sendFeedback(f: Feedback): Promise<void> {
  const { db, auth } = connect();
  const signedIn = localStorage.getItem(SIGNED_IN_FLAG) === '1';
  if (signedIn) await auth.authStateReady();
  const uid = signedIn ? auth.currentUser?.uid ?? null : null;
  const body = { rating: f.rating, message: f.message, ...(f.contact ? { contact: f.contact } : {}), uid, createdAt: serverTimestamp() };
  const ref = doc(collection(db, 'feedback'));
  if (!uid) { await setDoc(ref, body); return; }
  const batch = writeBatch(db);
  batch.set(ref, body);
  batch.set(doc(db, 'users', uid, 'feedback', ref.id), body);
  await batch.commit();
}

export function downloadData(data: AccountData): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agentontrack-account.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** Removes everything this account stored, then the sign-in itself. Firebase asks for a fresh sign-in first if the last one was long ago. */
export async function deleteEverything(user: User): Promise<void> {
  const { db } = connect();
  const feedback = await getDocs(collection(db, 'users', user.uid, 'feedback'));
  const summaries = await getDocs(collection(db, 'users', user.uid, 'summaries'));
  for (const d of feedback.docs) {
    await deleteDoc(doc(db, 'feedback', d.id));
    await deleteDoc(d.ref);
  }
  for (const d of summaries.docs) await deleteDoc(d.ref);
  await deleteDoc(doc(db, 'users', user.uid));
  try {
    await deleteUser(user);
  } catch (e) {
    if ((e as { code?: string }).code !== 'auth/requires-recent-login') throw e;
    await reauthenticateWithPopup(user, new GoogleAuthProvider());
    await deleteUser(user);
  }
  localStorage.removeItem(SIGNED_IN_FLAG);
}
