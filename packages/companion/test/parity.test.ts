// One record, several surfaces: the website's plan route, the phone's snapshot and the CLI's `next` are computed from the same record,
// so a phase has the same status and the same next step everywhere. The VS Code extension reads the website's routes, so it shows the first.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project, type Registered } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';
import { snapshotOf } from '../src/remote-actions.js';

const CLI = resolve('packages/cli/dist/index.js');
let dir: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-parity-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, 'agentontrack');
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('the same project everywhere', () => {
  it('shows one goal, one plan, the same phase statuses and the same next step on the website, the phone and the CLI', async () => {
    const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
    const s = { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
    const api = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    await api('/api/plan/draft', { goal: 'Fix the crash when the date is empty' });

    const web = await (await api('/api/plan')).json();
    const p = new Project(root);
    const phone: any = snapshotOf({ id: 'x', name: 'x', root } as Registered, p, { isRunning: () => false, recentRuns: () => [] }, [{ id: 'claude-code', name: 'Claude Code', canStart: false }]);
    p.close();
    const cli = JSON.parse(spawnSync(process.execPath, [CLI, 'next'], { cwd: root, env: { ...process.env, AGENTONTRACK_HOME: join(dir, 'home'), AGENTONTRACK_ROOT: root }, encoding: 'utf8' }).stdout);

    expect(phone.goal.statement).toBe('Fix the crash');
    expect(phone.plan.phases.map((x: any) => [x.id, x.status])).toEqual(web.views.map((x: any) => [x.id, x.status]));
    expect(phone.plan.approved).toBe(web.approved);
    expect(phone.suggestions.map((x: any) => x.kind)).toEqual(cli.map((x: any) => x.kind));
    expect(cli[0].kind).toBe('approve-plan');
  });
});
