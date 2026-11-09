// Stopping a run from the dashboard. The companion answers 409 when the run is not running (it finished, or was already stopped, between the list the person was looking at
// and the click) and 500 when the agent could not be ended. The first is a normal outcome: nothing needed stopping, and the refreshed list tells the truth. The second is not,
// and must reach the person. Kept apart from api.ts, which needs a browser, so this rule can be tested on its own.

export interface StopResult { stopped: boolean; message?: string }

export async function stopRunWith(post: (path: string) => Promise<unknown>, id: string): Promise<StopResult> {
  try {
    await post(`/api/runs/${id}/stop`);
    return { stopped: true };
  } catch (e) {
    if ((e as { status?: number }).status === 409) return { stopped: false, message: (e as Error).message };
    throw e;
  }
}

/** Stops every listed run, one failing never preventing the others, and says what could not be stopped. */
export async function stopAllWith(post: (path: string) => Promise<unknown>, ids: string[]): Promise<{ stopped: string[]; alreadyEnded: string[]; failed: { id: string; message: string }[] }> {
  const out = { stopped: [] as string[], alreadyEnded: [] as string[], failed: [] as { id: string; message: string }[] };
  for (const id of ids) {
    try {
      const r = await stopRunWith(post, id);
      (r.stopped ? out.stopped : out.alreadyEnded).push(id);
    } catch (e) { out.failed.push({ id, message: (e as Error).message }); }
  }
  return out;
}

/** What to tell the person after "stop everything": never claims an agent was stopped when none was, and names any that could not be. */
export function describeCancel(out: { stopped: string[]; alreadyEnded: string[]; failed: { id: string; message: string }[] }): string {
  if (out.failed.length) return `Stopped by you, but ${out.failed.length} running agent${out.failed.length === 1 ? '' : 's'} could not be stopped: ${out.failed.map((f) => `${f.id}: ${f.message}`).join('; ')}`;
  if (out.stopped.length) return 'Stopped by you, and the running agent was stopped.';
  return 'Stopped by you. Nothing was still running.';
}
