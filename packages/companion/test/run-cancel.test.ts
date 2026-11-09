// Cancelling a run, with a REAL child process and no timing guesses: the fake agent writes its pid, then waits for a file the test controls (a gate), then writes a
// "finished" file. So "the agent really stopped" is checked by the process being gone and by the finished file never appearing once the gate is opened, not by
// waiting a fixed time. This came out of a CI flake in the phone-cancel end-to-end test, where the test acted on a stale "running" row; see
// docs/release/FLAKE-phone-cancel.md. It tests the companion's stop, not Claude Code.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project, registerProject } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
// The prompt names the run: "slow-a" waits for the gate, "quick-a" finishes at once.
const FAKE = `
import { existsSync, writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
const name = /(slow|quick)-\\w+/.exec(prompt)?.[0] ?? 'run';
const dir = process.env.GATE_DIR;
writeFileSync(dir + '/' + name + '.pid', String(process.pid));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
if (name.startsWith('slow')) {
  while (!existsSync(dir + '/release')) await new Promise((ok) => setTimeout(ok, 20));
  writeFileSync(dir + '/' + name + '.finished', 'ran to the end');
}
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done ' + name }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));
`;

let dir: string; let root: string; let gate: string; let c: Companion; let origin: string;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return; await sleep(20); } throw new Error(`timed out waiting for: ${what}`); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (name: string) => Number(readFileSync(join(gate, `${name}.pid`), 'utf8'));

afterEach(async () => {
  // Whatever happened, let any agent still waiting finish, then close.
  try { writeFileSync(join(gate, 'release'), '1'); } catch { /* the folder may be gone */ }
  await c.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* a just-killed process can hold its folder for a moment; it is a throwaway in the OS temp directory */ }
});

const setup = async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-cancel-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  gate = join(dir, 'gate'); mkdirSync(gate);
  process.env.GATE_DIR = gate;
  root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof setup>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const startRun = async (s: S, name: string) => { const r = await api(s, '/api/runs', { runtime: 'claude-code', prompt: `go ${name}`, model: 'haiku', maxBudgetUsd: 0.1, ...(await proof(s)) }); expect(r.status).toBe(200); return (await r.json()).id as string; };
const runs = async (s: S) => (await (await api(s, '/api/runs')).json()) as { id: string; status: string }[];
const statusOf = async (s: S, id: string) => (await runs(s)).find((x) => x.id === id)?.status;
const stop = async (s: S, id: string) => api(s, `/api/runs/${id}/stop`, { ...(await proof(s)) });
const finishedEvents = (id: string) => { const p = new Project(root); try { return p.store.all().filter((e: any) => e.type === 'run.finished' && e.payload.id === id).map((e: any) => e.payload.status as string); } finally { p.close(); } };

describe('stopping a run', () => {
  it('ends the real agent process, records stopped once, and the delayed write never happens', async () => {
    const s = await setup();
    const id = await startRun(s, 'slow-a');
    await until('the agent to start', () => existsSync(join(gate, 'slow-a.pid')));
    const pid = pidOf('slow-a');
    expect(alive(pid)).toBe(true);
    expect(await statusOf(s, id)).toBe('running');

    expect((await stop(s, id)).status).toBe(200);
    // "Stopped" is only answered once the process has exited, so it is already gone, with no waiting.
    expect(alive(pid)).toBe(false);
    expect(await statusOf(s, id)).toBe('stopped');

    // Had the process survived, opening the gate would now let it write the file. It must not.
    writeFileSync(join(gate, 'release'), '1');
    await sleep(500);
    expect(existsSync(join(gate, 'slow-a.finished'))).toBe(false);
    expect(await statusOf(s, id)).toBe('stopped');
    await until('the end of the run to be recorded', () => finishedEvents(id).length > 0);
    expect(finishedEvents(id)).toEqual(['stopped']);
  });

  it('stops only the run it names: a stop for a run that already finished leaves another, running agent alone', async () => {
    // This is the mechanism of the phone-cancel flake: a stale "running" row belonged to a run that had finished.
    const s = await setup();
    const old = await startRun(s, 'quick-a');
    await until('the first run to finish', async () => (await statusOf(s, old)) === 'finished');

    const live = await startRun(s, 'slow-b');
    await until('the second agent to start', () => existsSync(join(gate, 'slow-b.pid')));
    const pid = pidOf('slow-b');

    const refused = await stop(s, old);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/not running/i);
    expect(alive(pid)).toBe(true);
    expect(await statusOf(s, live)).toBe('running');

    writeFileSync(join(gate, 'release'), '1');
    await until('the second run to finish by itself', async () => (await statusOf(s, live)) === 'finished');
    expect(existsSync(join(gate, 'slow-b.finished'))).toBe(true);
  });

  it('refuses to stop a run that already finished, and leaves it finished in the list and in the record', async () => {
    const s = await setup();
    const id = await startRun(s, 'quick-a');
    await until('the run to finish', async () => (await statusOf(s, id)) === 'finished');
    await until('the end of the run to be recorded', () => finishedEvents(id).length > 0);

    const r = await stop(s, id);
    expect(r.status).toBe(409);
    expect(await statusOf(s, id)).toBe('finished');
    expect(finishedEvents(id)).toEqual(['finished']);
  });

  it('refuses a second stop, and the run stays stopped with one record of its end', async () => {
    const s = await setup();
    const id = await startRun(s, 'slow-a');
    await until('the agent to start', () => existsSync(join(gate, 'slow-a.pid')));
    expect((await stop(s, id)).status).toBe(200);
    await until('the run to be stopped', async () => (await statusOf(s, id)) === 'stopped');
    await until('the end of the run to be recorded', () => finishedEvents(id).length > 0);

    const again = await stop(s, id);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already stopped/i);
    expect(await statusOf(s, id)).toBe('stopped');
    expect(finishedEvents(id)).toEqual(['stopped']);
  });

  it('keeps projects apart: a stop that names another project cannot end this project\'s run', async () => {
    const s = await setup();
    const A = registerProject(root).id;
    const root2 = join(dir, 'repo2'); mkdirSync(root2);
    const p2 = new Project(root2); p2.human.setGoal({ statement: 'g2', scope: { include: ['**'] } }); p2.close();
    const B = registerProject(root2).id;
    expect(B).not.toBe(A);

    const id = await startRun(s, 'slow-a');
    await until('the agent to start', () => existsSync(join(gate, 'slow-a.pid')));
    const pid = pidOf('slow-a');

    const wrong = await api(s, `/api/runs/${id}/stop?project=${B}`, { ...(await proof(s)) });
    expect(wrong.status).toBe(404);
    expect(alive(pid)).toBe(true);
    expect(await statusOf(s, id)).toBe('running');
    expect((await (await api(s, `/api/runs?project=${B}`)).json()).map((r: { id: string }) => r.id)).not.toContain(id);

    // The right project's stop still works.
    expect((await api(s, `/api/runs/${id}/stop?project=${A}`, { ...(await proof(s)) })).status).toBe(200);
    expect(alive(pid)).toBe(false);
  });

  it('refuses a run that does not exist', async () => {
    const s = await setup();
    expect((await stop(s, 'run_doesnotexist')).status).toBe(404);
  });

  it('leaves the project able to start another run after a stop, with no usage recorded for the killed one', async () => {
    const s = await setup();
    const a = await startRun(s, 'slow-a');
    await until('the agent to start', () => existsSync(join(gate, 'slow-a.pid')));
    await stop(s, a);
    await until('the run to be stopped', async () => (await statusOf(s, a)) === 'stopped');
    await until('the agent process to be gone', () => !alive(pidOf('slow-a')));

    const b = await startRun(s, 'quick-b');
    await until('the next run to finish', async () => (await statusOf(s, b)) === 'finished');
    const p = new Project(root);
    try { expect(p.store.all().filter((e: any) => e.type === 'usage.recorded' && e.payload.runId === a)).toEqual([]); } finally { p.close(); }
  });
});
