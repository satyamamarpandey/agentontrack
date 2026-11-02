import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveInRoot } from './paths.js';

/**
 * Files for people, through the companion. Every path is resolved through the real file system, so a symlink cannot
 * leave the project, and nothing inside .git is ever listed, read or written. A save names the hash it was based on, so
 * a stale window cannot silently replace a newer file.
 */

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const HIDDEN_DIRS = new Set(['.git', 'node_modules']);

export class WorkspaceError extends Error {
  constructor(readonly status: number, message: string, readonly data?: Record<string, unknown>) { super(message); }
}

export const hashText = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A project-relative path with forward slashes, or an error. Empty means the root. */
export function cleanRelative(root: string, raw: string): string {
  if (typeof raw !== 'string' || raw.includes('\0') || raw.length > 1000) throw new WorkspaceError(400, 'Not a usable path');
  const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (rel === '' || rel === '.') return '';
  if (/^([a-zA-Z]:|\/|~)/.test(rel) || rel.split('/').some((s) => s === '..')) throw new WorkspaceError(400, 'Use a path inside the project');
  const r = resolveInRoot(root, root, rel);
  if (!r.insideRoot) throw new WorkspaceError(403, 'That path leaves the project');
  if (r.path.split('/').some((s) => s === '.git')) throw new WorkspaceError(403, 'The .git folder is not available here');
  return r.path;
}

export interface Entry { name: string; path: string; type: 'dir' | 'file' | 'link'; size: number }

export function listDir(root: string, raw: string): { dir: string; entries: Entry[]; truncated: boolean } {
  const rel = cleanRelative(root, raw);
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new WorkspaceError(404, 'No such folder');
  const out: Entry[] = [];
  for (const name of readdirSync(abs)) {
    if (HIDDEN_DIRS.has(name)) continue;
    const p = join(abs, name);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    out.push({ name, path: rel ? `${rel}/${name}` : name, type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : 0 });
  }
  out.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  return { dir: rel, entries: out.slice(0, MAX_ENTRIES), truncated: out.length > MAX_ENTRIES };
}

const LANGUAGES: Record<string, string> = { md: 'markdown', ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', json: 'json', yml: 'yaml', yaml: 'yaml', py: 'python', css: 'css', html: 'html', sh: 'shell', toml: 'toml', rs: 'rust', go: 'go' };
export const languageOf = (path: string) => LANGUAGES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'text';

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } finally { closeSync(fd); }
}

export interface FileView { path: string; content: string; hash: string; size: number; language: string }

export function readTextFile(root: string, raw: string): FileView {
  const rel = cleanRelative(root, raw);
  if (!rel) throw new WorkspaceError(400, 'Name a file');
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new WorkspaceError(404, 'No such file');
  const st = statSync(abs);
  if (!st.isFile()) throw new WorkspaceError(400, 'That is not a file');
  if (st.size > MAX_FILE_BYTES) throw new WorkspaceError(413, `Larger than ${MAX_FILE_BYTES / 1024} KB, so it is not opened here`);
  if (looksBinary(abs)) throw new WorkspaceError(415, 'That looks like a binary file, so it is not opened as text');
  const content = readFileSync(abs, 'utf8');
  return { path: rel, content, hash: hashText(content), size: st.size, language: languageOf(rel) };
}

/**
 * Writes atomically. `baseHash` is the hash the editor was showing, or null for a file that did not exist. A different
 * current hash is a conflict, and nothing is written.
 */
export function writeTextFile(root: string, raw: string, content: string, baseHash: string | null): { path: string; hash: string; beforeHash: string | null; created: boolean } {
  const rel = cleanRelative(root, raw);
  if (!rel) throw new WorkspaceError(400, 'Name a file');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new WorkspaceError(413, `Larger than ${MAX_FILE_BYTES / 1024} KB`);
  if (content.includes('\0')) throw new WorkspaceError(415, 'Text only');
  const abs = join(root, rel);
  const exists = existsSync(abs);
  if (exists && lstatSync(abs).isSymbolicLink()) throw new WorkspaceError(403, 'That is a link, so it is not written through');
  if (exists && !statSync(abs).isFile()) throw new WorkspaceError(400, 'That is not a file');
  const current = exists ? hashText(readFileSync(abs, 'utf8')) : null;
  if (current !== baseHash) {
    throw new WorkspaceError(409, exists ? 'This file changed since you opened it. Reload it, then apply your edit again.' : 'This file already exists, or was removed.', { currentHash: current });
  }
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.aot-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, abs);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw new WorkspaceError(500, `Could not save: ${(err as Error).message}`);
  }
  return { path: rel, hash: hashText(content), beforeHash: current, created: !exists };
}
