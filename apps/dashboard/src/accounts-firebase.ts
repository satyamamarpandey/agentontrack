// Loaded only when a signed-in person presses Save.
// This page holds the companion session token, so it uses no popup resolver: Google's sign-in script loads only on the account page, in another tab.
import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';
import type { ProjectSummary } from './metrics';
import type { UsageCounts } from './telemetry';

const EMULATORS = import.meta.env.VITE_FIREBASE_EMULATORS === '1';

function connect(config: string) {
  const fresh = getApps().length === 0;
  const app = fresh ? initializeApp(JSON.parse(config)) : getApp();
  const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  const db = getFirestore(app);
  if (fresh && EMULATORS) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return { auth, db };
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
  await setDoc(doc(db, 'users', user.uid, 'summaries', summaryId(projectId)), { ...summary, savedAt: serverTimestamp() });
}

/** One document per install per week. The rules let anyone create it and nobody read, change or delete it. */
export async function sendUsageCounts(config: string, installId: string, counts: UsageCounts): Promise<void> {
  const { db } = connect(config);
  await setDoc(doc(db, 'telemetry', `${installId}_${counts.week}`), { ...counts, installId, createdAt: serverTimestamp() });
}
