import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), '..', '..', 'benchmarks', 'results');

export function readResult<T = any>(name: string): T | null {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

