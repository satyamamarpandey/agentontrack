// The default project for phone sessions is chosen on THIS computer, by the owner, with the terminal code. The phone only ever says "default"; the path lives here, resolved to its
// real location, and is checked again at every start. This tests the desktop route and what it shows, through the real companion; the phone's use of it is in remote-session-new.test.ts.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Project, registerProject, updateRegistered } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';
import { loadRemote, newRemoteFile, saveRemote } from '../src/remote-host.js';

let dir = ''; let c: Companion; let origin = ''; let rootA = ''; let rootB = ''; let A = ''; let B = '';
afterEach(async () => { await c?.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const setup = async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-defproj-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  rootA = join(dir, 'project-a'); rootB = join(dir, 'project-b'); mkdirSync(rootA); mkdirSync(rootB);
  for (const r of [rootA, rootB]) { const p = new Project(r); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close(); }
  A = registerProject(rootA).id; B = registerProject(rootB).id;
  saveRemote(await newRemoteFile('Test computer'));
  c = await startCompanion({ root: rootA, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof setup>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };
const choose = async (s: S, defaultProjectId: string | null, withProof = true) => api(s, '/api/remote/settings', { defaultProjectId, ...(withProof ? await proof(s) : {}) });
const status = async (s: S) => (await (await api(s, '/api/remote/status')).json()) as { defaultProject: null | { projectId: string; name: string | null; path: string; valid: boolean } };

describe('choosing the default project for phone sessions', () => {
  it('starts with none, and a phone therefore has nothing to ask for', async () => {
    const s = await setup();
    expect((await status(s)).defaultProject).toBeNull();
  });

  it('needs the owner\'s terminal code: without it, or with a wrong one, nothing changes', async () => {
    const s = await setup();
    expect((await choose(s, A, false)).status).toBe(400); // no proof at all: the request is not even well formed
    const ch = await (await api(s, '/api/challenge', {})).json();
    expect((await api(s, '/api/remote/settings', { defaultProjectId: A, challengeId: ch.challengeId, confirm: 'wrong' })).status).toBe(403);
    expect((await status(s)).defaultProject).toBeNull();
    expect(loadRemote()!.defaultProject ?? null).toBeNull();
  });

  it('records the project, shows its name and RESOLVED path to the owner, and stores that path on this computer', async () => {
    const s = await setup();
    const r = await choose(s, B);
    expect(r.status).toBe(200);
    const real = realpathSync.native(rootB);
    expect((await r.json()).defaultProject).toMatchObject({ projectId: B, name: 'project-b', path: real, valid: true });
    expect((await status(s)).defaultProject).toMatchObject({ projectId: B, name: 'project-b', path: real, valid: true });
    expect(loadRemote()!.defaultProject).toMatchObject({ projectId: B, realRoot: real });
  });

  it('can be cleared, and changed to another project', async () => {
    const s = await setup();
    await choose(s, A); await choose(s, B);
    expect((await status(s)).defaultProject!.projectId).toBe(B);
    expect((await choose(s, null)).status).toBe(200);
    expect((await status(s)).defaultProject).toBeNull();
    expect(loadRemote()!.defaultProject ?? null).toBeNull();
  });

  it('refuses a project that is not registered, an archived one, and anything that is not a project id (a path, a traversal)', async () => {
    const s = await setup();
    expect((await choose(s, 'c'.repeat(24))).status).toBe(404);
    updateRegistered(B, { archived: true });
    expect((await choose(s, B)).status).toBe(404);
    for (const bad of ['../../etc', 'C:\\Windows', rootA, 'default', 'A'.repeat(24), 'a'.repeat(23)]) expect((await choose(s, bad)).status).toBeGreaterThanOrEqual(400);
    expect((await status(s)).defaultProject).toBeNull();
  });

  it('says when the folder it points at has moved, so the owner is told and a phone start is refused', async () => {
    const s = await setup();
    await choose(s, B);
    renameSync(rootB, join(dir, 'project-b-moved'));
    const d = (await status(s)).defaultProject!;
    expect(d.projectId).toBe(B);
    expect(d.valid).toBe(false);
  });

  it('keeps the setting in the owner\'s file only, with no path ever sent to a phone (the phone reads ids and names)', async () => {
    const s = await setup();
    await choose(s, B);
    const file = readFileSync(join(dir, 'home', 'remote.json'), 'utf8');
    expect(file).toContain(B);
    expect(JSON.parse(file).defaultProject.realRoot).toBe(realpathSync.native(rootB));
  });
});
