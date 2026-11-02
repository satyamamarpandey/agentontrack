// The phase plan through the real companion and the real engine. The "agent" is a small script that prints what Claude Code prints and
// writes a file: this tests AgentOnTrack's planning, limits and evidence, not any model. The real-agent run is in e2e/live-plan.spec.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const FAKE = `
import { writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
if (/Make the change/.test(prompt)) writeFileSync('done.txt', 'ok');
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. All tests pass, everything is verified.' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, duration_api_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;
const CHECK = `node -e "process.exit(require('fs').existsSync('done.txt')?0:1)"`;

let dir: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-plan-'));
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
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const view = async (s: S) => (await api(s, '/api/plan')).json();
const status = (v: any, id: string) => v.views.find((x: any) => x.id === id).status;
const settle = async (s: S) => { for (let i = 0; i < 80; i++) { const r = await (await api(s, '/api/runs')).json(); if (r.length && r.every((x: any) => x.status !== 'running')) return; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };

/** A drafted plan whose tests phase runs a check that is true only once done.txt exists. */
async function approvedPlan(s: S) {
  let v = await (await api(s, '/api/plan/draft', { goal: 'Fix the crash when the date is empty' })).json();
  const plan = structuredClone(v.plan);
  for (const ph of plan.phases) ph.acceptance = ph.acceptance.map((a: any) => (a.kind === 'command' ? { ...a, command: CHECK } : a));
  v = await (await api(s, '/api/plan/draft', { plan, expectVersion: v.version })).json();
  const r = await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) });
  expect(r.status).toBe(200);
  return view(s);
}

describe('drafting and approving', () => {
  it('drafts a plan from the goal using only the phases it needs, and approves nothing', async () => {
    const s = await pair();
    expect((await view(s)).plan).toBeNull();
    const v = await (await api(s, '/api/plan/draft', { goal: 'Fix the crash when the date is empty' })).json();
    expect(v.plan.phases.map((p: any) => p.kind)).toEqual(['understand', 'implement', 'test', 'verify']);
    expect(v.approved).toBe(false);
    expect(v.facts.testCommand).toBe('npm test');
    expect(v.views.every((x: any) => x.status === 'draft')).toBe(true);
  });

  it('refuses to start anything before approval, and an invalid or stale edit', async () => {
    const s = await pair();
    const v = await (await api(s, '/api/plan/draft', { goal: 'Fix a bug' })).json();
    const early = await api(s, '/api/plan/phases/start', { phaseId: v.plan.phases[0].id });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toMatch(/never approved/);
    const cyc = structuredClone(v.plan); cyc.phases[0].dependsOn = [cyc.phases.at(-1).id];
    expect((await api(s, '/api/plan/draft', { plan: cyc })).status).toBe(400);
    expect((await api(s, '/api/plan/draft', { plan: v.plan, expectVersion: 99 })).status).toBe(409);
  });

  it('approval needs a person: the confirmation, and exactly the content that was shown', async () => {
    const s = await pair();
    const v = await (await api(s, '/api/plan/draft', { goal: 'Fix a bug' })).json();
    expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version })).status).toBe(400);
    const wrong = await api(s, '/api/plan/approve', { sha256: 'a'.repeat(64), expectVersion: v.version, ...(await proof(s)) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await view(s)).approved).toBe(false);
    expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) })).status).toBe(200);
    expect((await view(s)).approved).toBe(true);
  });

  it('changing what runs, or who runs it, withdraws the approval, and pausing or skipping does not', async () => {
    const s = await pair();
    const v = await approvedPlan(s);
    expect(v.approved).toBe(true);
    const paused = structuredClone(v.plan); paused.phases[1].state = 'paused'; paused.phases[2].state = 'skipped';
    const after = await (await api(s, '/api/plan/draft', { plan: paused, expectVersion: v.version })).json();
    expect(after.approved).toBe(true);
    const swapped = structuredClone(after.plan); swapped.phases[0].model = 'opus';
    const again = await (await api(s, '/api/plan/draft', { plan: swapped, expectVersion: after.version })).json();
    expect(again.approved).toBe(false);
    const blocked = await api(s, '/api/plan/phases/start', { phaseId: swapped.phases[0].id });
    expect((await blocked.json()).error).toMatch(/changed since you approved/);
  });

  it('a page cannot point a phase at another task to make it look verified', async () => {
    const s = await pair();
    const v = await approvedPlan(s);
    const forged = structuredClone(v.plan);
    const real = forged.phases.find((p: any) => p.taskId).taskId;
    for (const ph of forged.phases) ph.taskId = 'some-other-verified-task';
    const out = await (await api(s, '/api/plan/draft', { plan: forged, expectVersion: v.version })).json();
    expect(out.plan.phases.find((p: any) => p.taskId)?.taskId).toBe(real);
    expect(out.plan.phases.filter((p: any) => p.taskId === 'some-other-verified-task')).toEqual([]);
  });
});

describe('running phases, and what counts as done', () => {
  it('runs the phases in order, and an agent that says "verified" is not believed until the check passes', async () => {
    const s = await pair();
    let v = await approvedPlan(s);
    const [understand, implement, test, verify] = v.plan.phases.map((p: any) => p.id);
    expect(status(v, understand)).toBe('ready');
    expect(status(v, implement)).toBe('blocked');
    // The plan's own prompt, not the page's, is what the agent receives, and the run is tied to the phase.
    expect((await api(s, '/api/plan/phases/start', { phaseId: understand })).status).toBe(200);
    await settle(s);
    v = await view(s);
    expect(status(v, understand)).toBe('done-unchecked');
    expect(v.views.find((x: any) => x.id === understand).why).toMatch(/agent's word only/);
    expect(status(v, implement)).toBe('ready');
    expect((await api(s, '/api/plan/phases/start', { phaseId: implement })).status).toBe(200);
    await settle(s);
    v = await view(s);
    expect(status(v, implement)).toBe('done-unchecked');
    // The tests phase: the agent runs, claims success, and the phase still needs evidence.
    expect((await api(s, '/api/plan/phases/start', { phaseId: test })).status).toBe(200);
    await settle(s);
    v = await view(s);
    expect(status(v, test)).toBe('needs-evidence');
    expect(v.views.some((x: any) => x.status === 'verified')).toBe(false);
    // Only the engine's own check makes it verified.
    v = await (await api(s, '/api/plan/phases/verify', { phaseId: test })).json();
    expect(status(v, test)).toBe('verified');
    expect(status(v, verify)).toBe('ready');
  });

  it('a failing check says failed, and a change after it passed makes the evidence stale', async () => {
    const s = await pair();
    let v = await approvedPlan(s);
    const test = v.plan.phases.find((p: any) => p.kind === 'test').id;
    const ids = v.plan.phases.map((p: any) => p.id);
    for (const id of ids.slice(0, ids.indexOf(test))) { expect((await api(s, '/api/plan/phases/start', { phaseId: id })).status).toBe(200); await settle(s); }
    // done.txt exists after the implement phase, so remove it and the check must fail.
    rmSync(join(root, 'done.txt'), { force: true });
    expect((await api(s, '/api/plan/phases/start', { phaseId: test })).status).toBe(200);
    await settle(s);
    v = await (await api(s, '/api/plan/phases/verify', { phaseId: test })).json();
    expect(status(v, test)).toBe('failed');
    writeFileSync(join(root, 'done.txt'), 'ok');
    v = await (await api(s, '/api/plan/phases/verify', { phaseId: test })).json();
    expect(status(v, test)).toBe('verified');
    writeFileSync(join(root, 'changed-later.txt'), 'x');
    v = await view(s);
    expect(status(v, test)).toBe('stale');
  });

  it('stops at the phase run limit and at the plan budget, on the server', async () => {
    const s = await pair();
    let v = await approvedPlan(s);
    const first = v.plan.phases[0].id;
    const tight = structuredClone(v.plan); tight.phases[0].budget = { maxRuns: 1, maxUsd: 1 }; tight.limits.maxRuns = 10;
    v = await (await api(s, '/api/plan/draft', { plan: tight, expectVersion: v.version })).json();
    expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) })).status).toBe(200);
    expect((await api(s, '/api/plan/phases/start', { phaseId: first })).status).toBe(200);
    await settle(s);
    const second = await api(s, '/api/plan/phases/start', { phaseId: first });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/used its 1 runs/);
  });

  it('will not start an agent it cannot start, and says so instead of pretending', async () => {
    const s = await pair();
    let v = await (await api(s, '/api/plan/draft', { goal: 'Fix a bug' })).json();
    const plan = structuredClone(v.plan); plan.phases[0].agent = 'codex';
    v = await (await api(s, '/api/plan/draft', { plan, expectVersion: v.version })).json();
    expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) })).status).toBe(200);
    const r = await api(s, '/api/plan/phases/start', { phaseId: plan.phases[0].id });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/not built yet/);
  });

  it('a phase with no check to run cannot be verified', async () => {
    const s = await pair();
    const v = await approvedPlan(s);
    const manualOnly = v.plan.phases.find((p: any) => !p.acceptance.some((a: any) => a.kind === 'command')).id;
    const r = await api(s, '/api/plan/phases/verify', { phaseId: manualOnly });
    expect(r.status).toBe(409);
  });
});

describe('from a website the user allowed', () => {
  const SITE = 'https://example-site.test';
  it('may draft without a code, and may not approve or start without one from the terminal', async () => {
    const codes: string[] = [];
    const d = await startCompanion({ root, uiDir: join(dir, 'ui2'), allowedOrigins: [SITE], onTerminalChallenge: (code) => codes.push(code), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
    const base = d.url.slice(0, -1);
    const pr = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: d.newPairingCode() }) })).json();
    const call = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${pr.token}`, 'x-agentontrack-csrf': pr.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const draft = await call('/api/plan/draft', { goal: 'Fix a bug' });
    expect(draft.status).toBe(200);
    const v = await draft.json();
    expect(codes).toEqual([]);
    expect((await call('/api/plan/approve', { sha256: v.sha, expectVersion: v.version, challengeId: 'x', confirm: 'y' })).status).toBeGreaterThanOrEqual(400);
    expect((await call('/api/plan/phases/start', { phaseId: v.plan.phases[0].id })).status).toBe(428);
    await d.close();
  });
});
