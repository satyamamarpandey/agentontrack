// Shared helpers for the specs that run against the Firebase EMULATORS (never a real project).
// "Bearer owner" is the emulator's own back door: it bypasses the rules, the way the owner's console or server credentials would in production.
import { expect, type Page } from '@playwright/test';

export const PROJECT = 'demo-agentontrack';
export const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
export const STORE = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
export const DB = `projects/${PROJECT}/databases/(default)/documents`;
export const DOCS = `http://${STORE}/v1/${DB}`;
export const OWNER = { authorization: 'Bearer owner' };

export const asUser = (token: string | null) => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });
export const str = (stringValue: string) => ({ stringValue });
const ENCODED = new Set(['stringValue', 'integerValue', 'doubleValue', 'booleanValue', 'nullValue', 'timestampValue', 'arrayValue', 'mapValue', 'bytesValue', 'referenceValue', 'geoPointValue']);
/** A value already in Firestore's REST shape ({ stringValue: 'x' }, { arrayValue: ... }) is passed through; anything else is encoded. Both styles appear in the specs. */
const isEncoded = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).length === 1 && ENCODED.has(Object.keys(v)[0]!);
export const val = (v: unknown): object => isEncoded(v) ? (v as object) : typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { booleanValue: v } : v === null ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : { mapValue: { fields: fieldsOf(v as Record<string, unknown>) } };
export const fieldsOf = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]));
/** Turns a Firestore REST document back into plain values. */
export const plain = (fields: Record<string, any> | undefined): Record<string, any> => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? v.timestampValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values ?? []).map((x: any) => plain({ x }).x) : 'mapValue' in v ? plain(v.mapValue.fields) : v]));

/** A write through the commit endpoint, with server-time fields where the rules ask for request.time. An optional mask makes it an update of those fields only. */
export const commit = (token: string | null, path: string, data: Record<string, unknown>, serverTime: string[] = [], mask?: string[]) => fetch(`${DOCS}:commit`, {
  method: 'POST', headers: asUser(token),
  body: JSON.stringify({ writes: [{ update: { name: `${DB}/${path}`, fields: fieldsOf(data) }, ...(mask ? { updateMask: { fieldPaths: mask } } : {}), updateTransforms: serverTime.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }] }),
});
export const readDoc = (token: string | null, path: string) => fetch(`${DOCS}/${path}`, { headers: asUser(token) });
export const ownerRead = async (path: string): Promise<Record<string, any> | null> => { const r = await fetch(`${DOCS}/${path}`, { headers: OWNER }); if (r.status === 404) return null; expect(r.status, path).toBe(200); return plain((await r.json()).fields); };
export const ownerList = async (collection: string): Promise<{ id: string; data: Record<string, any> }[]> => { const r = await fetch(`${DOCS}/${collection}`, { headers: OWNER }); const j = await r.json() as { documents?: { name: string; fields: any }[] }; return (j.documents ?? []).map((d) => ({ id: d.name.split('/').pop()!, data: plain(d.fields) })); };
export const ownerWrite = (path: string, data: Record<string, unknown>, serverTime: string[] = []) => commit('owner', path, data, serverTime);
/** Empties the emulators (every document, every account), so a retried serial group starts the way a fresh `emulators:exec` does, instead of meeting its own earlier data. */
export const clearEmulators = async () => {
  const store = await fetch(`http://${STORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  const auth = await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  expect(store.status, 'clearing the Firestore emulator').toBe(200);
  expect(auth.status, 'clearing the Auth emulator').toBe(200);
};

/** A password account made straight at the emulator, for testing what the rules refuse. */
export async function signUpRest(email: string, password = 'not-a-secret-1'): Promise<{ idToken: string; localId: string; email: string }> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  expect(r.status, `sign up ${email}`).toBe(200);
  const b = await r.json() as { idToken: string; localId: string };
  return { idToken: b.idToken, localId: b.localId, email };
}
/** A fresh token for the same account, so that a changed claim (email verified) reaches the rules. */
export async function signInRest(email: string, password = 'not-a-secret-1'): Promise<string> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  expect(r.status).toBe(200);
  return (await r.json() as { idToken: string }).idToken;
}
export async function uidOf(email: string): Promise<string> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: 'POST', headers: { 'content-type': 'application/json', ...OWNER }, body: '{}' });
  const data = await r.json() as { userInfo?: { email: string; localId: string }[] };
  const u = data.userInfo?.find((x) => x.email === email);
  expect(u, `an account for ${email}`).toBeTruthy();
  return u!.localId;
}
/** Marks the address confirmed, as following the link in the email would. */
export async function markVerified(uid: string): Promise<void> {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, { method: 'POST', headers: { 'content-type': 'application/json', ...OWNER }, body: JSON.stringify({ localId: uid, emailVerified: true }) });
  expect(r.status).toBe(200);
}
/** Follows the newest verification link the emulator holds for an address, as the person would from their inbox. */
export async function followVerificationLink(email: string): Promise<void> {
  const codes = await (await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json() as { oobCodes: { email: string; requestType: string; oobLink: string }[] };
  const mine = codes.oobCodes.filter((c) => c.email === email && c.requestType === 'VERIFY_EMAIL');
  expect(mine.length, `a verification email for ${email}`).toBeGreaterThan(0);
  const r = await fetch(mine.at(-1)!.oobLink);
  expect(r.status).toBe(200);
}

/** What the administrator's console does: makes an account a member outright. Used to set up specs that are not about the invitation itself. */
export async function grantMembership(email: string, over: Record<string, unknown> = {}): Promise<string> {
  const uid = await uidOf(email);
  expect((await ownerWrite(`members/${uid}`, { email, inviteId: 'granted-by-test', applicationId: 'granted-by-test', status: 'active', ...over }, ['joinedAt'])).status).toBe(200);
  return uid;
}
export async function makeAdmin(uid: string): Promise<void> {
  expect((await ownerWrite(`admins/${uid}`, { note: 'made by the test' }, ['addedAt'])).status).toBe(200);
}

/** Clicks through the Auth emulator's own Google sign-in page, as a person would, from a page that shows the sign-in choices. */
export async function googlePopupSignIn(page: Page, email: string, name: string) {
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('sign-in').click()]);
  await expect(async () => {
    await popup.getByText('Add new account').click({ timeout: 3000 });
    await expect(popup.locator('#email-input')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await popup.locator('#email-input').fill(email);
  await popup.locator('#display-name-input').fill(name);
  await popup.locator('#sign-in').click();
}
