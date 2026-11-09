// Sessions are a projection of the existing log. These tests build logs by hand, so each rule is checked on its own: old logs, resume chains, a stopped run that can still be resumed,
// restart (orphans), replayed pin/archive/rename, search, and hostile or malformed payloads.
import { describe, expect, it } from 'vitest';
import { isSessionId, newSessionId, projectSessions, searchSessions, sessionIdOfRun, type StoredEvent } from '../src/index.js';

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 10, 8, 10, 0, n)).toISOString();
const ev = (type: string, payload: unknown, t = ++seq): StoredEvent => ({ seq: t, ts: at(t), type, actor: { kind: 'system' } as any, taskId: null, goalVersion: null, policyVersion: null, payload, prevHash: '', hash: '' });
const started = (id: string, extra: object = {}) => ev('run.started', { id, runtime: 'claude-code', model: 'haiku', ...extra });
const finished = (id: string, status = 'finished', sessionId: string | null = null) => ev('run.finished', { id, status, sessionId });
const reset = () => { seq = 0; };
const PROV = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('projectSessions', () => {
  it('shows nothing for an empty log', () => { reset(); expect(projectSessions([])).toEqual([]); });

  it('groups a log from before sessions existed: a run with no links is a session of its own, and resumes join the first one', () => {
    reset();
    const log = [started('run_aaaaaaaaaa'), finished('run_aaaaaaaaaa', 'finished', PROV), started('run_bbbbbbbbbb', { resumedFrom: 'run_aaaaaaaaaa' }), finished('run_bbbbbbbbbb', 'finished', PROV), started('run_cccccccccc'), finished('run_cccccccccc')];
    const s = projectSessions(log);
    expect(s).toHaveLength(2);
    const chain = s.find((x) => x.runIds.includes('run_aaaaaaaaaa'))!;
    expect(chain.runIds).toEqual(['run_aaaaaaaaaa', 'run_bbbbbbbbbb']);
    expect(chain.canResume).toBe(true);
    expect(chain.resumeRunId).toBe('run_bbbbbbbbbb');
    expect(chain.providerSessionId).toBe(PROV);
    const lone = s.find((x) => x.runIds.includes('run_cccccccccc'))!;
    expect(lone.canResume).toBe(false); // it left no provider session
    expect(lone.resumeRunId).toBeNull();
    expect(isSessionId(chain.id)).toBe(true);
  });

  it('joins a Codex resume to its session through the provider session id', () => {
    reset();
    const log = [started('run_1111111111', { runtime: 'codex' }), finished('run_1111111111', 'finished', 'thread-0001-aaaa'), started('run_2222222222', { runtime: 'codex', resumedSession: 'thread-0001-aaaa' }), finished('run_2222222222', 'finished', 'thread-0001-aaaa')];
    const s = projectSessions(log);
    expect(s).toHaveLength(1);
    expect(s[0]!.runIds).toEqual(['run_1111111111', 'run_2222222222']);
  });

  it('keeps a STOPPED run resumable when the provider named its session before the stop (session.linked)', () => {
    reset();
    const sid = 'ses_0123456789ab';
    const log = [ev('session.created', { sessionId: sid, runtime: 'claude-code', model: 'haiku' }), started('run_aaaaaaaaaa'), ev('session.run', { sessionId: sid, runId: 'run_aaaaaaaaaa' }), ev('session.linked', { sessionId: sid, providerSessionId: PROV, runId: 'run_aaaaaaaaaa' }), finished('run_aaaaaaaaaa', 'stopped', null)];
    const [s] = projectSessions(log);
    expect(s!.id).toBe(sid);
    expect(s!.status).toBe('stopped');
    expect(s!.providerSessionId).toBe(PROV);
    expect(s!.canResume).toBe(true);
    expect(s!.resumeRunId).toBe('run_aaaaaaaaaa');
  });

  it('says running for a live run, idle after a finish, failed after a failure', () => {
    reset();
    const a = [started('run_aaaaaaaaaa'), finished('run_aaaaaaaaaa', 'finished', PROV)];
    expect(projectSessions(a)[0]!.status).toBe('idle');
    expect(projectSessions([started('run_bbbbbbbbbb'), finished('run_bbbbbbbbbb', 'failed')])[0]!.status).toBe('failed');
    const running = projectSessions([started('run_cccccccccc')], { live: new Set(['run_cccccccccc']) })[0]!;
    expect(running.status).toBe('running');
    expect(running.canResume).toBe(false);
  });

  it('shows a run with no end that is not live (a restart) as orphaned, and never as running or idle', () => {
    reset();
    const [s] = projectSessions([started('run_aaaaaaaaaa')]);
    expect(s!.status).toBe('orphaned');
    expect(s!.canResume).toBe(false);
  });

  it('does not offer to resume through a run that is still live', () => {
    reset();
    const log = [started('run_aaaaaaaaaa'), finished('run_aaaaaaaaaa', 'finished', PROV), started('run_bbbbbbbbbb', { resumedFrom: 'run_aaaaaaaaaa' })];
    const [s] = projectSessions(log, { live: new Set(['run_bbbbbbbbbb']) });
    expect(s!.status).toBe('running');
    expect(s!.canResume).toBe(false);
  });

  it('replays rename, pin and archive in order, the last word winning', () => {
    reset();
    const sid = 'ses_0123456789ab';
    const log = [ev('session.created', { sessionId: sid, runtime: 'codex', title: 'First title' }), started('run_aaaaaaaaaa', { runtime: 'codex' }), ev('session.run', { sessionId: sid, runId: 'run_aaaaaaaaaa' }), finished('run_aaaaaaaaaa'),
      ev('session.updated', { sessionId: sid, title: 'Renamed', pinned: true }), ev('session.updated', { sessionId: sid, archived: true }), ev('session.updated', { sessionId: sid, archived: false, pinned: false })];
    const [s] = projectSessions(log);
    expect(s!.title).toBe('Renamed');
    expect(s!.titleSource).toBe('user');
    expect(s!.pinned).toBe(false);
    expect(s!.archived).toBe(false);
  });

  it('uses a default title that says what the agent is, and caps a user title', () => {
    reset();
    const [a] = projectSessions([started('run_aaaaaaaaaa'), started('run_bbbbbbbbbb', { runtime: 'codex' })]);
    expect(['Claude Code session', 'Codex session']).toContain(a!.title);
    const sid = 'ses_0123456789ab';
    const [b] = projectSessions([ev('session.created', { sessionId: sid, runtime: 'claude-code', title: 'x'.repeat(500) })]);
    expect(b!.title).toHaveLength(120);
  });

  it('puts pinned sessions first, then the most recently active', () => {
    reset();
    const log = [started('run_aaaaaaaaaa'), finished('run_aaaaaaaaaa'), started('run_bbbbbbbbbb'), finished('run_bbbbbbbbbb'),
      ev('session.created', { sessionId: 'ses_aaaaaaaaaaaa', runtime: 'claude-code' }), ev('session.run', { sessionId: 'ses_aaaaaaaaaaaa', runId: 'run_aaaaaaaaaa' }), ev('session.updated', { sessionId: 'ses_aaaaaaaaaaaa', pinned: true })];
    const s = projectSessions(log);
    expect(s[0]!.id).toBe('ses_aaaaaaaaaaaa');
  });

  it('marks where a session came from: a phone, a plan, a workflow', () => {
    reset();
    const s = projectSessions([started('run_aaaaaaaaaa', { source: 'phone:AAAA-BBBB' }), started('run_bbbbbbbbbb', { planId: 'p1', phaseId: 'x' }), started('run_cccccccccc', { source: 'cross-review:wf_1' }), started('run_dddddddddd')]);
    const src = (r: string) => s.find((x) => x.runIds.includes(r))!.source;
    expect([src('run_aaaaaaaaaa'), src('run_bbbbbbbbbb'), src('run_cccccccccc'), src('run_dddddddddd')]).toEqual(['phone', 'plan', 'workflow', 'user']);
  });

  it('ignores hostile or malformed payloads: bad ids, wrong types, unknown sessions, and a resume loop', () => {
    reset();
    const log = [ev('session.created', { sessionId: '../../etc/passwd', runtime: 'claude-code' }), ev('session.created', { sessionId: 42, runtime: 'x' }), ev('session.updated', { sessionId: 'ses_ffffffffffff', title: 'nobody' }),
      started('run_aaaaaaaaaa', { resumedFrom: 'run_bbbbbbbbbb' }), started('run_bbbbbbbbbb', { resumedFrom: 'run_aaaaaaaaaa' }), ev('session.linked', { runId: 'run_aaaaaaaaaa', providerSessionId: '../bad' }), ev('run.finished', { id: 'run_nope' })];
    const s = projectSessions(log);
    expect(s.every((x) => isSessionId(x.id))).toBe(true);
    expect(s.every((x) => x.providerSessionId === null)).toBe(true);
    expect(s.some((x) => x.title === 'nobody')).toBe(false);
  });

  it('looks up the session of a run, and of an unknown run', () => {
    reset();
    const log = [started('run_aaaaaaaaaa'), started('run_bbbbbbbbbb', { resumedFrom: 'run_aaaaaaaaaa' })];
    expect(sessionIdOfRun(log, 'run_bbbbbbbbbb')).toBe(sessionIdOfRun(log, 'run_aaaaaaaaaa'));
    expect(sessionIdOfRun(log, 'run_unknown')).toBeNull();
  });

  it('makes valid, unique ids', () => {
    const ids = new Set(Array.from({ length: 200 }, newSessionId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isSessionId(id)).toBe(true);
  });
});

describe('searchSessions', () => {
  const sid = 'ses_0123456789ab';
  const base = () => { reset(); return [ev('session.created', { sessionId: sid, runtime: 'claude-code', title: 'Fix the parser crash' }), started('run_aaaaaaaaaa'), ev('session.run', { sessionId: sid, runId: 'run_aaaaaaaaaa' })]; };
  it('finds titles, case-insensitively', () => {
    expect(searchSessions(base(), 'PARSER')).toEqual([{ sessionId: sid, where: 'title', snippet: 'Fix the parser crash' }]);
  });
  it('finds stored prompts and messages, and says where', () => {
    const log = [...base(), ev('session.prompt', { sessionId: sid, runId: 'run_aaaaaaaaaa', text: 'please refactor the tokenizer' }), ev('session.message', { sessionId: sid, runId: 'run_aaaaaaaaaa', text: 'I changed tokenizer.ts' })];
    expect(searchSessions(log, 'tokenizer').map((h) => h.where).sort()).toEqual(['message', 'prompt']);
  });
  it('finds nothing in text that was never stored', () => {
    expect(searchSessions(base(), 'tokenizer')).toEqual([]);
  });
  it('refuses an empty or oversized query and ignores messages for unknown or malformed sessions', () => {
    const log = [...base(), ev('session.prompt', { sessionId: '../x', text: 'tokenizer' })];
    expect(searchSessions(log, '')).toEqual([]);
    expect(searchSessions(log, 'x'.repeat(201))).toEqual([]);
    expect(searchSessions(log, 'tokenizer')).toEqual([]);
  });
});
