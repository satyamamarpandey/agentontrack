// The CI step that repeats the phone spec decides pass or fail with `summarize`, so a failure, a skip or a missing piece of evidence must never read as a pass.
// The reports here are small fakes in Playwright's JSON shape.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'scripts', 'repeat-phone-spec.mjs');
const { summarize, format } = (await import(pathToFileURL(FILE).href)) as { summarize: (r: unknown[]) => { ok: boolean; problems: string[]; rows: any[] }; format: (s: unknown) => string };

const GOOD = { runId: 'run_a', pid: 1, runsListedBeforeSending: ['run_old'], wasNew: true, refusalShown: false, finishedFileWritten: false, msClickToProcessGone: 40 };
const report = (over: { cancel?: object | null; stats?: object; others?: object[] } = {}) => ({
  stats: { expected: 12, unexpected: 0, skipped: 0, flaky: 0, ...over.stats },
  suites: [{ suites: [], specs: [
    ...(over.cancel === null ? [] : [{ title: 'a prompt can be cancelled from the phone, and the agent really stops', tests: [{ annotations: GOOD ? [{ type: 'cancel-evidence', description: JSON.stringify(GOOD) }] : [], results: [{ status: 'passed', duration: 1234, ...over.cancel }] }] }]),
    ...(over.others ?? []),
  ] }],
});

describe('repeat-phone-spec summarize', () => {
  it('passes when every repetition passed and recorded its own evidence', () => {
    const s = summarize([report(), report(), report()]);
    expect(s.ok).toBe(true);
    expect(s.problems).toEqual([]);
    expect(format(s)).toMatch(/ALL 3 REPETITIONS PASSED/);
  });
  it('fails when a repetition has a failed test, naming it', () => {
    const s = summarize([report(), report({ stats: { expected: 11, unexpected: 1 }, others: [{ title: 'another test', tests: [{ results: [{ status: 'failed' }] }] }] })]);
    expect(s.ok).toBe(false);
    expect(s.problems.join(' ')).toMatch(/repetition 2: failed: another test/);
  });
  it('fails when the cancel test failed', () => {
    const s = summarize([report({ cancel: { status: 'failed' }, stats: { unexpected: 1 } })]);
    expect(s.ok).toBe(false);
    expect(s.problems.join(' ')).toMatch(/cancel test did not pass \(failed\)/);
  });
  it('fails when anything was skipped, because nothing was proved', () => {
    expect(summarize([report({ stats: { skipped: 1 } })]).ok).toBe(false);
  });
  it('fails on a flaky test even though it passed on retry', () => {
    expect(summarize([report({ stats: { flaky: 1 } })]).problems.join(' ')).toMatch(/flaky/);
  });
  it('fails when the run produced no report', () => {
    const s = summarize([report(), null]);
    expect(s.ok).toBe(false);
    expect(s.problems.join(' ')).toMatch(/repetition 2: no report/);
  });
  it('fails when the cancel test is missing from the report', () => {
    const s = summarize([report({ cancel: null })]);
    expect(s.ok).toBe(false);
    expect(s.problems.join(' ')).toMatch(/not found/);
  });
  it('is not a pass with no repetitions at all', () => {
    expect(summarize([]).ok).toBe(false);
  });
});
