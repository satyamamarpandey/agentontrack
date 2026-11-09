import { spawnSync } from 'node:child_process';

/**
 * Ends the programs an agent started, not only the agent. `ChildProcess.kill()` signals one process: on Windows that is TerminateProcess on the agent alone, and on
 * POSIX a signal to the agent alone (the agent is not a process-group leader), so a build, a dev server or a shell the agent launched keeps running after "Stop".
 *
 * Windows: `taskkill /T /F` ends the whole tree, root included. This must run while the root is still alive, because the tree is found from each process's parent id.
 * POSIX: the descendants are found with `ps`, sent SIGTERM, and sent SIGKILL two seconds later if still alive; the caller still signals the root. The POSIX branch is NOT TESTED on a POSIX machine.
 * Best effort: a failure here never throws, and the caller's own kill and exit check still decide what is reported.
 */
export function killTree(pid: number | undefined | null): { rootKilled: boolean } {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return { rootKilled: false };
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
      return { rootKilled: r.status === 0 };
    }
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
    if (ps.status !== 0) return { rootKilled: false };
    const kids = new Map<number, number[]>();
    for (const line of ps.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
    }
    const order: number[] = [];
    for (let queue = [pid]; queue.length;) { const next = queue.shift()!; for (const k of kids.get(next) ?? []) { order.push(k); queue.push(k); } }
    const ordered = order.reverse();
    for (const d of ordered) { try { process.kill(d, 'SIGTERM'); } catch { /* already gone */ } }
    // A descendant that ignores SIGTERM is ended two seconds later. A pid that no longer exists is skipped by the catch.
    setTimeout(() => { for (const d of ordered) { try { process.kill(d, 0); process.kill(d, 'SIGKILL'); } catch { /* gone */ } } }, 2000).unref();
  } catch { /* best effort */ }
  return { rootKilled: false };
}
