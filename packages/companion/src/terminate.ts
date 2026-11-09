import { killTree } from '@agentontrack/adapters';

// Ending an agent process, and saying truthfully whether it ended. A stop used to send one signal, mark the run stopped and answer "stopped" without checking that the
// signal was delivered or that the process went away. Here the answer is "stopped" only once the process has exited; a process that ignores the first signal gets a hard
// kill after a grace period; and one that still will not go is reported as a failure, not as stopped.

/** The part of a child process this needs. An object with only `kill` (the Codex app-server wrapper) cannot be confirmed, and is reported as requested. */
export interface Killable {
  /** When present, the programs the agent started are ended with it (see killTree). */
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean | void | unknown;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  once?(event: 'exit', listener: () => void): unknown;
  off?(event: 'exit', listener: () => void): unknown;
}

export type StopOutcome =
  | { ok: true; how: 'already-gone' | 'exited' | 'escalated' | 'requested' }
  | { ok: false; reason: string };

export interface TerminateOptions { graceMs?: number; killMs?: number }

const exited = (c: Killable) => (c.exitCode !== undefined && c.exitCode !== null) || (c.signalCode !== undefined && c.signalCode !== null);

export async function terminate(child: Killable, opts: TerminateOptions = {}): Promise<StopOutcome> {
  const graceMs = opts.graceMs ?? 5000;
  const killMs = opts.killMs ?? 3000;
  if (exited(child)) return { ok: true, how: 'already-gone' };
  // Something that cannot report its exit: ask it to stop and say only that it was asked.
  if (typeof child.once !== 'function') { child.kill(); return { ok: true, how: 'requested' }; }

  let done!: () => void;
  const gone = new Promise<'gone'>((ok) => { done = () => ok('gone'); });
  child.once('exit', done);
  const waitFor = async (ms: number): Promise<boolean> => {
    if (exited(child)) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((ok) => { timer = setTimeout(() => ok('timeout'), ms); });
    const r = await Promise.race([gone, timeout]);
    if (timer) clearTimeout(timer);
    return r === 'gone' || exited(child);
  };

  try {
    let sent: unknown;
    // The agent's own programs first, while the agent still exists to find them from. On Windows this also ends the agent, so a later "could not deliver" from kill() is not a failure.
    const tree = killTree(child.pid);
    try { sent = child.kill(); } catch (err) { return { ok: false, reason: `The agent could not be signalled: ${(err as Error).message}`.slice(0, 300) }; }
    if (sent === false && !tree.rootKilled && !exited(child)) return { ok: false, reason: 'The signal to stop the agent could not be delivered, and the agent is still running.' };
    if (await waitFor(graceMs)) return { ok: true, how: 'exited' };
    try { child.kill('SIGKILL'); } catch { /* reported below if it is still there */ }
    if (await waitFor(killMs)) return { ok: true, how: 'escalated' };
    return { ok: false, reason: 'The agent did not exit after a stop and a forced kill, so it may still be running.' };
  } finally {
    child.off?.('exit', done);
  }
}
