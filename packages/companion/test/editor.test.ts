// An editor extension is code the user did not write. It may read the project and ask for changes, and it cannot confirm them itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let root: string; let c: Companion; let base: string; let codes: { code: string; action: string }[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-ed-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'a');
  const p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['**'] } });
  p.human.createTask({ id: 't', title: 't' });
  p.close();
  codes = [];
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), onTerminalChallenge: (code, action) => codes.push({ code, action }) });
  base = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pairEditor = async () => {
  const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentontrack-surface': 'editor' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  expect(r.status).toBe(200);
  expect(r.headers.get('set-cookie')).toBeNull();
  return r.json() as Promise<{ token: string; csrf: string }>;
};
const call = (s: { token: string; csrf: string }, path: string, body?: unknown) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${s.token}`, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('editor sessions', () => {
  it('can read project state, and are told that confirmation happens in the terminal', async () => {
    const s = await pairEditor();
    expect((await (await call(s, '/api/state')).json()).goal.statement).toBe('g');
    const ch = await (await call(s, '/api/challenge', {})).json();
    expect(ch).toMatchObject({ code: null, inTerminal: true });
  });

  it('cannot approve, change the goal or save a file on their own, and a code shown in the terminal is tied to one request', async () => {
    const s = await pairEditor();
    const goal = { goal: { statement: 'taken over' }, expectGoalVersion: 1 };
    const first = await call(s, '/api/goal', goal);
    expect(first.status).toBe(428);
    const { challengeId } = await first.json();
    expect(codes.at(-1)!.action).toMatch(/goal/);
    // Without the real code, or with the code for another request, nothing happens.
    expect((await call(s, '/api/goal', { ...goal, challengeId, confirm: 'guess' })).status).toBe(403);
    expect((await (await call(s, '/api/state')).json()).goal.statement).toBe('g');
    const again = await (await call(s, '/api/goal', goal)).json();
    const elsewhere = await call(s, '/api/goal', { goal: { statement: 'different' }, expectGoalVersion: 1, challengeId: again.challengeId, confirm: codes.at(-1)!.code });
    expect(elsewhere.status).toBe(403);
    expect((await (await call(s, '/api/state')).json()).goal.statement).toBe('g');
    const third = await (await call(s, '/api/goal', goal)).json();
    expect((await call(s, '/api/goal', { ...goal, challengeId: third.challengeId, confirm: codes.at(-1)!.code })).status).toBe(200);
    expect((await (await call(s, '/api/state')).json()).goal.statement).toBe('taken over');
  });

  it('are ended by repeated wrong codes, like an outside page', async () => {
    const s = await pairEditor();
    for (let i = 0; i < 6; i++) {
      const ch = await (await call(s, '/api/settings', { theme: 'light' })).json();
      await call(s, '/api/settings', { theme: 'light', challengeId: ch.challengeId, confirm: 'nope' });
    }
    expect((await call(s, '/api/state')).status).toBe(401);
  });

  it('only count as an editor if they say so and send no website origin, so a page cannot claim it', async () => {
    const withOrigin = await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-agentontrack-surface': 'editor' }, body: JSON.stringify({ code: c.newPairingCode() }) });
    expect(withOrigin.status).toBe(403);
  });

  it('leave the dashboard\'s own behaviour alone: a local browser still gets its code and a cookie', async () => {
    const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await r.json()).csrf;
    const ch = await (await fetch(`${base}/api/challenge`, { method: 'POST', headers: { cookie, 'x-agentontrack-csrf': csrf, 'content-type': 'application/json' }, body: '{}' })).json();
    expect(ch.code).toMatch(/^[0-9a-f]{4}$/);
  });
});
