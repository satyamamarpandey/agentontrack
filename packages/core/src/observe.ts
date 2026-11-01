import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { matchesAny } from './paths.js';
import { canonical, sha256 } from './store.js';

export interface FileEntry { size: number; mtimeMs: number; hash: string }
export interface Snapshot { files: Record<string, FileEntry>; truncated: boolean; sentinels?: Record<string, string | null> }
export interface SnapshotDiff { added: string[]; modified: string[]; deleted: string[] }

/**
 * Observes the workspace independently of what the agent reports. Unchanged size and mtime reuse the
 * previous hash for speed, so a same-size write that restores mtime goes unseen. Paths outside the root,
 * ignored paths, network and process effects are not observed at all.
 */
export function takeSnapshot(root: string, ignore: string[], maxFiles: number, previous?: Snapshot): Snapshot {
  const files: Record<string, FileEntry> = {};
  let count = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!matchesAny(`${rel}/x`, ignore)) walk(abs);
      } else if (ent.isFile() && !matchesAny(rel, ignore)) {
        if (++count > maxFiles) { truncated = true; return; }
        try {
          const st = statSync(abs);
          const prev = previous?.files[rel];
          const hash = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.hash : sha256(readFileSync(abs));
          files[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
        } catch { /* file vanished during the walk */ }
      }
    }
  };
  walk(root);
  return { files, truncated };
}

/** Hashes a short fixed list of sensitive files. null means absent, so creating one also registers as a change. */
export function hashSentinels(paths: string[]): Record<string, string | null> {
  const home = homedir();
  const out: Record<string, string | null> = {};
  for (const p of paths) {
    try { out[p] = sha256(readFileSync(p.replace(/^~/, home))); } catch { out[p] = null; }
  }
  return out;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const out: SnapshotDiff = { added: [], modified: [], deleted: [] };
  for (const [p, e] of Object.entries(b.files)) {
    const old = a.files[p];
    if (!old) out.added.push(p);
    else if (old.hash !== e.hash) out.modified.push(p);
  }
  for (const p of Object.keys(a.files)) if (!b.files[p]) out.deleted.push(p);
  return out;
}

export function changedPaths(d: SnapshotDiff): string[] {
  return [...d.added, ...d.modified, ...d.deleted];
}

export function snapshotDigest(s: Snapshot): string {
  return sha256(canonical(Object.fromEntries(Object.entries(s.files).map(([p, e]) => [p, e.hash]))));
}
