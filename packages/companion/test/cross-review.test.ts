// Builder, then reviewer from a handoff, then the project's own checks, through the real companion, real hook install, real handoff and real
// check engine. Both "agents" are scripts that print what each CLI is documented to print and record what they were asked: this tests the
// workflow and the handoff between runtimes, not Claude Code, Codex or any model. Real two-runtime execution is NOT TESTED here.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const REC = `import { appendFileSync, writeFileSync } from 'node:fs'; if (process.env.FAKE_WRITE) writeFileSync('built-by-' + (process.argv[1].includes('claude') ? 'claude' : 'codex') + '.txt', 'work'); appendFileSync(process.env.CALLS, JSON.stringify({ who: process.argv[1].includes('claude') ? 'claude-code' : 'codex', prompt: process.argv.find((a, i, all) => all[i - 1] === '-p' || all[i - 1] === '--') }) + '\\n');`;
const FAKE_CLAUDE = `${REC}
await new Promise((ok) => setTimeout(ok, Number(process.env.FAKE_DELAY_MS ?? 0)));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));`;
const FAKE_CODEX = `${REC}
console.log(JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }));`;

let dir: string; let root: string; let c: Companion; let origin: string; let calls: string; let mode: 'api-key' | 'subscription' = 'api-key';
const writeGrant = (projectId: string, runs: number) => { const now = Date.now(); mkdirSync(join(dir, 'home'), { recursive: true }); writeFileSync(join(dir, 'home', 'settings.json'), JSON.stringify({ unattendedGrant: { projectId, maxRuns: 10, remainingRuns: runs, maxPhasesPerSequence: 5, maxRounds: 5, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() } })); };
const grantLeft = () => JSON.parse(readFileSync(join(dir, 'home', 'settings.json'), 'utf8')).unattendedGrant.remainingRuns as number;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-xr-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  calls = join(dir, 'calls.jsonl');
  process.env.CALLS = calls;
  writeFileSync(calls, '');
  root = join(dir, 'repo');
  mkdirSync(root);
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE_CLAUDE);
  writeFileSync(join(dir, 'fake-codex.mjs'), FAKE_CODEX);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.human.recordDecision('Keep the public API', 'Other packages import it');
  p.human.createTask({ id: 't', title: 'Fix it', criteria: [{ id: 'ok', description: 'the check passes', kind: 'command', command: 'node -e "process.exit(0)"' }] });
  p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  mode = 'api-key';
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')], codexMode: 'exec', codexCommand: [process.execPath, join(dir, 'fake-codex.mjs')], allowPaidApi: true, detectedAuthMode: () => mode });
  origin = c.url.slice(0, -1);
  // Cross-review is chained, so by default these tests run with a valid grant and API-key sign-ins under paid API mode.
  const pid = ((await (await api(await pair(), '/api/projects')).json()) as { id: string }[])[0]!.id;
  writeGrant(pid, 10);
});
afterEach(async () => { delete process.env.FAKE_DELAY_MS; delete process.env.CALLS; delete process.env.FAKE_WRITE; await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const wfEvents = () => { const p = new Project(root); try { return p.store.all().filter((e: any) => String(e.type).startsWith('workflow.')).map((e: any) => ({ type: e.type, ...e.payload })); } finally { p.close(); } };
const waitEnded = async () => { for (let i = 0; i < 300; i++) { if (wfEvents().some((e) => e.type === 'workflow.ended')) return wfEvents(); await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the workflow did not end'); };
const body = (builder: string, reviewer: string, extra: object = {}) => ({ builder, reviewer, prompt: 'Fix the crash', builderModel: 'm1', reviewerModel: 'm2', taskId: 't', maxUsd: 0.1, ...extra });
const recorded = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { who: string; prompt: string });

describe('cross-review', () => {
  for (const [builder, reviewer] of [['claude-code', 'codex'], ['codex', 'claude-code']] as const) {
    it(`${builder} builds, ${reviewer} reviews from a handoff, then the checks run`, async () => {
      process.env.FAKE_WRITE = '1';
      const s = await pair();
      const r = await api(s, '/api/workflows/cross-review', body(builder, reviewer));
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      const ev = await waitEnded();
      expect(ev.find((e) => e.type === 'workflow.ended')!.status).toBe('finished');
      expect(ev.filter((e) => e.type === 'workflow.step').map((e) => e.step)).toEqual(['build', 'changes', 'handoff', 'review', 'checks']);
      const wrote = `built-by-${builder === 'claude-code' ? 'claude' : 'codex'}.txt`;
      expect(ev.find((e) => e.step === 'changes')!.files).toContain(wrote);
      expect(ev.find((e) => e.type === 'workflow.started')!.gitRepository).toBe(true);
      expect(ev.find((e) => e.step === 'handoff')!.approvalsCarried).toBe(0);
      expect(ev.find((e) => e.step === 'checks')!.ran).toBe(true);
      const seen = recorded();
      expect(seen.map((x) => x.who)).toEqual([builder, reviewer]);
      expect(seen[0]!.prompt).toBe('Fix the crash');
      // The reviewer gets the goal, the decision and the limits, and is told not to edit or weaken checks.
      expect(seen[1]!.prompt).toMatch(/Do not edit files and do not weaken any check/);
      expect(seen[1]!.prompt).toContain('Fix the crash');
      expect(seen[1]!.prompt).toContain('Keep the public API');
      expect(seen[1]!.prompt).toContain(`Files the builder changed (1): ${wrote}`);
      const p = new Project(root);
      expect(p.store.all().some((e: any) => e.type === 'handoff.accepted' && e.actor.runtime === reviewer)).toBe(true);
      expect(p.state().receipts.some((x: any) => x.taskId === 't' && x.passed)).toBe(true);
      p.close();
    });
  }

  it('does not report success, review or run checks when the builder finished but changed nothing', async () => {
    // Seen in 3 of 18 real Claude Code and Codex handoffs: the Codex builder's run ended finished and no file existed.
    const s = await pair();
    const r = await api(s, '/api/workflows/cross-review', body('codex', 'claude-code'));
    expect(r.status).toBe(200);
    const ev = await waitEnded();
    const step = ev.find((e: any) => e.step === 'changes') as any;
    expect(step.count).toBe(0);
    expect(step.warning).toMatch(/changed nothing/);
    expect(ev.find((e: any) => e.type === 'workflow.ended')?.status).toBe('builder-changed-nothing');
    expect(ev.some((e: any) => ['handoff', 'review', 'checks'].includes(e.step))).toBe(false);
    expect(recorded().map((x) => x.who)).toEqual(['codex']);
  });

  it('gives no warning when the builder changed a file', async () => {
    process.env.FAKE_WRITE = '1';
    const s = await pair();
    await api(s, '/api/workflows/cross-review', body('codex', 'claude-code'));
    const step = (await waitEnded()).find((e: any) => e.step === 'changes') as any;
    expect(step.count).toBeGreaterThan(0);
    expect(step.warning).toBeUndefined();
  });

  it('one click is exactly two runs, and a retry with the same Idempotency-Key returns the first answer instead of a second workflow', async () => {
    process.env.FAKE_WRITE = '1';
    const s = await pair();
    const key = 'xreview-retry-key-0123456789';
    const post = () => fetch(`${origin}/api/workflows/cross-review`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body('claude-code', 'codex')) });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await a.json()).workflow).toBe((await b.json()).workflow);
    await waitEnded();
    expect(recorded().map((x) => x.who)).toEqual(['claude-code', 'codex']);
    // A different request on the same key is refused.
    const other = await fetch(`${origin}/api/workflows/cross-review`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body('codex', 'claude-code')) });
    expect(other.status).toBe(409);
  });

  it('is refused at the cap of four running agents, and the refusal is not recorded against its key', async () => {
    process.env.FAKE_DELAY_MS = '8000';
    const s = await pair();
    for (let i = 0; i < 4; i++) expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: `busy ${i}`, model: 'haiku', maxBudgetUsd: 0.1 })).status).toBe(200);
    const r = await api(s, '/api/workflows/cross-review', body('claude-code', 'codex'));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/busy/);
    expect(wfEvents().filter((e) => e.type === 'workflow.started')).toHaveLength(0);
  });

  it('refuses the same agent as builder and reviewer', async () => {
    const r = await api(await pair(), '/api/workflows/cross-review', body('codex', 'codex'));
    expect(r.status).toBe(409);
  });

  it('does not start the builder at all when the reviewer cannot be started safely', async () => {
    const hooks = join(root, '.codex', 'hooks.json');
    writeFileSync(hooks, readFileSync(hooks, 'utf8').split(JSON.stringify(CLI).slice(1, -1)).join('missing.js'));
    const r = await api(await pair(), '/api/workflows/cross-review', body('claude-code', 'codex'));
    expect(r.status).toBe(409);
    expect(recorded()).toEqual([]);
    expect(wfEvents()).toEqual([]);
  });

  it('does not review when the builder fails', async () => {
    writeFileSync(join(dir, 'fake-claude.mjs'), 'process.exit(3);');
    const s = await pair();
    expect((await api(s, '/api/workflows/cross-review', body('claude-code', 'codex'))).status).toBe(200);
    const ev = await waitEnded();
    expect(ev.find((e) => e.type === 'workflow.ended')!.status).toBe('builder-failed');
    expect(recorded()).toEqual([]);
  });

  it('does not review without a task to hand off, so no context is lost silently', async () => {
    process.env.FAKE_WRITE = '1'; // the builder must change something, or the workflow ends before the handoff
    const s = await pair();
    await api(s, '/api/workflows/cross-review', body('claude-code', 'codex', { taskId: 'missing' }));
    const ev = await waitEnded();
    expect(ev.find((e) => e.type === 'workflow.ended')!.status).toMatch(/^no-handoff/);
    expect(recorded().map((x) => x.who)).toEqual(['claude-code']);
  });

  describe('who may start it', () => {
    it('is refused on a subscription sign-in even with a grant, names the compliant paths, and starts nothing', async () => {
      mode = 'subscription';
      const r = await api(await pair(), '/api/workflows/cross-review', body('claude-code', 'codex'));
      expect(r.status).toBe(409);
      const msg = (await r.json()).error as string;
      expect(msg).toMatch(/own API key in paid API mode/);
      expect(msg).toMatch(/two separate runs/);
      expect(recorded()).toEqual([]);
      expect(wfEvents()).toEqual([]);
    });

    it('is refused without a grant even with API-key sign-ins', async () => {
      rmSync(join(dir, 'home', 'settings.json'));
      const r = await api(await pair(), '/api/workflows/cross-review', body('claude-code', 'codex'));
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/Unattended runs are off|two separate runs/);
      expect(recorded()).toEqual([]);
    });

    it('is refused when the grant has fewer than the two runs it needs', async () => {
      const pid = ((await (await api(await pair(), '/api/projects')).json()) as { id: string }[])[0]!.id;
      writeGrant(pid, 1);
      expect((await api(await pair(), '/api/workflows/cross-review', body('claude-code', 'codex'))).status).toBe(409);
      expect(recorded()).toEqual([]);
    });

    it('is allowed with a grant and API-key sign-ins, and spends one grant run for each of the two runs', async () => {
      process.env.FAKE_WRITE = '1';
      const r = await api(await pair(), '/api/workflows/cross-review', body('claude-code', 'codex'));
      expect(r.status).toBe(200);
      await waitEnded();
      expect(recorded().map((x) => x.who)).toEqual(['claude-code', 'codex']);
      expect(grantLeft()).toBe(8);
    });
  });

  describe('manual review of a finished run (no grant, works on a subscription)', () => {
    const buildOnce = async (s: S) => {
      const r = await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'Fix the crash', model: 'm1', maxBudgetUsd: 0.1 });
      expect(r.status).toBe(200);
      const id = (await r.json()).id as string;
      for (let i = 0; i < 100; i++) { const rs = (await (await api(s, '/api/runs')).json()) as { id: string; status: string }[]; if (rs.find((x) => x.id === id)?.status !== 'running') break; await new Promise((ok) => setTimeout(ok, 100)); }
      return id;
    };
    it('starts exactly one reviewer run from a handoff on a subscription sign-in with no grant', async () => {
      mode = 'subscription';
      rmSync(join(dir, 'home', 'settings.json'));
      const s = await pair();
      const runId = await buildOnce(s);
      const r = await api(s, '/api/workflows/review', { runId, reviewer: 'codex', model: 'm2', taskId: 't' });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      const out = await r.json();
      expect(out.started).toBe(true);
      await new Promise((ok) => setTimeout(ok, 1500));
      expect(recorded().map((x) => x.who)).toEqual(['claude-code', 'codex']);
      expect(recorded()[1]!.prompt).toMatch(/Do not edit files and do not weaken any check/);
      const p = new Project(root);
      expect(p.store.all().some((e: any) => e.type === 'handoff.accepted' && e.actor.runtime === 'codex')).toBe(true);
      p.close();
      expect(wfEvents()).toEqual([]);
    });

    it('is a single start: the same Idempotency-Key returns the first answer and starts no second reviewer', async () => {
      const s = await pair();
      const runId = await buildOnce(s);
      const key = 'manual-review-key-0123456789';
      const post = () => fetch(`${origin}/api/workflows/review`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ runId, reviewer: 'codex', model: 'm2', taskId: 't' }) });
      const [a, b] = await Promise.all([post(), post()]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await a.json()).runId).toBe((await b.json()).runId);
      await new Promise((ok) => setTimeout(ok, 1500));
      expect(recorded().map((x) => x.who)).toEqual(['claude-code', 'codex']);
    });

    it('refuses an unknown run, and the same agent as the one that did the work', async () => {
      const s = await pair();
      expect((await api(s, '/api/workflows/review', { runId: 'run_nope', reviewer: 'codex', model: 'm2' })).status).toBe(404);
      const runId = await buildOnce(s);
      expect((await api(s, '/api/workflows/review', { runId, reviewer: 'claude-code', model: 'm2' })).status).toBe(409);
      expect(recorded().map((x) => x.who)).toEqual(['claude-code']);
    });
  });
});
