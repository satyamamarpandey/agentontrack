// The ask and notes routes through the real companion: answers come from the record, with sources.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-askc-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  const root = join(dir, 'repo');
  mkdirSync(root);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Ship refunds', scope: { include: ['**'] } });
  const old = p.human.recordDecision('Refunds go to the card', 'Simple');
  p.human.linkDecision(old, 'task', 'pay-4');
  p.human.recordDecision('Refunds go to the wallet', 'Wallet refunds land at once', old);
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

describe('ask and notes', () => {
  it('answers from the record and names what is stale', async () => {
    const s = await pair();
    const why = await (await api(s, `/api/ask?q=${encodeURIComponent('Why do refunds go to the wallet?')}`)).json();
    expect(why.matched).toBe(true);
    expect(why.sources[0].kind).toBe('decision');
    const stale = await (await api(s, `/api/ask?q=${encodeURIComponent('what is stale')}`)).json();
    expect(stale.sources[0]).toMatchObject({ kind: 'drift', id: 'task:pay-4' });
  });

  it('keeps a private note private to the person and a project note visible', async () => {
    const s = await pair();
    expect((await api(s, '/api/notes', { text: 'Try the wallet refund on staging first' })).status).toBe(200);
    expect((await api(s, '/api/notes', { text: 'Retries use backoff', scope: 'project' })).status).toBe(200);
    const a = await (await api(s, `/api/ask?q=${encodeURIComponent('staging backoff')}`)).json();
    expect(a.sources.map((x: any) => x.text).join('|')).toMatch(/staging first.*human, private|backoff.*human, project/);
    expect((await api(s, '/api/notes', { text: '' })).status).toBe(400);
  });

  it('refuses an unpaired caller', async () => {
    expect((await fetch(`${origin}/api/ask?q=refunds`)).status).toBeGreaterThanOrEqual(401);
  });
});
