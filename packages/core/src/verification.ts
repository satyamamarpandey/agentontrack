import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from './paths.js';
import { sha256 } from './store.js';

/** What a verification file looked like when the human created the task. Holds counts, not content. */
export interface VerificationEntry {
  hash: string;
  checks: number;
  disabled: number;
  thresholds: number[];
  scripts?: Record<string, string>;
}
export type VerificationManifest = Record<string, VerificationEntry>;

export interface VerificationFinding {
  path: string;
  severity: 'suspected-weakening' | 'changed' | 'strengthened';
  detail: string;
}

const CHECKS = /\b(?:expect|assert\w*|should|it|test|describe|def test_\w+)\s*[.(]/g;
const DISABLED = /\b(?:it|test|describe)\.(?:skip|todo)\b|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\.only\s*\(|--passWithNoTests|--pass-with-no-tests|\|\|\s*true\b|continue-on-error:\s*true/g;
const THRESHOLD = /(?:threshold|coverage|lines|branches|functions|statements)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/gi;

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const TRIVIAL_COMMAND = /^\s*(true|exit 0|:|echo\b.*|node -e ["']?0?["']?|node -e ["']process\.exit\(0\)["'])\s*$/;
const PLACEHOLDER_ASSERT = /\b(assert\.ok\(\s*true\s*\)|assert\(\s*true\s*\)|expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|assert\s+True\b)/;

/**
 * Flags checks that can pass without the work being done. A flagged check withholds VERIFIED until a human accepts
 * the warning. Heuristic: in benchmark v3 a placeholder test let an unfinished task reach VERIFIED, and a check this
 * does not recognise can still do the same.
 */
export function assessCriteria(criteria: { id: string; kind: string; command?: string | undefined; sha256?: string | undefined }[], root: string, verificationPaths: string[], files: string[]): string[] {
  const out: string[] = [];
  for (const c of criteria) {
    if (c.kind === 'command' && TRIVIAL_COMMAND.test(c.command ?? '')) out.push(`${c.id} runs a command that always succeeds`);
    if (c.kind === 'artifact' && !c.sha256) out.push(`${c.id} only checks that a file exists`);
  }
  if (criteria.some((c) => c.kind === 'command' && /\b(test|jest|vitest|pytest|mocha)\b/.test(c.command ?? ''))) {
    const tests = files.filter((f) => matchesAny(f, verificationPaths) && !f.endsWith('package.json') && !f.includes('.github/'));
    if (tests.length === 0) out.push('a test command is the check, but the project has no test files');
    let real = 0;
    let placeholder = 0;
    for (const f of tests) {
      let text = '';
      try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      if (PLACEHOLDER_ASSERT.test(text)) placeholder++;
      else if (count(text, CHECKS) > 0) real++;
    }
    if (placeholder > 0 && real === 0) out.push('the only tests are placeholders, such as assert.ok(true)');
    if (criteria.some((c) => c.kind === 'command' && /\b(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(c.command ?? ''))) {
      try {
        const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test;
        if (typeof script === 'string' && (TRIVIAL_COMMAND.test(script) || count(script, DISABLED) > 0)) out.push(`the test script does not really test anything: ${script}`);
      } catch { /* no package.json, or not JSON: the command itself will report that */ }
    }
  }
  return out;
}

export function inspectVerificationFile(absPath: string, relPath: string): VerificationEntry | null {
  let text: string;
  try { text = readFileSync(absPath, 'utf8'); } catch { return null; }
  const entry: VerificationEntry = {
    hash: sha256(text), checks: count(text, CHECKS), disabled: count(text, DISABLED),
    thresholds: [...text.matchAll(THRESHOLD)].map((m) => Number(m[1])),
  };
  if (relPath.endsWith('package.json')) {
    try {
      const scripts = JSON.parse(text).scripts ?? {};
      entry.scripts = Object.fromEntries(Object.entries(scripts).filter(([k]) => /test|check|verify|lint|ci/.test(k))) as Record<string, string>;
      // Only script changes matter here: dependency bumps in package.json are not weakening.
      entry.hash = sha256(JSON.stringify(entry.scripts));
      entry.checks = 0;
      entry.disabled = count(JSON.stringify(entry.scripts), DISABLED);
      entry.thresholds = [];
    } catch { /* leave as text */ }
  }
  return entry;
}

/** Heuristic by construction. A renamed test or a hollowed-out assertion that keeps its counts is not caught. */
export function compareManifests(base: VerificationManifest, now: VerificationManifest): VerificationFinding[] {
  const out: VerificationFinding[] = [];
  for (const [path, b] of Object.entries(base)) {
    const n = now[path];
    if (!n) { out.push({ path, severity: 'suspected-weakening', detail: 'verification file deleted' }); continue; }
    if (n.hash === b.hash) continue;
    const reasons: string[] = [];
    if (n.checks < b.checks) reasons.push(`checks fell from ${b.checks} to ${n.checks}`);
    if (n.disabled > b.disabled) reasons.push(`disabled or skipped markers rose from ${b.disabled} to ${n.disabled}`);
    if (b.thresholds.some((t, i) => n.thresholds[i] !== undefined && n.thresholds[i]! < t)) reasons.push('a threshold was lowered');
    if (b.thresholds.length > n.thresholds.length) reasons.push('a threshold was removed');
    if (b.scripts && JSON.stringify(b.scripts) !== JSON.stringify(n.scripts)) reasons.push('a test or check script changed');
    if (reasons.length) out.push({ path, severity: 'suspected-weakening', detail: reasons.join('; ') });
    else if (n.checks > b.checks) out.push({ path, severity: 'strengthened', detail: `checks rose from ${b.checks} to ${n.checks}` });
    else out.push({ path, severity: 'changed', detail: 'content changed with no drop in checks' });
  }
  for (const path of Object.keys(now)) {
    if (!base[path]) out.push({ path, severity: 'strengthened', detail: 'new verification file' });
  }
  return out;
}
