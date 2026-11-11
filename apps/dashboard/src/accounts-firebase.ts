// Loaded only when a signed-in person presses Save, or when the welcome page on the public site checks early access.
// This page holds the companion session token, so it uses no popup resolver: Google's sign-in script loads only on the site's sign-in pages, in another tab.
import { getApp, getApps, initializeApp } from 'firebase/app';
import { protect } from './app-check';
import { connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';
import type { AccessStatus } from './accounts';
import type { ProjectSummary } from './metrics';
import type { UsageCounts } from './telemetry';

const EMULATORS = import.meta.env.VITE_FIREBASE_EMULATORS === '1';

function connect(config: string) {
  const fresh = getApps().length === 0;
  const app = fresh ? initializeApp(JSON.parse(config)) : getApp();
  if (fresh) protect(app, EMULATORS);
  const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  const db = getFirestore(app);
  if (fresh && EMULATORS) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return { auth, db };
}

/** The person's own membership and administrator records: both readable by them, and about nobody else. */
export async function accessStatus(config: string): Promise<AccessStatus> {
  const { auth, db } = connect(config);
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) { localStorage.removeItem('aot-signed-in'); localStorage.removeItem('aot-access'); return { signedIn: false, member: 'none', admin: false, email: null }; }
  const [m, a] = await Promise.all([getDoc(doc(db, 'members', user.uid)), getDoc(doc(db, 'admins', user.uid))]);
  const member = m.exists() ? (m.data().status === 'active' ? 'active' : 'revoked') : 'none';
  const out: AccessStatus = { signedIn: true, member, admin: a.exists(), email: user.email };
  localStorage.setItem('aot-access', out.admin ? 'admin' : member);
  return out;
}

/** Saving again under the same project replaces the earlier summary. The document id is random, not the project's id. */
function summaryId(projectId: string): string {
  const key = `aot-summary-id-${projectId}`;
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

export async function saveProjectSummary(config: string, projectId: string, summary: ProjectSummary): Promise<void> {
  const { auth, db } = connect(config);
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) { localStorage.removeItem('aot-signed-in'); throw new Error('You are signed out. Sign in on the account page, then save again.'); }
  try {
    await setDoc(doc(db, 'users', user.uid, 'summaries', summaryId(projectId)), { ...summary, savedAt: serverTimestamp() });
  } catch (e) {
    if ((e as { code?: string }).code === 'permission-denied') throw new Error('Saving needs an active early-access account. Your account page shows where your application stands.');
    throw e;
  }
}

/** One document per install per week. The rules let anyone create it and nobody read, change or delete it. */
export async function sendUsageCounts(config: string, installId: string, counts: UsageCounts): Promise<void> {
  const { db } = connect(config);
  await setDoc(doc(db, 'telemetry', `${installId}_${counts.week}`), { ...counts, installId, createdAt: serverTimestamp() });
}
