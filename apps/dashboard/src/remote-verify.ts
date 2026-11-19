import { fingerprint, type Envelope, type PublicIdentity } from '@agentontrack/remote';

/*
 * What the phone checks before it believes anything it finds on the relay. The relay (and anyone who can write the person's documents) is not
 * trusted, so each check uses only what the computer signed, or what this phone works out for itself.
 */

/**
 * The fingerprint the person compares with their computer's screen, worked out here from the key itself. A fingerprint stored beside the key
 * is never shown: whoever can write that document could keep the old text while swapping the key. An unusable key has no fingerprint.
 */
export async function fingerprintOfKey(pub: unknown): Promise<string> {
  const p = pub as Partial<PublicIdentity> | null;
  if (!p || typeof p.sign !== 'string' || typeof p.agree !== 'string' || !p.sign || !p.agree) return '';
  try { return await fingerprint({ sign: p.sign, agree: p.agree }); } catch { return ''; }
}

/** Only the answer to THIS request counts. Another genuine answer from the same computer, placed where this one is expected, is ignored. */
export const answersRequest = (env: Pick<Envelope, 'kind' | 'rid'> | null | undefined, rid: string): boolean => !!env && env.kind === 'response' && env.rid === rid;

/** A snapshot is believed only as the snapshot it says it is: a genuine message of another kind, or another project's snapshot, is refused. */
export const isSnapshotNamed = (env: Pick<Envelope, 'kind' | 'rid'> | null | undefined, name: string): boolean => !!env && env.kind === 'snapshot' && env.rid === name;

/** How long a request stays valid after the phone has stopped waiting for its answer. It covers a small difference between the two clocks. */
export const REQUEST_GRACE_MS = 30_000;
/** When a request sent now stops being valid. Never longer than nine minutes, whatever the wait. */
export const requestExpiry = (sentAt: number, waitMs: number): number => sentAt + Math.min(Math.max(1_000, waitMs) + REQUEST_GRACE_MS, 9 * 60_000);
