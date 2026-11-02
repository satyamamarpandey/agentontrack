import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let root: string; let c: Companion; let base: string; let s: { cookie: string; csrf: string };
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-diff-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'line one\nline two\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  const p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 't' });
  p.close();
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  base = c.url.slice(0, -1);
  const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  s = { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf };
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie: s.cookie } });
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

describe('worktree diffs for an editor', () => {
  it('gives the file at the base and as it is now, exactly, and null for a new or removed file', async () => {
    const w = await post('/api/worktrees', { taskId: 't', agent: 'codex' });
    writeFileSync(join(w.path, 'src', 'a.ts'), 'line one\nline TWO\nline three\n');
    writeFileSync(join(w.path, 'src', 'new.ts'), 'brand new\n');
    const mod = await (await get(`/api/worktrees/diff?id=${w.id}&path=src/a.ts`)).json();
    expect(mod).toEqual({ path: 'src/a.ts', before: 'line one\nline two\n', after: 'line one\nline TWO\nline three\n' });
    expect(await (await get(`/api/worktrees/diff?id=${w.id}&path=src/new.ts`)).json()).toEqual({ path: 'src/new.ts', before: null, after: 'brand new\n' });
    rmSync(join(w.path, 'src', 'a.ts'));
    expect((await (await get(`/api/worktrees/diff?id=${w.id}&path=src/a.ts`)).json()).after).toBeNull();
  });

  it('stays inside the worktree, and says so for an unknown one', async () => {
    const w = await post('/api/worktrees', { taskId: 't', agent: 'codex' });
    for (const bad of ['../../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', '.git/config']) expect((await get(`/api/worktrees/diff?id=${w.id}&path=${encodeURIComponent(bad)}`)).status, bad).toBeGreaterThanOrEqual(400);
    expect((await get('/api/worktrees/diff?id=wt_nope&path=src/a.ts')).status).toBe(404);
  });

  it('serves a handoff as readable text, built from the record', async () => {
    const made = await post('/api/handoffs', { from: 'claude-code', to: 'codex' });
    const md = (await (await get(`/api/handoffs/markdown?id=${made.id}`)).json()).markdown as string;
    expect(md).toMatch(/^# Handoff hnd_/);
    expect(md).toMatch(/Approvals that do NOT carry over|## Next/);
    expect((await get('/api/handoffs/markdown?id=../x')).status).toBe(404);
  });
});
