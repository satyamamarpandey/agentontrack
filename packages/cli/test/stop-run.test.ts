// The dashboard's Stop must treat "that run already ended" as a normal answer and a failure to end an agent as a real error, and a cancel of several runs must reach all of them.
// Found while changing the companion's stop route to refuse a run that is not running: the callers had assumed a 200 and would have thrown, or aborted their loop, on the 409.
import { describe, expect, it } from 'vitest';
import { describeCancel, stopAllWith, stopRunWith } from '../../../apps/dashboard/src/stop-run';

class Err extends Error { constructor(readonly status: number, message: string) { super(message); } }
const fake = (script: Record<string, number | 'network' | 'ok'>) => {
  const calls: string[] = [];
  const post = async (path: string) => {
    calls.push(path);
    const id = /run_\w+/.exec(path)![0];
    const r = script[id] ?? 'ok';
    if (r === 'ok') return { status: 'stopped' };
    if (r === 'network') throw new TypeError('fetch failed');
    throw new Err(r, r === 409 ? 'That run is not running.' : 'The agent did not exit after a stop and a forced kill, so it may still be running.');
  };
  return { post, calls };
};

describe('stopRunWith', () => {
  it('says stopped when the companion stopped it', async () => {
    const f = fake({});
    expect(await stopRunWith(f.post, 'run_a')).toEqual({ stopped: true });
    expect(f.calls).toEqual(['/api/runs/run_a/stop']);
  });
  it('treats "not running" (409) as a normal answer, with the companion\'s words', async () => {
    expect(await stopRunWith(fake({ run_a: 409 }).post, 'run_a')).toEqual({ stopped: false, message: 'That run is not running.' });
  });
  it('lets a failure to end the agent (500) through, so the person is told', async () => {
    await expect(stopRunWith(fake({ run_a: 500 }).post, 'run_a')).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/may still be running/) });
  });
  it('lets a network failure through, which is not "already ended"', async () => {
    await expect(stopRunWith(fake({ run_a: 'network' }).post, 'run_a')).rejects.toThrow('fetch failed');
  });
  it('lets an unknown run (404) through', async () => {
    await expect(stopRunWith(fake({ run_a: 404 }).post, 'run_a')).rejects.toMatchObject({ status: 404 });
  });
});

describe('stopAllWith', () => {
  it('reaches every run even when one has ended and another cannot be stopped, and says which was which', async () => {
    const f = fake({ run_b: 409, run_c: 500 });
    const out = await stopAllWith(f.post, ['run_a', 'run_b', 'run_c', 'run_d']);
    expect(f.calls).toEqual(['/api/runs/run_a/stop', '/api/runs/run_b/stop', '/api/runs/run_c/stop', '/api/runs/run_d/stop']);
    expect(out.stopped).toEqual(['run_a', 'run_d']);
    expect(out.alreadyEnded).toEqual(['run_b']);
    expect(out.failed).toEqual([{ id: 'run_c', message: expect.stringMatching(/may still be running/) }]);
  });
  it('has nothing to say for no runs', async () => {
    expect(await stopAllWith(fake({}).post, [])).toEqual({ stopped: [], alreadyEnded: [], failed: [] });
  });
});

describe('describeCancel', () => {
  it('says the agent was stopped only when one was', () => {
    expect(describeCancel({ stopped: ['run_a'], alreadyEnded: [], failed: [] })).toBe('Stopped by you, and the running agent was stopped.');
  });
  it('does not claim a stop when everything had already ended', () => {
    expect(describeCancel({ stopped: [], alreadyEnded: ['run_a'], failed: [] })).toBe('Stopped by you. Nothing was still running.');
    expect(describeCancel({ stopped: [], alreadyEnded: [], failed: [] })).toBe('Stopped by you. Nothing was still running.');
  });
  it('names every agent that could not be stopped, even when others were', () => {
    const t = describeCancel({ stopped: ['run_a'], alreadyEnded: ['run_b'], failed: [{ id: 'run_c', message: 'may still be running' }, { id: 'run_d', message: 'signal not delivered' }] });
    expect(t).toMatch(/2 running agents could not be stopped/);
    expect(t).toMatch(/run_c: may still be running; run_d: signal not delivered/);
  });
  it('uses the singular for one', () => {
    expect(describeCancel({ stopped: [], alreadyEnded: [], failed: [{ id: 'run_c', message: 'x' }] })).toMatch(/1 running agent could not be stopped/);
  });
});
