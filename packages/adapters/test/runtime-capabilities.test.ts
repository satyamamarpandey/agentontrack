import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, PROVIDERS, RUNTIME_CAPABILITIES, capabilitiesFor, capabilityMatrix } from '../src/index.js';

const root = join(__dirname, '..', '..', '..');
const cert = JSON.parse(readFileSync(join(root, 'benchmarks/results/provider-certification.json'), 'utf8')) as { entries: { id: string; status: string }[] };

describe('runtime capability contract', () => {
  it('gives every runtime a verdict and a note for every capability', () => {
    for (const [id, caps] of Object.entries(RUNTIME_CAPABILITIES)) {
      expect(Object.keys(caps).sort(), id).toEqual([...CAPABILITIES].sort());
      for (const c of CAPABILITIES) expect(caps[c].note.length, `${id}.${c}`).toBeGreaterThan(5);
    }
  });
  it('covers claude-code, codex, hermes and every provider adapter', () => {
    for (const id of ['claude-code', 'codex', 'hermes', ...Object.keys(PROVIDERS)]) expect(capabilitiesFor(id), id).not.toBeNull();
    expect(capabilitiesFor('nonexistent')).toBeNull();
    expect(capabilitiesFor('constructor')).toBeNull();
  });
  it('allows "supported" only with evidence that exists in the repository', () => {
    for (const [id, caps] of Object.entries(RUNTIME_CAPABILITIES)) for (const c of CAPABILITIES) {
      const claim = caps[c];
      if (claim.verdict === 'supported') {
        expect(claim.evidence, `${id}.${c}`).toBeTruthy();
        expect(existsSync(join(root, claim.evidence!)), `${id}.${c}: ${claim.evidence}`).toBe(true);
      } else expect(claim.evidence, `${id}.${c}`).toBeUndefined();
    }
  });
  it('claims session control as supported only where a real run is on record (Claude Code), never for fixture-only agents', () => {
    const companion = readFileSync(join(root, 'packages/companion/src/index.ts'), 'utf8');
    const startable = [...companion.matchAll(/\{ id: '([\w-]+)', name: '[^']+', installed: [^\n]*?canStart: (?!false)/g)].map((m) => m[1]);
    expect(startable).toEqual(['claude-code', 'codex']);
    for (const [id, caps] of Object.entries(RUNTIME_CAPABILITIES)) if (id !== 'claude-code' && id !== 'codex') {
      for (const c of ['startSession', 'sendPrompt', 'streamOutput', 'cancel'] as const) {
        expect(caps[c].verdict, `${id}.${c}`).not.toBe('supported');
        if (startable.includes(id)) expect(caps[c].verdict, `${id}.${c}`).toBe('unverified');
      }
    }
  });
  it('Codex is supported only where a real Codex run is on record with a PASS verdict', () => {
    for (const [c, claim] of Object.entries(RUNTIME_CAPABILITIES.codex!)) if ((claim as any).verdict === 'supported' && String((claim as any).evidence).endsWith('.json')) {
      const rec = JSON.parse(readFileSync(join(root, (claim as any).evidence), 'utf8'));
      expect(rec.verdict, `codex.${c}: ${(claim as any).evidence}`).toBe('PASS');
    }
    // The exec transport and attachments were never run against a real Codex.
    expect(RUNTIME_CAPABILITIES.codex!.attachments.verdict).toBe('unverified');
  });
  it('does not mark interception supported where the certification record is not verified', () => {
    for (const e of cert.entries) {
      const caps = capabilitiesFor(e.id);
      if (caps && e.status !== 'NATIVE_ENFORCEMENT_VERIFIED') expect(caps.approvalInterception.verdict, e.id).not.toBe('supported');
    }
  });
  it('does not mark hosted-model capabilities supported for agents with no hosted-model run', () => {
    for (const id of ['hermes']) for (const c of ['approvalInterception', 'toolUseObservation', 'usageReporting'] as const) expect(capabilitiesFor(id)![c].verdict, `${id}.${c}`).not.toBe('supported');
  });
  it('flattens to one row per runtime and capability', () => {
    expect(capabilityMatrix()).toHaveLength(Object.keys(RUNTIME_CAPABILITIES).length * CAPABILITIES.length);
  });
});
