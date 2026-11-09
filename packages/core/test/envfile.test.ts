// e.env: optional, never required, and its values never leave the object that holds them.
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvConfig, findEnvFile, loadEnvFile, parseEnv } from '../src/index.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aot-env-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const SECRET = 'sk-test-DO-NOT-PRINT-1234567890';
const file = (text: string) => { const f = join(dir, 'e.env'); writeFileSync(f, text); return f; };

describe('parsing', () => {
  it('reads KEY=value, comments, quotes and export, and skips anything else', () => {
    expect(parseEnv(['# note', '', 'A=1', 'export B="two words"', "C='x'", 'D=val # trailing', 'not a line', '1BAD=x', '  E = 5  '].join('\n'))).toEqual({ A: '1', B: 'two words', C: 'x', D: 'val', E: '5' });
    expect(parseEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('a missing or empty file', () => {
  it('breaks nothing: no keys set, paid mode off, default Ollama address', () => {
    for (const cfg of [loadEnvFile(null), loadEnvFile(join(dir, 'nope.env')), loadEnvFile(file('# only comments\nAOT_ALLOW_PAID_API=\nANTHROPIC_API_KEY=\n'))]) {
      expect(cfg.allowPaidApi).toBe(false);
      expect(cfg.ollamaHost).toBe('http://127.0.0.1:11434');
      expect(cfg.keysFor('claude-code')).toEqual({});
      expect(cfg.describe().keys.every((k) => !k.set)).toBe(true);
    }
  });
});

describe('values never leak', () => {
  const cfg = () => loadEnvFile(file(`AOT_ALLOW_PAID_API=1\nANTHROPIC_API_KEY=${SECRET}\nOPENAI_API_KEY=${SECRET}2\nSOMETHING_ELSE=${SECRET}3\n`));
  it('not through JSON, string conversion, inspect or describe', () => {
    const c = cfg();
    for (const text of [JSON.stringify(c), String(c), inspect(c, { depth: 5, showHidden: true }), JSON.stringify(c.describe()), `${c}`]) expect(text, text).not.toContain(SECRET);
    expect(c.describe().keys.find((k) => k.name === 'ANTHROPIC_API_KEY')).toEqual({ name: 'ANTHROPIC_API_KEY', set: true, secret: true });
  });
  it('and never into process.env', () => {
    cfg();
    expect(process.env.ANTHROPIC_API_KEY ?? '').not.toContain('DO-NOT-PRINT');
    expect(Object.values(process.env).some((v) => v?.includes('DO-NOT-PRINT'))).toBe(false);
  });
  it('and a name that is not listed is ignored, only its name is reported', () => {
    const c = cfg();
    expect(c.describe().ignoredNames).toEqual(['SOMETHING_ELSE']);
    expect(c.get('ANTHROPIC_API_KEY')).toBe(SECRET);
    expect(JSON.stringify(c.describe())).not.toContain(`${SECRET}3`);
  });
});

describe('paid API mode', () => {
  it('gives an agent its own key only when AOT_ALLOW_PAID_API is exactly 1', () => {
    expect(loadEnvFile(file(`ANTHROPIC_API_KEY=${SECRET}\n`)).keysFor('claude-code')).toEqual({});
    expect(loadEnvFile(file(`AOT_ALLOW_PAID_API=true\nANTHROPIC_API_KEY=${SECRET}\n`)).keysFor('claude-code')).toEqual({});
    const on = loadEnvFile(file(`AOT_ALLOW_PAID_API=1\nANTHROPIC_API_KEY=${SECRET}\nOPENAI_API_KEY=other\n`));
    expect(on.keysFor('claude-code')).toEqual({ ANTHROPIC_API_KEY: SECRET });
    expect(on.keysFor('codex')).toEqual({ OPENAI_API_KEY: 'other' });
    expect(on.keysFor('gemini')).toEqual({});
  });
});

describe('where it is found', () => {
  it('prefers the explicit path, then the working folder, and can be turned off', () => {
    const cwd = join(dir, 'w'); mkdirSync(cwd);
    expect(findEnvFile(cwd, { AGENTONTRACK_HOME: join(dir, 'h') })).toBeNull();
    writeFileSync(join(cwd, 'e.env'), 'A=1');
    expect(findEnvFile(cwd, { AGENTONTRACK_HOME: join(dir, 'h') })).toBe(join(cwd, 'e.env'));
    const other = join(dir, 'other.env'); writeFileSync(other, 'A=2');
    expect(findEnvFile(cwd, { AGENTONTRACK_ENV_FILE: other })).toBe(other);
    expect(findEnvFile(cwd, { AGENTONTRACK_ENV_FILE: 'none' })).toBeNull();
  });
});

describe('the repository', () => {
  const root = join(__dirname, '..', '..', '..');
  it('ignores e.env and tracks only the example', () => {
    const git = (a: string) => execSync(`git ${a}`, { cwd: root, encoding: 'utf8' });
    expect(git('check-ignore e.env').trim()).toBe('e.env');
    expect(() => git('check-ignore e.env.example')).toThrow();
    expect(git('ls-files e.env').trim()).toBe('');
  });
  it('the example holds no value for any key', () => {
    const vals = parseEnv(readFileSync(join(root, 'e.env.example'), 'utf8'));
    expect(Object.values(vals).every((v) => v === '')).toBe(true);
    expect(new EnvConfig(vals, null).describe().keys.length).toBeGreaterThan(0);
  });
});
