import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Resolves through the deepest existing ancestor, so a symlink cannot hide an escape from the root. */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    return join(realpathSync.native(cur), ...tail);
  } catch {
    return resolve(p);
  }
}

export interface ResolvedPath {
  /** POSIX-style path relative to root, or the absolute path if it lies outside. */
  path: string;
  insideRoot: boolean;
}

export function resolveInRoot(root: string, cwd: string, raw: string): ResolvedPath {
  const expanded = raw.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
  const abs = realish(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  const rel = relative(realish(root), abs);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (rel === '') return { path: '.', insideRoot: true };
  return { path: (inside ? rel : abs).split(sep).join('/'), insideRoot: inside };
}
