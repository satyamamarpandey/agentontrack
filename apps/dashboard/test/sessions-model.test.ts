import { describe, expect, it } from 'vitest';
import { FORK_UNSUPPORTED, groupSessions, makeDrafts, resumeBlock, statusOf, STATUS_INFO, type SessionRow, type Store } from '../src/sessions-model';

const row = (o: Partial<SessionRow>): SessionRow => ({ id: 'ses_aaaaaaaa', runtime: 'claude-code', model: null, title: 't', titleSource: 'default', status: 'idle', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pinned: false, archived: false, worktreeId: null, runIds: [], lastRunId: null, canResume: true, source: 'user', lastPrompt: null, messages: 0, ...o });
const mem = (): Store => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };

describe('sessions model', () => {
  it('groups into active, recent and archived, pinned then newest', () => {
    const g = groupSessions([row({ id: 'a', updatedAt: '2026-01-02' }), row({ id: 'b', status: 'running' }), row({ id: 'c', archived: true }), row({ id: 'd', pinned: true, updatedAt: '2026-01-01' }), row({ id: 'e', updatedAt: '2026-01-03' })]);
    expect(g.active.map((s) => s.id)).toEqual(['b']);
    expect(g.recent.map((s) => s.id)).toEqual(['d', 'e', 'a']);
    expect(g.archived.map((s) => s.id)).toEqual(['c']);
  });
  it('treats a status it does not know as unknown, never as fine', () => {
    expect(statusOf({ status: 'completed' })).toBe('unknown');
    expect(statusOf({ status: 'failed' })).toBe('failed');
    expect(STATUS_INFO.unknown.tone).toBe('bad');
    expect(STATUS_INFO.failed.tone).toBe('bad');
    for (const v of Object.values(STATUS_INFO)) expect(v.text).not.toMatch(/success|passed|verified|done/i);
  });
  it('explains why Resume is unavailable', () => {
    expect(resumeBlock({ status: 'running', canResume: false, archived: false })).toMatch(/in progress/);
    expect(resumeBlock({ status: 'idle', canResume: false, archived: false })).toMatch(/no session/);
    expect(resumeBlock({ status: 'failed', canResume: true, archived: false })).toBeNull();
  });
  it('says fork is not supported', () => { expect(FORK_UNSUPPORTED).toMatch(/Not supported/); });
  it('keeps unsent text per session across a reload, and drops it when cleared', () => {
    const s = mem();
    const a = makeDrafts(s);
    a.set('ses_1', 'half a thought'); a.set('ses_2', 'other');
    expect(a.get('ses_1')).toBe('half a thought');
    const b = makeDrafts(s); // a reload
    expect(b.get('ses_1')).toBe('half a thought');
    expect(b.get('ses_2')).toBe('other');
    b.clear('ses_1'); b.set('ses_2', '');
    expect(makeDrafts(s).keys()).toEqual([]);
    expect(s.getItem('aot.sessionDrafts')).toBeNull();
  });
  it('survives damaged or blocked storage', () => {
    const bad: Store = { getItem: () => '{not json', setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('x'); } };
    const d = makeDrafts(bad);
    expect(() => d.set('k', 'v')).not.toThrow();
    expect(d.get('k')).toBe('v');
    expect(makeDrafts(null).get('x')).toBe('');
  });
});
