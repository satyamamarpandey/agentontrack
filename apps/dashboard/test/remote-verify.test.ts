// What the phone believes from the relay. Negative regressions from the 2026-11-19 audit: a swapped computer key that keeps the old
// fingerprint text, a genuine answer to a different request, a snapshot of another project, and a request that outlives the phone's wait.
import { describe, expect, it } from 'vitest';
import { createIdentity, fingerprint } from '@agentontrack/remote';
import { answersRequest, fingerprintOfKey, isSnapshotNamed, REQUEST_GRACE_MS, requestExpiry } from '../src/remote-verify';

describe('the computer fingerprint a phone shows', () => {
  it('is worked out from the key, so a swapped key shows a different fingerprint whatever text is stored beside it', async () => {
    const real = await createIdentity();
    const attacker = await createIdentity();
    const shownForReal = await fingerprintOfKey(real.pub);
    const shownForSwapped = await fingerprintOfKey(attacker.pub);
    expect(shownForReal).toBe(await fingerprint(real.pub));
    expect(shownForReal).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    // The attacker rewrites the document: their key, the real computer's fingerprint text. The phone ignores the text.
    const tamperedDoc = { pub: attacker.pub, fingerprint: shownForReal };
    expect(await fingerprintOfKey(tamperedDoc.pub)).toBe(shownForSwapped);
    expect(shownForSwapped).not.toBe(shownForReal);
  });
  it('a missing or malformed key has no fingerprint to agree with', async () => {
    for (const bad of [null, undefined, {}, { sign: 'x' }, { sign: '', agree: '' }, { sign: 7, agree: 8 }, 'text']) expect(await fingerprintOfKey(bad)).toBe('');
  });
});

describe('answers and snapshots are believed only as what they say they are', () => {
  it('only the answer to this request counts', () => {
    expect(answersRequest({ kind: 'response', rid: 'r1' }, 'r1')).toBe(true);
    expect(answersRequest({ kind: 'response', rid: 'r2' }, 'r1'), 'a genuine answer to another request').toBe(false);
    expect(answersRequest({ kind: 'snapshot', rid: 'r1' }, 'r1'), 'a snapshot in an answer\'s place').toBe(false);
    expect(answersRequest({ kind: 'request', rid: 'r1' }, 'r1'), 'the phone\'s own request reflected back').toBe(false);
    expect(answersRequest(null, 'r1')).toBe(false);
    expect(answersRequest(undefined, 'r1')).toBe(false);
  });
  it('only the snapshot of that name counts', () => {
    expect(isSnapshotNamed({ kind: 'snapshot', rid: 'index' }, 'index')).toBe(true);
    expect(isSnapshotNamed({ kind: 'snapshot', rid: 'other-project' }, 'index'), 'another project\'s snapshot').toBe(false);
    expect(isSnapshotNamed({ kind: 'response', rid: 'index' }, 'index'), 'an answer in a snapshot\'s place').toBe(false);
    expect(isSnapshotNamed(null, 'index')).toBe(false);
  });
});

describe('a request stops being valid shortly after the phone stops waiting', () => {
  it('expires one grace period after the wait, never five minutes later', () => {
    const t = 1_800_000_000_000;
    expect(requestExpiry(t, 60_000)).toBe(t + 60_000 + REQUEST_GRACE_MS);
    expect(requestExpiry(t, 60_000) - t).toBeLessThan(2 * 60_000);
    expect(requestExpiry(t, 0) - t).toBe(1_000 + REQUEST_GRACE_MS);
  });
  it('is capped below the protocol limit even for a long wait', () => {
    const t = 1_800_000_000_000;
    expect(requestExpiry(t, 60 * 60_000) - t).toBe(9 * 60_000);
  });
});
