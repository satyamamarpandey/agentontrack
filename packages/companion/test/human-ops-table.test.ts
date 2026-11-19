// Every operation that only a person may perform, in one table. For each: no code, a wrong code, a used code and a code issued to a different
// browser session are all refused, and the record is exactly as it was afterwards. Then the routes that had no test of their own before the
// 2026-11-19 inventory (docs/uat/evidence/INVENTORY.md) are exercised for real. Real companion and engine; no agent runs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand, Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let root: string; let c: Companion; let origin: string;
let pendingId = ''; let proposalId = '';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-humanops-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't1', title: 'First task', criteria: [{ id: 'c', description: 'file exists', kind: 'artifact', path: 'src/a.txt' }] });
  p.human.createTask({ id: 't2', title: 'Second task', criteria: [] });
  const cmd = classifyCommand('git push origin main');
  pendingId = p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: cmd.effects, opaque: cmd.opaque, coverage: 'enforced', rawInput: 'git push origin main' }).approvalIds[0]!;
  proposalId = p.propose('goal', { statement: 'Delete everything' }, { kind: 'agent', runtime: 'claude-code' });
  p.close();
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const challenge = async (s: S) => (await (await api(s, '/api/challenge', {})).json()) as { challengeId: string; code: string };
const record = async (s: S) => {
  const st = await (await api(s, '/api/state')).json() as any;
  return JSON.stringify({ goal: st.goal, policy: st.policy, policyVersion: st.policyVersion, tasks: st.tasks, active: st.activeTask, approvals: st.approvals, proposals: st.proposals, team: st.team, plan: st.plan ?? null });
};

/** Every human operation with a body of the right shape, so that only the missing proof can be the reason for a refusal. */
const OPS: [string, () => Record<string, unknown>][] = [
  ['/api/approvals/approve', () => ({ id: pendingId })],
  ['/api/approvals/deny', () => ({ id: pendingId })],
  ['/api/approvals/revoke', () => ({ id: pendingId })],
  ['/api/goal', () => ({ goal: { statement: 'Do anything at all', scope: { include: ['**'] } } })],
  ['/api/goal/close', () => ({ outcome: 'completed' })],
  ['/api/goal/reopen', () => ({})],
  ['/api/plan/approve', () => ({ sha256: 'a'.repeat(64), expectVersion: 1 })],
  ['/api/team', () => ({ members: [] })],
  ['/api/worktrees/merge', () => ({ id: 'wt_000000000000' })],
  ['/api/worktrees/discard', () => ({ id: 'wt_000000000000' })],
  ['/api/handoffs/accept-stale', () => ({ id: 'hnd_x', to: 'codex' })],
  ['/api/file/protected', () => ({ path: 'GOAL.md', content: 'rewritten', baseHash: null })],
  ['/api/proposals/accept', () => ({ id: proposalId })],
  ['/api/proposals/reject', () => ({ id: proposalId })],
  ['/api/policy/profile', () => ({ profile: 'standard' })],
  ['/api/tasks', () => ({ title: 'A task nobody asked for', criteria: [] })],
  ['/api/tasks/activate', () => ({ id: 't2' })],
  ['/api/tasks/close', () => ({ id: 't1' })],
  ['/api/verification/accept-weak', () => ({ taskId: 't1' })],
  ['/api/verification/accept', () => ({ taskId: 't1' })],
  ['/api/mismatch/ack', () => ({ seq: 1 })],
  ['/api/data/delete', () => ({})],
  ['/api/agents/claude-code/disconnect', () => ({})],
  ['/api/agents/codex/disconnect', () => ({})],
];

describe('every human operation needs a fresh code from the same browser session', () => {
  it('the table lists every human operation the companion has', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const declared = [...src.matchAll(/^\s+'(\/api\/[^']+)': \{ schema:/gm)].map((m) => m[1]!).sort();
    expect(declared.length).toBeGreaterThan(15);
    for (const path of declared) expect(OPS.map(([p]) => p), `${path} is a human operation with no row in this table`).toContain(path);
  });

  it.each(OPS)('%s: no code, a wrong code, a used code and another session\'s code change nothing', async (path, body) => {
    const s = await pair();
    const other = await pair();
    const before = await record(s);
    // 1. No proof at all.
    expect([400, 403], 'no code').toContain((await api(s, path, body())).status);
    // 2. A challenge id that does not exist.
    expect((await api(s, path, { ...body(), challengeId: 'deadbeefdeadbeef', confirm: '0000' })).status, 'unknown challenge').toBe(403);
    // 3. A real challenge with the wrong code. The wrong guess uses the challenge up, so the right code afterwards is refused too.
    const ch = await challenge(s);
    const wrong = ch.code === 'ffff' ? '0000' : 'ffff';
    expect((await api(s, path, { ...body(), challengeId: ch.challengeId, confirm: wrong })).status, 'wrong code').toBe(403);
    expect((await api(s, path, { ...body(), challengeId: ch.challengeId, confirm: ch.code })).status, 'the right code after a wrong guess').toBe(403);
    // 4. A code issued to a different paired browser.
    const theirs = await challenge(other);
    expect((await api(s, path, { ...body(), challengeId: theirs.challengeId, confirm: theirs.code })).status, 'another session\'s code').toBe(403);
    expect(await record(s), `${path} changed the record without proof`).toBe(before);
  });
});

describe('routes that had no test of their own', () => {
  const human = async (s: S, path: string, body: Record<string, unknown>) => { const ch = await challenge(s); return api(s, path, { ...body, challengeId: ch.challengeId, confirm: ch.code }); };

  it('reads need a paired session, and answer for this project', async () => {
    const s = await pair();
    for (const path of ['/api/actions', '/api/evaluations', '/api/providers', '/api/event/1']) {
      expect((await fetch(`${origin}${path}`)).status, `${path} without a session`).toBe(401);
      expect((await api(s, path)).status, path).toBe(200);
    }
    expect(Array.isArray(await (await api(s, '/api/actions')).json())).toBe(true);
    expect(Array.isArray(await (await api(s, '/api/providers')).json())).toBe(true);
    expect((await api(s, '/api/event/999999')).status, 'an event that does not exist').toBe(404);
    expect([400, 404, 409]).toContain((await api(s, '/api/plan/phases/prompt?phaseId=nope')).status);
  });

  it('a task is activated and closed, and a goal closed and reopened, by a person with a code', async () => {
    const s = await pair();
    expect((await human(s, '/api/tasks/activate', { id: 't2' })).status).toBe(200);
    expect((await (await api(s, '/api/state')).json()).activeTask?.id).toBe('t2');
    expect((await human(s, '/api/tasks/activate', { id: 'no-such-task' })).status, 'a task that does not exist').toBe(409);
    expect((await human(s, '/api/tasks/close', { id: 't2', outcome: 'done elsewhere' })).status).toBe(200);
    expect((await human(s, '/api/goal/close', { outcome: 'abandoned' })).status).toBe(200);
    expect((await human(s, '/api/goal/reopen', {})).status).toBe(200);
  });

  it('an agent\'s proposal becomes the goal only when a person accepts it, and a rejected one never does', async () => {
    const s = await pair();
    expect((await (await api(s, '/api/state')).json()).goal.statement).toBe('Fix the crash');
    expect((await human(s, '/api/proposals/reject', { id: proposalId, note: 'no' })).status).toBe(200);
    expect((await (await api(s, '/api/state')).json()).goal.statement).toBe('Fix the crash');
    expect((await human(s, '/api/proposals/accept', { id: proposalId })).status, 'a rejected proposal cannot be accepted afterwards').toBe(409);
    expect((await (await api(s, '/api/state')).json()).goal.statement).toBe('Fix the crash');
  });

  it('verification and mismatch acknowledgements refuse what does not exist, with a code', async () => {
    const s = await pair();
    expect((await human(s, '/api/mismatch/ack', { seq: 999999 })).status).toBe(409);
    expect((await human(s, '/api/verification/accept', { taskId: 'no-such-task' })).status).toBe(409);
    expect((await human(s, '/api/verification/accept-weak', { taskId: 'no-such-task' })).status).toBe(409);
  });

  it('discover looks inside one named folder only, and refuses a drive or a relative path', async () => {
    const s = await pair();
    expect((await api(s, '/api/projects/discover', { dir: 'relative/path' })).status).toBe(400);
    expect((await api(s, '/api/projects/discover', { dir: process.platform === 'win32' ? 'C:\\' : '/' })).status).toBe(400);
    expect((await api(s, '/api/projects/discover', { dir: join(dir, 'does-not-exist') })).status).toBe(400);
    mkdirSync(join(dir, 'code', 'one', '.git'), { recursive: true });
    const found = await (await api(s, '/api/projects/discover', { dir: join(dir, 'code'), depth: 2 })).json() as any;
    expect(found.found.map((f: any) => f.name)).toEqual(['one']);
  });

  it('clone accepts only a GitHub https address and a folder made for the project; nothing is fetched for a refused request', async () => {
    const s = await pair();
    for (const url of ['file:///etc/passwd', 'https://evil.example/x/y', 'git@github.com:a/b.git', 'https://github.com/a/b --upload-pack=x', 'ext::sh -c id', 'https://github.com/../..']) {
      expect((await api(s, '/api/projects/clone', { url, dest: join(dir, 'clone-here') })).status, url).toBe(400);
    }
    expect((await api(s, '/api/projects/clone', { url: 'https://github.com/owner/repo', dest: 'relative' })).status).toBe(400);
    expect((await api(s, '/api/projects/clone', { url: 'https://github.com/owner/repo', dest: join(dir, 'home', 'inside-data') })).status, 'inside the data folder').toBe(400);
  });

  it('probe takes a URL only, and reports an unreachable local server as unreachable', async () => {
    const s = await pair();
    expect((await api(s, '/api/probe', { baseUrl: 'not a url' })).status).toBe(400);
    const r = await api(s, '/api/probe', { baseUrl: 'http://127.0.0.1:9' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toMatch(/false|unreachable|not/i);
  });
});
