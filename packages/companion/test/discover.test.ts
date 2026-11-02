import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverRepos, parseGithubUrl } from '../src/index.js';

let top: string;
beforeEach(() => { top = mkdtempSync(join(tmpdir(), 'aot-disc-')); });
afterEach(() => rmSync(top, { recursive: true, force: true, maxRetries: 5 }));
const repo = (...p: string[]) => { const d = join(top, ...p); mkdirSync(join(d, '.git'), { recursive: true }); return d; };

describe('discoverRepos', () => {
  it('finds repositories one and two levels down, and marks the ones already added', () => {
    const a = repo('a'); repo('group', 'b');
    const r = discoverRepos(top, 2, new Set([resolve(a)]));
    expect(r.found.map((f) => [f.name, f.registered])).toEqual([['a', true], ['b', false]]);
  });
  it('does not enter a repository, dot-folders or dependency folders', () => {
    repo('a'); repo('a', 'inner'); repo('.hidden', 'x'); repo('node_modules', 'dep'); repo('vendor', 'v');
    expect(discoverRepos(top, 3, new Set()).found.map((f) => f.name)).toEqual(['a']);
  });
  it('stops at the depth asked for', () => {
    repo('l1', 'l2', 'l3');
    expect(discoverRepos(top, 2, new Set()).found).toEqual([]);
    expect(discoverRepos(top, 3, new Set()).found.map((f) => f.name)).toEqual(['l3']);
  });
  it('does not follow links out of the folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'aot-out-'));
    mkdirSync(join(outside, 'secret', '.git'), { recursive: true });
    try { symlinkSync(outside, join(top, 'link'), 'junction'); } catch { return; }
    expect(discoverRepos(top, 3, new Set()).found).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
  it('returns names and paths only, and bounds how much it reports', () => {
    for (let i = 0; i < 230; i++) repo(`r${String(i).padStart(3, '0')}`);
    writeFileSync(join(top, 'file.txt'), 'x');
    const r = discoverRepos(top, 1, new Set());
    expect(r.found.length).toBe(200);
    expect(r.truncated).toBe(true);
    expect(Object.keys(r.found[0]!).sort()).toEqual(['name', 'path', 'registered']);
  });
});

describe('parseGithubUrl', () => {
  it('accepts github.com over https and normalises it', () => {
    expect(parseGithubUrl('https://github.com/octocat/Hello-World')).toBe('https://github.com/octocat/Hello-World.git');
    expect(parseGithubUrl('https://github.com/octocat/Hello-World.git/')).toBe('https://github.com/octocat/Hello-World.git');
  });
  it('refuses everything else', () => {
    for (const bad of ['http://github.com/a/b', 'git@github.com:a/b.git', 'file:///etc', 'C:\repo', '/home/x/repo', 'https://evil.test/a/b', 'https://github.com/a', 'https://github.com/a/b/c', 'https://github.com/../b', '--upload-pack=x', 'https://github.com.evil.test/a/b', 'ext::sh -c x']) expect(parseGithubUrl(bad), bad).toBeNull();
  });
});
