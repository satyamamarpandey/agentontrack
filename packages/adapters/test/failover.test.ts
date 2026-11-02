import { describe, expect, it } from 'vitest';
import { failoverOptions, runtimeFacts } from '../src/providers.js';

describe('failover is by what the receiver can enforce', () => {
  it('lists who can take over, with what they would not do, and puts hard gates first', () => {
    const opts = failoverOptions('claude-code', ['claude-code', 'codex', 'opencode', 'cline', 'continue', 'mystery-agent']);
    expect(opts.map((o) => o.id)).not.toContain('claude-code');
    expect(opts[0]).toMatchObject({ id: 'opencode', usable: true });
    const codex = opts.find((o) => o.id === 'codex')!;
    expect(codex.usable).toBe(true);
    expect(codex.warnings.join()).toMatch(/runs the action anyway/);
    expect(codex.warnings.join()).toMatch(/weaker gate/);
    expect(codex.warnings.join()).toMatch(/do not carry over/);
    expect(opts.find((o) => o.id === 'mystery-agent')).toMatchObject({ usable: false, why: [expect.stringMatching(/no adapter/)] });
    expect(opts.at(-1)!.usable).toBe(false);
  });

  it('calls a host open if any way of failing lets the action run, and does not guess about what it does not know', () => {
    expect(runtimeFacts('copilot').hostFailMode).toBe('open');
    expect(runtimeFacts('gemini').hostFailMode).toBe('open');
    expect(runtimeFacts('cline').hostFailMode).toBe('open');
    expect(runtimeFacts('opencode').hostFailMode).toBe('closed');
    expect(runtimeFacts('claude-code').hostFailMode).toBe('closed');
    expect(runtimeFacts('nothing-known')).toMatchObject({ known: false, enforcesShell: false, hostFailMode: 'unknown' });
  });

  it('says nothing about model quality or remaining quota, which it does not know', () => {
    const text = JSON.stringify(failoverOptions('codex', ['claude-code', 'opencode']));
    expect(text).not.toMatch(/quota|remaining|better|smarter|faster|cheaper/i);
  });
});
