// The multi-agent surface, over the companion: what the web, the CLI and an editor all call. Real git, real engine.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let root: string; let c: Companion; let origin: string;
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-collab-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const n = 1;\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  const p = new Project(root);
  p.human.setGoal({ statement: 'Improve', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 'work', criteria: [{ id: 'c', description: 'file exists', kind: 'command', command: `node -e "process.exit(require('fs').existsSync('src/new.ts')?0:1)"` }] });
  p.close();
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

type S = { cookie: string; csrf: string };
const pair = async (): Promise<S> => { const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) }); return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf }; };
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const j = async (r: Response) => r.json() as Promise<any>;

describe('team', () => {
  it('is set by a person with a fresh code, versioned, and a stale window is refused', async () => {
    const s = await pair();
    const team = [{ agent: 'claude-code', role: 'implement' }, { agent: 'codex', role: 'review' }];
    expect((await api(s, '/api/team', { members: team })).status).toBeGreaterThanOrEqual(400);
    expect((await j(await api(s, '/api/team'))).version).toBe(0);
    expect((await api(s, '/api/team', { members: team, ...(await proof(s)) })).status).toBe(200);
    const swapped = [{ agent: 'codex', role: 'implement' }, { agent: 'claude-code', role: 'review' }];
    expect((await api(s, '/api/team', { members: swapped, expectVersion: 1, ...(await proof(s)) })).status).toBe(200);
    const stale = await api(s, '/api/team', { members: team, expectVersion: 1, ...(await proof(s)) });
    expect(stale.status).toBe(409);
    expect((await j(await api(s, '/api/team'))).version).toBe(2);
    expect((await j(await api(s, '/api/state'))).team.members[0].agent).toBe('codex');
    const plan = await j(await api(s, '/api/workflow?kind=implement-review-verify'));
    expect(plan.stages.map((x: any) => x.agent)).toEqual(['codex', 'claude-code', 'checks']);
    expect((await api(s, '/api/workflow?kind=nonsense')).status).toBe(400);
  });
});

describe('parallel work', () => {
  it('two agents, two worktrees, a real conflict shown, a safe merge refused, and the other merged after a person says so', async () => {
    const s = await pair();
    const a = await j(await api(s, '/api/worktrees', { taskId: 't', agent: 'claude-code' }));
    const b = await j(await api(s, '/api/worktrees', { taskId: 't', agent: 'codex' }));
    expect((await api(s, '/api/worktrees', { taskId: 't', agent: 'codex' })).status).toBe(409);
    writeFileSync(join(a.path, 'src', 'app.ts'), 'export const n = "claude";\n');
    writeFileSync(join(a.path, 'src', 'new.ts'), 'export {};\n');
    writeFileSync(join(b.path, 'src', 'app.ts'), 'export const n = "codex";\n');
    await api(s, '/api/worktrees/commit', { id: a.id, message: 'claude' });
    await api(s, '/api/worktrees/commit', { id: b.id, message: 'codex' });
    const view = await j(await api(s, '/api/worktrees'));
    expect(view.worktrees).toHaveLength(2);
    expect(view.conflicts).toEqual([expect.objectContaining({ files: ['src/app.ts'], combine: expect.objectContaining({ clean: false, conflicts: ['src/app.ts'] }) })]);
    // A merge needs a person.
    expect((await api(s, '/api/worktrees/merge', { id: a.id })).status).toBeGreaterThanOrEqual(400);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe('export const n = 1;\n');
    const ok = await j(await api(s, '/api/worktrees/merge', { id: a.id, ...(await proof(s)) }));
    expect(ok.merged).toBe(true);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toContain('claude');
    const preview = await j(await api(s, `/api/worktrees/preview?id=${b.id}`));
    expect(preview).toMatchObject({ clean: false, conflicts: ['src/app.ts'], stale: true });
    const bad = await j(await api(s, '/api/worktrees/merge', { id: b.id, ...(await proof(s)) }));
    expect(bad.merged).toBe(false);
    expect(git(root, 'status', '--porcelain').stdout.trim()).toBe('');
    await api(s, '/api/worktrees/discard', { id: b.id, ...(await proof(s)) });
    expect(existsSync(b.path)).toBe(false);
  });
});

describe('handoff over the companion', () => {
  it('Claude stops, the record is saved, Codex takes it, and nothing it was granted carries over', async () => {
    const s = await pair();
    const p = new Project(root);
    writeFileSync(join(root, 'src', 'new.ts'), 'export {};\n');
    p.verifyTask('t');
    p.close();
    const made = await j(await api(s, '/api/handoffs', { from: 'claude-code', to: 'codex', reason: 'limit', detail: 'the provider reported a usage limit', writeMarkdown: true }));
    expect(made.id).toMatch(/^hnd_/);
    expect(made.problems).toEqual([]);
    expect(readFileSync(join(root, 'HANDOFF.md'), 'utf8')).toContain('usage limit');
    expect((await j(await api(s, '/api/handoffs')))[0]).toMatchObject({ id: made.id, outcome: 'prepared', from: 'claude-code', to: 'codex' });
    const got = await j(await api(s, `/api/handoffs/get?id=${made.id}`));
    expect(got.handoff.reason).toMatchObject({ kind: 'limit' });
    expect(got.handoff.limits.join()).toMatch(/runs the action anyway/);
    const took = await j(await api(s, '/api/handoffs/accept', { id: made.id, to: 'codex' }));
    expect(took).toMatchObject({ accepted: true, reusable: ['c'] });
    expect((await j(await api(s, '/api/handoffs')))[0].outcome).toBe('accepted');
    expect((await api(s, `/api/handoffs/get?id=../../x`)).status).toBe(404);
  });

  it('a stale handoff needs a person to accept it, through the confirmation path', async () => {
    const s = await pair();
    const made = await j(await api(s, '/api/handoffs', { from: 'claude-code', to: 'codex' }));
    await api(s, '/api/goal', { goal: { statement: 'A new direction', scope: { include: ['**'] } }, ...(await proof(s)) });
    const no = await j(await api(s, '/api/handoffs/accept', { id: made.id, to: 'codex' }));
    expect(no).toMatchObject({ accepted: false, problems: [expect.objectContaining({ code: 'STALE_GOAL' })] });
    expect((await api(s, '/api/handoffs/accept-stale', { id: made.id, to: 'codex' })).status).toBeGreaterThanOrEqual(400);
    expect((await api(s, '/api/handoffs/accept-stale', { id: made.id, to: 'codex', challengeId: 'x', confirm: 'wrong' })).status).toBe(403);
    const yes = await j(await api(s, '/api/handoffs/accept-stale', { id: made.id, to: 'codex', ...(await proof(s)) }));
    expect(yes.accepted).toBe(true);
    expect(yes.reusable).toEqual([]);
  });

  it('says who can take over, and what they would not do', async () => {
    const s = await pair();
    const r = await j(await api(s, '/api/failover?from=claude-code&installed=claude-code,codex,opencode,mystery'));
    expect(r.from).toMatchObject({ id: 'claude-code', hostFailMode: 'closed' });
    expect(r.options.map((o: any) => [o.id, o.usable])).toEqual([['opencode', true], ['codex', true], ['mystery', false]]);
  });
});
