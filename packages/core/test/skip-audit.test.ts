// Every skipped test is a place where a regression can hide, so each skip site is listed here with the reason it is acceptable. Adding a skip
// fails this test until the list is updated (and the readiness record in docs/PRODUCT_READINESS.md says why), which makes the addition a reviewed
// decision and not a quiet one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP = /\b(?:test|it|describe)\.(?:skip|skipIf|fixme|todo)\(|\b(?:test|it)\.fail\(/g;

/** file -> number of skip sites, and why they are accepted. */
const AUDITED: Record<string, { count: number; why: string }> = {
  'packages/core/test/hardening.test.ts': { count: 0, why: 'the "it.skip" there is text written into a fixture file to test skipped-test detection, not a skip' },
  'packages/vscode/test/live.test.ts': { count: 1, why: 'real inference; runs only with AGENTONTRACK_LIVE=1' },
  'e2e/accounts-configured.spec.ts': { count: 2, why: 'needs a site built with a Firebase config; the early-access gate test applies only while installs are gated (NEXT_PUBLIC_INSTALL_PUBLIC unset)' },
  'e2e/early-access-emulator.spec.ts': { count: 1, why: 'Firebase emulator job; that job fails on any skip' },
  'e2e/early-access.spec.ts': { count: 1, why: 'axe runs once, in Chromium' },
  'e2e/accounts.spec.ts': { count: 1, why: 'Firebase emulator job; that job fails on any skip' },
  'e2e/phone.spec.ts': { count: 1, why: 'Firebase emulator job; that job fails on any skip' },
  'e2e/rules.spec.ts': { count: 1, why: 'Firebase emulator job; that job fails on any skip' },
  'e2e/audit.spec.ts': { count: 1, why: 'screenshot/audit tool, needs an output folder' },
  'e2e/capture.spec.ts': { count: 1, why: 'screenshot capture tool' },
  'e2e/dashboard.spec.ts': { count: 3, why: 'per-browser conditions: no Tab key on mobile, WebKit tab order, axe runs once' },
  'e2e/projects.spec.ts': { count: 3, why: 'per-browser conditions: no arrow keys on mobile, WebKit tab order, axe runs once' },
  'e2e/live-public-workspace.spec.ts': { count: 1, why: 'real inference; runs only with AGENTONTRACK_LIVE=1' },
  'e2e/live-workspace.spec.ts': { count: 1, why: 'real inference; runs only with AGENTONTRACK_LIVE=1' },
  'e2e/dashboard-stop.spec.ts': { count: 1, why: 'the Workspace is laid out differently on a phone; the stop handling is not viewport-specific' },
  'e2e/phone-new-session.spec.ts': { count: 1, why: 'Firebase emulator job; needs the emulators and a site built for them' },
  'e2e/sessions.spec.ts': { count: 2, why: 'the Workspace is laid out differently on a phone (narrow widths are checked on the desktop projects); archiving needs a terminal proof on some builds, and the wording is covered by companion tests' },
  'e2e/phone-shell.spec.ts': { count: 1, why: 'applies only to the build without accounts' },
  'e2e/public-pairing.spec.ts': { count: 2, why: 'RISK: skips when the browser blocks the page from reaching the companion. The block is recorded as a result, but a regression that causes it would also skip. Listed in the audit doc' },
  'e2e/site.spec.ts': { count: 10, why: 'build-variant conditions (accounts or not, installs gated or not, release published or not) and axe once; each variant has its own assertions in the same file, so a skip here is always paired with a test that runs' },
  'e2e/workspace.spec.ts': { count: 3, why: 'desktop/mobile split and axe once' },
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.') || name === 'site-repo' || name === 'dist-pages' || name === 'dist-release') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
};

describe('skipped tests', () => {
  it('are exactly the audited ones', () => {
    const found: Record<string, number> = {};
    for (const f of [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'e2e')), ...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'benchmarks'))]) {
      const n = (readFileSync(f, 'utf8').match(SKIP) ?? []).length;
      if (n) found[relative(ROOT, f).split('\\').join('/')] = n;
    }
    const expected = Object.fromEntries(Object.entries(AUDITED).filter(([, v]) => v.count > 0).map(([k, v]) => [k, v.count]));
    // The hardening fixture text matches the pattern once as a string, which is why it is listed with count 0 above and tolerated here.
    delete found['packages/core/test/hardening.test.ts'];
    delete found['packages/core/test/skip-audit.test.ts'];
    expect(found).toEqual(expected);
  });
});
