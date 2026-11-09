// Two projects in one companion: what belongs to one is not usable from the other. Attachments, resumable sessions, notes and decisions are all
// per project, so a caller (or an agent's prompt) that names another project's id gets a refusal and no data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project, registerProject } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const CLAUDE = `console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-claude-0001', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, modelUsage: {} }));`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

let dir: string; let c: Companion; let origin: string; let A = ''; let B = '';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-iso-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  writeFileSync(join(dir, 'fake-claude.mjs'), CLAUDE);
  const roots = ['a', 'b'].map((n) => { const r = join(dir, n); mkdirSync(r); return r; });
  for (const [i, r] of roots.entries()) {
    const p = new Project(r);
    p.human.setGoal({ statement: `Goal of project ${i}`, scope: { include: ['**'] } });
    if (i === 0) p.human.recordDecision('Refunds go to the wallet', 'Instant');
    p.close();
    installHooks('claude-code', r, `"${process.execPath}" "${CLI}"`);
  }
  [A, B] = roots.map((r) => registerProject(r).id);
  c = await startCompanion({ root: roots[0], uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const upload = (s: S, project: string) => fetch(`${origin}/api/attachments?project=${project}`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/octet-stream' }, body: PNG });
const settle = async (s: S, project: string) => { for (let i = 0; i < 200; i++) { const r = (await (await api(s, `/api/runs?project=${project}`)).json()) as any[]; if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };
const run = (s: S, project: string, extra: object = {}) => api(s, `/api/runs?project=${project}`, { runtime: 'claude-code', prompt: 'go', model: 'm1', maxBudgetUsd: 0.1, ...extra });

describe('one project cannot use another project’s data', () => {
  it('knows two separate projects', () => { expect(A).not.toBe(B); });

  it('an attachment from project A is not found from project B', async () => {
    const s = await pair();
    const { id } = await (await upload(s, A)).json();
    expect((await run(s, A, { attachments: [id] })).status).toBe(200);
    await settle(s, A);
    expect((await run(s, B, { attachments: [id] })).status).toBe(404);
  });

  it('a run of project A cannot be resumed from project B', async () => {
    const s = await pair();
    const first = await (await run(s, A)).json();
    await settle(s, A);
    expect((await run(s, A, { resumeRunId: first.id })).status).toBe(200);
    await settle(s, A);
    const cross = await run(s, B, { resumeRunId: first.id });
    expect(cross.status).toBe(404);
  });

  it('a question in project B does not see project A’s decisions or notes', async () => {
    const s = await pair();
    await api(s, `/api/notes?project=${A}`, { text: 'Wallet refunds use the queue', scope: 'project' });
    const inA = await (await api(s, `/api/ask?project=${A}&q=${encodeURIComponent('wallet refunds')}`)).json();
    const inB = await (await api(s, `/api/ask?project=${B}&q=${encodeURIComponent('wallet refunds')}`)).json();
    expect(inA.matched).toBe(true);
    expect(inB).toMatchObject({ matched: false, sources: [] });
  });

  it('an unknown project id is refused', async () => {
    const s = await pair();
    expect((await run(s, 'not-a-project')).status).toBe(404);
  });
});
