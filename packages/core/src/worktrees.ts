import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Agent Conflict Controller, the git half. Each agent that writes in parallel gets its own worktree on its own branch, so two agents never
 * change one working folder at once. Everything here is plain git, run in the project, and every result says what git said.
 */

export interface Git { ok: boolean; out: string; err: string; code: number | null }

export function git(cwd: string, ...args: string[]): Git {
  const r = spawnSync('git', ['-c', 'user.name=AgentOnTrack', '-c', 'user.email=agentontrack@invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 26, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: `${r.stderr ?? ''}${r.error?.message ?? ''}`.trim(), code: r.status };
}

export const isGitRepo = (root: string) => git(root, 'rev-parse', '--is-inside-work-tree').out === 'true';
export const headOf = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').out;
export const branchOf = (cwd: string) => git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').out;

const SAFE = /^[A-Za-z0-9._-]{1,60}$/;
export const safeName = (s: string) => {
  const t = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40);
  if (!SAFE.test(t)) throw new Error(`Not usable in a branch name: ${s.slice(0, 40)}`);
  return t;
};

export function addWorktree(root: string, dir: string, branch: string): { path: string; base: string } {
  if (!isGitRepo(root)) throw new Error('This project is not a git repository, so parallel work cannot be isolated. Run git init first.');
  const base = headOf(root);
  if (!base) throw new Error('This repository has no commit yet. Make one first, so each agent has a base to start from.');
  mkdirSync(join(dir, '..'), { recursive: true });
  const r = git(root, 'worktree', 'add', '-q', '-b', branch, dir, base);
  if (!r.ok) throw new Error(`Could not create the worktree: ${r.err.slice(0, 240)}`);
  return { path: dir, base };
}

export function removeWorktree(root: string, dir: string, branch: string, deleteBranch: boolean): void {
  const r = git(root, 'worktree', 'remove', '--force', dir);
  if (!r.ok && existsSync(dir)) { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); git(root, 'worktree', 'prune'); }
  if (deleteBranch) git(root, 'branch', '-D', branch);
}

/** Files AgentOnTrack itself puts in a worktree so the agent's hooks reach the project. They are never part of the agent's work, a diff or a commit. */
const INFRA_FILES = new Set(['.claude/settings.local.json']);

export interface Changed { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }

/** Everything this worktree changed since its base: committed, staged, unstaged and untracked. */
export function changedSince(wt: string, base: string): Changed[] {
  const out = new Map<string, Changed['status']>();
  const kind = (c: string): Changed['status'] => (c.startsWith('A') ? 'added' : c.startsWith('D') ? 'deleted' : c.startsWith('R') ? 'renamed' : 'modified');
  for (const line of git(wt, 'diff', '--name-status', '-M', base).out.split('\n').filter(Boolean)) {
    const [c, ...rest] = line.split('\t');
    out.set(rest.at(-1)!, kind(c!));
  }
  for (const f of git(wt, 'ls-files', '--others', '--exclude-standard').out.split('\n').filter(Boolean)) out.set(f, 'added');
  return [...out].filter(([path]) => !INFRA_FILES.has(path)).map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Records the agent's work as a commit on its branch, so it can be compared and merged. */
export function commitAll(wt: string, message: string): { commit: string; empty: boolean } {
  git(wt, 'add', '-A');
  for (const f of INFRA_FILES) git(wt, 'reset', '-q', '--', f);
  const staged = git(wt, 'diff', '--cached', '--quiet');
  if (staged.ok) return { commit: headOf(wt), empty: true };
  const r = git(wt, 'commit', '-q', '-m', message);
  if (!r.ok) throw new Error(`Could not record the work: ${r.err.slice(0, 240)}`);
  return { commit: headOf(wt), empty: false };
}

export interface MergePreview { clean: boolean; conflicts: string[]; detail: string }

/** Asks git what merging `branch` into the current branch would do, without touching either. */
export function previewMerge(root: string, branch: string): MergePreview {
  const r = git(root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch);
  if (r.ok) return { clean: true, conflicts: [], detail: 'No conflicts' };
  if (r.code === 1) {
    const lines = r.out.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('CONFLICT'));
    return { clean: false, conflicts: [...new Set(lines)], detail: 'Conflicting changes' };
  }
  return { clean: false, conflicts: [], detail: `git could not preview the merge: ${r.err.slice(0, 200)}` };
}

export interface Merged { merged: boolean; commit?: string; error?: string }

/** Merges with a merge commit. On any failure the merge is aborted, so the project is left as it was. */
export function mergeBranch(root: string, branch: string, message: string): Merged {
  const status = git(root, 'status', '--porcelain', '--untracked-files=no').out;
  if (status) return { merged: false, error: 'The project has uncommitted changes. Commit or stash them first, so a merge cannot mix with them.' };
  const before = headOf(root);
  const r = git(root, 'merge', '--no-ff', '-m', message, branch);
  if (r.ok) return { merged: true, commit: headOf(root) };
  git(root, 'merge', '--abort');
  const back = headOf(root) === before;
  return { merged: false, error: `${r.out.split('\n').find((l) => /CONFLICT/.test(l)) ?? r.err.slice(0, 200)}${back ? '' : ' (could not restore the project: check git status)'}` };
}

export const behindBy = (root: string, base: string): number => Number(git(root, 'rev-list', '--count', `${base}..HEAD`).out) || 0;
