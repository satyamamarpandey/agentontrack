// Agent sessions through the real companion with a REAL child process (a script that names a provider session, records its arguments, and waits on a gate file):
// a new session really starts a new provider session, a resume really passes the provider's id, a stopped run stays resumable, a restart loses nothing, projects stay apart,
// transcript text is stored only when the owner says so, and rename/pin/archive survive a restart. It tests the companion, not Claude Code.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project, buildHandoff, registerProject, saveHandoff } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
// The prompt names the run: "slow-x" waits for the gate, "quick-x" finishes at once. The provider session id is the --resume value, or a new one.
const FAKE = `
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const name = /(slow|quick)-\\w+/.exec(prompt)?.[0] ?? 'run';
const dir = process.env.GATE_DIR;
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const sid = resume ?? ('sess-' + randomBytes(6).toString('hex'));
writeFileSync(dir + '/' + name + '.args', JSON.stringify({ resume, hasP: args.includes('-p'), argv: args }));
writeFileSync(dir + '/' + name + '.pid', String(process.pid));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', session_id: sid }));
if (name.startsWith('slow')) { while (!existsSync(dir + '/release')) await new Promise((ok) => setTimeout(ok, 20)); }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done ' + name + ' alpha-marker' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }));
`;

let dir: string; let root: string; let gate: string; let c: Companion; let origin: string;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) => { for (const t = Date.now(); Date.now() - t < ms;) { if (await fn()) return; await sleep(20); } throw new Error(`timed out waiting for: ${what}`); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const argsOf = (name: string) => JSON.parse(readFileSync(join(gate, `${name}.args`), 'utf8')) as { resume: string | null; hasP: boolean; argv: string[] };
const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]!; };
const pidOf = (name: string) => Number(readFileSync(join(gate, `${name}.pid`), 'utf8'));

afterEach(async () => {
  try { writeFileSync(join(gate, 'release'), '1'); } catch { /* gone */ }
  await c.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* a just-killed process can hold its folder for a moment; it is a throwaway in the OS temp directory */ }
});

const boot = async () => {
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')] });
  origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof boot>>;
const setup = async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-sess-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  gate = join(dir, 'gate'); mkdirSync(gate); process.env.GATE_DIR = gate;
  root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake-claude.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  return boot();
};
const restart = async () => { await c.close(); return boot(); };
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const list = async (s: S, qs = '') => (await (await api(s, `/api/agent-sessions${qs}`)).json()) as { keepTranscripts: boolean; sessions: any[] };
const newSession = async (s: S, name: string, extra: object = {}, qs = '') => { const r = await api(s, `/api/agent-sessions${qs}`, { runtime: 'claude-code', prompt: `go ${name}`, model: 'haiku', maxBudgetUsd: 0.1, ...extra }); expect(r.status).toBe(200); return (await r.json()) as { sessionId: string; runId: string; status: string }; };
const resume = (s: S, sid: string, name: string, qs = '') => api(s, `/api/agent-sessions/${sid}/resume${qs}`, { prompt: `go ${name}`, model: 'haiku', maxBudgetUsd: 0.1 });
const idle = async (s: S, sid: string) => { await until(`session ${sid} to be idle`, async () => (await list(s)).sessions.find((x) => x.id === sid)?.status === 'idle'); };

describe('a new session', () => {
  it('starts a genuinely new provider session (no --resume), and is listed with its run', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a', { title: 'Parser work' });
    await idle(s, a.sessionId);
    expect({ resume: argsOf('quick-a').resume, hasP: argsOf('quick-a').hasP }).toEqual({ resume: null, hasP: true });
    const row = (await list(s)).sessions.find((x) => x.id === a.sessionId)!;
    expect(row).toMatchObject({ runtime: 'claude-code', title: 'Parser work', titleSource: 'user', status: 'idle', canResume: true, linked: true, runIds: [a.runId], source: 'user' });
    expect(JSON.stringify(row)).not.toMatch(/sess-[a-f0-9]{12}/); // the provider's own id is not handed to the page
  });

  it('two new sessions are two different provider sessions', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a'); const b = await newSession(s, 'quick-b');
    expect(a.sessionId).not.toBe(b.sessionId);
    await idle(s, a.sessionId); await idle(s, b.sessionId);
    expect(argsOf('quick-a').resume).toBeNull();
    expect(argsOf('quick-b').resume).toBeNull();
  });
});

describe('continuing a session', () => {
  it('passes the provider session id to --resume, keeps the same session, and lists both runs', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a'); await idle(s, a.sessionId);
    const r = await resume(s, a.sessionId, 'quick-b');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.sessionId).toBe(a.sessionId);
    await idle(s, a.sessionId);
    const providerFirst = JSON.parse(readFileSync(join(gate, 'quick-a.args'), 'utf8')); // first run: no resume
    expect(providerFirst.resume).toBeNull();
    expect(argsOf('quick-b').resume).toMatch(/^sess-[a-f0-9]{12}$/); // second run: resumed the provider session the first run named
    const row = (await list(s)).sessions.find((x) => x.id === a.sessionId)!;
    expect(row.runIds).toEqual([a.runId, b.runId]);
  });

  it('refuses a second run while one is going, and says so', async () => {
    const s = await setup();
    const a = await newSession(s, 'slow-a');
    await until('the agent to start', () => existsSync(join(gate, 'slow-a.pid')));
    await until('the provider to name its session', async () => (await api(s, `/api/agent-sessions/${a.sessionId}`)).status === 200 && (await (await api(s, `/api/agent-sessions/${a.sessionId}`)).json()).linked === true);
    const again = await resume(s, a.sessionId, 'quick-b');
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/still has a run going/);
  });

  it('refuses an unknown session, a wrong-runtime continue, and a session that left nothing to resume', async () => {
    const s = await setup();
    expect((await resume(s, 'ses_ffffffffffff', 'quick-x')).status).toBe(404);
    const a = await newSession(s, 'quick-a'); await idle(s, a.sessionId);
    const wrong = await api(s, '/api/runs', { runtime: 'codex', prompt: 'go quick-z', model: 'default', sessionId: a.sessionId });
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error).toMatch(/cannot continue with codex/);
  });
});

describe('a stopped run', () => {
  it('stays resumable, because the provider named its session at the start of the run', async () => {
    const s = await setup();
    const a = await newSession(s, 'slow-a');
    await until('the agent to start', () => existsSync(join(gate, 'slow-a.pid')));
    await until('the session to be linked', async () => (await (await api(s, `/api/agent-sessions/${a.sessionId}`)).json()).linked === true);
    expect((await api(s, `/api/runs/${a.runId}/stop`, {})).status).toBe(200);
    expect(alive(pidOf('slow-a'))).toBe(false);
    await until('the session to read stopped', async () => (await list(s)).sessions.find((x) => x.id === a.sessionId)?.status === 'stopped');
    const row = (await list(s)).sessions.find((x) => x.id === a.sessionId)!;
    expect(row.canResume).toBe(true);
    const r = await resume(s, a.sessionId, 'quick-b');
    expect(r.status).toBe(200);
    await idle(s, a.sessionId);
    expect(argsOf('quick-b').resume).toMatch(/^sess-[a-f0-9]{12}$/);
  });
});

describe('a restart of the companion', () => {
  it('loses no session: it is still listed, can be continued, and keeps its title, pin and archive state', async () => {
    let s = await setup();
    const a = await newSession(s, 'quick-a', { title: 'Before restart' }); await idle(s, a.sessionId);
    const b = await newSession(s, 'quick-b'); await idle(s, b.sessionId);
    expect((await api(s, `/api/agent-sessions/${a.sessionId}/update`, { title: 'Renamed', pinned: true })).status).toBe(200);
    expect((await api(s, `/api/agent-sessions/${b.sessionId}/update`, { archived: true })).status).toBe(200);
    s = await restart();
    const rows = (await list(s)).sessions;
    expect(rows.map((x) => x.id)).toEqual([a.sessionId]); // the archived one is hidden by default
    expect(rows[0]).toMatchObject({ title: 'Renamed', pinned: true, status: 'idle', canResume: true });
    expect((await list(s, '?archived=1')).sessions.map((x) => x.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
    const r = await resume(s, a.sessionId, 'quick-c');
    expect(r.status).toBe(200);
    await idle(s, a.sessionId);
    expect(argsOf('quick-c').resume).toMatch(/^sess-[a-f0-9]{12}$/);
  });

  it('shows a run that never ended as orphaned, not running, and does not offer to resume it unless its provider session is known', async () => {
    const s = await setup();
    const p = new Project(root);
    p.store.append({ type: 'run.started', actor: { kind: 'human' }, payload: { id: 'run_aaaaaaaaaa', runtime: 'claude-code', model: 'haiku' } });
    p.close();
    const row = (await list(s)).sessions[0]!;
    expect(row.status).toBe('orphaned');
    expect(row.canResume).toBe(false);
    expect((await resume(s, row.id, 'quick-a')).status).toBe(409);
  });
});

describe('sessions of two projects stay apart', () => {
  it('a session of project A is not found, listed or continued from project B', async () => {
    const s = await setup();
    const rootB = join(dir, 'repoB'); mkdirSync(rootB);
    const pb = new Project(rootB); pb.human.setGoal({ statement: 'b', scope: { include: ['**'] } }); pb.close();
    installHooks('claude-code', rootB, `"${process.execPath}" "${CLI}"`);
    const A = registerProject(root).id; const B = registerProject(rootB).id;
    expect(A).not.toBe(B);
    const a = await newSession(s, 'quick-a', {}, `?project=${A}`);
    await until('A to finish', async () => (await (await api(s, `/api/agent-sessions?project=${A}`)).json()).sessions.find((x: any) => x.id === a.sessionId)?.status === 'idle');
    expect((await (await api(s, `/api/agent-sessions?project=${B}`)).json()).sessions).toEqual([]);
    expect((await api(s, `/api/agent-sessions/${a.sessionId}?project=${B}`)).status).toBe(404);
    expect((await resume(s, a.sessionId, 'quick-b', `?project=${B}`)).status).toBe(404);
    expect((await api(s, `/api/agent-sessions/${a.sessionId}/update?project=${B}`, { title: 'hijack' })).status).toBe(404);
    expect((await list(s, '')).sessions.find((x) => x.id === a.sessionId)?.title).not.toBe('hijack');
  });
});

describe('transcript retention is the owner\'s choice, and is off by default', () => {
  it('stores no prompt or agent text by default, and search then finds titles only', async () => {
    const s = await setup();
    expect((await list(s)).keepTranscripts).toBe(false);
    const a = await newSession(s, 'quick-a', { title: 'Needle in the title' }); await idle(s, a.sessionId);
    const p = new Project(root);
    try { expect(p.store.byType(['session.prompt', 'session.message'])).toEqual([]); } finally { p.close(); }
    expect((await list(s, '?q=needle')).sessions.map((x) => x.id)).toEqual([a.sessionId]);
    expect((await list(s, '?q=alpha-marker')).sessions).toEqual([]); // the agent's words were never kept
    expect((await (await api(s, `/api/agent-sessions/${a.sessionId}`)).json()).transcript).toEqual([]);
  });

  // WHAT IS RETAINED with retention OFF (documented by this test): the metadata of a run and a session (ids, runtime, model, status, times, cost and token counts, a SHA-256 of the
  // prompt, and a title only if the person typed one), and the last ~2000 output lines of a run IN MEMORY, which is gone when the companion stops. NOT retained anywhere on disk:
  // the prompt text, the agent's words, a derived session title, or a handoff built after the run.
  it('persists no prompt or answer text anywhere on disk with retention off: events, export, session titles, handoff and every file in the project state', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a zebra-needle-77', { title: 'Typed by the person' }); await idle(s, a.sessionId);
    const p = new Project(root);
    try {
      p.human.createTask({ id: 'tk', title: 'Fix it', criteria: [] });
      const h = buildHandoff(p, { from: 'claude-code', taskId: 'tk', reason: { kind: 'planned' } });
      saveHandoff(p, h, {});
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      const everything = [JSON.stringify(p.store.all()), JSON.stringify(h), ...walk(p.stateDir).map((f) => readFileSync(f, 'latin1'))].join('\n');
      expect(everything).not.toContain('zebra-needle-77');
      expect(everything).not.toContain('alpha-marker');
      expect(everything).toContain('Typed by the person'); // a title the person typed is theirs
    } finally { p.close(); }
    const exported = await (await api(s, '/api/data/export')).text();
    expect(exported).not.toMatch(/zebra-needle-77|alpha-marker/);
    expect(JSON.stringify((await list(s)).sessions)).not.toMatch(/zebra-needle-77|alpha-marker/);
    // The default title is generic, not made from the prompt.
    const b = await newSession(s, 'quick-b zebra-needle-77'); await idle(s, b.sessionId);
    expect((await list(s)).sessions.find((x) => x.id === b.sessionId).title).toBe('Claude Code session');
  });

  it('when the owner turns it on, keeps the prompt and the agent\'s lines, and search finds them', async () => {
    const s = await setup();
    expect((await api(s, '/api/settings', { keepTranscripts: true })).status).toBe(200);
    expect((await list(s)).keepTranscripts).toBe(true);
    const a = await newSession(s, 'quick-a'); await idle(s, a.sessionId);
    await until('the transcript to be stored', async () => (await (await api(s, `/api/agent-sessions/${a.sessionId}`)).json()).transcript.length >= 2);
    const t = (await (await api(s, `/api/agent-sessions/${a.sessionId}`)).json()).transcript as { kind: string; text: string }[];
    expect(t.map((x) => x.kind).sort()).toEqual(['message', 'prompt']);
    expect(t.find((x) => x.kind === 'prompt')!.text).toBe('go quick-a');
    expect((await list(s, '?q=alpha-marker')).sessions.map((x) => x.id)).toEqual([a.sessionId]);
    expect((await list(s, '?q=alpha-marker')).sessions[0].match.where).toBe('message');
  });
});

describe('the policy a session runs under can only narrow what the agent may do', () => {
  it('a standard session gets the standard tools and mode, and says nothing about a policy in its record', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a'); await idle(s, a.sessionId);
    const argv = argsOf('quick-a').argv;
    expect(flag(argv, '--allowedTools')).toBe('Bash,Write,Edit,Read,Grep,Glob');
    expect(flag(argv, '--permission-mode')).toBe('acceptEdits');
    expect(argv).not.toContain('--disallowedTools');
    const p = new Project(root);
    try { expect(p.store.byType(['session.created'])[0]!.payload.policy).toBeUndefined(); } finally { p.close(); }
  });

  it('a read-only session loses the write tools and the "accept edits" mode, and the record says read-only', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a', { policy: 'read-only' }); await idle(s, a.sessionId);
    const argv = argsOf('quick-a').argv;
    expect(flag(argv, '--allowedTools')).toBe('Read,Grep,Glob');
    expect(flag(argv, '--tools')).toBe('Read,Grep,Glob'); // an allow-list of built-in tools, so a tool nobody listed (PowerShell, Task, web, MCP) is not there at all
    expect(flag(argv, '--disallowedTools')).toBe('Bash,PowerShell,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch');
    expect(flag(argv, '--permission-mode')).toBe('default');
    expect(argv).toContain('--strict-mcp-config'); // no MCP server from the project or user config is loaded into a read-only run
    expect(flag(argv, '--mcp-config')).toBe('{"mcpServers":{}}');
    expect(argv.join(' ')).not.toMatch(/acceptEdits|Write,Edit,Read/);
    const p = new Project(root);
    try {
      expect(p.store.byType(['session.created'])[0]!.payload.policy).toBe('read-only');
      expect(p.store.byType(['run.started'])[0]!.payload.policy).toBe('read-only');
    } finally { p.close(); }
  });

  it('keeps a read-only session read-only when it is continued, even if the continue request says nothing about policy', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a', { policy: 'read-only' }); await idle(s, a.sessionId);
    expect((await resume(s, a.sessionId, 'quick-b')).status).toBe(200);
    await idle(s, a.sessionId);
    const argv = argsOf('quick-b').argv;
    expect(flag(argv, '--tools')).toBe('Read,Grep,Glob');
    expect(argv.join(' ')).not.toMatch(/acceptEdits/);
  });

  it('keeps a read-only session read-only when it is continued by run id too (POST /api/runs with resumeRunId)', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a', { policy: 'read-only' }); await idle(s, a.sessionId);
    const r = await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'go quick-c', model: 'haiku', maxBudgetUsd: 0.1, resumeRunId: a.runId });
    expect(r.status).toBe(200);
    await idle(s, a.sessionId);
    const argv = argsOf('quick-c').argv;
    expect(flag(argv, '--tools')).toBe('Read,Grep,Glob');
    expect(argv.join(' ')).not.toMatch(/acceptEdits/);
  });

  it('refuses a prompt with a NUL character before anything is started', async () => {
    const s = await setup();
    const r = await api(s, '/api/agent-sessions', { runtime: 'claude-code', prompt: 'go quick-nul\0x', model: 'haiku', maxBudgetUsd: 0.1 });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(gate, 'quick-nul.args'))).toBe(false);
  });

  it('refuses a policy it does not know, so nothing wider than the standard can be asked for', async () => {
    const s = await setup();
    for (const policy of ['bypass', 'accept-edits', 'dangerously-skip-permissions', 'ALL', '']) {
      const r = await api(s, '/api/agent-sessions', { runtime: 'claude-code', prompt: 'go quick-x', model: 'haiku', policy });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(existsSync(join(gate, 'quick-x.args'))).toBe(false);
  });
});

describe('the session routes refuse bad input', () => {
  it('rejects a malformed id, an empty update and unknown fields', async () => {
    const s = await setup();
    const a = await newSession(s, 'quick-a'); await idle(s, a.sessionId);
    expect((await api(s, '/api/agent-sessions/not-an-id')).status).toBe(404);
    expect((await api(s, `/api/agent-sessions/${a.sessionId}/update`, {})).status).toBeGreaterThanOrEqual(400);
    expect((await api(s, `/api/agent-sessions/${a.sessionId}/update`, { title: 'x', cwd: '/etc' })).status).toBeGreaterThanOrEqual(400);
    expect((await api(s, `/api/agent-sessions/${a.sessionId}/update`, { title: 'y'.repeat(500) })).status).toBeGreaterThanOrEqual(400);
    expect((await api(s, '/api/agent-sessions', { runtime: 'claude-code', prompt: '-dangerously', model: 'haiku' })).status).toBeGreaterThanOrEqual(400);
  });
});
