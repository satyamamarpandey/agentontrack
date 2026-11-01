import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand, Project } from '../src/index.js';

let dir: string;
let root: string;
let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl-w-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'test'), { recursive: true });
  p = new Project(root);
  p.human.setGoal({ statement: 'g' });
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const task = (criteria: unknown[]) => p.human.createTask({ title: 't', criteria });

describe('weak checks', () => {
  it('a command that always succeeds withholds VERIFIED, while still recording what ran', () => {
    const id = task([{ id: 'c', description: 'd', kind: 'command', command: 'echo ok' }]);
    const ev = p.verifyTask(id);
    expect(ev.status).toBe('IMPLEMENTED_UNVERIFIED');
    expect(ev.weakCriteria?.[0]).toMatch(/always succeeds/);
    expect(ev.reasons.join()).toMatch(/Weak check/);
  });

  it('flags a test command when the only tests are placeholders (the benchmark v3 case)', () => {
    writeFileSync(join(root, 'test', 'a.test.js'), "test('x', () => assert.ok(true));\n");
    const ev = p.evaluate(task([{ id: 'c', description: 'd', kind: 'command', command: 'npm test' }]));
    expect(ev.weakCriteria?.join()).toMatch(/placeholders/);
  });

  it('flags a test command with no test files, and an unhashed artifact', () => {
    expect(p.evaluate(task([{ id: 'c', description: 'd', kind: 'command', command: 'npm test' }])).weakCriteria?.join()).toMatch(/no test files/);
    expect(p.evaluate(task([{ id: 'c', description: 'd', kind: 'artifact', path: 'x' }])).weakCriteria?.join()).toMatch(/only checks that a file exists/);
  });

  it('does not flag real tests', () => {
    writeFileSync(join(root, 'test', 'a.test.js'), "test('x', () => assert.equal(add(1, 2), 3));\n");
    expect(p.evaluate(task([{ id: 'c', description: 'd', kind: 'command', command: 'npm test' }])).weakCriteria).toBeUndefined();
  });
});

describe('strict mode trusts the human\'s own criteria commands', () => {
  it('allows the criterion command with redirection, and still holds other programs', () => {
    p.human.setProfile('strict');
    task([{ id: 'c', description: 'd', kind: 'command', command: 'npm run check' }]);
    const go = (cmd: string) => { const c = classifyCommand(cmd); return p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: c.effects, opaque: c.opaque, coverage: 'enforced', rawInput: cmd }).decision; };
    expect(go('npm run check 2>&1')).toBe('allow');
    expect(go('node evil.js')).toBe('request_approval');
  });
});

