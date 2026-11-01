// Scans tracked files for credential shapes. A simple check; it does not replace a dedicated scanner.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, /\bsk-[A-Za-z0-9]{32,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bre_[A-Za-z0-9]{24,}\b/, /postgres(ql)?:\/\/[^\s:]+:[^\s@]{6,}@/];
const files = spawnSync('git', ['ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const hits = [];
for (const f of files) {
  if (f === 'pnpm-lock.yaml' || /\.(png|jpg|ico|woff2?)$/.test(f)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const re of PATTERNS) if (re.test(text)) hits.push(`${f}: ${re}`);
}
console.log(`scanned ${files.length} files`);
if (hits.length) { console.error(hits.join('\n')); process.exit(1); }
