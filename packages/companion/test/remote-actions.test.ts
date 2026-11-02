// What a phone can and cannot do, run against a real project and the real engine. The deps that would start an agent are recorders:
// this tests validation, scoping and approval rules. Starting a real agent from a phone is tested end to end in the emulator job.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand, decompose, Project, type ProjectFacts, type Registered } from '@agentontrack/core';
import { makeExecutor, snapshotOf, type ExecDeps } from '../src/remote-actions.js';
import { Refusal, type HostContext, type TrustedDevice } from '../src/remote-host.js';

const facts: ProjectFacts = { testCommand: null, testCommandSource: null, protectedPaths: [], meanSecondsPerTask: null, tasksInHistory: 0 };
let dir: string; let root: string; let p: Project; let entry: Registered;
let calls: { fn: string; args: unknown[] }[]; let exec: ReturnType<typeof makeExecutor>; let maxUsd = 1;
const device = { did: 'd1', name: 'Phone', fingerprint: 'AAAA-BBBB', level: 'control' } as TrustedDevice;
const ctx: HostContext = { did: 'd1', device };
const run = (action: string, params: unknown = {}) => exec(action, params, ctx);
const refused = async (action: string, params: unknown) => { try { await run(action, params); return 'ran'; } catch (e) { return e instanceof Refusal ? e.code : `error:${(e as Error).message}`; } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-ra-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'secret-folder-name'); mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Notes\nhello');
  writeFileSync(join(root, 'src', 'code.ts'), 'export const a = 1;');
  writeFileSync(join(root, '.env'), 'TOKEN=abc');
  writeFileSync(join(root, 'GOAL.md'), 'private goal text');
  writeFileSync(join(root, 'big.md'), 'x'.repeat(250_000));
  p = new Project(root);
  p.human.setGoal({ statement: 'Fix a bug', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't1', title: 'Task one', criteria: [] });
  entry = { id: 'proj1', name: 'My project', root } as Registered;
  calls = [];
  const rec = (fn: string, ret: unknown) => (...args: unknown[]) => { calls.push({ fn, args }); return ret as never; };
  exec = makeExecutor({
    registry: () => [entry], projectFor: () => ({ entry, p }), isRunning: () => false, stopRun: (_p, id) => { calls.push({ fn: 'stopRun', args: [id] }); return id === 'run_live'; },
    recentRuns: () => [], startPhase: rec('startPhase', { id: 'run_a', status: 'running' }), startPrompt: rec('startPrompt', { id: 'run_b', status: 'running' }),
    continuePlan: rec('continuePlan', { started: true, note: 'x' }), cancelContinue: () => true, models: async () => [], agents: async () => [], maxUsdPerRun: () => maxUsd, version: 'test',
  } satisfies ExecDeps);
  maxUsd = 1;
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pending = () => [...p.state().approvals.values()].filter((a) => a.status === 'pending');
const hold = (kind: 'push' | 'outside') => {
  if (kind === 'push') { const c = classifyCommand('git push origin main'); p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: c.effects, opaque: false, coverage: 'enforced', rawInput: 'git push origin main' }); }
  else p.preAction({ runtime: 'claude-code', tool: 'Write', effects: [{ kind: 'fs.write', target: 'docs/outside.md' }], opaque: false, coverage: 'enforced', rawInput: 'write' });
  return pending().at(-1)!;
};

describe('reading', () => {
  it('lists projects by name and status, and never gives out a folder path', async () => {
    const list = await run('projects.list') as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'proj1', name: 'My project', goal: 'Fix a bug' });
    expect(JSON.stringify(list)).not.toContain('secret-folder-name');
    expect(JSON.stringify(await run('project.snapshot', { project: 'proj1' }))).not.toContain('secret-folder-name');
  });

  it('shows the snapshot a phone needs: goal, approvals, evidence, usage and whether the record is intact', async () => {
    hold('push');
    const s = await run('project.snapshot', { project: 'proj1' }) as any;
    expect(s.goal).toMatchObject({ statement: 'Fix a bug' });
    expect(s.approvals[0]).toMatchObject({ kind: 'vcs.push', fromPhone: false });
    expect(s.integrity.ok).toBe(true);
    expect(Date.parse(s.generatedAt)).toBeGreaterThan(0);
    expect(JSON.stringify(s).length).toBeLessThan(100_000);
  });

  it('reads Markdown and text inside the project, and nothing else', async () => {
    expect((await run('file.read', { project: 'proj1', path: 'README.md' }) as any).content).toContain('hello');
    for (const [path, code] of [['src/code.ts', 'not-markdown'], ['.env', 'not-markdown'], ['GOAL.md', 'protected'], ['../outside.md', 'error:'], ['/etc/hosts.md', 'error:'], ['..\\outside.md', 'error:']] as const) {
      const got = await refused('file.read', { project: 'proj1', path });
      expect(got.startsWith(code), `${path} -> ${got}`).toBe(true);
    }
  });

  it('cuts a very large file instead of sending it all', async () => {
    const f = await run('file.read', { project: 'proj1', path: 'big.md' }) as any;
    expect(f.truncated).toBe(true);
    expect(f.content.length).toBeLessThan(101_000);
  });
});

describe('lists', () => {
  it('lists Markdown and text only, skipping hidden, dependency and protected files, with no paths above the project', async () => {
    mkdirSync(join(root, 'docs'), { recursive: true }); mkdirSync(join(root, 'node_modules', 'x'), { recursive: true }); mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guide.md'), 'g'); writeFileSync(join(root, 'node_modules', 'x', 'r.md'), 'n'); writeFileSync(join(root, '.git', 'notes.md'), 'h');
    const list = (await run('files.list', { project: 'proj1' }) as any).files.map((f: any) => f.path);
    expect(list).toContain('README.md');
    expect(list).toContain('docs/guide.md');
    for (const never of ['src/code.ts', '.env', 'GOAL.md', 'node_modules/x/r.md', '.git/notes.md']) expect(list, never).not.toContain(never);
    expect(JSON.stringify(list)).not.toContain('secret-folder-name');
  });
  it('lists handoffs, newest first', async () => {
    const a = await run('handoff.create', { project: 'proj1', from: 'claude-code', to: 'codex' }) as any;
    const got = await run('handoffs.list', { project: 'proj1' }) as any;
    expect(got.handoffs[0].id).toBe(a.id);
  });
});

describe('what is refused', () => {
  it('an unregistered project, an unknown action, an extra parameter and a malformed one', async () => {
    p.close();
    exec = makeExecutor({ registry: () => [entry], projectFor: () => ({ entry, p: new Project(root) }), isRunning: () => false, stopRun: () => false, recentRuns: () => [], startPhase: () => ({ id: '', status: '' }), startPrompt: () => ({ id: '', status: '' }), continuePlan: () => ({ started: false, note: '' }), cancelContinue: () => false, models: async () => [], agents: async () => [], maxUsdPerRun: () => 1, version: 't' });
    expect(await refused('project.snapshot', { project: 'someone-elses' })).toBe('no-project');
    expect(await refused('shell.exec', { project: 'proj1', cmd: 'ls' })).toBe('unknown-action');
    expect(await refused('project.snapshot', { project: 'proj1', also: 'this' })).toBe('bad-request');
    expect(await refused('run.stop', { project: 'proj1', runId: '../../x' })).toBe('bad-request');
    p = new Project(root);
  });

  it('a prompt that starts with a hyphen, or is empty or huge', async () => {
    for (const prompt of ['--dangerously-skip-permissions', '', 'x'.repeat(5000)]) expect(await refused('run.start', { project: 'proj1', prompt }), prompt.slice(0, 20)).toBe('bad-request');
    expect(calls.filter((c) => c.fn.startsWith('start'))).toEqual([]);
  });
});

describe('starting and stopping', () => {
  it('a free prompt is capped by what the desktop allowed, and never above five dollars', async () => {
    await run('run.start', { project: 'proj1', prompt: 'Look at the parser' });
    expect((calls.at(-1)!.args[2] as any).maxUsd).toBe(1);
    maxUsd = 1000;
    await run('run.start', { project: 'proj1', prompt: 'Look at the parser' });
    expect((calls.at(-1)!.args[2] as any).maxUsd).toBe(5);
    expect(calls.at(-1)!.args[3]).toBe('phone:AAAA-BBBB');
  });

  it('a phase start goes through the plan\'s own start rules, and records that a phone asked', async () => {
    await run('run.start', { project: 'proj1', prompt: 'go', phaseId: 'implement-3', extra: 'be careful' });
    expect(calls.at(-1)).toMatchObject({ fn: 'startPhase', args: [entry, p, 'implement-3', 'be careful', 'phone:AAAA-BBBB'] });
  });

  it('stopping a run that is not running here is said plainly', async () => {
    expect(await run('run.stop', { project: 'proj1', runId: 'run_live' })).toEqual({ stopped: true });
    expect(await refused('run.stop', { project: 'proj1', runId: 'run_gone' })).toBe('no-run');
  });

  it('pausing a phase changes only its state, keeps the approval, and bounded continuation is passed on with its limit', async () => {
    const d = p.savePlan(decompose('Fix a bug', facts));
    p.human.approvePlan(d.sha, d.version);
    const first = p.state().plan!.doc.phases[0].id;
    await run('plan.state', { project: 'proj1', phaseId: first, state: 'paused' });
    expect(p.state().plan!.doc.phases[0].state).toBe('paused');
    expect(p.state().plan!.approvedSha).toBe(p.state().plan!.sha);
    expect(await refused('plan.state', { project: 'proj1', phaseId: 'nope', state: 'paused' })).toBe('no-phase');
    expect(await refused('plan.continue', { project: 'proj1', maxPhases: 50 })).toBe('bad-request');
    await run('plan.continue', { project: 'proj1', maxPhases: 2 });
    expect(calls.at(-1)!.args[2]).toBe(2);
  });

  it('checks run only for a phase that has a command and an approved plan', async () => {
    const d = p.savePlan(decompose('Fix a bug', facts));
    expect(await refused('plan.verify', { project: 'proj1', phaseId: p.state().plan!.doc.phases[0].id })).toBe('no-checks');
    p.human.approvePlan(d.sha, d.version);
    expect(await refused('plan.verify', { project: 'proj1', phaseId: p.state().plan!.doc.phases[0].id })).toBe('no-checks');
  });
});

describe('approvals from a phone', () => {
  it('can always be refused from the phone, and the record says a phone did it', async () => {
    const a = hold('push');
    expect(await run('approval.decide', { project: 'proj1', id: a.id, decision: 'deny', note: 'no' })).toEqual({ decision: 'denied' });
    const after = p.state().approvals.get(a.id)!;
    expect(after.status).toBe('denied');
    expect(JSON.stringify(after)).toContain('remote-device:AAAA-BBBB');
  });

  it('cannot approve a push, a deploy or anything else that leaves the machine: it waits for the desktop', async () => {
    const a = hold('push');
    expect(await refused('approval.decide', { project: 'proj1', id: a.id, decision: 'approve' })).toBe('needs-desktop');
    expect(p.state().approvals.get(a.id)!.status).toBe('pending');
    expect(pending()).toHaveLength(1);
  });

  it('may approve a file write outside the goal\'s scope, once, for ten minutes, and says so', async () => {
    const a = hold('outside');
    expect(a.effect.kind).toBe('fs.write');
    expect(await run('approval.decide', { project: 'proj1', id: a.id, decision: 'approve' })).toEqual({ decision: 'approved', expiresInMinutes: 10, uses: 1 });
    const done = p.state().approvals.get(a.id)!;
    expect(done.status).toBe('granted');
    expect(JSON.stringify(done)).toContain('remote-device:AAAA-BBBB');
  });

  it('cannot decide something already decided, or something that does not exist', async () => {
    const a = hold('push');
    await run('approval.decide', { project: 'proj1', id: a.id, decision: 'deny' });
    expect(await refused('approval.decide', { project: 'proj1', id: a.id, decision: 'approve' })).toBe('not-pending');
    expect(await refused('approval.decide', { project: 'proj1', id: 'apr_nope', decision: 'deny' })).toBe('not-pending');
  });

  it('a handoff carries no approval, so accepting one from a phone cannot grant any', async () => {
    const held = hold('push');
    const made = await run('handoff.create', { project: 'proj1', from: 'claude-code', to: 'codex' }) as any;
    const got = await run('handoff.accept', { project: 'proj1', id: made.id, to: 'codex' }) as any;
    expect(got.accepted).toBe(true);
    expect(p.state().approvals.get(held.id)!.status).toBe('pending');
    expect([...p.state().approvals.values()].filter((x) => x.status === 'granted')).toEqual([]);
  });
});

describe('the snapshot', () => {
  it('stays small even with a great deal going on', async () => {
    for (let i = 0; i < 30; i++) p.recordUsage({ runtime: 'claude-code', model: 'm', source: 'provider-reported', sessionId: `s${i}`, inputTokens: 10, outputTokens: 10 });
    const s = snapshotOf(entry, p, { isRunning: () => false, recentRuns: () => Array.from({ length: 10 }, (_, i) => ({ id: `run_${i}`, status: 'finished', started: i, events: Array.from({ length: 50 }, (_, j) => 'line '.repeat(200) + j) })) });
    expect(JSON.stringify(s).length).toBeLessThan(100_000);
    expect(s.runs).toHaveLength(4);
    expect(s.runs[0]!.tail).toHaveLength(12);
  });
});
