import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSpec, planWorkflow } from '../src/index.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aot-spec-')); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'parser.ts'), 'export {}'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const GOOD = `# Fix the date parser

## Problem
The parser rejects two-digit years.

## Plan
Add a pivot year.

\`\`\`ts
export interface ParseOptions { pivot: number; strict?: boolean }
export function parseDate(input: string, opts: ParseOptions): Date | null {
\`\`\`

## Alternatives
Reject two-digit years outright. Rejected: it breaks existing callers.

## Files to change
- \`src/parser.ts\` changes parseDate
- \`src/pivot.ts\` is a new file
`;

describe('checkSpec', () => {
  it('passes a document that writes everything down', () => {
    const r = checkSpec(GOOD, root);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe('go');
    expect(r.paths).toEqual([{ path: 'src/parser.ts', exists: true, markedNew: false }, { path: 'src/pivot.ts', exists: false, markedNew: true }]);
  });
  it('fails a vague document and says what is missing', () => {
    const r = checkSpec('# Idea\n\nWe should somehow make dates better, etc.\n', root);
    expect(r.verdict).toBe('no-go');
    const codes = r.findings.map((f) => f.code);
    for (const c of ['missing-problem', 'missing-plan', 'missing-alternatives', 'missing-files', 'no-paths', 'no-data-structures', 'no-signatures', 'vague']) expect(codes).toContain(c);
  });
  it('flags a path that does not exist and is not marked new', () => {
    const r = checkSpec(GOOD.replace('`src/pivot.ts` is a new file', '`src/pivot.ts` handles it'), root);
    expect(r.findings.map((f) => f.code)).toContain('unknown-path');
  });
  it('does not read outside the project', () => {
    const r = checkSpec(GOOD + '\nSee `../../etc/passwd` and `/etc/hosts`.\n', root);
    expect(r.paths.filter((p) => p.exists)).toHaveLength(1);
  });
  it('ignores vague words inside code', () => {
    expect(checkSpec(GOOD + '\n```\n// TODO etc.\n```\n', root).findings.filter((f) => f.code === 'vague')).toEqual([]);
  });
  it('states what it cannot judge', () => {
    expect(checkSpec(GOOD, root).limits).toMatch(/does not judge/);
  });
});

describe('spec-review workflow', () => {
  const team = [{ agent: 'claude-code', role: 'analyze' as const }, { agent: 'codex', role: 'review' as const }, { agent: 'gemini', role: 'review' as const }];
  it('plans a draft, a structure check, fresh reviewers, a go/no-go and a person', () => {
    const p = planWorkflow(team, 'spec-review');
    expect(p.problems).toEqual([]);
    expect(p.stages.map((s) => s.id)).toEqual(['draft', 'structure-check', 'explain-back', 'attack-1', 'attack-2', 'attack-3', 'go-no-go', 'approve']);
    expect(p.stages.find((s) => s.id === 'approve')!.agent).toBe('person');
    expect(p.stages.filter((s) => s.role === 'review' && s.agent !== 'person').every((s) => s.isolated)).toBe(true);
    expect(p.stages.find((s) => s.id === 'structure-check')!.agent).toBe('checks');
  });
  it('refuses to plan without a drafter or a reviewer, and says so', () => {
    expect(planWorkflow([{ agent: 'codex', role: 'review' }], 'spec-review').problems.join(' ')).toMatch(/analyze/);
    expect(planWorkflow([{ agent: 'claude-code', role: 'analyze' }], 'spec-review').problems.join(' ')).toMatch(/review role/);
  });
  it('warns when one agent does every review, and when the drafter also reviews', () => {
    const one = planWorkflow([{ agent: 'claude-code', role: 'analyze' }, { agent: 'claude-code', role: 'review' }], 'spec-review');
    expect(one.warnings.join(' ')).toMatch(/same agent/);
    expect(one.warnings.join(' ')).toMatch(/drafts and also reviews/);
  });
});
