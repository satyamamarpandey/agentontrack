// Server-authoritative autonomy, through the real companion with a stand-in agent. The only thing that lets runs follow one another with nobody acting is a grant that a person
// created with the terminal code: for one project, limited in runs, expiring. Even then a chained run is refused for a subscription or unidentified sign-in, because provider
// permission for unattended subscription automation is unresolved (docs/product/PROVIDER_COMPLIANCE.md rows 3 and 4). Nothing the caller sends can switch any of this on.
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks, type AuthMode } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const FAKE = `
import { appendFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
appendFileSync('prompts.log', prompt.replace(/\\n/g, ' ').slice(-120) + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
await new Promise((ok) => setTimeout(ok, Number(process.env.AOT_FAKE_DELAY_MS ?? 0)));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, duration_api_ms: 3, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
`;
// The check never passes (nothing writes done.txt), so a loop always wants another round: only the gates can stop it.
const CHECK = `node -e "process.exit(require('fs').existsSync('done.txt')?0:1)"`;

let dir: string; let root: string; let c: Companion; let origin: string;
const boot = async (extra: { mode?: AuthMode; paid?: boolean } = {}) => {
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')], allowPaidApi: extra.paid ?? true, detectedAuthMode: () => extra.mode ?? 'api-key' });
  origin = c.url.slice(0, -1);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-auto-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, 'agentontrack');
});
afterEach(async () => { await c.close(); delete process.env.AOT_FAKE_DELAY_MS; rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const grant = async (s: S, extra: object = {}) => { const r = await api(s, '/api/settings/unattended', { allow: true, maxRounds: 5, ...extra, ...(await proof(s)) }); expect(r.status).toBe(200); return (await r.json()).unattended.grant; };
const settings = async (s: S) => (await api(s, '/api/settings')).json();
const projectId = async (s: S) => (await (await api(s, '/api/projects')).json())[0].id as string;
const settingsFile = () => join(dir, 'home', 'settings.json');
const writeGrant = (g: object) => { mkdirSync(join(dir, 'home'), { recursive: true }); writeFileSync(settingsFile(), JSON.stringify({ unattendedGrant: g })); };
const prompts = () => (fs.existsSync(join(root, 'prompts.log')) ? fs.readFileSync(join(root, 'prompts.log'), 'utf8').trim().split('\n').length : 0);
const remaining = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).unattendedGrant.remainingRuns as number;
const until = async (fn: () => Promise<boolean> | boolean, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('timed out waiting'); };
const sequence = async (s: S) => (await (await api(s, '/api/plan')).json()).sequence as { active: boolean; ended: { reason: string; message: string } | null };

async function approvedPlan(s: S) {
  let v = await (await api(s, '/api/plan/draft', { goal: 'Fix the crash when the date is empty' })).json();
  const plan = structuredClone(v.plan);
  plan.phases.forEach((ph: any, n: number) => {
    ph.acceptance = ph.acceptance.filter((x: any) => x.kind !== 'command');
    if (n === 0) { ph.dependsOn = []; ph.acceptance.push({ id: 'loop-check', description: 'done.txt exists', kind: 'command', command: CHECK }); }
  });
  v = await (await api(s, '/api/plan/draft', { plan, expectVersion: v.version })).json();
  expect((await api(s, '/api/plan/approve', { sha256: v.sha, expectVersion: v.version, ...(await proof(s)) })).status).toBe(200);
  return (await (await api(s, '/api/plan')).json()).plan.phases[0].id as string;
}
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const H = 3_600_000;

describe('a direct caller cannot start several phases or rounds without a grant', () => {
  it('refuses continue (several phases) and loop (the default rounds) with no grant, whatever flags it sends, and starts nothing', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s);
    for (const [path, body] of [['/api/plan/continue', { maxPhases: 3 }], ['/api/plan/continue', { maxPhases: 10, chain: true, unattended: true }], ['/api/plan/loop', { phaseId: id }], ['/api/plan/loop', { phaseId: id, rounds: 5, chain: true, allowUnattended: true }]] as const) {
      const r = await api(s, path, body);
      expect(r.status, path).toBe(409);
      expect((await r.json()).error).toMatch(/Unattended runs are off.*Settings/s);
    }
    expect(prompts()).toBe(0);
  });
  it('one phase via /api/plan/continue (maxPhases 1) and one loop round need no grant, even with a subscription sign-in', async () => {
    await boot({ mode: 'subscription', paid: false });
    const s = await pair(); const id = await approvedPlan(s);
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 1 })).status).toBe(200);
    await until(() => prompts() === 1);
  });
});

describe('the grant is limited, scoped, expiring and enforced when it is used', () => {
  it('an expired grant is refused', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s); const pid = await projectId(s);
    writeGrant({ projectId: pid, maxRuns: 5, remainingRuns: 5, maxPhasesPerSequence: 5, maxRounds: 5, createdAt: iso(-5 * H), expiresAt: iso(-1 * H) });
    const r = await api(s, '/api/plan/loop', { phaseId: id, rounds: 3 });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/expired/);
    expect(prompts()).toBe(0);
  });
  it('a grant for another project is refused', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s);
    writeGrant({ projectId: 'f'.repeat(24), maxRuns: 5, remainingRuns: 5, maxPhasesPerSequence: 5, maxRounds: 5, createdAt: iso(-1000), expiresAt: iso(H) });
    const r = await api(s, '/api/plan/loop', { phaseId: id, rounds: 3 });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/different project/);
    expect(prompts()).toBe(0);
  });
  it('a grant that lasts more than 24 hours is not honoured, and the route cannot make one', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s); const pid = await projectId(s);
    writeGrant({ projectId: pid, maxRuns: 5, remainingRuns: 5, maxPhasesPerSequence: 5, maxRounds: 5, createdAt: iso(-1000), expiresAt: iso(30 * H) });
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 3 })).status).toBe(409);
    expect((await api(s, '/api/settings/unattended', { allow: true, hours: 48, ...(await proof(s)) })).status).toBe(400);
    expect((await api(s, '/api/settings/unattended', { allow: true, maxRuns: 11, ...(await proof(s)) })).status).toBe(400);
  });
  it('a hand-written grant with missing or out-of-range limits is not honoured', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s); const pid = await projectId(s);
    const ok = { projectId: pid, maxRuns: 5, remainingRuns: 5, maxPhasesPerSequence: 5, maxRounds: 5, createdAt: iso(-1000), expiresAt: iso(H) };
    for (const bad of [{ ...ok, maxPhasesPerSequence: undefined }, { ...ok, remainingRuns: 6 }, { ...ok, maxRounds: 50 }, { ...ok, maxRuns: 99, remainingRuns: 99 }]) {
      writeGrant(bad);
      expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 3 })).status).toBe(409);
    }
    expect(prompts()).toBe(0);
  });
  it('a spent grant stops the sequence after exactly that many runs, and the count is persisted', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s);
    const g = await grant(s, { maxRuns: 2 });
    expect(g).toMatchObject({ maxRuns: 2, remainingRuns: 2 });
    expect(Date.parse(g.expiresAt) - Date.parse(g.createdAt)).toBe(4 * H);
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 5 })).status).toBe(200);
    await until(async () => !(await sequence(s)).active);
    expect(prompts()).toBe(2);
    expect((await sequence(s)).ended).toMatchObject({ reason: 'grant' });
    expect((await sequence(s)).ended!.message).toMatch(/no runs left/);
    expect(remaining()).toBe(0);
    const again = await api(s, '/api/plan/loop', { phaseId: id, rounds: 2 });
    expect(again.status).toBe(409);
    expect(prompts()).toBe(2);
  });
  it('a single start does not spend the grant', async () => {
    await boot();
    const s = await pair(); const id = await approvedPlan(s);
    await grant(s, { maxRuns: 3 });
    expect((await api(s, '/api/plan/phases/start', { phaseId: id })).status).toBe(200);
    await until(() => prompts() === 1);
    expect(remaining()).toBe(3);
  });
  it('cancelling the grant aborts a running sequence and the agent it is waiting on', async () => {
    process.env.AOT_FAKE_DELAY_MS = '6000';
    await boot();
    const s = await pair(); const id = await approvedPlan(s);
    await grant(s);
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 5 })).status).toBe(200);
    await until(() => prompts() === 1);
    expect((await api(s, '/api/settings/unattended', { allow: false, ...(await proof(s)) })).status).toBe(200);
    expect((await settings(s)).unattended.active).toBe(false);
    await until(async () => !(await sequence(s)).active, 10_000);
    expect((await sequence(s)).ended).toMatchObject({ reason: 'cancelled' });
    const runs = await (await api(s, '/api/runs')).json();
    expect(runs.every((r: any) => r.status !== 'running')).toBe(true);
    await new Promise((ok) => setTimeout(ok, 800));
    expect(prompts()).toBe(1);
  });
  it('a grant needs the terminal code to be created or cancelled', async () => {
    await boot();
    const s = await pair();
    expect([400, 403]).toContain((await api(s, '/api/settings/unattended', { allow: true })).status);
    expect([400, 403]).toContain((await api(s, '/api/settings/unattended', { allow: false })).status);
    expect((await settings(s)).unattended.active).toBe(false);
  });
});

describe('starting agents from a phone is its own setting, off by default, changed only with the terminal code', () => {
  it('is off by default; cannot be changed by the general settings route or without the code; can be turned on and off with it', async () => {
    await boot();
    const s = await pair();
    expect((await settings(s)).allowMobileExecution).toBe(false);
    expect((await api(s, '/api/settings', { allowMobileExecution: true })).status).toBe(200); // unknown field, ignored
    expect((await settings(s)).allowMobileExecution).toBe(false);
    expect([400, 403]).toContain((await api(s, '/api/settings/mobile-execution', { allow: true })).status);
    expect((await settings(s)).allowMobileExecution).toBe(false);
    expect((await api(s, '/api/settings/mobile-execution', { allow: true, ...(await proof(s)) })).status).toBe(200);
    expect((await settings(s)).allowMobileExecution).toBe(true);
    expect((await api(s, '/api/settings/mobile-execution', { allow: false, ...(await proof(s)) })).status).toBe(200);
    expect((await settings(s)).allowMobileExecution).toBe(false);
  });
});

describe('even with a valid grant, a chained run needs an API-key sign-in under paid API mode', () => {
  const REFUSAL = /subscription sign-in.*unresolved.*your own API key in paid API mode, or start each phase yourself/s;
  for (const mode of ['subscription', 'unknown'] as const) {
    it(`${mode} sign-in: loop and continue are refused, nothing starts, and one phase started by hand still works`, async () => {
      await boot({ mode, paid: true });
      const s = await pair(); const id = await approvedPlan(s);
      await grant(s);
      for (const [path, body] of [['/api/plan/loop', { phaseId: id, rounds: 3 }], ['/api/plan/continue', { maxPhases: 3 }]] as const) {
        const r = await api(s, path, body);
        expect(r.status, `${mode} ${path}`).toBe(409);
        expect((await r.json()).error).toMatch(REFUSAL);
      }
      expect(prompts()).toBe(0);
      expect((await api(s, '/api/plan/phases/start', { phaseId: id })).status).toBe(200);
    });
  }
  it('an API-key sign-in with paid API mode OFF is refused too', async () => {
    await boot({ mode: 'api-key', paid: false });
    const s = await pair(); const id = await approvedPlan(s);
    await grant(s);
    const r = await api(s, '/api/plan/loop', { phaseId: id, rounds: 3 });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(REFUSAL);
  });
  it('API-key sign-in, paid API mode on and a grant: the sequence runs and spends the grant', async () => {
    await boot({ mode: 'api-key', paid: true });
    const s = await pair(); const id = await approvedPlan(s);
    await grant(s, { maxRuns: 4 });
    expect((await api(s, '/api/plan/loop', { phaseId: id, rounds: 2 })).status).toBe(200);
    await until(async () => !(await sequence(s)).active);
    expect(prompts()).toBe(2);
    expect(remaining()).toBe(2);
  });
});
