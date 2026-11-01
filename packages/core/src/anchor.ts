import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Project } from './project.js';

export interface AnchorEntry { seq: number; hash: string; instance: string; at: string }
export interface AnchorCheck { ok: boolean; checked: number; lastSeq: number | null; problems: string[] }

const refBase = (p: Project) => `refs/agentontrack/anchors/${basename(p.stateDir)}`;
const refFor = (p: Project, instance: string) => `${refBase(p)}/${instance}`;

/** A remote is passed to git, so an option or a helper transport in it would run commands on this machine. */
export function checkRemote(remote: string): string {
  if (!remote || remote.startsWith('-') || remote.includes('::') || /[\r\n]/.test(remote)) throw new Error(`Not an acceptable git remote: ${remote.slice(0, 80)}`);
  return remote;
}
const IDENTITY = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=AgentOnTrack', '-c', 'user.email=anchor@agentontrack.invalid', '-c', 'commit.gpgsign=false'];

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function inTemp<T>(fn: (git: (...a: string[]) => { ok: boolean; out: string; err: string }, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aot-anchor-'));
  const git = (...a: string[]) => {
    const r = spawnSync('git', [...IDENTITY, ...a], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:git:file' } });
    return { ok: r.status === 0, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error?.message ?? ''}` };
  };
  try {
    if (!git('init', '-q').ok) throw new Error('git is needed for an external anchor, and could not run');
    return fn(git, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Appends the log head to a ref on a git remote. It never forces, so a remote that refuses non-fast-forward updates
 * and deletions keeps its history even if this machine is fully compromised. The anchor is only as strong as that
 * remote: if the same credentials can force-push or delete there, an attacker can rewrite it too.
 */
export function pushAnchor(p: Project, remote: string): AnchorEntry {
  const head = p.store.head();
  const instance = p.state().instance;
  if (!head || !instance) throw new Error('Nothing to anchor yet');
  const entry: AnchorEntry = { seq: head.seq, hash: head.hash, instance, at: new Date().toISOString() };
  checkRemote(remote);
  const ref = refFor(p, instance);
  return inTemp((git, dir) => {
    let lines = '';
    if (git('fetch', '-q', '--', remote, `${ref}:${ref}`).ok) {
      git('checkout', '-q', '--detach', ref);
      lines = readFileSync(join(dir, 'anchors.jsonl'), 'utf8');
    }
    writeFileSync(join(dir, 'anchors.jsonl'), `${lines}${JSON.stringify(entry)}\n`);
    git('add', 'anchors.jsonl');
    const commit = git('commit', '-q', '-m', `anchor ${entry.seq}`);
    if (!commit.ok) throw new Error(`Anchor commit failed: ${commit.err}`);
    const push = git('push', '-q', '--', remote, `HEAD:${ref}`);
    if (!push.ok) throw new Error(`Anchor push failed: ${push.err.trim().slice(0, 300)}`);
    return entry;
  });
}

/** Every anchored head must still be in the local log, unchanged. A consistent rewrite of log and witness fails this. */
export function checkAnchor(p: Project, remote: string): AnchorCheck {
  const instance = p.state().instance;
  if (!instance) return { ok: false, checked: 0, lastSeq: null, problems: ['No log instance'] };
  checkRemote(remote);
  const ref = refFor(p, instance);
  return inTemp((git, dir) => {
    // A rebuilt log gets a new instance id. Anchors filed under any other id mean this project's log was replaced.
    const others = git('ls-remote', '--', remote, `${refBase(p)}/*`).out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]).filter((r) => r !== ref);
    if (others.length) return { ok: false, checked: 0, lastSeq: null, problems: [`The remote holds anchors for another log of this project: ${others.join(', ')}. The log may have been replaced`] };
    if (!git('fetch', '-q', '--', remote, `${ref}:${ref}`).ok) return { ok: false, checked: 0, lastSeq: null, problems: ['The remote holds no anchor for this project, or could not be reached'] };
    git('checkout', '-q', '--detach', ref);
    const problems: string[] = [];
    let checked = 0;
    let lastSeq: number | null = null;
    for (const line of readFileSync(join(dir, 'anchors.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const a: AnchorEntry = JSON.parse(line);
      checked++;
      if (lastSeq !== null && a.seq < lastSeq) problems.push(`Anchor at event ${a.seq} goes backwards from ${lastSeq}`);
      lastSeq = a.seq;
      const ev = p.store.eventAt(a.seq);
      if (!ev) problems.push(`Anchored event ${a.seq} is missing from the log: truncation or rollback`);
      else if (ev.hash !== a.hash) problems.push(`Event ${a.seq} differs from the hash anchored on ${a.at}: rewritten history`);
    }
    return { ok: problems.length === 0, checked, lastSeq, problems };
  });
}
