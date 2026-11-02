// Real git, real folders. Nothing here is mocked: an overlap, a conflict and a failed merge are what git itself reports.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '../src/index.js';

let dir: string; let root: string; let p: Project;
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-wt-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export const name = "base";\nexport const other = 1;\n');
  writeFileSync(join(root, 'docs', 'readme.md'), 'docs\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  p = new Project(root);
  p.human.setGoal({ statement: 'Improve the app', scope: { include: ['src/**', 'docs/**'] } });
  p.human.createTask({ id: 't', title: 'work' });
});
afterEach(() => { try { p.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const edit = (wt: { path: string }, rel: string, text: string) => { mkdirSync(join(wt.path, rel, '..'), { recursive: true }); writeFileSync(join(wt.path, rel), text); };

describe('worktrees: one agent, one folder', () => {
  it('gives each agent its own folder and branch, and refuses a second one for the same agent and task', () => {
    const a = p.createWorktree('t', 'claude-code');
    const b = p.createWorktree('t', 'codex');
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
    expect(existsSync(join(a.path, 'src', 'app.ts'))).toBe(true);
    expect(() => p.createWorktree('t', 'codex')).toThrow(/already owns/);
    expect(() => p.createWorktree('nope', 'codex')).toThrow(/No task/);
    expect(p.worktrees().map((w) => w.agent)).toEqual(['claude-code', 'codex']);
  });

  it('refuses where isolation is impossible, and says why', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const q = new Project(plain);
    q.human.setGoal({ statement: 'g' });
    q.human.createTask({ id: 't', title: 't' });
    expect(() => q.createWorktree('t', 'codex')).toThrow(/not a git repository/);
    q.close();
  });

  it('survives a restart and a saved projection, because it lives in the record', () => {
    const a = p.createWorktree('t', 'codex');
    p.checkpoint();
    p.close();
    p = new Project(root);
    expect(p.worktrees().find((w) => w.id === a.id)).toMatchObject({ agent: 'codex', status: 'active', base: a.base });
  });
});

describe('overlap and conflict', () => {
  it('sees an overlap before anyone commits, and sees real conflict after', () => {
    const a = p.createWorktree('t', 'claude-code');
    const b = p.createWorktree('t', 'codex');
    edit(a, 'src/app.ts', 'export const name = "claude";\nexport const other = 1;\n');
    edit(a, 'src/only-claude.ts', 'x');
    edit(b, 'src/app.ts', 'export const name = "codex";\nexport const other = 1;\n');
    edit(b, 'docs/only-codex.md', 'y');
    const st = p.worktreeStatus(a.id);
    expect(st.changed.map((c) => `${c.status}:${c.path}`)).toEqual(['modified:src/app.ts', 'added:src/only-claude.ts']);
    const early = p.detectConflicts();
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ files: ['src/app.ts'], combine: null });
    p.commitWorktree(a.id, 'claude work'); p.commitWorktree(b.id, 'codex work');
    const late = p.detectConflicts();
    expect(late[0]!.combine).toMatchObject({ clean: false, conflicts: ['src/app.ts'] });
  });

  it('two agents on different files are not a conflict, and both can merge', () => {
    const a = p.createWorktree('t', 'claude-code');
    const b = p.createWorktree('t', 'codex');
    edit(a, 'src/a.ts', 'a'); edit(b, 'docs/b.md', 'b');
    p.commitWorktree(a.id, 'a'); p.commitWorktree(b.id, 'b');
    expect(p.detectConflicts()).toEqual([]);
    expect(p.mergeWorktree(a.id).merged).toBe(true);
    expect(p.mergeWorktree(b.id).merged).toBe(true);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('a');
    expect(readFileSync(join(root, 'docs', 'b.md'), 'utf8')).toBe('b');
    expect(p.worktrees().map((w) => w.status)).toEqual(['merged', 'merged']);
    expect(git(root, 'status', '--porcelain').stdout.trim()).toBe('');
  });

  it('a conflicting merge fails safely: the project is exactly as it was, and the branch is kept for review', () => {
    const a = p.createWorktree('t', 'claude-code');
    const b = p.createWorktree('t', 'codex');
    edit(a, 'src/app.ts', 'export const name = "claude";\nexport const other = 1;\n');
    edit(b, 'src/app.ts', 'export const name = "codex";\nexport const other = 1;\n');
    p.commitWorktree(a.id, 'a'); p.commitWorktree(b.id, 'b');
    expect(p.mergeWorktree(a.id).merged).toBe(true);
    const after = git(root, 'rev-parse', 'HEAD').stdout.trim();
    const stale = p.worktreeStatus(b.id);
    expect(stale.stale).toBe(true);
    expect(stale.behindBy).toBe(2);
    expect(p.mergePreview(b.id)).toMatchObject({ clean: false, conflicts: ['src/app.ts'], stale: true });
    const r = p.mergeWorktree(b.id);
    expect(r.merged).toBe(false);
    expect(r.error).toMatch(/CONFLICT/);
    expect(git(root, 'rev-parse', 'HEAD').stdout.trim()).toBe(after);
    expect(git(root, 'status', '--porcelain').stdout.trim()).toBe('');
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toContain('"claude"');
    expect(p.worktrees().find((w) => w.id === b.id)).toMatchObject({ status: 'active', mergeError: expect.stringMatching(/CONFLICT/) });
    expect(git(root, 'branch', '--list', b.branch).stdout).toContain(b.branch);
    p.discardWorktree(b.id);
    expect(p.worktrees().find((w) => w.id === b.id)!.status).toBe('discarded');
    expect(existsSync(b.path)).toBe(false);
  });

  it('will not merge on top of uncommitted changes in the project, or work outside the approved scope', () => {
    const a = p.createWorktree('t', 'codex');
    edit(a, 'src/ok.ts', 'ok');
    edit(a, 'deploy/prod.conf', 'secret change');
    expect(p.worktreeStatus(a.id).outOfScope.map((o) => o.path)).toEqual(['deploy/prod.conf']);
    p.commitWorktree(a.id, 'x');
    expect(() => p.mergeWorktree(a.id)).toThrow(/outside the approved scope.*deploy\/prod\.conf/);
    expect(existsSync(join(root, 'src', 'ok.ts'))).toBe(false);

    const b = p.createWorktree('t', 'claude-code');
    edit(b, 'src/b.ts', 'b');
    p.commitWorktree(b.id, 'b');
    writeFileSync(join(root, 'src', 'app.ts'), 'edited by hand\n');
    const r = p.mergeWorktree(b.id);
    expect(r.merged).toBe(false);
    expect(r.error).toMatch(/uncommitted/);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe('edited by hand\n');
  });

  it('needs recorded work before it will preview or merge', () => {
    const a = p.createWorktree('t', 'codex');
    edit(a, 'src/x.ts', 'x');
    expect(() => p.mergePreview(a.id)).toThrow(/Record the work/);
    expect(() => p.mergeWorktree(a.id)).toThrow(/Record the work/);
    expect(p.commitWorktree(a.id, 'first').empty).toBe(false);
    expect(p.commitWorktree(a.id, 'again').empty).toBe(true);
  });
});

describe('the gate follows an agent into its worktree', () => {
  const act = (cwd: string, target: string) => p.preAction({ runtime: 'codex', tool: 'Write', effects: [{ kind: 'fs.write', target }], opaque: false, coverage: 'enforced', cwd, rawInput: target });

  it('judges a path inside a worktree by the project\'s scope, and still refuses what is outside both', () => {
    const a = p.createWorktree('t', 'codex');
    expect(act(a.path, 'src/new.ts').decision).toBe('allow');
    expect(act(a.path, join(a.path, 'src', 'new.ts')).decision).toBe('allow');
    expect(act(a.path, 'deploy/prod.conf').decision).toBe('request_approval');
    expect(act(a.path, '../../elsewhere.txt').reasons.join()).toMatch(/outside the project root/);
    expect(act(a.path, join(dir, 'elsewhere.txt')).decision).toBe('request_approval');
    expect(act(root, 'src/new.ts').decision).toBe('allow');
  });

  it('after a worktree is gone, its folder is no longer part of the project', () => {
    const a = p.createWorktree('t', 'codex');
    p.discardWorktree(a.id);
    expect(act(a.path, 'src/new.ts').reasons.join()).toMatch(/outside the project root/);
  });
});
