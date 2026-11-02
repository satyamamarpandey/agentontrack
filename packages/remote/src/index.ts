/**
 * The wire protocol between a phone and a desktop companion, carried through Firestore.
 *
 * Firestore only ever holds ciphertext and signatures. It has no authority: a message is acted on only if it is signed by a device key
 * the person approved on the desktop, was not seen before, has not expired, and decrypts under a key only those two parties can derive.
 * The same code runs in the phone's browser and in the companion, through the standard WebCrypto API.
 */

export const PROTOCOL = 1;
/** A request may live this long at most, counted from when it was made. */
export const MAX_LIFETIME_MS = 10 * 60_000;
/** How far a device's clock may be ahead of the receiver's before a message is refused. */
export const MAX_SKEW_MS = 2 * 60_000;
export const MAX_PLAINTEXT_BYTES = 150_000;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Public halves only. These are what the other side is given, and what a fingerprint is made from. */
export interface PublicIdentity { sign: string; agree: string }
export interface Identity { signing: CryptoKeyPair; agreement: CryptoKeyPair; pub: PublicIdentity }
/** A private key written out, for the companion's own file. A phone keeps its keys as non-extractable objects instead. */
export interface StoredIdentity { signPriv: JsonWebKey; agreePriv: JsonWebKey; pub: PublicIdentity }

const rawPub = async (k: CryptoKey) => b64(await subtle().exportKey('raw', k));

/** Makes a device or computer identity. With `extractable` false, the private keys can be used but never read back out. */
export async function createIdentity(extractable = false): Promise<Identity> {
  const signing = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, ['sign', 'verify']) as CryptoKeyPair;
  const agreement = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']) as CryptoKeyPair;
  return { signing, agreement, pub: { sign: await rawPub(signing.publicKey), agree: await rawPub(agreement.publicKey) } };
}

export async function exportIdentity(id: Identity): Promise<StoredIdentity> {
  return { signPriv: await subtle().exportKey('jwk', id.signing.privateKey), agreePriv: await subtle().exportKey('jwk', id.agreement.privateKey), pub: id.pub };
}

export async function importIdentity(s: StoredIdentity): Promise<Identity> {
  const signPriv = await subtle().importKey('jwk', s.signPriv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const agreePriv = await subtle().importKey('jwk', s.agreePriv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const signPub = await subtle().importKey('raw', unb64(s.pub.sign), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const agreePub = await subtle().importKey('raw', unb64(s.pub.agree), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { signing: { privateKey: signPriv, publicKey: signPub }, agreement: { privateKey: agreePriv, publicKey: agreePub }, pub: s.pub };
}

/**
 * A short code made from both public keys, for a person to compare on two screens. Matching codes mean the phone and the computer are
 * talking about the same keys, so nobody in the middle swapped one. It is not secret.
 */
export async function fingerprint(pub: PublicIdentity): Promise<string> {
  const d = new Uint8Array(await subtle().digest('SHA-256', enc.encode(`${pub.sign}.${pub.agree}`)));
  const hex = Array.from(d.slice(0, 10)).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

/** The key for one pair: ECDH between this side's private key and the other's public key, then HKDF bound to who they are. */
export async function pairKey(mine: Identity, theirAgreePub: string, ctx: { uid: string; cid: string; did: string }): Promise<CryptoKey> {
  const theirs = await subtle().importKey('raw', unb64(theirAgreePub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle().deriveBits({ name: 'ECDH', public: theirs }, mine.agreement.privateKey, 256);
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('agentontrack/remote/v1'), info: enc.encode(`${ctx.uid}|${ctx.cid}|${ctx.did}`) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** What is fixed about a message and covered by both the signature and the encryption, so none of it can be changed or moved. */
export interface Meta {
  v: number;
  uid: string; cid: string; did: string;
  /** The request's id. A response carries the id of the request it answers. */
  rid: string;
  kind: string;
  /** Strictly increasing per device, so an old message cannot be played again. Responses use 0. */
  ctr: number;
  iat: number; exp: number;
}
export interface Envelope extends Meta { iv: string; ct: string; sig: string }

const canonical = (m: Meta): string => JSON.stringify([m.v, m.uid, m.cid, m.did, m.rid, m.kind, m.ctr, m.iat, m.exp]);
const signedBytes = (m: Meta, iv: Uint8Array, ct: Uint8Array): Uint8Array<ArrayBuffer> => {
  const head = enc.encode(canonical(m));
  const out = new Uint8Array(head.length + iv.length + ct.length);
  out.set(head); out.set(iv, head.length); out.set(ct, head.length + iv.length);
  return out;
};

export async function seal(plain: unknown, meta: Meta, key: CryptoKey, signKey: CryptoKey): Promise<Envelope> {
  const body = enc.encode(JSON.stringify(plain));
  if (body.length > MAX_PLAINTEXT_BYTES) throw new Error('This message is too large to send');
  if (meta.exp - meta.iat > MAX_LIFETIME_MS || meta.exp <= meta.iat) throw new Error('A message may live for ten minutes at most');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(canonical(meta)) }, key, body));
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, signedBytes(meta, iv, ct)));
  return { ...meta, iv: b64(iv), ct: b64(ct), sig: b64(sig) };
}

export type OpenFailure = 'malformed' | 'bad-signature' | 'expired' | 'from-the-future' | 'too-long-lived' | 'wrong-recipient' | 'cannot-decrypt';
export class OpenError extends Error { constructor(readonly reason: OpenFailure, message: string) { super(message); } }

/**
 * Checks a message in the order that costs least and trusts least: shape, who it is for, the signature, the time window, and only then
 * decryption. Anything wrong throws an OpenError whose reason says which check failed. Replay and idempotency are the caller's, since they
 * need the caller's memory of what it has already seen.
 */
export async function open<T = unknown>(env: Envelope, expect: { uid: string; cid: string; did: string }, key: CryptoKey, signerPub: string, now = Date.now(), opts: { allowExpired?: boolean } = {}): Promise<T> {
  const strs = [env.uid, env.cid, env.did, env.rid, env.kind, env.iv, env.ct, env.sig];
  if (env.v !== PROTOCOL || strs.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 400_000) || !Number.isSafeInteger(env.ctr) || env.ctr < 0 || !Number.isFinite(env.iat) || !Number.isFinite(env.exp)) throw new OpenError('malformed', 'Not a message this version understands');
  if (env.uid !== expect.uid || env.cid !== expect.cid || env.did !== expect.did) throw new OpenError('wrong-recipient', 'This message is for someone else');
  let ok = false;
  try {
    const pub = await subtle().importKey('raw', unb64(signerPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(env.sig), signedBytes(env, unb64(env.iv), unb64(env.ct)));
  } catch { ok = false; }
  if (!ok) throw new OpenError('bad-signature', 'The signature does not match a trusted device');
  if (env.exp - env.iat > MAX_LIFETIME_MS) throw new OpenError('too-long-lived', 'This message claims to live too long');
  if (env.iat > now + MAX_SKEW_MS) throw new OpenError('from-the-future', 'This message is dated in the future');
  // A snapshot is how a phone shows the last known state while the computer is offline, so it may be read after it expires. What it says
  // about when it was made is inside the signed content, so an old one can never pass for a new one.
  if (env.exp < now && !opts.allowExpired) throw new OpenError('expired', 'This message has expired');
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: enc.encode(canonical(env)) }, key, unb64(env.ct));
    return JSON.parse(dec.decode(plain)) as T;
  } catch { throw new OpenError('cannot-decrypt', 'This message cannot be read'); }
}

/**
 * The name a project's snapshot is stored under. It is made from the computer's id and the project's id by a hash, so the stored name says
 * nothing about the project, and the phone, which learns the project id from the encrypted list, can work out the same name.
 */
export async function snapshotKey(cid: string, projectId: string): Promise<string> {
  const d = await subtle().digest('SHA-256', enc.encode(`agentontrack/snapshot|${cid}|${projectId}`));
  return `p_${b64(new Uint8Array(d).slice(0, 12))}`;
}

/** A random id, long enough that two never collide. */
export const newId = (bytes = 12): string => b64(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
