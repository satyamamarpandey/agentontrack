/** Pure logic for the Sessions pane: grouping, honest status wording, why Resume is unavailable, and unsent-text drafts. No React here, so it is unit-tested directly. */
export type SessionState = 'running' | 'idle' | 'failed' | 'stopped' | 'orphaned';
export interface SessionRow {
  id: string; runtime: string; model: string | null; title: string; titleSource: 'user' | 'default'; status: SessionState | string;
  createdAt: string; updatedAt: string; pinned: boolean; archived: boolean; worktreeId: string | null; linked?: boolean;
  runIds: string[]; lastRunId: string | null; canResume: boolean; source: string; lastPrompt: string | null; messages: number;
  match?: { where: string; snippet: string };
}

const KNOWN: readonly string[] = ['running', 'idle', 'failed', 'stopped', 'orphaned'];
/** A status this build does not know is shown as unknown, never as fine. */
export const statusOf = (s: { status: string }): SessionState | 'unknown' => (KNOWN.includes(s.status) ? (s.status as SessionState) : 'unknown');

export const STATUS_INFO: Record<SessionState | 'unknown', { label: string; tone: 'good' | 'warn' | 'bad' | 'muted'; text: string }> = {
  running: { label: 'running', tone: 'warn', text: 'A run is in progress now.' },
  idle: { label: 'idle', tone: 'muted', text: 'The last run ended and the agent is waiting for the next prompt. That does not mean the work is correct: check it under Verification.' },
  failed: { label: 'failed', tone: 'bad', text: 'The last run failed. Read its last output before you continue it.' },
  stopped: { label: 'stopped', tone: 'muted', text: 'The last run was stopped before it finished.' },
  orphaned: { label: 'orphaned', tone: 'warn', text: 'The last run has no recorded ending, for example because the companion restarted while it ran. How it ended is not known.' },
  unknown: { label: 'unknown', tone: 'bad', text: 'This computer reported a status this version does not understand. Treat the outcome as unknown.' },
};

export const SOURCE_LABEL: Record<string, string> = { phone: 'phone', user: 'you', plan: 'plan', workflow: 'workflow', other: 'other' };
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? 'other';

export interface Groups { active: SessionRow[]; recent: SessionRow[]; archived: SessionRow[] }
/** Active: a run is in progress. Recent: everything else not archived. Archived: archived. Pinned first, then newest, inside each. */
export function groupSessions(list: readonly SessionRow[]): Groups {
  const order = (a: SessionRow, b: SessionRow) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  const g: Groups = { active: [], recent: [], archived: [] };
  for (const s of list) (s.archived ? g.archived : s.status === 'running' ? g.active : g.recent).push(s);
  g.active.sort(order); g.recent.sort(order); g.archived.sort(order);
  return g;
}

/** Why Resume is unavailable, in words for a person, or null when it can be used. */
export function resumeBlock(s: Pick<SessionRow, 'status' | 'canResume' | 'archived'>): string | null {
  if (s.status === 'running') return 'A run is in progress. Stop it, or wait for it to end, before you continue this session.';
  if (!s.canResume) return 'The agent left no session that can be continued, so a new prompt would start from nothing. Start a new session instead.';
  return null;
}

/** Fork is not offered by AgentOnTrack. Claude Code has its own fork option on the command line, but this build does not call it and has not tested it, so it is shown disabled and not faked. */
export const FORK_UNSUPPORTED = 'Not supported yet. Claude Code can fork a session on its own command line, but AgentOnTrack does not start forks and this has not been tested here.';

export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const SLOT = 'aot.sessionDrafts';
/** Unsent text per session (or per "new session" form): kept in memory, and in the tab's session storage so a reload keeps it. Cleared only on a successful send. */
export function makeDrafts(store: Store | null) {
  const mem = new Map<string, string>();
  try { const raw = JSON.parse(store?.getItem(SLOT) ?? '{}') as Record<string, unknown>; for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') mem.set(k, v); } catch { /* damaged: start empty */ }
  const save = () => { try { if (mem.size) store?.setItem(SLOT, JSON.stringify(Object.fromEntries(mem))); else store?.removeItem(SLOT); } catch { /* storage full or blocked: memory still holds it */ } };
  return {
    get: (k: string) => mem.get(k) ?? '',
    set: (k: string, v: string) => { if (v) mem.set(k, v); else mem.delete(k); save(); },
    clear: (k: string) => { mem.delete(k); save(); },
    keys: () => [...mem.keys()],
  };
}
