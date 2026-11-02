// The managed loop through the real companion and engine. The "agent" fixes the problem only when its prompt says the previous round failed,
// so the test shows what AgentOnTrack does between rounds: run the checks itself, feed the failure back, stop at the first pass, at the limit, and on cancel.
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const FAKE = `
import { writeFileSync, appendFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
appendFileSync('prompts.log', prompt.replace(/\\n/g, ' ').slice(-220) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
if (process.env.AOT_FAKE_NEVER_FIXES !== '1' && /did not pass/.test(prompt)) writeFileSync('done.txt', 'ok');
await new Promise((ok) => setTimeout(ok, Number(process.env.AOT_FAKE_DELAY_MS ?? 0)));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. Everything passes.' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, duration_api_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;
const CHECK = `node -e "process.exit(require('fs').existsSync('done.txt')?0:1)"`;

let dir: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-loop-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, 'agentontrack');
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); delete process.env.AOT_FAKE_NEVER_FIXES; delete process.env.AOT_FAKE_DELAY_MS; rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const statusOf = async (s: S, id: string) => (await (await api(s, '/api/plan')).json()).views.find((x: any) => x.id === id).status;
const until = async (fn: () => Promise<boolean>, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((ok) => setTimeout(ok, 150)); } throw new Error('timed out waiting'); };

/** A plan whose first phase has no dependencies and one command check that is true only once done.txt exists; the others have no command check. */
async function approvedPlan(s: S) {
  let v = await (await api(s, '/api/plan/draft', { goal: 'Fix the crash when the date is empty' })).json();
  const plan = structuredClone(v.plan);
  plan.phases.forEach((ph: any, n: number) => {
    ph.acceptance = ph.acceptance.filter((x: any) => x.kind !== 'command');
    if (n === 0) { ph.dependsOn = []; ph.acceptance.push({ id: 'loop-check', description: 'done.txt exists', kind: 'command', command: CHECK }); }
  });
  v = await (await api(s, '/api/plan/draft', { plan, expectVersion: v.version })).json();
  expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) })).status).toBe(200);
  return (await api(s, '/api/plan')).json();
}
const implementId = (view: any) => view.plan.phases[0].id;

describe('the managed loop', () => {
  it('runs the checks itself between rounds, feeds the failure back, and stops as soon as they pass', async () => {
    const s = await pair();
    const view = await approvedPlan(s);
    const id = implementId(view);
    // Phases before it must be settled for it to be ready: skip them (a person's choice, recorded in the plan).
    const r = await api(s, '/api/plan/loop', { phaseId: id, rounds: 3 });
    expect(r.status).toBe(200);
    expect((await r.json()).started).toBe(true);
    await until(async () => (await statusOf(s, id)) === 'verified');
    const log = fs.readFileSync(join(root, 'prompts.log'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(2);
    expect(log[1]).toMatch(/did not pass/);
    expect(log[1]).toMatch(/Do not change or weaken the checks/);
  });

  it('stops at the number of rounds when the agent never fixes it, and the phase is then failed, not verified', async () => {
    process.env.AOT_FAKE_NEVER_FIXES = '1';
    const s = await pair();
    const id = implementId(await approvedPlan(s));
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 2 })).status).toBe(200);
    await until(async () => fs.existsSync(join(root, 'prompts.log')) && fs.readFileSync(join(root, 'prompts.log'), 'utf8').trim().split('\n').length >= 2);
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(fs.readFileSync(join(root, 'prompts.log'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(await statusOf(s, id)).toBe('failed');
  });

  it('can be cancelled between rounds, and stops the agent that is running', async () => {
    process.env.AOT_FAKE_NEVER_FIXES = '1';
    process.env.AOT_FAKE_DELAY_MS = '4000';
    const s = await pair();
    const id = implementId(await approvedPlan(s));
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 5 })).status).toBe(200);
    await until(async () => fs.existsSync(join(root, 'prompts.log')));
    expect((await (await api(s, '/api/plan/loop', { phaseId: id, stop: true })).json()).stopped).toBe(true);
    await new Promise((ok) => setTimeout(ok, 2500));
    expect(fs.readFileSync(join(root, 'prompts.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    // Nothing is left going: a new loop may start.
    process.env.AOT_FAKE_DELAY_MS = '0';
    expect((await (await api(s, '/api/plan/loop', { phaseId: id, rounds: 1 })).json()).started).toBe(true);
    await until(async () => (await statusOf(s, id)) === 'failed');
    await new Promise((ok) => setTimeout(ok, 800));
  });

  it('refuses/ a phase with no command check, because it could never know when to stop', async () => {
    const s = await pair();
    const view = await approvedPlan(s);
    const manual = view.plan.phases.find((p: any) => !p.acceptance.some((a: any) => a.kind === 'command'))!;
    const r = await api(s, '/api/plan/loop', { phaseId: manual.id, rounds: 2 });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/needs a command check/);
  });

  it('is bounded by the rounds asked for and by the rounds the phase allows, and rejects more than five', async () => {
    const s = await pair();
    const view = await approvedPlan(s);
    const id = implementId(view);
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 6 })).status).toBe(400);
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 0 })).status).toBe(400);
  });
});
