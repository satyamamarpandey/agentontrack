// Loaded only through loadAccounts, when someone signs in, sends feedback on a configured site, or was signed in before.
// What this may store is fixed here and in firestore.rules: profile, preferences, feedback, and summaries of counts.
import { getApp, getApps, initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { connectAuthEmulator, createUserWithEmailAndPassword, deleteUser, EmailAuthProvider, getAuth, GithubAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile, type AuthProvider, type User } from 'firebase/auth';
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { SIGNED_IN_FLAG } from './accounts-config';
import type { Feedback } from './feedback';

const EMULATORS = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === '1';
/** A reCAPTCHA v3 site key, public by design. With it, Firebase can refuse feedback and sign-in calls that do not come from this site. Enforcement is switched on by the owner in the Firebase console. */
const APP_CHECK_KEY = process.env.NEXT_PUBLIC_APPCHECK_SITE_KEY;

function connect() {
  const fresh = getApps().length === 0;
  const app = fresh ? initializeApp(JSON.parse(process.env.NEXT_PUBLIC_FIREBASE_CONFIG!)) : getApp();
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (fresh && APP_CHECK_KEY && !EMULATORS) initializeAppCheck(app, { provider: new ReCaptchaV3Provider(APP_CHECK_KEY), isTokenAutoRefreshEnabled: true });
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

export type Method = 'google' | 'github';
const provider = (m: Method): AuthProvider => (m === 'github' ? new GithubAuthProvider() : new GoogleAuthProvider());

/** Records the person's name and email, and keeps an earlier saved preference. No provider token is read or kept. */
async function finish(user: User, theme: string): Promise<User> {
  const { db } = connect();
  await setDoc(doc(db, 'users', user.uid), { profile: { name: (user.displayName ?? '').slice(0, 200), email: user.email ?? '' }, updatedAt: serverTimestamp() }, { merge: true });
  const saved = await getDoc(doc(db, 'users', user.uid));
  if (!saved.data()?.preferences) await savePreferences(user.uid, theme);
  localStorage.setItem(SIGNED_IN_FLAG, '1');
  return user;
}

/** Only the name and email are kept. Merging keeps an earlier saved preference. */
export async function signIn(theme: string, method: Method = 'google'): Promise<User> {
  const { auth } = connect();
  const { user } = await signInWithPopup(auth, provider(method));
  return finish(user, theme);
}

const MESSAGES: Record<string, string> = {
  'auth/email-already-in-use': 'That email already has an account. Sign in instead, or reset the password.',
  'auth/invalid-credential': 'The email or password is not right.',
  'auth/wrong-password': 'The email or password is not right.',
  'auth/user-not-found': 'The email or password is not right.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/invalid-email': 'That does not look like an email address.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes, then try again.',
  'auth/operation-not-allowed': 'This way of signing in is not switched on for this site yet.',
  'auth/account-exists-with-different-credential': 'That email already has an account that signs in another way. Use that way.',
  'auth/popup-closed-by-user': 'The sign-in window was closed before it finished.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.',
};
/** A plain sentence for a Firebase error, and never the raw error code to the person. */
export function explain(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  return MESSAGES[code] ?? (code ? 'Sign-in did not work. Try again in a moment.' : (e as Error)?.message ?? 'Something went wrong.');
}

export async function emailSignUp(name: string, email: string, password: string, theme: string): Promise<User> {
  const { auth } = connect();
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  if (name.trim()) await updateProfile(user, { displayName: name.trim().slice(0, 200) });
  return finish(user, theme);
}

export async function emailSignIn(email: string, password: string, theme: string): Promise<User> {
  const { auth } = connect();
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return finish(user, theme);
}

/** Firebase answers the same way whether or not the address has an account, so this never reveals which do. */
export async function resetPassword(email: string): Promise<void> {
  try { await sendPasswordResetEmail(connect().auth, email); } catch (e) {
    // Whether an address has an account is not told to whoever asks, so "no such account" looks the same as success. Anything else (offline, a bad address) is still shown.
    if ((e as { code?: string }).code !== 'auth/user-not-found') throw e;
  }
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
/** Deleting an account needs a recent sign-in. An email account gives its password again, and others sign in again with their own provider. */
async function reauthenticate(user: User, password?: string): Promise<void> {
  const id = user.providerData[0]?.providerId;
  if (id === 'password') {
    if (!password || !user.email) throw new Error('Enter your password to confirm.');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  } else {
    await reauthenticateWithPopup(user, provider(id === 'github.com' ? 'github' : 'google'));
  }
}

export async function deleteEverything(user: User, password?: string): Promise<void> {
  const { db } = connect();
  const feedback = await getDocs(collection(db, 'users', user.uid, 'feedback'));
  const summaries = await getDocs(collection(db, 'users', user.uid, 'summaries'));
  for (const d of feedback.docs) {
    await deleteDoc(doc(db, 'feedback', d.id));
    await deleteDoc(d.ref);
  }
  for (const d of summaries.docs) await deleteDoc(d.ref);
  // Linked computers, and what they and their phones left behind: sealed requests, responses, snapshots, presence and the phone list.
  for (const comp of (await getDocs(collection(db, 'users', user.uid, 'computers'))).docs) {
    for (const sub of ['devices', 'requests', 'responses', 'snapshots', 'presence']) for (const d of (await getDocs(collection(comp.ref, sub))).docs) await deleteDoc(d.ref);
    await deleteDoc(comp.ref);
  }
  await deleteDoc(doc(db, 'users', user.uid));
  try {
    await deleteUser(user);
  } catch (e) {
    if ((e as { code?: string }).code !== 'auth/requires-recent-login') throw e;
    await reauthenticate(user, password);
    await deleteUser(user);
  }
  localStorage.removeItem(SIGNED_IN_FLAG);
}
