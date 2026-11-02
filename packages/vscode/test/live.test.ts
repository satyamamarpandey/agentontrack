// REAL Claude Code, started through the extension's client and the companion, in a real project with a real remote.
// It spends a little real usage, so it runs only with AGENTONTRACK_LIVE=1. Nothing in it is mocked or stood in for.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { startCompanion, type Companion } from '@agentontrack/companion';
import { Project } from '@agentontrack/core';
import { CompanionClient, snapshot } from '../src/client.js';

const LIVE = !!process.env.AGENTONTRACK_LIVE;
let dir: string; let root: string; let bare: string; let c: Companion; let client: CompanionClient; let codes: { code: string; action: string }[] = [];

beforeAll(async () => {
  if (!LIVE) return;
  dir = mkdtempSync(join(tmpdir(), 'aot-vsc-live-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  bare = join(dir, 'remote.git');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'init');
  mkdirSync(bare);
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main'], { cwd: bare });
  git('remote', 'add', 'origin', bare);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Create the done file in src', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 'Create done file', criteria: [{ id: 'c', description: 'the file exists', kind: 'command', command: `node -e "process.exit(require('fs').existsSync('src/done.txt')?0:1)"` }] });
  p.close();
  installHooks('claude-code', root, `"${process.execPath.replace(/\\/g, '/')}" "${resolve('packages/cli/dist/index.js').replace(/\\/g, '/')}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), onTerminalChallenge: (code, action) => codes.push({ code, action }) });
  client = new CompanionClient(c.url.replace(/\/$/, ''));
  await client.pair(c.newPairingCode());
});
afterAll(async () => { if (LIVE) { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } });

const pushed = () => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'main']).status === 0;
const code = async () => codes.at(-1)!.code;

async function run(prompt: string): Promise<string> {
  const r = await client.postConfirmed<{ id: string }>('/api/runs', { runtime: 'claude-code', prompt, model: 'haiku', maxBudgetUsd: 0.25 }, code);
  for (let i = 0; i < 240; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const run = (await client.get<{ id: string; status: string }[]>('/api/runs')).find((x) => x.id === r!.id);
    if (run && run.status !== 'running') return run.status;
  }
  throw new Error('The run did not finish');
}

describe.skipIf(!LIVE)('real Claude Code through the extension client', () => {
  it('writes a file, is held at a push, and pushes only after a person approves with the terminal code', async () => {
    const push = 'Run exactly this Bash command: git push origin HEAD:main . If it is refused, do not try another way. Report the refusal and stop.';
    expect(await run(`Use the Write tool to create src/done.txt containing "ok". Then: ${push}`)).toBe('finished');
    expect(existsSync(join(root, 'src', 'done.txt'))).toBe(true);
    expect(pushed(), 'held before any decision').toBe(false);

    const s = await snapshot(client, undefined);
    const waiting = s.pending.find((a) => a.kind === 'vcs.push');
    expect(waiting, 'the request is on the sidebar').toBeDefined();
    expect(waiting!.runtime).toBe('claude-code');

    await client.postConfirmed('/api/approvals/approve', { id: waiting!.id, ttlMinutes: 60, uses: 1, portable: false }, code);
    expect(await run('The user has now approved it. Run exactly this Bash command: git push origin HEAD:main . Then stop.')).toBe('finished');
    expect(pushed(), 'reached the remote only after approval').toBe(true);

    await client.postConfirmed('/api/verify', { taskId: 't' }, code);
    const end = await snapshot(client, undefined);
    expect(end.task).toMatchObject({ id: 't', status: 'VERIFIED' });
    expect(end.integrityOk).toBe(true);
    expect(end.usage!.output).toBeGreaterThan(0);
    expect(end.pending).toEqual([]);
  }, 400_000);
});
