// Stopping a run ends the programs the agent started, not only the agent. REAL processes: the "agent" is a node program that starts a detached grandchild
// (a build or a dev server that is not tied to its parent's lifetime) and writes the grandchild's pid to a file. Before this, Stop ended the agent and left the
// grandchild running (reproduced on Windows by a plain child.kill()). Windows is the platform this was run on; the POSIX branch of killTree is NOT TESTED here.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminate } from '../src/terminate.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what: string, fn: () => boolean, ms = 10_000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (fn()) return; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error(`timed out waiting for: ${what}`); };
let dir = ''; let grandchild = 0;
afterEach(() => {
  if (grandchild && alive(grandchild)) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } }
  grandchild = 0;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp */ }
});

describe('stopping an agent', () => {
  it('also ends a program the agent started', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aot-tree-'));
    const pidFile = join(dir, 'grandchild.pid');
    const agent = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    await until('the agent to start its program', () => existsSync(pidFile));
    grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    const out = await terminate(agent, { graceMs: 5000, killMs: 3000 });
    expect(out.ok).toBe(true);
    await until('the agent\'s program to end', () => !alive(grandchild), 5000);
  });
});
