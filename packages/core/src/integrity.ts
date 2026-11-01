import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign, verify, type KeyObject } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, sha256, type EventStore } from './store.js';

/**
 * Trust model (docs/security/integrity.md). A process running as the same user can read and write everything
 * here. These controls force it to alter several independent records consistently, and the approver key stops
 * it forging a signed approval without the passphrase. Only an external anchor the local user cannot rewrite
 * catches a fully consistent rewrite. None of this makes the log immutable.
 */

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export interface ApproverFile { publicKey: string; salt: string; iv: string; tag: string; ciphertext: string }

export function createApprover(passphrase: string): ApproverFile {
  if (passphrase.length < 10) throw new Error('Approver passphrase must be at least 10 characters');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([c.update(privateKey.export({ type: 'pkcs8', format: 'der' })), c.final()]);
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
  };
}

export function unlockApprover(file: ApproverFile, passphrase: string): KeyObject {
  try {
    const key = scryptSync(passphrase, Buffer.from(file.salt, 'base64'), 32, SCRYPT);
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
    d.setAuthTag(Buffer.from(file.tag, 'base64'));
    const der = Buffer.concat([d.update(Buffer.from(file.ciphertext, 'base64')), d.final()]);
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('Wrong approver passphrase');
  }
}

export const keyFingerprint = (publicKeyB64: string) => sha256(Buffer.from(publicKeyB64, 'base64')).slice(0, 16);

export function signBody(key: KeyObject, body: unknown): string {
  return sign(null, Buffer.from(canonical(body)), key).toString('base64');
}

export function verifyBody(publicKeyB64: string, body: unknown, signature: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(canonical(body)), pub, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export interface WitnessEntry { seq: number; hash: string; instance?: string; approverKey?: string; sig?: string }

/** An append-only copy of each event's head, kept apart from the database. */
export class Witness {
  constructor(readonly path: string) { mkdirSync(dirname(path), { recursive: true }); }

  exists(): boolean { return existsSync(this.path); }

  add(entry: WitnessEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  all(): WitnessEntry[] {
    if (!existsSync(this.path)) return [];
    const out: WitnessEntry[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn final line is tolerated and shows up as a lag */ }
    }
    return out;
  }

  /** Reads only the tail, so the hook-path check stays constant-time as the log grows. */
  last(): WitnessEntry | undefined {
    if (!existsSync(this.path)) return undefined;
    const size = statSync(this.path).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    const fd = openSync(this.path, 'r');
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]!); } catch { /* keep looking */ }
    }
    return undefined;
  }

  replace(entries: WitnessEntry[]): void {
    writeFileSync(this.path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
}

export interface IntegrityReport {
  ok: boolean;
  chain: { ok: boolean; events: number; firstBadSeq?: number };
  problems: string[];
  firstBadSeq?: number;
  witnessEntries: number;
  signedCheckpoints: number;
  approverKey: string | null;
  assurance: string;
}

export function verifyIntegrity(store: EventStore, witness: Witness, approverKey: string | null, instance: string | null): IntegrityReport {
  const chain = store.verifyChain();
  const problems: string[] = [];
  let firstBad = chain.firstBadSeq;
  const note = (msg: string, seq?: number) => {
    problems.push(msg);
    if (seq !== undefined && (firstBad === undefined || seq < firstBad)) firstBad = seq;
  };
  if (!chain.ok) note(`Hash chain breaks at event ${chain.firstBadSeq}`, chain.firstBadSeq);

  const entries = witness.all();
  const head = store.head();
  if (chain.events > 0 && entries.length === 0) note('Witness file is missing or empty');
  let signed = 0;
  let pinnedKey: string | null = null;
  let pinnedInstance: string | null = null;
  for (const w of entries) {
    if (w.instance) pinnedInstance ??= w.instance;
    if (w.approverKey) pinnedKey = w.approverKey;
    const ev = store.eventAt(w.seq);
    if (!ev) { note(`Witness records event ${w.seq}, which is missing: truncation or rollback`, w.seq); continue; }
    if (ev.hash !== w.hash) note(`Event ${w.seq} differs from its witnessed hash: rewritten history`, w.seq);
    if (w.sig) {
      if (pinnedKey && verifyBody(pinnedKey, { seq: w.seq, hash: w.hash, instance: pinnedInstance }, w.sig)) signed++;
      else note(`Checkpoint at event ${w.seq} has an invalid signature`, w.seq);
    }
  }
  if (head && entries.length) {
    const lastSeq = entries[entries.length - 1]!.seq;
    // One unwitnessed event is a crash between commit and witness write. More means the witness was cut back.
    if (head.seq - lastSeq > 1) note(`${head.seq - lastSeq} events are not in the witness: the witness was truncated`);
  }
  if (instance && pinnedInstance && instance !== pinnedInstance) note('This log belongs to a different project instance: replayed or swapped database');
  if (pinnedKey && approverKey && pinnedKey !== approverKey) note('Approver key in the log differs from the witnessed key');
  if (pinnedKey && !approverKey) note('Witness shows an enrolled approver, but the log has none: enrolment removed');

  return {
    ok: problems.length === 0, chain, problems, ...(firstBad !== undefined ? { firstBadSeq: firstBad } : {}), witnessEntries: entries.length, signedCheckpoints: signed, approverKey: approverKey ? keyFingerprint(approverKey) : null,
    assurance: signed > 0
      ? 'Tamper-evident up to the last signed checkpoint unless the attacker also replaces the pinned key in the witness. Not immutable.'
      : 'Tamper-evident against edits that miss the witness. A same-user attacker who rewrites both is not detected without an external anchor. Not immutable.',
  };
}
