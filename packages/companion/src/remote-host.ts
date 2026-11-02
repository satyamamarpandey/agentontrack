import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentontrackHome } from '@agentontrack/core';
import { createIdentity, exportIdentity, fingerprint, importIdentity, newId, open, OpenError, pairKey, seal, type Envelope, type Identity, type PublicIdentity, type StoredIdentity } from '@agentontrack/remote';

/**
 * The desktop side of the phone link. It decides, from its own memory and not from anything Firestore says, whether a request may run:
 * the sender must be a device the person approved on this computer, the counter must be higher than the last, the request must be
 * unexpired and new, and only then is the action handed to the executor, which checks it against the current goal, plan and approvals.
 */
export type Level = 'view' | 'control';

/** The only things a phone can ask for. Anything else is refused by name, before any code looks at its parameters. */
export const READ_ACTIONS = ['ping', 'projects.list', 'project.snapshot', 'files.list', 'file.read', 'diff.read', 'handoffs.list', 'models.list', 'agents.list'] as const;
export const CONTROL_ACTIONS = ['run.start', 'run.stop', 'plan.state', 'plan.continue', 'plan.verify', 'handoff.create', 'handoff.accept', 'approval.decide'] as const;

export interface TrustedDevice {
  did: string; name: string; pub: PublicIdentity; fingerprint: string;
  level: Level; trustedAt: string; lastCtr: number; revokedAt?: string;
}
interface Cached { did: string; rid: string; response: Envelope; exp: number }
export interface RemoteFile {
  computerId: string; name: string;
  identity: StoredIdentity;
  /** Which account the link belongs to, and the Firebase project, once the person has set it up on this computer. */
  link?: { uid: string; firebase: { apiKey: string; projectId: string; authDomain?: string; appId?: string }; computer: { email: string; password: string }; linkedAt: string };
  devices: TrustedDevice[];
  /** Requests answered recently, so a repeated one gets the same answer and runs nothing twice. */
  cache: Cached[];
  /** Ids seen at all, with when they stop mattering, so an old request cannot be played again once its answer has aged out. */
  seen: Record<string, number>;
  /** Most it will let a phone spend on one run, in USD. A person changes it on the desktop. */
  maxUsdPerRun: number;
}

export const remotePath = () => join(agentontrackHome(), 'remote.json');
const MAX_DEVICES = 5;
const CACHE_KEEP = 200;

export function loadRemote(path = remotePath()): RemoteFile | null {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as RemoteFile : null; } catch { return null; }
}
export function saveRemote(f: RemoteFile, path = remotePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  // The file holds this computer's private keys and the link's password, so only its owner may read it.
  writeFileSync(tmp, JSON.stringify(f, null, 1), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* not supported on this file system */ }
  renameSync(tmp, path);
}

export async function newRemoteFile(name: string): Promise<RemoteFile> {
  const id = await createIdentity(true);
  return { computerId: newId(9).replace(/[^A-Za-z0-9]/g, 'x'), name, identity: await exportIdentity(id), devices: [], cache: [], seen: {}, maxUsdPerRun: 1 };
}

export interface HostContext { did: string; device: TrustedDevice }
export type Executor = (action: string, params: unknown, ctx: HostContext) => Promise<unknown>;
export type Failure = { ok: false; code: string; message: string };
export type Outcome = { ok: true; result: unknown } | Failure;

export class RemoteHost {
  private identity!: Identity;
  private keys = new Map<string, CryptoKey>();
  /** One request at a time per device, so two requests with the same counter cannot both pass the check. */
  private gate = new Map<string, Promise<unknown>>();

  constructor(private file: RemoteFile, private run: Executor, private persist: (f: RemoteFile) => void = (f) => saveRemote(f), private now: () => number = Date.now) {}

  async init(): Promise<this> { this.identity = await importIdentity(this.file.identity); return this; }
  get state(): RemoteFile { return this.file; }
  get pub(): PublicIdentity { return this.identity.pub; }
  fingerprint(): Promise<string> { return fingerprint(this.identity.pub); }
  private uid(): string { if (!this.file.link) throw new Error('This computer is not linked to an account yet'); return this.file.link.uid; }
  private save() { this.persist(this.file); }

  /** Adds a phone the person has just approved on this computer. Nothing else can add one. */
  async trust(did: string, name: string, pub: PublicIdentity, level: Level): Promise<TrustedDevice> {
    if (this.file.devices.filter((d) => !d.revokedAt).length >= MAX_DEVICES && !this.file.devices.some((d) => d.did === did && !d.revokedAt)) throw new Error(`At most ${MAX_DEVICES} phones can be trusted at once. Revoke one first.`);
    const fp = await fingerprint(pub);
    const rest = this.file.devices.filter((d) => d.did !== did);
    const device: TrustedDevice = { did, name: name.slice(0, 60), pub, fingerprint: fp, level, trustedAt: new Date(this.now()).toISOString(), lastCtr: 0 };
    this.file.devices = [...rest, device];
    this.keys.delete(did);
    this.save();
    return device;
  }

  /** Takes effect at once, here. Nothing in Firestore can undo it. */
  revoke(did: string): boolean {
    const d = this.file.devices.find((x) => x.did === did && !x.revokedAt);
    if (!d) return false;
    d.revokedAt = new Date(this.now()).toISOString();
    this.file.cache = this.file.cache.filter((c) => c.did !== did);
    this.keys.delete(did);
    this.save();
    return true;
  }

  setLevel(did: string, level: Level): boolean {
    const d = this.file.devices.find((x) => x.did === did && !x.revokedAt);
    if (!d) return false;
    d.level = level; this.save();
    return true;
  }

  async keyFor(device: TrustedDevice): Promise<CryptoKey> {
    let k = this.keys.get(device.did);
    if (!k) { k = await pairKey(this.identity, device.pub.agree, { uid: this.uid(), cid: this.file.computerId, did: device.did }); this.keys.set(device.did, k); }
    return k;
  }

  /** What a phone is given back: signed by this computer, readable only by that phone. */
  async reply(device: TrustedDevice, rid: string, kind: string, body: unknown, lifetimeMs = 5 * 60_000): Promise<Envelope> {
    const t = this.now();
    return seal(body, { v: 1, uid: this.uid(), cid: this.file.computerId, did: device.did, rid, kind, ctr: 0, iat: t, exp: t + lifetimeMs }, await this.keyFor(device), this.identity.signing.privateKey);
  }

  /** Takes one request from the channel and returns the sealed answer, or null for something that is not worth answering. */
  handle(env: Envelope): Promise<Envelope | null> {
    const lane = this.gate.get(env.did) ?? Promise.resolve();
    const next = lane.then(() => this.process(env), () => this.process(env));
    this.gate.set(env.did, next.catch(() => undefined));
    return next;
  }

  private fail(device: TrustedDevice, rid: string, code: string, message: string): Promise<Envelope> {
    return this.reply(device, rid, 'response', { ok: false, code, message } satisfies Failure);
  }

  private async process(env: Envelope): Promise<Envelope | null> {
    const device = this.file.devices.find((d) => d.did === env.did);
    // A device that was never approved, or was revoked, gets no answer at all: nothing it sends is acted on or even confirmed received.
    if (!device || device.revokedAt) return null;
    const t = this.now();
    this.prune(t);
    const cached = this.file.cache.find((c) => c.did === device.did && c.rid === env.rid);
    let plain: { action?: unknown; params?: unknown };
    try {
      plain = await open(env, { uid: this.uid(), cid: this.file.computerId, did: device.did }, await this.keyFor(device), device.pub.sign, t);
    } catch (e) {
      const reason = e instanceof OpenError ? e.reason : 'malformed';
      // A bad signature gets nothing back, as it may not be from the device. A real device with a stale clock or an old message is told why.
      if (reason === 'bad-signature' || reason === 'wrong-recipient' || reason === 'malformed') return null;
      return this.fail(device, env.rid, reason, reason === 'expired' ? 'This request expired before the computer saw it, so it was not run.' : 'This request could not be accepted.');
    }
    // The same request again: the same answer, and nothing is run twice.
    if (cached) return cached.response;
    if (this.file.seen[`${device.did}:${env.rid}`]) return this.fail(device, env.rid, 'replayed', 'This request was already handled, and its answer has aged out.');
    if (env.ctr <= device.lastCtr) return this.fail(device, env.rid, 'replayed', 'This request is older than one already handled, so it was not run.');
    device.lastCtr = env.ctr;
    this.file.seen[`${device.did}:${env.rid}`] = env.exp + 60_000;

    let out: Outcome;
    const isRead = (READ_ACTIONS as readonly string[]).includes(String(plain.action));
    const isControl = (CONTROL_ACTIONS as readonly string[]).includes(String(plain.action));
    if (typeof plain.action !== 'string' || plain.action.length > 60) out = { ok: false, code: 'malformed', message: 'The request names no action.' };
    else if (!isRead && !isControl) out = { ok: false, code: 'unknown-action', message: 'A phone cannot ask for that.' };
    else if (isControl && device.level !== 'control') out = { ok: false, code: 'view-only', message: 'This phone was approved to look, not to control. Change that on the computer.' };
    else {
      try { out = { ok: true, result: await this.run(plain.action, plain.params, { did: device.did, device }) }; }
      catch (e) { const err = e as { code?: string; message?: string }; out = { ok: false, code: err.code ?? 'refused', message: err.message ?? 'The computer refused this request.' }; }
    }
    const response = await this.reply(device, env.rid, 'response', out);
    this.file.cache.push({ did: device.did, rid: env.rid, response, exp: env.exp + 60_000 });
    if (this.file.cache.length > CACHE_KEEP) this.file.cache.splice(0, this.file.cache.length - CACHE_KEEP);
    this.save();
    return response;
  }

  private prune(t: number) {
    for (const [k, until] of Object.entries(this.file.seen)) if (until < t) delete this.file.seen[k];
    this.file.cache = this.file.cache.filter((c) => c.exp >= t);
  }
}

/** An error the executor throws to say why it refused, in words a person reads on their phone. */
export class Refusal extends Error { constructor(readonly code: string, message: string) { super(message); } }
