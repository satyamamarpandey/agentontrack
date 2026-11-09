// A run inside an isolated worktree, through the real companion, real git, and the real hook program. The "agent" is a script that behaves like
// Claude Code in the one way that matters here: it runs the hook command found in the settings of the folder it was started in, with that folder as
// its project directory. This proves the gate reaches a worktree; it is not Claude Code and not a model.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const FAKE = `
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('.claude/settings.local.json', 'utf8'));
const cmd = cfg.hooks.PreToolUse[0].hooks[0].command;
const input = JSON.stringify({ session_id: 'sess-wt-1', cwd: process.cwd(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
const r = spawnSync(cmd, { shell: true, input, encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd(), AGENTONTRACK_ROOT: '' } });
writeFileSync('made.txt', 'work');
appendFileSync(process.env.CALLS, JSON.stringify({ cwd: process.cwd(), hookOut: r.stdout, status: r.status }) + '\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));
`;

let dir: string; let root: string; let c: Companion; let origin: string; let calls: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-wt-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  calls = join(dir, 'calls.jsonl'); process.env.CALLS = calls; writeFileSync(calls, '');
  root = join(dir, 'repo');
  mkdirSync(root);
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...a], { cwd: root });
  g('init', '-q'); writeFileSync(join(root, 'README.md'), 'hi'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.human.createTask({ id: 't', title: 'Fix it', criteria: [{ id: 'ok', description: 'x', kind: 'command', command: 'node -e "process.exit(0)"' }] });
  p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { delete process.env.CALLS; await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const startRun = async (s: S, body: object) => api(s, '/api/runs', { runtime: 'claude-code', prompt: 'Do it', model: 'haiku', maxBudgetUsd: 0.1, ...body, ...(await proof(s)) });
const settle = async (s: S) => { for (let i = 0; i < 300; i++) { const r = (await (await api(s, '/api/runs')).json()) as any[]; if (r.length && r.every((x) => x.status !== 'running')) return r; await new Promise((ok) => setTimeout(ok, 100)); } throw new Error('the run did not finish'); };

describe('a run inside an isolated worktree', () => {
  it('runs in the worktree, with the gate reaching it, and leaves the project folder untouched', async () => {
    const s = await pair();
    const wt = await (await api(s, '/api/worktrees', { taskId: 't', agent: 'claude-code' })).json();
    expect(wt.id).toMatch(/^wt_/);
    const r = await startRun(s, { worktreeId: wt.id });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const [run] = await settle(s);
    expect(run.status).toBe('finished');
    const call = JSON.parse(readFileSync(calls, 'utf8').trim().split('\n')[0]!);
    // macOS reports /private/var for /var, so compare resolved paths.
    expect(realpathSync(call.cwd).replaceAll('\\', '/').toLowerCase()).toBe(realpathSync(wt.path).replaceAll('\\', '/').toLowerCase());
    // The hook ran from the worktree and judged the action against the main project's record: a push needs a person.
    expect(call.hookOut).toMatch(/permissionDecision":"deny/);
    expect(call.hookOut).toMatch(/needs human approval/);
    const p = new Project(root);
    const asked = p.store.all().filter((e: any) => e.type === 'action.requested' && e.payload?.tool === 'Bash');
    p.close();
    expect(asked.length).toBeGreaterThan(0);
    // The work is in the worktree, not the project, and the hook file we added is not part of the diff.
    expect(existsSync(join(root, 'made.txt'))).toBe(false);
    expect(existsSync(join(wt.path, 'made.txt'))).toBe(true);
    const wts = await (await api(s, '/api/worktrees')).json();
    const status = wts.worktrees.find((w: any) => w.id === wt.id);
    expect(status.changed.map((x: any) => x.path)).toEqual(['made.txt']);
    const committed = await api(s, '/api/worktrees/commit', { id: wt.id });
    expect(committed.status).toBe(200);
    const files = spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: wt.path, encoding: 'utf8' }).stdout.trim().split('\n');
    expect(files).toEqual(['made.txt']);
  });

  it('refuses another agent’s worktree, an unknown one, and a Codex exec run in a worktree', async () => {
    const s = await pair();
    const wt = await (await api(s, '/api/worktrees', { taskId: 't', agent: 'codex' })).json();
    const other = await startRun(s, { worktreeId: wt.id });
    expect(other.status).toBe(409);
    expect((await other.json()).error).toMatch(/belongs to codex/);
    expect((await startRun(s, { worktreeId: 'wt_nope' })).status).toBe(404);
  });

  it('refuses to start when the hooks would not run from the worktree', async () => {
    const s = await pair();
    const wt = await (await api(s, '/api/worktrees', { taskId: 't', agent: 'claude-code' })).json();
    const f = join(root, '.claude', 'settings.local.json');
    writeFileSync(f, readFileSync(f, 'utf8').replaceAll(CLI.replaceAll('\\', '\\\\'), join(dir, 'missing.js').replaceAll('\\', '\\\\')));
    const r = await startRun(s, { worktreeId: wt.id });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Not started in the worktree/);
    expect(readFileSync(calls, 'utf8')).toBe('');
  });
});
