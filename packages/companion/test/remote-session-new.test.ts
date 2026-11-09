// A phone starts a NEW session: `session.new`. The executor is exercised with a real project, a real idempotency store and recording doubles for what actually starts a process,
// so every refusal can be shown to start nothing, and every retry to start exactly one. It tests the host's decisions, not Claude or Codex, and not Firebase.
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project, type Registered } from '@agentontrack/core';
import { IdempotencyStore, IdempotencyUnavailable } from '../src/idempotency.js';
import { MAX_RUNNING_FOR_PHONE_START, makeExecutor, stillTheSameFolder, type ExecDeps } from '../src/remote-actions.js';
import { CONTROL_ACTIONS, READ_ACTIONS, Refusal, type HostContext, type TrustedDevice } from '../src/remote-host.js';

const ID_A = 'a'.repeat(24); const ID_B = 'b'.repeat(24);
const KEY = 'k1_'.padEnd(26, 'x');
const device = { did: 'd1', name: 'Phone', fingerprint: 'AAAA-BBBB', level: 'control' } as TrustedDevice;
const ctx: HostContext = { did: 'd1', device };
let dir = ''; let rootA = ''; let rootB = ''; let pA: Project; let pB: Project; let reg: Registered[];
let started: { agent: string; model: string; prompt: string; maxUsd: number; policy: string; project: string; source: string }[];
let validCalls = 0; let validUntilCall = Infinity;
let defaultProject: { projectId: string; realRoot: string } | null; let defaultValid: boolean; let running: number; let canStart: boolean;
let startBehaviour: () => void; let idem: IdempotencyStore | { begin: () => never; finish: () => void; abandon: () => void };
let exec: ReturnType<typeof makeExecutor>;
const run = (action: string, params: unknown = {}) => exec(action, params, ctx);
const code = async (action: string, params: unknown) => { try { await run(action, params); return 'ran'; } catch (e) { return e instanceof Refusal ? e.code : `error:${(e as Error).message}`; } };
const params = (over: object = {}) => ({ v: 1, idemKey: KEY, project: ID_A, agent: 'claude-code', model: 'haiku', policy: 'standard', prompt: 'Fix the parser', ...over });
const auditOf = (p: Project) => p.store.byType(['remote.session.requested']).map((e) => e.payload);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-rsn-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  rootA = join(dir, 'project-a-private-folder'); rootB = join(dir, 'project-b'); mkdirSync(rootA); mkdirSync(rootB);
  pA = new Project(rootA); pB = new Project(rootB);
  reg = [{ id: ID_A, name: 'Project A', root: rootA } as Registered, { id: ID_B, name: 'Project B', root: rootB } as Registered];
  validCalls = 0; validUntilCall = Infinity; started = []; defaultProject = null; defaultValid = true; running = 0; canStart = true; startBehaviour = () => {};
  idem = new IdempotencyStore(join(dir, 'idem.json'));
  const deps = (): ExecDeps => ({
    registry: () => reg, projectFor: (id) => { const entry = reg.find((r) => r.id === id)!; return { entry, p: id === ID_A ? pA : pB }; },
    isRunning: () => false, stopRun: () => false, recentRuns: () => [],
    startPhase: () => ({ id: 'x', status: 'running' }), startPrompt: () => ({ id: 'x', status: 'running' }), loopPhase: () => ({ started: true, note: '' }), continuePlan: () => ({ started: true, note: '' }), cancelContinue: () => true,
    models: async () => [], agents: async () => [{ id: 'claude-code', canStart }, { id: 'codex', canStart: false, reason: 'Connect Codex to this project first' }], maxUsdPerRun: () => 1, allowMobileExecution: () => true, version: 'test',
    defaultProject: () => defaultProject, defaultStillValid: () => defaultValid && ++validCalls <= validUntilCall, runningCount: () => running,
    startSession: (entry, _p, o, source) => { startBehaviour(); started.push({ ...o, project: entry.id, source }); return { runId: `run_${started.length}`, sessionId: `ses_${String(started.length).padStart(12, '0')}`, status: 'running' }; },
    sessionDetail: (_p, sid) => (sid === 'ses_aaaaaaaaaaaa' ? { id: sid, status: 'running', title: 'T', runtime: 'claude-code', canResume: false, linked: true, runs: [{ id: 'run_1', status: 'running', events: Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(400)}`) }] } : null),
    idem: { begin: (...a) => (idem as IdempotencyStore).begin(...a), finish: (...a) => (idem as IdempotencyStore).finish(...a), abandon: (...a) => (idem as IdempotencyStore).abandon(...a), peek: (...a) => (idem as IdempotencyStore).peek(...a) },
  });
  exec = makeExecutor(deps());
});
afterEach(() => { pA.close(); pB.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('the action is a control action, and a phone learns it exists from ping', () => {
  it('is in the control list (so a view-only phone is refused by the host) and its reader is in the read list', () => {
    expect(CONTROL_ACTIONS).toContain('session.new');
    expect(READ_ACTIONS).not.toContain('session.new' as never);
    expect(READ_ACTIONS).toContain('session.get');
  });
  it('lists its operations in ping only when it can really start sessions', async () => {
    expect(((await run('ping')) as any).ops).toEqual(['session.new@1', 'session.get@1', 'session.status@1']);
    const bare = makeExecutor({ registry: () => reg, projectFor: () => ({ entry: reg[0]!, p: pA }), isRunning: () => false, stopRun: () => false, recentRuns: () => [], startPhase: () => ({ id: 'x', status: 'r' }), startPrompt: () => ({ id: 'x', status: 'r' }), loopPhase: () => ({ started: true, note: '' }), continuePlan: () => ({ started: true, note: '' }), cancelContinue: () => true, models: async () => [], agents: async () => [], maxUsdPerRun: () => 1, allowMobileExecution: () => true, version: 't' });
    expect(((await bare('ping', {}, ctx)) as any).ops).toEqual([]);
    await expect(bare('session.new', params(), ctx)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('starting a session in a named project', () => {
  it('starts exactly one new session with exactly what was asked, and says what happened', async () => {
    const r = await run('session.new', params()) as any;
    expect(started).toEqual([{ agent: 'claude-code', model: 'haiku', prompt: 'Fix the parser', maxUsd: 1, policy: 'standard', project: ID_A, source: 'phone:AAAA-BBBB' }]);
    expect(r).toMatchObject({ runId: 'run_1', sessionId: 'ses_000000000001', status: 'running', project: { id: ID_A, name: 'Project A' }, agent: 'claude-code', policy: 'standard', usedDefault: false, deduped: false });
    expect(JSON.stringify(r)).not.toContain('project-a-private-folder'); // never the folder
  });

  it('records who asked, in which project, and the outcome, and never the text of the prompt', async () => {
    await run('session.new', params({ prompt: 'secret instructions about the payroll' }));
    const a = auditOf(pA);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ fingerprint: 'AAAA-BBBB', idemKey: KEY, outcome: 'started', projectId: ID_A, usedDefault: false, agent: 'claude-code', policy: 'standard', runId: 'run_1', sessionId: 'ses_000000000001' });
    expect(JSON.stringify(a)).not.toContain('payroll');
    expect(auditOf(pB)).toEqual([]);
  });

  it('passes the policy through, and caps the spend at the owner\'s limit', async () => {
    await run('session.new', params({ policy: 'read-only', maxUsd: 4, idemKey: 'a'.repeat(24) }));
    await run('session.new', params({ maxUsd: 0.2, idemKey: 'b'.repeat(24) }));
    await run('session.new', params({ idemKey: 'c'.repeat(24) }));
    expect(started.map((s) => [s.policy, s.maxUsd])).toEqual([['read-only', 1], ['standard', 0.2], ['standard', 1]]);
  });

  it('refuses a project that is not registered, an archived one, and an agent that cannot start, each starting nothing and releasing the key', async () => {
    expect(await code('session.new', params({ project: 'c'.repeat(24) }))).toBe('no-project');
    reg[0]!.archived = true;
    expect(await code('session.new', params())).toBe('project-archived');
    reg[0]!.archived = false;
    expect(await code('session.new', params({ agent: 'codex' }))).toBe('agent-unavailable');
    canStart = false;
    expect(await code('session.new', params())).toBe('agent-unavailable');
    expect(started).toEqual([]);
    canStart = true;
    expect(await code('session.new', params())).toBe('ran'); // the same key works once the cause is gone
    expect(started).toHaveLength(1);
  });

  it('refuses while several runs are already going, and starts nothing', async () => {
    running = MAX_RUNNING_FOR_PHONE_START;
    expect(await code('session.new', params())).toBe('busy');
    running = MAX_RUNNING_FOR_PHONE_START - 1;
    expect(await code('session.new', params())).toBe('ran');
    expect(started).toHaveLength(1);
  });
});

describe('the run cap', () => {
  it('also applies to an ordinary run.start from the phone, not only to new sessions', async () => {
    running = 3;
    expect(await code('run.start', { project: ID_A, prompt: 'do it' })).toBe('busy');
    running = 0;
    expect(await code('run.start', { project: ID_A, prompt: 'do it' })).toBe('ran');
  });
});

describe('the default project', () => {
  it('is checked once more right before the spawn: a folder swapped after the first check (during discovery) is refused and nothing starts', async () => {
    defaultProject = { projectId: ID_B, realRoot: rootB };
    validUntilCall = 1; // valid at the first check, changed by the second
    expect(await code('session.new', params({ project: 'default' }))).toBe('default-unavailable');
    expect(started).toHaveLength(0);
  });
  it('a prompt with a NUL character is refused by the request schema, so no key is left stuck', async () => {
    const p = params({ prompt: 'hello\0world' });
    expect(await code('session.new', p)).toBe('bad-request');
    expect(await code('session.new', params({ idemKey: p.idemKey }))).not.toBe('in-doubt');
  });
  it('has no default until the owner sets one: the phone gets a clear refusal and nothing starts', async () => {
    expect(await code('session.new', params({ project: 'default' }))).toBe('no-default-project');
    expect(started).toEqual([]);
  });

  it('starts in the owner\'s default when the phone asks for "default", and says it did', async () => {
    defaultProject = { projectId: ID_B, realRoot: rootB };
    const r = await run('session.new', params({ project: 'default' })) as any;
    expect(started[0]!.project).toBe(ID_B);
    expect(r).toMatchObject({ usedDefault: true, project: { id: ID_B, name: 'Project B' } });
    expect(auditOf(pB)[0]).toMatchObject({ usedDefault: true, projectId: ID_B });
    expect(auditOf(pA)).toEqual([]);
  });

  it('marks the default in the project list, by id, without a path', async () => {
    defaultProject = { projectId: ID_B, realRoot: rootB };
    const list = await run('projects.list') as any[];
    expect(list.find((x) => x.id === ID_B).isDefault).toBe(true);
    expect(list.find((x) => x.id === ID_A).isDefault).toBe(false);
    expect(JSON.stringify(list)).not.toContain(rootB);
  });

  it('is checked again at the moment of the request: an unregistered default, a folder that moved, a missing folder', async () => {
    defaultProject = { projectId: 'd'.repeat(24), realRoot: rootA };
    expect(await code('session.new', params({ project: 'default' }))).toBe('default-unavailable'); // not registered any more
    defaultProject = { projectId: ID_A, realRoot: rootA };
    defaultValid = false; // the folder is no longer the one that was chosen
    expect(await code('session.new', params({ project: 'default' }))).toBe('default-unavailable');
    defaultValid = true;
    expect(started).toEqual([]);
    expect(await code('session.new', params({ project: 'default' }))).toBe('ran'); // the same request is fine once it is valid again
  });

  it('is not used for a request that names a project, and never for one that is archived', async () => {
    defaultProject = { projectId: ID_B, realRoot: rootB };
    await run('session.new', params({ project: ID_A }));
    expect(started[0]!.project).toBe(ID_A);
    reg[1]!.archived = true;
    expect(await code('session.new', params({ project: 'default', idemKey: 'z'.repeat(24) }))).toBe('project-archived');
  });
});

describe('a retry never starts a second session', () => {
  it('gives the same answer to the same request, marked as a repeat, and starts nothing more', async () => {
    const first = await run('session.new', params()) as any;
    const again = await run('session.new', params()) as any;
    expect(started).toHaveLength(1);
    expect(again).toMatchObject({ runId: first.runId, sessionId: first.sessionId, deduped: true });
    expect(auditOf(pA).map((x: any) => x.outcome)).toEqual(['started', 'deduped']);
  });

  it('still returns the stored result when the default project changed between the two requests', async () => {
    defaultProject = { projectId: ID_A, realRoot: rootA };
    const first = await run('session.new', params({ project: 'default' })) as any;
    defaultProject = { projectId: ID_B, realRoot: rootB };
    const again = await run('session.new', params({ project: 'default' })) as any;
    expect(started).toHaveLength(1);
    expect(again).toMatchObject({ sessionId: first.sessionId, project: { id: ID_A }, deduped: true });
  });

  it('refuses a key reused for a different request, and starts nothing', async () => {
    await run('session.new', params());
    for (const over of [{ prompt: 'Something else' }, { agent: 'codex' }, { project: ID_B }, { policy: 'read-only' }, { model: 'opus' }]) expect(await code('session.new', params(over))).toBe('idem-mismatch');
    expect(started).toHaveLength(1);
  });

  it('says "in doubt" after a crash between recording the key and recording the outcome, and starts nothing', async () => {
    const sha = (await import('@agentontrack/core')).sha256((await import('@agentontrack/core')).canonical({ v: 1, project: ID_A, agent: 'claude-code', model: 'haiku', policy: 'standard', prompt: 'Fix the parser', maxUsd: null }));
    (idem as IdempotencyStore).begin('d1', KEY, sha); // begun, never finished
    expect(await code('session.new', params())).toBe('in-doubt');
    expect(started).toEqual([]);
  });

  it('after a failure that is NOT a refusal (the outcome is unknown), the key stays in doubt: a retry is never run twice', async () => {
    startBehaviour = () => { throw new Error('the disk vanished'); };
    expect(await code('session.new', params())).toBe('error:the disk vanished');
    startBehaviour = () => {};
    expect(await code('session.new', params())).toBe('in-doubt');
    expect(started).toEqual([]);
  });

  it('after a refusal before any process exists, the key is released and a retry works', async () => {
    startBehaviour = () => { throw new Refusal('blocked', 'Connect Claude Code to this project first'); };
    expect(await code('session.new', params())).toBe('blocked');
    startBehaviour = () => {};
    expect(await code('session.new', params())).toBe('ran');
    expect(started).toHaveLength(1);
  });

  it('keeps devices apart: another phone with the same key starts its own session', async () => {
    await run('session.new', params());
    await exec('session.new', params(), { did: 'd2', device: { ...device, did: 'd2', fingerprint: 'CCCC-DDDD' } as TrustedDevice });
    expect(started.map((s) => s.source)).toEqual(['phone:AAAA-BBBB', 'phone:CCCC-DDDD']);
  });

  it('refuses, starting nothing, when the record of recent requests is unreadable', async () => {
    idem = { begin: () => { throw new IdempotencyUnavailable('The record of recent requests could not be read, so nothing was started.'); }, finish: () => {}, abandon: () => {} };
    expect(await code('session.new', params())).toBe('unavailable');
    expect(started).toEqual([]);
  });
});

describe('what a phone may NOT put in the request', () => {
  it('refuses a path, an argument list, an environment, a resume target, a working directory, or anything else extra', async () => {
    for (const extra of [{ cwd: '/etc' }, { path: 'C:\\Windows' }, { argv: ['--dangerously-skip-permissions'] }, { env: { X: '1' } }, { resumeRunId: 'run_1' }, { worktree: 'new' }, { attachments: ['a'.repeat(64)] }, { unknown: 1 }]) expect(await code('session.new', params(extra))).toBe('bad-request');
    expect(started).toEqual([]);
  });

  it('refuses a project that is not an id or "default", whatever it looks like', async () => {
    for (const project of ['../x', '..\\..\\x', 'C:\\x', '/etc', 'a'.repeat(23), 'A'.repeat(24), 'g'.repeat(24), 'default ', '', 'Default']) expect(await code('session.new', params({ project }))).toBe('bad-request');
    expect(started).toEqual([]);
  });

  it('refuses an unknown agent or policy, a prompt that starts with a hyphen or is too long or empty, a bad key, a wrong version, and a spend above the cap', async () => {
    const bad: object[] = [{ agent: 'hermes' }, { agent: 'claude-code; rm -rf' }, { policy: 'bypass' }, { policy: 'accept-edits' }, { policy: 'dangerously-skip-permissions' }, { prompt: '-p evil' }, { prompt: 'x'.repeat(4001) }, { prompt: '' }, { idemKey: 'short' }, { idemKey: 'has spaces and !!'.padEnd(30, 'x') }, { idemKey: 'k'.repeat(65) }, { v: 2 }, { v: undefined }, { maxUsd: 6 }, { maxUsd: 0 }, { maxUsd: -1 }, { model: '-x' }, { model: 'a b' }];
    for (const over of bad) expect(await code('session.new', params(over))).toBe('bad-request');
    expect(started).toEqual([]);
  });
});

describe('reading a session back', () => {
  it('gives a status and a short, clipped tail, never a transcript', async () => {
    const r = await run('session.get', { project: ID_A, sessionId: 'ses_aaaaaaaaaaaa' }) as any;
    expect(r).toMatchObject({ id: 'ses_aaaaaaaaaaaa', status: 'running', linked: true });
    expect(r.runs[0].events).toHaveLength(12);
    expect(r.runs[0].events.every((e: string) => e.length <= 340)).toBe(true);
  });
  it('refuses an unknown session, an unregistered project, and a malformed id', async () => {
    expect(await code('session.get', { project: ID_A, sessionId: 'ses_bbbbbbbbbbbb' })).toBe('no-session');
    expect(await code('session.get', { project: 'c'.repeat(24), sessionId: 'ses_aaaaaaaaaaaa' })).toBe('no-project');
    expect(await code('session.get', { project: ID_A, sessionId: '../../x' })).toBe('bad-request');
    expect(await code('session.get', { project: ID_A, sessionId: 'ses_aaaaaaaaaaaa', extra: 1 })).toBe('bad-request');
  });
});

describe('stillTheSameFolder (the default project is checked against the real folder at every start)', () => {
  it('is true for the folder that was chosen, false once it moved, was deleted, or was replaced by a link elsewhere', () => {
    const real = join(dir, 'chosen'); mkdirSync(real);
    const chosen = realpathSync.native(real);
    expect(stillTheSameFolder(real, chosen)).toBe(true);
    renameSync(real, join(dir, 'moved'));
    expect(stillTheSameFolder(real, chosen)).toBe(false); // moved away
    const elsewhere = join(dir, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'x'), '1');
    symlinkSync(elsewhere, real, 'junction'); // a link now stands where the folder was
    expect(stillTheSameFolder(real, chosen)).toBe(false);
    rmSync(real, { recursive: true, force: true });
    expect(stillTheSameFolder(real, chosen)).toBe(false); // gone
  });
});
