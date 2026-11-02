import { createHash } from 'node:crypto';
import { fingerprint, snapshotKey, type Envelope } from '@agentontrack/remote';
import { RemoteHost, type Executor, type Level, type RemoteFile, type TrustedDevice } from './remote-host.js';
import type { PendingDevice, Transport } from './remote-transport.js';

export interface ServiceOptions {
  file: RemoteFile;
  save: (f: RemoteFile) => void;
  executor: Executor;
  transport: Transport;
  /** What to publish: the project list, and one snapshot per project. Called often, so they must be cheap. */
  list: () => unknown;
  projects: () => { id: string; snapshot: () => unknown }[];
  version: string;
  snapshotEveryMs?: number;
  heartbeatEveryMs?: number;
  now?: () => number;
}

export interface ServiceStatus {
  running: boolean; online: boolean; lastError: string; degraded: 'quota' | null;
  computerId: string; name: string; fingerprint: string;
  devices: (Pick<TrustedDevice, 'did' | 'name' | 'level' | 'fingerprint' | 'trustedAt' | 'revokedAt'>)[];
  pending: { did: string; name: string; fingerprint: string }[];
  maxUsdPerRun: number;
}

const QUOTA_BACKOFF_MS = 10 * 60_000;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Runs the phone link: takes sealed requests off the channel, lets the host decide, writes back the sealed answer, and keeps the phones' view
 * fresh. It holds no authority of its own, and it treats a refusal from Firebase for quota as a pause and not as a failure.
 */
export class RemoteService {
  readonly host: RemoteHost;
  private pending: PendingDevice[] = [];
  private pendingFp = new Map<string, string>();
  private lastError = '';
  private online = false;
  private running = false;
  private quotaUntil = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private inflight = new Set<string>();
  private published = new Map<string, { digest: string; at: number }>();
  private now: () => number;

  constructor(private o: ServiceOptions) {
    this.now = o.now ?? Date.now;
    this.host = new RemoteHost(o.file, o.executor, o.save, this.now);
  }

  async start(): Promise<void> {
    await this.host.init();
    if (!this.o.file.link) throw new Error('This computer is not linked to an account yet');
    await this.o.transport.start({
      onRequest: (env) => { void this.onRequest(env); },
      onDevices: (list) => { void this.onDevices(list); },
      onError: (e) => { this.online = false; this.lastError = this.explain(e); },
    });
    this.running = true; this.online = true; this.lastError = '';
    await this.beat();
    await this.publish(true);
    this.timers.push(setInterval(() => void this.beat(), this.o.heartbeatEveryMs ?? 60_000), setInterval(() => void this.publish(false), this.o.snapshotEveryMs ?? 4_000));
  }

  async stop(): Promise<void> {
    this.running = false; this.online = false;
    for (const t of this.timers.splice(0)) clearInterval(t);
    await this.o.transport.stop();
  }

  private explain(e: unknown): string {
    const code = (e as { code?: string })?.code ?? '';
    if (code === 'resource-exhausted') { this.quotaUntil = this.now() + QUOTA_BACKOFF_MS; return 'quota: the free Firebase allowance for today is used up, so updates are paused'; }
    if (code === 'permission-denied') return 'permission denied: the computer\'s link was removed or the rules changed';
    if (code === 'unavailable') return 'cannot reach Firebase right now';
    return (e as Error)?.message ?? 'unknown error';
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.now() < this.quotaUntil) return undefined;
    try { const r = await fn(); this.online = true; return r; }
    catch (e) { this.lastError = this.explain(e); if ((e as { code?: string }).code !== 'resource-exhausted') this.online = false; return undefined; }
  }

  private async beat() { await this.guarded(() => this.o.transport.heartbeat(this.o.version)); }

  private async onRequest(env: Envelope): Promise<void> {
    const key = `${env.did}:${env.rid}`;
    if (this.inflight.has(key) || !this.running) return;
    this.inflight.add(key);
    try {
      const answer = await this.host.handle(env);
      if (answer) await this.guarded(() => this.o.transport.respond(answer));
      // Whatever it was, it has been dealt with, so it is taken off the channel. Nothing waits there to be replayed.
      await this.guarded(() => this.o.transport.removeRequest(env.rid));
    } finally { this.inflight.delete(key); }
  }

  private async onDevices(list: PendingDevice[]) {
    this.pending = list.filter((d) => d.status === 'pending' && d.pub?.sign && d.pub?.agree && !this.host.state.devices.some((x) => x.did === d.did && !x.revokedAt));
    // Worked out from the key as it is now, every time. A phone that swaps its key must show the fingerprint of the new key.
    this.pendingFp.clear();
    for (const d of this.pending) this.pendingFp.set(d.did, await fingerprint(d.pub));
  }

  /** A person has confirmed, on this computer, that the fingerprint on the phone's screen is the one shown here. */
  async trust(did: string, level: Level): Promise<TrustedDevice> {
    const d = this.pending.find((x) => x.did === did);
    if (!d) throw new Error('That phone is not waiting to be approved');
    const t = await this.host.trust(did, d.name, d.pub, level);
    await this.guarded(() => this.o.transport.setDeviceStatus(did, 'trusted'));
    this.pending = this.pending.filter((x) => x.did !== did);
    await this.publish(true);
    return t;
  }

  async revoke(did: string): Promise<boolean> {
    const ok = this.host.revoke(did);
    if (ok) await this.guarded(() => this.o.transport.setDeviceStatus(did, 'revoked'));
    for (const k of this.published.keys()) if (k.startsWith(`${did}__`)) this.published.delete(k);
    return ok;
  }

  /** Writes a snapshot per trusted phone, only when something changed, or every few minutes so its age stays honest. */
  async publish(force: boolean): Promise<void> {
    if (!this.running || this.now() < this.quotaUntil) return;
    const devices = this.host.state.devices.filter((d) => !d.revokedAt);
    if (!devices.length) return;
    const parts: [string, unknown][] = [['list', this.o.list()]];
    for (const p of this.o.projects()) parts.push([await snapshotKey(this.o.file.computerId, p.id), p.snapshot()]);
    for (const [name, body] of parts) {
      const stable = JSON.parse(JSON.stringify(body, (k, v) => (k === 'generatedAt' ? undefined : v)));
      const d = digest(stable);
      for (const dev of devices) {
        const id = `${dev.did}__${name}`;
        const prev = this.published.get(id);
        if (!force && prev && prev.digest === d && this.now() - prev.at < 5 * 60_000) continue;
        const t = this.now();
        const env = await this.host.reply(dev, name, 'snapshot', { ...(body as object), generatedAt: new Date(t).toISOString() }, 10 * 60_000);
        const done = await this.guarded(() => this.o.transport.snapshot(id, env));
        if (done !== undefined || this.now() >= this.quotaUntil) this.published.set(id, { digest: d, at: t });
      }
    }
  }

  async status(): Promise<ServiceStatus> {
    return {
      running: this.running, online: this.online && this.now() >= this.quotaUntil, lastError: this.lastError, degraded: this.now() < this.quotaUntil ? 'quota' : null,
      computerId: this.o.file.computerId, name: this.o.file.name, fingerprint: await this.host.fingerprint(),
      devices: this.o.file.devices.map(({ did, name, level, fingerprint: fp, trustedAt, revokedAt }) => ({ did, name, level, fingerprint: fp, trustedAt, ...(revokedAt ? { revokedAt } : {}) })),
      pending: this.pending.map((d) => ({ did: d.did, name: d.name, fingerprint: this.pendingFp.get(d.did) ?? '' })),
      maxUsdPerRun: this.o.file.maxUsdPerRun,
    };
  }
}
