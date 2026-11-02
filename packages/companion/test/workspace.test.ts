import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-ws-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), 'SECRET_GIT');
  writeFileSync(join(root, 'README.md'), '# Hello\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'GOAL.md'), 'goal\n');
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

type S = { cookie: string; csrf: string };
const pair = async (): Promise<S> => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf };
};
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const read = async (s: S, path: string) => (await api(s, `/api/file?path=${encodeURIComponent(path)}`)).json();

describe('files through the companion', () => {
  it('lists, reads and saves, and tells the editor the new hash', async () => {
    const s = await pair();
    const list = await (await api(s, '/api/files')).json();
    expect(list.entries.map((e: any) => e.name)).toEqual(['src', 'GOAL.md', 'README.md']);
    expect(list.entries.some((e: any) => e.name === '.git')).toBe(false);
    const f = await read(s, 'README.md');
    expect(f).toMatchObject({ content: '# Hello\n', language: 'markdown', protected: false });
    const saved = await (await api(s, '/api/file', { path: 'README.md', content: '# Changed\n', baseHash: f.hash })).json();
    expect(saved.hash).not.toBe(f.hash);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Changed\n');
    expect((await read(s, 'README.md')).hash).toBe(saved.hash);
  });

  it('refuses a save based on a stale hash, and says what the file is now', async () => {
    const s = await pair();
    const f = await read(s, 'README.md');
    writeFileSync(join(root, 'README.md'), 'changed on disk\n');
    const r = await api(s, '/api/file', { path: 'README.md', content: 'mine\n', baseHash: f.hash });
    expect(r.status).toBe(409);
    expect((await r.json()).currentHash).not.toBe(f.hash);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('changed on disk\n');
  });

  it('creates a new file only when the editor says it did not exist', async () => {
    const s = await pair();
    expect((await api(s, '/api/file', { path: 'src/new.ts', content: 'x', baseHash: null })).status).toBe(200);
    expect((await api(s, '/api/file', { path: 'src/new.ts', content: 'y', baseHash: null })).status).toBe(409);
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('x');
  });

  it('two windows on one file: the second cannot overwrite the first, and succeeds after reloading', async () => {
    const a = await pair(); const b = await pair();
    const fa = await read(a, 'src/a.ts'); const fb = await read(b, 'src/a.ts');
    expect(fa.hash).toBe(fb.hash);
    expect((await api(a, '/api/file', { path: 'src/a.ts', content: 'from A\n', baseHash: fa.hash })).status).toBe(200);
    expect((await api(b, '/api/file', { path: 'src/a.ts', content: 'from B\n', baseHash: fb.hash })).status).toBe(409);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('from A\n');
    const again = await read(b, 'src/a.ts');
    expect(again.content).toBe('from A\n');
    expect((await api(b, '/api/file', { path: 'src/a.ts', content: 'from A\nand B\n', baseHash: again.hash })).status).toBe(200);
  });

  it('never leaves the project, and never touches .git', async () => {
    const s = await pair();
    for (const bad of ['../outside.txt', '..\\outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini', '~/x', 'src/../../x', '.git/config', 'a/.git/hooks/pre-commit']) {
      expect((await api(s, `/api/file?path=${encodeURIComponent(bad)}`)).status, `read ${bad}`).toBeGreaterThanOrEqual(400);
      const w = await api(s, '/api/file', { path: bad, content: 'x', baseHash: null });
      expect(w.status, `write ${bad}`).toBeGreaterThanOrEqual(400);
    }
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('SECRET_GIT');
    expect(existsSync(join(dir, 'outside.txt'))).toBe(false);
    expect((await api(s, '/api/files?dir=..')).status).toBeGreaterThanOrEqual(400);
  });

  it('does not follow a link out of the project', async () => {
    const s = await pair();
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'secret.txt'), 'OUTSIDE');
    try { symlinkSync(join(dir, 'elsewhere'), join(root, 'link'), 'junction'); } catch { return; }
    expect((await api(s, '/api/file?path=link/secret.txt')).status).toBeGreaterThanOrEqual(400);
    expect((await api(s, '/api/file', { path: 'link/new.txt', content: 'x', baseHash: null })).status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, 'elsewhere', 'new.txt'))).toBe(false);
  });

  it('opens text only, and not large or binary files', async () => {
    const s = await pair();
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    expect((await api(s, '/api/file?path=bin.dat')).status).toBe(415);
    expect((await api(s, '/api/file?path=big.txt')).status).toBe(413);
    expect((await api(s, '/api/file', { path: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 1), baseHash: null })).status).toBe(413);
    expect((await api(s, '/api/file', { path: 'nul.txt', content: 'a\0b', baseHash: null })).status).toBe(415);
  });

  it('a person\'s save does not later read as an agent\'s unauthorized change, and is in the record', async () => {
    const s = await pair();
    const p = new Project(root);
    p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
    p.human.createTask({ id: 't', title: 't' });
    p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: [], opaque: false, coverage: 'enforced', rawInput: 'ls' });
    const before = p.store.byType(['workspace.drift']).length;
    const f = await read(s, 'README.md');
    await api(s, '/api/file', { path: 'README.md', content: 'edited by a person\n', baseHash: f.hash });
    p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: [], opaque: false, coverage: 'enforced', rawInput: 'ls -l' });
    expect(p.store.byType(['workspace.drift']).length).toBe(before);
    expect(p.store.byType(['file.saved']).at(-1)?.payload).toMatchObject({ path: 'README.md', afterHash: expect.any(String), via: 'workspace' });
    p.close();
  });
});

describe('protected files', () => {
  it('goal, safety, instruction and hook files cannot be saved on the ordinary path', async () => {
    const s = await pair();
    for (const path of ['GOAL.md', '.claude/settings.local.json', '.cursor/hooks.json', '.codex/hooks.json']) {
      const r = await api(s, '/api/file', { path, content: 'x', baseHash: path === 'GOAL.md' ? (await read(s, 'GOAL.md')).hash : null });
      expect(r.status, path).toBe(403);
    }
    expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toBe('goal\n');
    expect(existsSync(join(root, '.claude'))).toBe(false);
    expect((await read(s, 'GOAL.md')).protected).toBe(true);
  });

  it('can be saved with a fresh confirmation, once, and the code does not work twice', async () => {
    const s = await pair();
    const f = await read(s, 'GOAL.md');
    const body = { path: 'GOAL.md', content: 'new goal text\n', baseHash: f.hash };
    expect((await api(s, '/api/file/protected', { ...body, challengeId: 'nope', confirm: 'nope' })).status).toBe(403);
    const pr = await proof(s);
    expect((await api(s, '/api/file/protected', { ...body, ...pr })).status).toBe(200);
    expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toBe('new goal text\n');
    expect((await api(s, '/api/file/protected', { ...body, ...pr })).status).toBe(403);
  });
});

describe('state a stale window cannot overwrite', () => {
  it('a goal change based on an older goal version is refused', async () => {
    const s = await pair();
    const goal = (statement: string) => ({ statement, scope: { include: ['**'] } });
    expect((await api(s, '/api/goal', { goal: goal('one'), expectGoalVersion: null, ...(await proof(s)) })).status).toBe(200);
    expect((await api(s, '/api/goal', { goal: goal('two'), expectGoalVersion: 1, ...(await proof(s)) })).status).toBe(200);
    const stale = await api(s, '/api/goal', { goal: goal('from an old window'), expectGoalVersion: 1, ...(await proof(s)) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatch(/version 2, not 1/);
    expect((await (await api(s, '/api/revision')).json()).goalVersion).toBe(2);
    expect((await (await api(s, '/api/state')).json()).goal.statement).toBe('two');
  });

  it('revision and event catch-up give every client the same ordered history', async () => {
    const s = await pair();
    await api(s, '/api/goal', { goal: { statement: 'g' }, ...(await proof(s)) });
    const rev = await (await api(s, '/api/revision')).json();
    const all = await (await api(s, '/api/events?since=0&limit=500')).json();
    expect(all.head).toBe(rev.head);
    expect(all.events.map((e: any) => e.seq)).toEqual(Array.from({ length: rev.head }, (_, i) => i + 1));
    expect(all.events[0].hash).toBeUndefined();
    const page = await (await api(s, '/api/events?since=0&limit=1')).json();
    expect(page.events).toHaveLength(1);
    expect(page.more).toBe(true);
    const tail = await (await api(s, `/api/events?since=${rev.head}`)).json();
    expect(tail.events).toEqual([]);
    expect(tail.more).toBe(false);
  });
});

describe('projects', () => {
  it('can be renamed and archived, and the registry keeps it', async () => {
    const s = await pair();
    const [p0] = await (await api(s, '/api/projects')).json();
    const r = await (await api(s, '/api/projects/update', { id: p0.id, name: 'Renamed', archived: true })).json();
    expect(r).toMatchObject({ name: 'Renamed', archived: true });
    expect((await (await api(s, '/api/projects')).json())[0]).toMatchObject({ name: 'Renamed', archived: true });
    expect((await api(s, '/api/projects/update', { id: 'nope', name: 'x' })).status).toBe(404);
  });

  it('creates a project folder with git, and refuses places that are not a project', async () => {
    const s = await pair();
    const target = join(dir, 'brand-new');
    expect((await api(s, '/api/projects', { path: target, create: true, gitInit: true })).status).toBe(200);
    expect(existsSync(join(target, '.git'))).toBe(true);
    for (const bad of [homedir(), join(dir, 'home'), join(dir, 'home', 'projects', 'x'), process.platform === 'win32' ? 'C:\\' : '/']) {
      expect((await api(s, '/api/projects', { path: bad, create: true })).status, bad).toBe(400);
    }
  });
});

describe('from a website the user allowed', () => {
  const SITE = 'https://example-site.test';
  it('a file save needs the terminal code, which is tied to the exact text, even when the text is long', async () => {
    const codes: { code: string; action: string }[] = [];
    const d = await startCompanion({ root, uiDir: join(dir, 'ui'), allowedOrigins: [SITE], onTerminalChallenge: (code, action) => codes.push({ code, action }) });
    const base = d.url.slice(0, -1);
    const pr = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: d.newPairingCode() }) })).json();
    const call = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${pr.token}`, 'x-agentontrack-csrf': pr.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const get = (path: string) => fetch(`${base}${path}`, { headers: { origin: SITE, authorization: `Bearer ${pr.token}` } });
    const f = await (await get('/api/file?path=src/a.ts')).json();
    const long = `// ${'x'.repeat(20_000)}\n`;
    const first = await call('/api/file', { path: 'src/a.ts', content: long, baseHash: f.hash });
    expect(first.status).toBe(428);
    const { challengeId } = await first.json();
    expect(codes.at(-1)!.action).toMatch(/src\/a\.ts/);
    expect(codes.at(-1)!.action).toMatch(/sha256/);
    // The same code does not work for different text.
    expect((await call('/api/file', { path: 'src/a.ts', content: `${long}more`, baseHash: f.hash, challengeId, confirm: codes.at(-1)!.code })).status).toBe(403);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const again = await (await call('/api/file', { path: 'src/a.ts', content: long, baseHash: f.hash })).json();
    expect((await call('/api/file', { path: 'src/a.ts', content: long, baseHash: f.hash, challengeId: again.challengeId, confirm: codes.at(-1)!.code })).status).toBe(200);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe(long);
    await d.close();
  });
});
