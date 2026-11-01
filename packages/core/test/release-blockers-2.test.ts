import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAnchor, checkRemote, Project, pushAnchor, stateDirFor } from '../src/index.js';

let dir: string; let root: string; let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-rb2-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  p = new Project(root);
});
afterEach(() => { try { p.close(); } catch { /* closed by the test */ } rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('anchor remote cannot run commands', () => {
  it('refuses options and helper transports, including when stored', () => {
    for (const bad of ['--upload-pack=touch x', '-x', 'ext::sh -c touch', 'foo::bar', '']) {
      expect(() => checkRemote(bad), bad).toThrow(/acceptable/);
      expect(() => pushAnchor(p, bad), bad).toThrow(/acceptable/);
      expect(() => checkAnchor(p, bad), bad).toThrow(/acceptable/);
      expect(() => p.human.configureAnchor(bad, 1), bad).toThrow(/acceptable/);
    }
  });
  it('the option form runs nothing', () => {
    const marker = join(dir, 'ran');
    try { pushAnchor(p, `--upload-pack=touch ${marker};`); } catch { /* refused */ }
    expect(existsSync(marker)).toBe(false);
  });
});

describe('a rebuilt log with a new instance', () => {
  it('fails verify, because the remote still holds the old log\'s anchors', () => {
    const b = join(dir, 'a.git');
    mkdirSync(b);
    spawnSync('git', ['init', '--bare', '-q'], { cwd: b });
    pushAnchor(p, b);
    expect(checkAnchor(p, b).ok).toBe(true);
    p.close();
    // The attacker deletes the state and starts a clean log for the same project, then anchors it.
    rmSync(stateDirFor(root), { recursive: true, force: true, maxRetries: 5 });
    rmSync(p.witness.path, { force: true });
    p = new Project(root);
    pushAnchor(p, b);
    const r = checkAnchor(p, b);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/another log/);
  });
});
