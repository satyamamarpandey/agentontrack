// Loaded only through loadAccounts: when someone applies for early access, signs in, redeems an invitation, sends feedback on a configured
// site, or was signed in before. What this may store is fixed here and in firestore.rules, which is the only authority: this file is a client.
import { getApp, getApps, initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { connectAuthEmulator, createUserWithEmailAndPassword, deleteUser, EmailAuthProvider, getAuth, GithubAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile, type AuthProvider, type User } from 'firebase/auth';
import { collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, query, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch } from 'firebase/firestore';
import { BASE_PATH, SIGNED_IN_FLAG } from './accounts-config';
import type { Application } from './early-access';
import { applicationId, normalizeEmail, shortReference } from './early-access';
import type { Feedback } from './feedback';

const EMULATORS = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === '1';
/** A reCAPTCHA v3 site key, public by design. With it, Firebase can refuse calls that do not come from this site. Enforcement is switched on by the owner in the Firebase console. */
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

const sha256hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const asDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : null);
const isDenied = (e: unknown) => (e as { code?: string })?.code === 'permission-denied';
/** Firestore queues a write it cannot deliver and keeps trying quietly. A person pressing Send deserves an answer, so a write that has not landed in time is reported as such. */
const timed = <T,>(p: Promise<T>, ms = 20_000): Promise<T> => new Promise((ok, fail) => {
  const t = setTimeout(() => fail(Object.assign(new Error('Could not reach the server. Check your connection and try again in a moment.'), { code: 'unreachable' })), ms);
  p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
});

/* ---------------- Sign-in ---------------- */

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

/** Signing in records nothing until the person is a member: the rules refuse the profile write before that, and that is expected. */
async function finish(user: User, theme: string): Promise<User> {
  localStorage.setItem(SIGNED_IN_FLAG, '1');
  try { await saveProfile(user, theme); } catch (e) { if (!isDenied(e)) throw e; }
  return user;
}

async function saveProfile(user: User, theme: string): Promise<void> {
  const { db } = connect();
  await setDoc(doc(db, 'users', user.uid), { profile: { name: (user.displayName ?? '').slice(0, 200), email: user.email ?? '' }, updatedAt: serverTimestamp() }, { merge: true });
  const saved = await getDoc(doc(db, 'users', user.uid));
  if (!saved.data()?.preferences) await savePreferences(user.uid, theme);
}

/** For a member whose sign-in came before their membership: writes the profile the rules refused at the time. */
export async function ensureProfile(user: User, theme: string): Promise<void> {
  await saveProfile(user, theme);
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
  'auth/weak-password': 'Use a password of at least 8 characters.',
  'auth/invalid-email': 'That does not look like an email address.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes, then try again.',
  'auth/operation-not-allowed': 'This way of signing in is not switched on for this site yet.',
  'auth/account-exists-with-different-credential': 'That email already has an account that signs in another way. Use that way.',
  'auth/popup-closed-by-user': 'The sign-in window was closed before it finished.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.',
  'auth/network-request-failed': 'The network request did not go through. Check your connection and try again.',
  'auth/requires-recent-login': 'Sign in again to confirm this change.',
  'permission-denied': 'This account is not allowed to do that.',
};
/** A plain sentence for a Firebase error, and never the raw error code to the person. */
export function explain(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  return MESSAGES[code] ?? (code ? 'That did not work. Try again in a moment.' : (e as Error)?.message ?? 'Something went wrong.');
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
    if ((e as { code?: string }).code !== 'auth/user-not-found') throw e;
  }
}

export async function signOutHere(): Promise<void> {
  await signOut(connect().auth);
  localStorage.removeItem(SIGNED_IN_FLAG);
  try { localStorage.removeItem('aot-access'); } catch { /* storage may be blocked */ }
}

/** Email accounts confirm their address with the link Firebase sends. Google and GitHub addresses arrive verified. */
export async function sendVerification(): Promise<void> {
  const user = await currentUser();
  if (!user) throw new Error('You are signed out.');
  await sendEmailVerification(user, { url: `${location.origin}${BASE_PATH}/join/` });
}

/** After the person clicked the link in their inbox: picks up the new state, and gets a token that carries it, so the rules see it. */
export async function refreshVerified(): Promise<boolean> {
  const user = await currentUser();
  if (!user) return false;
  await user.reload();
  await user.getIdToken(true);
  return user.emailVerified;
}

/* ---------------- Access: who the signed-in person is to this site ---------------- */

export type MemberStatus = 'active' | 'revoked' | 'none';
export interface Access { signedIn: boolean; uid: string | null; email: string | null; name: string | null; verified: boolean; member: MemberStatus; admin: boolean; providerId: string | null }
export const SIGNED_OUT: Access = { signedIn: false, uid: null, email: null, name: null, verified: false, member: 'none', admin: false, providerId: null };

/** Reads the person's own membership and administrator records. Both are allowed for the person themselves, and say nothing about anyone else. */
export async function access(): Promise<Access> {
  const user = await currentUser();
  if (!user) return SIGNED_OUT;
  const { db } = connect();
  const [m, a] = await Promise.all([getDoc(doc(db, 'members', user.uid)), getDoc(doc(db, 'admins', user.uid))]);
  const member: MemberStatus = m.exists() ? (m.data().status === 'active' ? 'active' : 'revoked') : 'none';
  const out: Access = { signedIn: true, uid: user.uid, email: user.email, name: user.displayName, verified: user.emailVerified, member, admin: a.exists(), providerId: user.providerData[0]?.providerId ?? null };
  // A hint for the dashboard page, which reads it without loading Firebase; the rules decide for real on every request.
  try { localStorage.setItem('aot-access', out.admin ? 'admin' : member); } catch { /* storage may be blocked */ }
  return out;
}

/* ---------------- Early access: applying ---------------- */

export interface Submitted { id: string; reference: string }

/** Stores the application under the hash of the address. A second application for the same address is refused by the rules. */
export async function submitApplication(app: Application): Promise<Submitted> {
  const { db } = connect();
  const id = await applicationId(app.email);
  try {
    await timed(setDoc(doc(db, 'applications', id), { ...app, status: 'pending', schema: 1, createdAt: serverTimestamp() }));
  } catch (e) {
    if (isDenied(e)) throw new Error('We could not save this application. If you applied before with this address, it is already on file: there is nothing more to do.');
    throw e;
  }
  return { id, reference: shortReference(id) };
}

export interface MyApplication { id: string; reference: string; status: 'pending' | 'approved' | 'rejected'; createdAt: Date | null; needsVerification?: boolean }

/** The signed-in person's own application, found by their verified address. Returns null when there is none. */
export async function myApplication(): Promise<MyApplication | null> {
  const user = await currentUser();
  if (!user?.email) return null;
  if (!user.emailVerified) return { id: '', reference: '', status: 'pending', createdAt: null, needsVerification: true };
  const id = await applicationId(user.email);
  try {
    const snap = await getDoc(doc(connect().db, 'applications', id));
    if (!snap.exists()) return null;
    return { id, reference: shortReference(id), status: snap.data().status, createdAt: asDate(snap.data().createdAt) };
  } catch (e) {
    if (isDenied(e)) return null;
    throw e;
  }
}

export async function withdrawApplication(): Promise<void> {
  const user = await currentUser();
  if (!user?.email) throw new Error('You are signed out.');
  await deleteDoc(doc(connect().db, 'applications', await applicationId(user.email)));
}

/* ---------------- Early access: redeeming an invitation ---------------- */

export class InviteError extends Error {}

/**
 * One batch: the invitation goes from 'sent' to 'redeemed' and the person's membership record is created. The rules accept the second write only
 * because they can see the first, and accept the first only for the signed-in, verified person the invitation was addressed to, before it expires.
 */
export async function redeemInvite(token: string): Promise<void> {
  const user = await currentUser();
  if (!user) throw new InviteError('Sign in first, with the address the invitation was sent to.');
  if (!user.emailVerified) throw new InviteError('Confirm your email address first: the invitation can only be used by the address it was sent to.');
  const clean = token.trim();
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(clean)) throw new InviteError('This invitation link is not complete. Copy the whole link from the message you received.');
  const { db } = connect();
  const hash = await sha256hex(clean);
  const ref = doc(db, 'invites', hash);
  let inv;
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new InviteError('This invitation is not valid.');
    inv = snap.data();
  } catch (e) {
    if (isDenied(e)) throw new InviteError('This invitation is not valid for this account, has expired, or was already used. Ask for a new link if you think that is wrong.');
    throw e;
  }
  const batch = writeBatch(db);
  batch.update(ref, { status: 'redeemed', redeemedBy: user.uid, redeemedAt: serverTimestamp() });
  batch.set(doc(db, 'members', user.uid), { email: normalizeEmail(user.email!), inviteId: hash, applicationId: inv.applicationId, status: 'active', joinedAt: serverTimestamp(), ...(user.displayName ? { name: user.displayName.slice(0, 200) } : {}) });
  try { await timed(batch.commit()); } catch (e) {
    if (isDenied(e)) throw new InviteError('This invitation could not be used: it may have expired or been used a moment ago.');
    throw e;
  }
  try { await saveProfile(user, document.documentElement.dataset.theme ?? 'dark'); } catch { /* the account page saves it on the next visit */ }
}

/* ---------------- Administration ---------------- */

export interface AppRow extends Application { id: string; reference: string; status: 'pending' | 'approved' | 'rejected'; notes?: string; createdAt: Date | null; reviewedAt: Date | null }
export interface InviteRow { id: string; email: string; applicationId: string; status: 'sent' | 'redeemed' | 'revoked'; expired: boolean; createdAt: Date | null; expiresAt: Date | null; redeemedAt: Date | null; redeemedBy?: string; note?: string }
export interface MemberRow { uid: string; email: string; name?: string; inviteId: string; applicationId: string; status: 'active' | 'revoked'; joinedAt: Date | null; statusAt: Date | null; note?: string }
export interface AuditRow { id: string; action: string; target: string; by: string; at: Date | null; note?: string }
export interface TesterFeedbackRow { id: string; kind: string; rating?: number; message: string; version?: string; os?: string; connector?: string; diagnostics?: string; uid: string; email?: string; createdAt: Date | null }
export interface AdminData { applications: AppRow[]; invites: InviteRow[]; members: MemberRow[]; audit: AuditRow[]; feedback: TesterFeedbackRow[] }

const byNewest = <T extends { createdAt?: Date | null; at?: Date | null; joinedAt?: Date | null }>(rows: T[]) => rows.sort((a, b) => ((b.createdAt ?? b.at ?? b.joinedAt)?.getTime() ?? 0) - ((a.createdAt ?? a.at ?? a.joinedAt)?.getTime() ?? 0));

/** Everything the administrator may see, in one read. Small by design: a handful of friends, not a public launch. */
export async function adminLoad(): Promise<AdminData> {
  const { db } = connect();
  const [apps, invites, members, audit, feedback] = await Promise.all(['applications', 'invites', 'members', 'audit', 'testerFeedback'].map((c) => getDocs(collection(db, c))));
  const now = Date.now();
  return {
    applications: byNewest(apps!.docs.map((d) => ({ ...(d.data() as Application), id: d.id, reference: shortReference(d.id), status: d.data().status, notes: d.data().notes, createdAt: asDate(d.data().createdAt), reviewedAt: asDate(d.data().reviewedAt) }))),
    invites: byNewest(invites!.docs.map((d) => { const x = d.data(); const expiresAt = asDate(x.expiresAt); return { id: d.id, email: x.email, applicationId: x.applicationId, status: x.status, expired: x.status === 'sent' && !!expiresAt && expiresAt.getTime() < now, createdAt: asDate(x.createdAt), expiresAt, redeemedAt: asDate(x.redeemedAt), redeemedBy: x.redeemedBy, note: x.note }; })),
    members: byNewest(members!.docs.map((d) => { const x = d.data(); return { uid: d.id, email: x.email, name: x.name, inviteId: x.inviteId, applicationId: x.applicationId, status: x.status, joinedAt: asDate(x.joinedAt), statusAt: asDate(x.statusAt), note: x.note }; })),
    audit: byNewest(audit!.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditRow, 'id' | 'at'>), at: asDate(d.data().at) }))),
    feedback: byNewest(feedback!.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TesterFeedbackRow, 'id' | 'createdAt'>), createdAt: asDate(d.data().createdAt) }))),
  };
}

const me = async () => { const u = await currentUser(); if (!u) throw new Error('You are signed out.'); return u; };
const auditEntry = (uid: string, action: string, target: string, note?: string) => ({ action, target, by: uid, at: serverTimestamp(), ...(note ? { note: note.slice(0, 300) } : {}) });

export async function adminSetStatus(id: string, status: 'pending' | 'approved' | 'rejected', note?: string): Promise<void> {
  const u = await me(); const { db } = connect();
  const batch = writeBatch(db);
  batch.update(doc(db, 'applications', id), { status, reviewedAt: serverTimestamp(), reviewedBy: u.uid });
  batch.set(doc(collection(db, 'audit')), auditEntry(u.uid, status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'reopen', `application:${id}`, note));
  await batch.commit();
}

export async function adminNote(id: string, notes: string): Promise<void> {
  const u = await me(); const { db } = connect();
  const batch = writeBatch(db);
  batch.update(doc(db, 'applications', id), { notes: notes.slice(0, 2000), reviewedAt: serverTimestamp(), reviewedBy: u.uid });
  batch.set(doc(collection(db, 'audit')), auditEntry(u.uid, 'note', `application:${id}`));
  await batch.commit();
}

export async function adminDeleteApplication(id: string): Promise<void> {
  const u = await me(); const { db } = connect();
  const batch = writeBatch(db);
  batch.delete(doc(db, 'applications', id));
  batch.set(doc(collection(db, 'audit')), auditEntry(u.uid, 'delete-application', `application:${id}`));
  await batch.commit();
}

export const DEFAULT_INVITE_DAYS = 14;
export const inviteLink = (token: string) => `${location.origin}${BASE_PATH}/join/#t=${token}`;
const newToken = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

/**
 * Makes a single-use invitation for an application: a fresh random token, stored only as its hash, addressed to the applicant's email, with an expiry.
 * The link is returned once and never stored, so "resend" means a new link (the earlier one is revoked). The application is marked approved.
 */
export async function adminInvite(app: { id: string; email: string; status: string }, days = DEFAULT_INVITE_DAYS, note?: string): Promise<{ link: string; expiresAt: Date; hash: string }> {
  const u = await me(); const { db } = connect();
  const token = newToken();
  const hash = await sha256hex(token);
  const expiresAt = new Date(Date.now() + Math.min(Math.max(days, 1), 30) * 86_400_000);
  const batch = writeBatch(db);
  batch.set(doc(db, 'invites', hash), { email: normalizeEmail(app.email), applicationId: app.id, status: 'sent', createdAt: serverTimestamp(), createdBy: u.uid, expiresAt: Timestamp.fromDate(expiresAt), ...(note ? { note: note.slice(0, 300) } : {}) });
  if (app.status !== 'approved') batch.update(doc(db, 'applications', app.id), { status: 'approved', reviewedAt: serverTimestamp(), reviewedBy: u.uid });
  batch.set(doc(collection(db, 'audit')), auditEntry(u.uid, 'invite', `application:${app.id}`, `expires ${expiresAt.toISOString().slice(0, 10)}`));
  await batch.commit();
  return { link: inviteLink(token), expiresAt, hash };
}

export async function adminRevokeInvite(hash: string, note?: string): Promise<void> {
  const u = await me(); const { db } = connect();
  const batch = writeBatch(db);
  batch.update(doc(db, 'invites', hash), { status: 'revoked', revokedAt: serverTimestamp(), revokedBy: u.uid });
  batch.set(doc(collection(db, 'audit')), auditEntry(u.uid, 'revoke-invite', `invite:${hash.slice(0, 12)}`, note));
  await batch.commit();
}

/** Revoking makes every rule that asks for an active member fail on the next request, including the dashboard's account features and the phone link. */
export async function adminSetMember(uid: string, status: 'active' | 'revoked', note?: string): Promise<void> {
  const u = await me(); const { db } = connect();
  const batch = writeBatch(db);
  batch.update(doc(db, 'members', uid), { status, statusAt: serverTimestamp(), statusBy: u.uid, ...(note ? { note: note.slice(0, 300) } : {}) });
  batch.set(doc(collection(db, 'audit')), auditEntry(u.uid, status === 'revoked' ? 'revoke-member' : 'reinstate', `member:${uid}`, note));
  await batch.commit();
}

export async function adminRecordExport(what: string): Promise<void> {
  const u = await me();
  await setDoc(doc(collection(connect().db, 'audit')), auditEntry(u.uid, 'export', what));
}

/* ---------------- Tester feedback ---------------- */

export interface TesterFeedback { kind: 'bug' | 'feature' | 'ui' | 'connector' | 'experience'; rating?: number; message: string; version?: string; os?: 'windows' | 'macos' | 'linux' | 'other'; connector?: string; diagnostics?: string }

export async function sendTesterFeedback(f: TesterFeedback): Promise<void> {
  const u = await me(); const { db } = connect();
  const body: Record<string, unknown> = { kind: f.kind, message: f.message.trim().slice(0, 4000), uid: u.uid, createdAt: serverTimestamp() };
  if (f.rating) body.rating = f.rating;
  if (f.version?.trim()) body.version = f.version.trim().slice(0, 40);
  if (f.os) body.os = f.os;
  if (f.connector?.trim()) body.connector = f.connector.trim().slice(0, 60);
  if (f.diagnostics?.trim()) body.diagnostics = f.diagnostics.trim().slice(0, 6000);
  if (u.email) body.email = normalizeEmail(u.email);
  await timed(setDoc(doc(collection(db, 'testerFeedback')), body));
}

/* ---------------- Account data ---------------- */

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

/** Anyone may send feedback. A signed-in member also gets a copy under their account, so they can export and delete it. */
export async function sendFeedback(f: Feedback): Promise<void> {
  const { db, auth } = connect();
  const signedIn = localStorage.getItem(SIGNED_IN_FLAG) === '1';
  if (signedIn) await auth.authStateReady();
  const uid = signedIn ? auth.currentUser?.uid ?? null : null;
  const body = { rating: f.rating, message: f.message, ...(f.contact ? { contact: f.contact } : {}), uid, createdAt: serverTimestamp() };
  const ref = doc(collection(db, 'feedback'));
  if (!uid) { await timed(setDoc(ref, body)); return; }
  const batch = writeBatch(db);
  batch.set(ref, body);
  batch.set(doc(db, 'users', uid, 'feedback', ref.id), body);
  try { await timed(batch.commit()); } catch (e) {
    // Signed in but not a member: the copy under the account is refused, the feedback itself is still welcome.
    if (!isDenied(e)) throw e;
    await timed(setDoc(ref, { ...body, uid: null }));
  }
}

export function downloadData(data: AccountData): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agentontrack-account.json';
  a.click();
  URL.revokeObjectURL(url);
}

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

/** A step that may already have been done, or may not be allowed any more (a revoked member cannot read their tree): both mean there is nothing left for this person to remove. */
async function tolerant(step: () => Promise<unknown>): Promise<void> {
  try { await step(); } catch (e) { if (!isDenied(e) && (e as { code?: string })?.code !== 'not-found') throw e; }
}

/** Firebase accepts an account deletion only shortly after a sign-in; asking for the password or the provider again afterwards would strand a half-finished deletion. */
const recentlySignedIn = (user: User) => Date.now() - new Date(user.metadata.lastSignInTime ?? 0).getTime() < 4 * 60_000;

/**
 * Removes everything this account stored, then the sign-in. Order matters, and every step can be repeated after a failure:
 *   1. sign in again if the last sign-in is not recent, before anything is removed;
 *   2. the account tree (profile, preferences, feedback, summaries, linked computers and what they left) and the person's own tester feedback;
 *   3. the redeemed invitation addressed to this person, and their early-access application;
 *   4. the membership record, last of the data steps: from then on every rule that asks for an active member refuses this person, and so any
 *      sign-in token issued before the deletion stops reaching member data at once, instead of when it expires;
 *   5. the sign-in itself.
 * A revoked member cannot read their tree, so step 2 is skipped for them without an error; the administrator deletes what is left.
 */
export async function deleteEverything(user: User, password?: string): Promise<void> {
  const { db } = connect();
  if (!recentlySignedIn(user)) await reauthenticate(user, password);
  const membership = await getDoc(doc(db, 'members', user.uid)).then((m) => (m.exists() ? m.data() : null), () => null);
  await tolerant(async () => {
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
  });
  await tolerant(async () => { for (const d of (await getDocs(query(collection(db, 'testerFeedback'), where('uid', '==', user.uid)))).docs) await deleteDoc(d.ref); });
  if (typeof membership?.inviteId === 'string') await tolerant(() => deleteDoc(doc(db, 'invites', membership.inviteId)));
  if (user.email && user.emailVerified) await tolerant(async () => deleteDoc(doc(db, 'applications', await applicationId(user.email!))));
  await tolerant(() => deleteDoc(doc(db, 'members', user.uid)));
  await deleteUser(user);
  localStorage.removeItem(SIGNED_IN_FLAG);
  try { localStorage.removeItem('aot-access'); } catch { /* storage may be blocked */ }
}

export { updateDoc };
