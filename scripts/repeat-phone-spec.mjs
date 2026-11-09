// Runs the phone end-to-end spec N times, each time in a FRESH Firebase emulator, to look for intermittent failures; keeps one report and one set of traces per repetition,
// and prints the cancel test's own evidence for each. Used by ci.yml only when asked (input repeat_phone). Needs Java and the emulators, so it runs in CI, not on every machine.
//   node scripts/repeat-phone-spec.mjs <n>
// A fresh emulator per repetition because the spec signs in to one emulated account and links a computer: repeating inside one emulator would carry state from one repetition
// into the next and could fail for reasons that have nothing to do with the test under study.
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CANCEL = /a prompt can be cancelled from the phone/;

/** Reads Playwright JSON reports (one per repetition) and says what happened. Pure, so it can be tested. */
export function summarize(reports) {
  const rows = [];
  reports.forEach((rep, i) => {
    const tests = [];
    const walk = (suite) => { for (const s of suite.suites ?? []) walk(s); for (const sp of suite.specs ?? []) for (const t of sp.tests ?? []) tests.push({ title: sp.title, test: t }); };
    for (const s of rep?.suites ?? []) walk(s);
    const cancel = tests.find((x) => CANCEL.test(x.title));
    const result = cancel?.test.results?.at(-1);
    const notes = [...(cancel?.test.annotations ?? []), ...(result?.annotations ?? [])].filter((a) => a.type === 'cancel-evidence');
    let evidence = null; try { evidence = notes.length ? JSON.parse(notes.at(-1).description) : null; } catch { evidence = null; }
    rows.push({
      repetition: i + 1,
      stats: rep?.stats ?? null,
      cancelStatus: result?.status ?? (cancel ? 'no result' : 'not found'),
      cancelMs: result?.duration ?? null,
      evidence,
      failedTests: tests.filter((x) => x.test.results?.some((r) => r.status !== 'passed' && r.status !== 'skipped')).map((x) => x.title),
      skipped: tests.filter((x) => x.test.results?.every((r) => r.status === 'skipped')).length,
    });
  });
  const problems = [];
  for (const r of rows) {
    if (!r.stats) problems.push(`repetition ${r.repetition}: no report (the run did not finish)`);
    else {
      if (r.stats.unexpected > 0 || r.failedTests.length) problems.push(`repetition ${r.repetition}: failed: ${r.failedTests.join('; ') || r.stats.unexpected + ' unexpected'}`);
      if (r.stats.skipped > 0 || r.skipped > 0) problems.push(`repetition ${r.repetition}: ${r.stats.skipped || r.skipped} test(s) skipped, so nothing was proved`);
      if (r.stats.flaky > 0) problems.push(`repetition ${r.repetition}: ${r.stats.flaky} flaky test(s)`);
    }
    if (r.cancelStatus !== 'passed') problems.push(`repetition ${r.repetition}: the cancel test did not pass (${r.cancelStatus})`);
    else if (!r.evidence) problems.push(`repetition ${r.repetition}: the cancel test passed but recorded no evidence`);
    else if (!r.evidence.wasNew || r.evidence.refusalShown || r.evidence.finishedFileWritten) problems.push(`repetition ${r.repetition}: the evidence says the cancel was not of its own run, or was refused, or a delayed write happened`);
  }
  return { rows, problems, ok: problems.length === 0 && rows.length > 0 };
}

export function format(s) {
  const lines = s.rows.map((r) => `#${r.repetition}: cancel test ${r.cancelStatus}${r.cancelMs != null ? ` in ${r.cancelMs} ms` : ''}; ${r.stats ? `${r.stats.expected} passed, ${r.stats.unexpected} failed, ${r.stats.skipped} skipped, ${r.stats.flaky} flaky` : 'no report'}${r.evidence ? `\n    evidence: ${JSON.stringify(r.evidence)}` : ''}`);
  return `${lines.join('\n')}\n${s.ok ? `ALL ${s.rows.length} REPETITIONS PASSED` : `PROBLEMS:\n  ${s.problems.join('\n  ')}`}`;
}

const main = () => {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n < 1 || n > 30) { console.error('usage: repeat-phone-spec.mjs <1..30>'); process.exit(2); }
  const win = process.platform === 'win32';
  for (let i = 1; i <= n; i++) {
    const dir = `test-results-repeat/run-${i}`;
    mkdirSync(dir, { recursive: true });
    console.log(`\n=== repetition ${i} of ${n}, in a fresh emulator ===`);
    const cmd = `pnpm exec playwright test phone.spec --project=chromium --workers=1 --reporter=list,json --output=${dir}/out`;
    spawnSync('pnpm', ['dlx', 'firebase-tools@15', 'emulators:exec', '--only', 'auth,firestore', '--project', 'demo-agentontrack', cmd], { stdio: 'inherit', shell: win, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: `${dir}/e2e.json` } });
  }
  const reports = [];
  for (let i = 1; i <= n; i++) { const f = `test-results-repeat/run-${i}/e2e.json`; try { reports.push(existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null); } catch { reports.push(null); } }
  const s = summarize(reports);
  console.log(`\n${format(s)}`);
  process.exit(s.ok ? 0 : 1);
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
