import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, relative, sep, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failoverOptions, runtimeFacts, coverageFor, PROVIDERS, providerInstalled, hooksInstalled, installHooks, probeLocalModel, uninstallHooks } from '@agentontrack/adapters';
import { renderHandoffMarkdown, acceptHandoff2, buildHandoff, listHandoffs, loadHandoff, planWorkflow, checkSpec, saveHandoff, validateHandoff, hashText, listDir, WorkspaceError, updateRegistered, approvalView, agentontrackHome, computeAnalytics, isPendingLive, loadRegistry, Project, registerProject, saveRegistry, stateDirFor, type Registered } from '@agentontrack/core';
import * as z from 'zod/v4';

const SESSION_TTL_MS = 8 * 3_600_000;
const REMOTE_SESSION_TTL_MS = 2 * 3_600_000;
/** Things a paired outside page may do without a terminal code: none of them grants or disables anything. */
const REMOTE_FREE = new Set(['/api/challenge', '/api/unpair', '/api/feedback']);
const MAX_TERMINAL_FAILURES = 5;
const MAX_SHOWN_REQUEST = 4000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_PAIR_FAILURES = 5;
const MAX_BODY = 256 * 1024;
const COOKIE = 'bl_session';
const here = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export interface CompanionOptions {
  root?: string;
  port?: number;
  uiDir?: string;
  home?: string;
  /** Overrides the agent command. Used by tests that must not spend inference; they label results as such. */
  claudeCommand?: string[];
  benchmarksDir?: string;
  /** Exact origins allowed to call the API. Empty by default. They still need a pairing code. */
  allowedOrigins?: string[];
  /** Hook command for this install. Without it, the dev build's own path is used. */
  selfCommand?: string;
  /** Shows a code to the person at the terminal. A session from an outside origin changes nothing without one. */
  onTerminalChallenge?: (code: string, action: string) => void;
}

export interface Companion {
  url: string;
  port: number;
  newPairingCode(): string;
  close(): Promise<void>;
  server: Server;
}

interface Session { tokenHash: string; csrf: string; createdAt: number; expiresAt: number; userAgent: string; origin?: string; surface?: 'editor'; terminalFailures?: number }
interface Run { id: string; project: string; child: ChildProcess; started: number; events: string[]; status: string }

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const settingsPath = () => join(agentontrackHome(), 'settings.json');
export const DEFAULT_SETTINGS = { telemetry: false, diagnostics: false, theme: 'dark', environment: { show: true, userGridGCo2PerKwh: null as number | null } };
type Settings = typeof DEFAULT_SETTINGS;
const loadSettings = (): Settings => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }; } catch { return structuredClone(DEFAULT_SETTINGS); } };
const saveSettings = (s: Settings) => { mkdirSync(dirname(settingsPath()), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); };

const TaskInput = z.object({ title: z.string().min(1).max(300), criteria: z.array(z.unknown()).max(50).default([]), limits: z.unknown().optional() });
const RunInput = z.object({ runtime: z.enum(['claude-code', 'codex', 'hermes']), prompt: z.string().min(1).max(20_000).regex(/^[^-]/, 'A prompt cannot start with a hyphen'), model: z.string().regex(/^\w[\w.:-]{0,79}$/).default('haiku'), maxBudgetUsd: z.number().positive().max(5).default(0.5) });
const HumanFields = { confirm: z.string(), passphrase: z.string().optional() };

function detectVersionArgs(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0]!.slice(0, 80) : null;
}

function detectVersion(cmd: string): string | null {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0]!.slice(0, 80) : null;
}

/** Reports login state without ever reading credentials: only the official CLI's own status command. */
function claudeAuth(): { authenticated: boolean; method: string | null; subscription: string | null } {
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' });
  try {
    const o = JSON.parse(r.stdout);
    return { authenticated: !!o.loggedIn, method: o.authMethod ?? null, subscription: o.subscriptionType ?? null };
  } catch { return { authenticated: false, method: null, subscription: null }; }
}

export async function startCompanion(opts: CompanionOptions = {}): Promise<Companion> {
  if (opts.home) process.env.AGENTONTRACK_HOME = opts.home;
  const uiDir = opts.uiDir ?? resolve(here, '..', 'ui');
  const benchmarksDir = opts.benchmarksDir ?? resolve(here, '..', '..', '..', 'benchmarks', 'results');
  const sessions = new Map<string, Session>();
  const projects = new Map<string, Project>();
  const runs = new Map<string, Run>();
  const allowed = new Set(opts.allowedOrigins ?? []);
  const challenges = new Map<string, { code: string; expires: number; session: string; bodyKey?: string }>();
  const bodies = new WeakMap<IncomingMessage, any>();
  const proved = new WeakSet<IncomingMessage>();
  const streams = new Set<NodeJS.Timeout>();
  let code: { value: string; expires: number; failures: number } | null = null;
  let port = 0;

  const register = registerProject;
  if (opts.root) register(opts.root);

  const projectFor = (id: string | null): { entry: Registered; p: Project } => {
    const reg = loadRegistry();
    const entry = id ? reg.find((r) => r.id === id) : reg[0];
    if (!entry) throw new HttpError(404, 'No such project');
    if (!existsSync(entry.root)) throw new HttpError(409, `Project folder is missing: ${entry.root}. It may have been moved; attach it at its new path.`);
    let p = projects.get(entry.id);
    if (!p) { p = new Project(entry.root); projects.set(entry.id, p); }
    return { entry, p };
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<any> => {
    if (bodies.has(req)) return bodies.get(req);
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
      chunks.push(c as Buffer);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bodies.set(req, parsed);
      return parsed;
    } catch { throw new HttpError(400, 'Invalid JSON'); }
  };

  const sessionOf = (req: IncomingMessage): [string, Session] | null => {
    // A cross-origin page holds its token in memory, because a strict cookie is correctly never sent to it.
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
    const m = bearer ?? /(?:^|;\s*)bl_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
    if (!m) return null;
    const key = hash(m[1]!);
    const s = sessions.get(key);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(key); return null; }
    // A token from an outside page works only from that page's origin.
    if (s.origin && req.headers.origin !== s.origin) return null;
    return [key, s];
  };

  /**
   * Knowing the port grants nothing. Host stops DNS rebinding, Origin and Sec-Fetch-Site stop other sites, the cookie
   * proves pairing, and the CSRF header proves same-origin script. A human action also needs a fresh challenge.
   */
  const guard = (req: IncomingMessage) => {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Bad Host header');
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) return;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, 'Bad Origin');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
  };

  /** An outside origin, even a compromised one, must not be able to act alone: the code goes to the terminal, tied to this exact request. */
  const requireTerminalProof = (req: IncomingMessage, path: string, key: string, body: any, projectId: string | null) => {
    const { challengeId, confirm, passphrase: _pw, ...rest } = body ?? {};
    // A save is shown by path and content hash, so the code is bound to the exact text without needing to print all of it.
    if (typeof rest.content === 'string') rest.content = `[${Buffer.byteLength(rest.content, 'utf8')} bytes, sha256 ${hashText(rest.content)}]`;
    // The page controls key order and can pad a request, so what is shown is sorted, complete and bounded.
    const sorted = JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))), null, 1);
    if (sorted.length > MAX_SHOWN_REQUEST) throw new HttpError(413, 'This request is too long to show in full in your terminal. Use the local address.');
    const project = loadRegistry().find((r) => r.id === projectId) ?? loadRegistry()[0];
    const bodyKey = hash(`${path} ${projectId ?? ''} ${sorted}`);
    for (const [id, x] of challenges) if (x.expires < Date.now() || (x.session === key && x.bodyKey && id !== challengeId)) challenges.delete(id);
    const c = challenges.get(challengeId ?? '');
    if (!c) {
      if (!opts.onTerminalChallenge) throw new HttpError(403, 'This companion cannot show a confirmation code, so an outside page cannot make changes. Use the local address.');
      const id = randomBytes(8).toString('hex');
      const value = randomBytes(3).toString('hex');
      challenges.set(id, { code: value, expires: Date.now() + 120_000, session: key, bodyKey });
      const action = `${path.replace('/api/', '')} in project ${project?.name ?? '(none)'}: ${sorted}`;
      opts.onTerminalChallenge(value, action);
      throw Object.assign(new HttpError(428, 'Enter the code shown in your terminal'), { extra: { challengeId: id, action } });
    }
    challenges.delete(challengeId);
    if (c.session !== key || c.bodyKey !== bodyKey || c.expires < Date.now() || !safeEq(c.code, String(confirm ?? ''))) {
      const s = sessions.get(key);
      if (s) {
        s.terminalFailures = (s.terminalFailures ?? 0) + 1;
        if (s.terminalFailures >= MAX_TERMINAL_FAILURES) sessions.delete(key);
      }
      throw new HttpError(403, 'That terminal code is wrong, expired or for a different request');
    }
    proved.add(req);
  };

  const requireHumanProof = (req: IncomingMessage, key: string, body: any, p: Project, action: string) => {
    if (!proved.has(req)) {
      const c = challenges.get(body.challengeId ?? '');
      challenges.delete(body.challengeId ?? '');
      if (!c || c.session !== key || c.expires < Date.now() || !safeEq(c.code, String(body.confirm ?? ''))) throw new HttpError(403, `Confirmation code is wrong or expired for: ${action}`);
    }
    if (p.approverEnrolled()) {
      // The page could read whatever is typed into it, so the passphrase stays off outside origins.
      if (sessions.get(key)?.origin || sessions.get(key)?.surface) throw new HttpError(409, 'This project has an approver passphrase, which must not be typed into a website or an editor extension. Use the local dashboard address, or the command line.');
      try { p.unlock(String(body.passphrase ?? '')); } catch (err) { throw new HttpError(403, (err as Error).message); }
    }
    return { method: p.approverEnrolled() ? 'dashboard+passphrase' : 'dashboard' };
  };

  const finishRun = (run: Run, p: Project, result: any, exitCode: number | null) => {
    const wallClockMs = Date.now() - run.started;
    run.status = exitCode === 0 ? 'finished' : run.status === 'stopped' ? 'stopped' : 'failed';
    if (result?.modelUsage) {
      for (const [model, u] of Object.entries<any>(result.modelUsage)) {
        p.recordUsage({
          runtime: 'claude-code', model, source: 'provider-reported', sessionId: result.session_id, runId: run.id, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadInputTokens ?? 0, cacheCreationTokens: u.cacheCreationInputTokens ?? 0, costUsd: u.costUSD, costBasis: u.costBasis ?? 'unknown', durationMs: result.duration_ms,
        });
      }
    }
    p.store.append({ type: 'run.finished', actor: { kind: 'system', runtime: 'claude-code' }, payload: { id: run.id, status: run.status, exitCode, wallClockMs, durationApiMs: result?.duration_api_ms ?? null, totalCostUsd: result?.total_cost_usd ?? null, numTurns: result?.num_turns ?? null, sessionId: result?.session_id ?? null, resultText: typeof result?.result === 'string' ? result.result.slice(0, 2000) : null } });
  };

  const startRun = (entry: Registered, p: Project, input: z.infer<typeof RunInput>): Run => {
    if (input.runtime !== 'claude-code') throw new HttpError(409, `Starting ${input.runtime} from the dashboard is not built yet. Run it yourself: its hooks still report here.`);
    if (!hooksInstalled('claude-code', entry.root)) throw new HttpError(409, 'Connect Claude Code to this project first, so its hooks are in place');
    const [cmd, ...pre] = opts.claudeCommand ?? ['claude'];
    const args = [...pre, '-p', input.prompt, '--model', input.model, '--max-budget-usd', String(input.maxBudgetUsd), '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Write,Edit,Read,Grep,Glob', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local'];
    const child = spawn(cmd!, args, { cwd: entry.root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const run: Run = { id: `run_${randomBytes(5).toString('hex')}`, project: entry.id, child, started: Date.now(), events: [], status: 'running' };
    runs.set(run.id, run);
    p.store.append({ type: 'run.started', actor: { kind: 'human' }, payload: { id: run.id, runtime: input.runtime, model: input.model, maxBudgetUsd: input.maxBudgetUsd, promptSha256: hash(input.prompt) } });
    let buf = '';
    let result: any = null;
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const o = JSON.parse(line);
          if (o.type === 'result') result = o;
          const content = o.message?.content;
          const summary = o.type === 'assistant' && Array.isArray(content) ? content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[tool ${c.name}]` : '')).filter(Boolean).join(' ').slice(0, 400) : o.type === 'result' ? `result: ${o.subtype}` : '';
          if (summary) run.events.push(summary);
        } catch { /* a non-JSON line is not an event */ }
      }
    });
    child.stderr!.resume();
    child.on('error', (err) => { run.events.push(`Could not start the agent: ${err.message}`); run.status = 'failed'; });
    child.on('close', (exit) => { try { finishRun(run, p, result, exit); } catch { /* project closed during shutdown */ } });
    return run;
  };

  /** Turns a workspace failure into an HTTP answer with its own status, and its data, such as the current hash after a conflict. */
  const workspace = <T,>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (err instanceof WorkspaceError) throw Object.assign(new HttpError(err.status, err.message), { extra: err.data ?? {} });
      throw err;
    }
  };

  const eventView = (e: any) => {
    const { hash: _h, prevHash: _p, ...rest } = e;
    return rest;
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true, paired: !!sessionOf(req) });
    if (path === '/api/pair' && method === 'POST') {
      const body = await readBody(req);
      if (!code || code.expires < Date.now()) throw new HttpError(403, 'No pairing code is active. Generate one in the terminal running `agentontrack dashboard`.');
      if (!safeEq(code.value, String(body.code ?? '').trim().toUpperCase())) {
        code.failures++;
        if (code.failures >= MAX_PAIR_FAILURES) code = null;
        throw new HttpError(403, 'Wrong pairing code');
      }
      code = null;
      // The token is created here, after proof of the code. Any value the client held before pairing is ignored.
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      const now = Date.now();
      const remote = req.headers.origin && allowed.has(req.headers.origin) ? req.headers.origin : undefined;
      // An editor extension runs code the user did not write. It says what it is, gets a bearer token and no cookie, and then, like an outside page,
      // cannot confirm its own requests: the code goes to the terminal.
      const editor = !remote && !req.headers.origin && req.headers['x-agentontrack-surface'] === 'editor';
      sessions.set(hash(token), { tokenHash: hash(token), csrf, createdAt: now, expiresAt: now + (remote || editor ? REMOTE_SESSION_TTL_MS : SESSION_TTL_MS), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 120), ...(remote ? { origin: remote } : {}), ...(editor ? { surface: 'editor' as const } : {}) });
      if (remote || editor) return json(res, 200, { csrf, token });
      return json(res, 200, { csrf }, { 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    }
    const sess = sessionOf(req);
    if (!sess) throw new HttpError(401, 'Not paired');
    const [key, session] = sess;
    if (path === '/api/session' && method === 'GET') return json(res, 200, { csrf: session.csrf, expiresAt: session.expiresAt });
    if (method !== 'GET' && !safeEq(String(req.headers['x-agentontrack-csrf'] ?? ''), session.csrf)) throw new HttpError(403, 'Missing CSRF token');

    if ((session.origin || session.surface) && method === 'POST' && !REMOTE_FREE.has(path)) requireTerminalProof(req, path, key, await readBody(req), url.searchParams.get('project'));
    const projectId = url.searchParams.get('project');

    if (path === '/api/events/stream' && method === 'GET') {
      const { p } = projectFor(projectId);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      let last = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? p.store.head()?.seq ?? 0);
      let timer: NodeJS.Timeout | undefined;
      const send = () => {
        try {
          if (!sessions.has(key)) throw new Error('session ended');
          for (const e of p.store.since(last)) {
            res.write(`id: ${e.seq}\ndata: ${JSON.stringify(eventView(e))}\n\n`);
            last = e.seq;
          }
          res.write(': ping\n\n');
        } catch {
          // Session ended, or the project was deleted or closed. End this stream; the browser reconnects if it still can.
          clearInterval(timer);
          res.end();
        }
      };
      send();
      timer = setInterval(send, 700);
      streams.add(timer);
      req.on('close', () => { clearInterval(timer); streams.delete(timer!); });
      return;
    }
    if (path === '/api/challenge' && method === 'POST') {
      const { p } = projectFor(projectId);
      // An outside page never sees a code: the request itself is answered with a prompt, and the code goes to the terminal.
      if (session.origin || session.surface) return json(res, 200, { challengeId: '', code: null, inTerminal: true, needsPassphrase: p.approverEnrolled() });
      const id = randomBytes(8).toString('hex');
      const value = randomBytes(2).toString('hex');
      challenges.set(id, { code: value, expires: Date.now() + 120_000, session: key });
      return json(res, 200, { challengeId: id, code: value, needsPassphrase: p.approverEnrolled() });
    }
    if (path === '/api/projects' && method === 'GET') {
      return json(res, 200, loadRegistry().map((r) => {
        const missing = !existsSync(r.root);
        if (missing) return { ...r, missing };
        const { p } = projectFor(r.id);
        const s = p.state();
        const t = s.activeTaskId ? s.tasks.get(s.activeTaskId) : null;
        return { ...r, missing, goal: s.goal?.statement ?? null, goalVersion: s.goal?.version ?? null, activeTask: t ? { id: t.id, title: t.title, status: p.evaluate(t.id).status } : null, pendingApprovals: [...s.approvals.values()].filter((a) => isPendingLive(a, new Date())).length };
      }));
    }
    if (path === '/api/projects' && method === 'POST') {
      const body = z.object({ path: z.string().min(1).max(1000), create: z.boolean().default(false), gitInit: z.boolean().default(false) }).parse(await readBody(req));
      if (!isAbsolute(body.path)) throw new HttpError(400, 'Use an absolute path');
      // A project is a folder of its own: never a drive root, a home folder, or anywhere inside AgentOnTrack's own data.
      const target = resolve(body.path);
      const home = resolve(agentontrackHome());
      if (dirname(target) === target || target === resolve(homedir()) || target === home || target.startsWith(home + sep)) throw new HttpError(400, 'Choose a folder made for this project, not a drive root, your home folder or AgentOnTrack\'s own data folder');
      if (body.create) mkdirSync(body.path, { recursive: true });
      if (!existsSync(body.path) || !statSync(body.path).isDirectory()) throw new HttpError(400, 'That folder does not exist');
      if (body.gitInit && existsSync(body.path) && !existsSync(join(body.path, '.git'))) {
        const g = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: body.path, encoding: 'utf8', timeout: 30_000 });
        if (g.status !== 0) throw new HttpError(409, `git init failed: ${(g.stderr || g.error?.message || '').slice(0, 200)}`);
      }
      return json(res, 200, register(body.path));
    }
    if (path === '/api/projects/update' && method === 'POST') {
      const body = z.object({ id: z.string().min(1), name: z.string().min(1).max(120).optional(), archived: z.boolean().optional() }).parse(await readBody(req));
      try { return json(res, 200, updateRegistered(body.id, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) })); } catch (err) { throw new HttpError(404, (err as Error).message); }
    }
    if (path === '/api/agents' && method === 'GET') {
      const { entry } = projectFor(projectId);
      const claudeV = detectVersion('claude');
      const codexV = detectVersion('codex');
      const hermesV = detectVersion('hermes');
      const claude = claudeV ? claudeAuth() : { authenticated: false, method: null, subscription: null };
      return json(res, 200, [
        { id: 'claude-code', name: 'Claude Code', version: claudeV, installed: !!claudeV, ...claude, hooksInstalled: hooksInstalled('claude-code', entry.root), coverage: coverageFor('claude-code'), liveStatus: claudeV ? 'see-evidence' : 'BLOCKED' },
        { id: 'codex', name: 'Codex', version: codexV, installed: !!codexV, authenticated: null, hooksInstalled: hooksInstalled('codex', entry.root), coverage: coverageFor('codex'), liveStatus: codexV ? 'Installed here. Connect to use it' : 'Not installed on this machine' },
        { id: 'hermes', name: 'Hermes', version: hermesV, installed: !!hermesV, authenticated: null, hooksInstalled: false, coverage: coverageFor('hermes'), liveStatus: hermesV ? 'Installed here. Add its hook config to use it' : 'Not installed on this machine' },
      ]);
    }
    if (path === '/api/providers' && method === 'GET') {
      const { entry } = projectFor(projectId);
      return json(res, 200, Object.values(PROVIDERS).map((a) => { const version = detectVersionArgs(a.bin, a.versionArgs); return { id: a.id, name: a.name, kind: a.kind, surfaces: a.surfaces, version, installed: !!version, hooksInstalled: providerInstalled(a, entry.root), failure: a.failure, limitations: a.limitations, connect: `agentontrack install ${a.id}` }; }));
    }
    const agentAction = /^\/api\/agents\/(claude-code|codex)\/(connect|disconnect)$/.exec(path);
    if (agentAction && method === 'POST') {
      const { entry } = projectFor(projectId);
      const runtime = agentAction[1] as 'claude-code' | 'codex';
      if (agentAction[2] === 'connect') {
        const cli = resolve(here, '..', '..', 'cli', 'dist', 'index.js').replace(/\\/g, '/');
        const r = installHooks(runtime, entry.root, opts.selfCommand ?? `"${process.execPath.replace(/\\/g, '/')}" "${cli}"`);
        return json(res, 200, { connected: true, path: r.path, note: runtime === 'codex' ? 'Codex skips a hook until you trust it with /hooks.' : undefined });
      }
      uninstallHooks(runtime, entry.root);
      return json(res, 200, { connected: false });
    }
    if (path === '/api/probe' && method === 'POST') {
      const body = z.object({ baseUrl: z.string().url(), model: z.string().optional() }).parse(await readBody(req));
      return json(res, 200, await probeLocalModel(body.baseUrl, body.model));
    }

    const { entry, p } = projectFor(projectId);
    const s = () => p.state();

    if (path === '/api/state' && method === 'GET') {
      const st = s();
      const now = new Date();
      const task = st.activeTaskId ? st.tasks.get(st.activeTaskId) : null;
      return json(res, 200, {
        project: entry, goal: st.goal, goals: st.goals, policy: st.policy, policyVersion: st.policyVersion, proposals: st.proposals, decisions: st.decisions,
        activeTask: task ? { ...task, evaluation: p.evaluate(task.id), findings: p.verificationFindings(task.id) } : null,
        tasks: [...st.tasks.values()].map((t) => ({ id: t.id, title: t.title, closed: t.closed ?? null, criteria: t.criteria, limits: t.limits, createdAt: t.createdAt, evaluation: p.evaluate(t.id) })),
        approvals: [...st.approvals.values()].filter((a) => !a.id.endsWith('_portable')).map((a) => ({ ...a, view: approvalView(a, now) })).reverse(),
        receipts: [...st.receipts].reverse().slice(0, 200), claims: st.claims.slice(-50).reverse(), mismatches: [...st.mismatches].reverse(), rejectedEvents: st.rejectedEvents,
        team: st.team, integrity: p.verifyIntegrity(), approverEnrolled: p.approverEnrolled(), head: p.store.head()?.seq ?? 0,
      });
    }
    if (path === '/api/revision' && method === 'GET') {
      const st = s();
      return json(res, 200, { head: p.store.head()?.seq ?? 0, hash: p.store.head()?.hash ?? null, goalVersion: st.goal?.version ?? null, policyVersion: st.policyVersion, activeTaskId: st.activeTaskId });
    }
    if (path === '/api/events' && method === 'GET') {
      const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
      const all = p.store.since(since);
      return json(res, 200, { head: p.store.head()?.seq ?? 0, events: all.slice(0, limit).map(eventView), more: all.length > limit });
    }
    if (path === '/api/team' && method === 'GET') return json(res, 200, s().team);
    if (path === '/api/workflow' && method === 'GET') {
      const kind = z.enum(['implement-review-verify', 'parallel-then-compare', 'review-only', 'spec-review']).parse(url.searchParams.get('kind') ?? 'implement-review-verify');
      return json(res, 200, planWorkflow(s().team.members as any, kind));
    }
    if (path === '/api/worktrees' && method === 'GET') return json(res, 200, { worktrees: p.worktrees().map((w) => (w.status === 'active' ? p.worktreeStatus(w.id) : w)), conflicts: p.detectConflicts() });
    if (path === '/api/worktrees/preview' && method === 'GET') return json(res, 200, p.mergePreview(url.searchParams.get('id') ?? ''));
    if (path === '/api/worktrees' && method === 'POST') {
      const b = z.object({ taskId: z.string().min(1), agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/) }).parse(await readBody(req));
      try { return json(res, 200, p.createWorktree(b.taskId, b.agent)); } catch (err) { throw new HttpError(409, (err as Error).message); }
    }
    if (path === '/api/worktrees/commit' && method === 'POST') {
      const b = z.object({ id: z.string(), message: z.string().min(1).max(200).default('Work recorded by AgentOnTrack') }).parse(await readBody(req));
      try { return json(res, 200, p.commitWorktree(b.id, b.message)); } catch (err) { throw new HttpError(409, (err as Error).message); }
    }
    if (path === '/api/handoffs' && method === 'GET') return json(res, 200, listHandoffs(p));
    if (path === '/api/handoffs/markdown' && method === 'GET') {
      try { return json(res, 200, { markdown: renderHandoffMarkdown(loadHandoff(p, url.searchParams.get('id') ?? '')) }); } catch (err) { throw new HttpError(404, (err as Error).message); }
    }
    if (path === '/api/worktrees/diff' && method === 'GET') return json(res, 200, workspace(() => { try { return p.worktreeFileDiff(url.searchParams.get('id') ?? '', url.searchParams.get('path') ?? ''); } catch (err) { if (err instanceof WorkspaceError) throw err; throw new HttpError(404, (err as Error).message); } }));
    if (path === '/api/handoffs/get' && method === 'GET') {
      try { const h = loadHandoff(p, url.searchParams.get('id') ?? ''); return json(res, 200, { handoff: h, problems: validateHandoff(p, h) }); } catch (err) { throw new HttpError(404, (err as Error).message); }
    }
    if (path === '/api/handoffs' && method === 'POST') {
      const b = z.object({ from: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/), to: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/).optional(), taskId: z.string().optional(), reason: z.enum(['planned', 'unavailable', 'limit', 'interrupted', 'review']).default('planned'), detail: z.string().max(300).optional(), writeMarkdown: z.boolean().default(false) }).parse(await readBody(req));
      const limits = b.to ? (() => { const f = runtimeFacts(b.to); return [!f.known ? 'AgentOnTrack has no adapter for this runtime.' : '', f.hostFailMode === 'open' ? 'If its hook cannot run, the host runs the action anyway.' : '', f.known && !f.enforcesEdit ? 'It does not gate file edits.' : ''].filter(Boolean); })() : [];
      try {
        const h = buildHandoff(p, { from: b.from, ...(b.to ? { to: b.to } : {}), ...(b.taskId ? { taskId: b.taskId } : {}), reason: { kind: b.reason, ...(b.detail ? { detail: b.detail } : {}) }, limits });
        const out = saveHandoff(p, h, { writeMarkdown: b.writeMarkdown });
        return json(res, 200, { id: h.id, contentSha256: h.contentSha256, wroteMarkdown: !!out.markdown, problems: validateHandoff(p, h) });
      } catch (err) { throw new HttpError(409, (err as Error).message); }
    }
    if (path === '/api/handoffs/accept' && method === 'POST') {
      const b = z.object({ id: z.string(), to: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/) }).parse(await readBody(req));
      try { return json(res, 200, acceptHandoff2(p, loadHandoff(p, b.id), b.to)); } catch (err) { throw new HttpError(404, (err as Error).message); }
    }
    if (path === '/api/failover' && method === 'GET') {
      const from = url.searchParams.get('from') ?? '';
      const installed = (url.searchParams.get('installed') ?? ['claude-code', 'codex', 'hermes', ...Object.keys(PROVIDERS)].filter((id) => { const a = (PROVIDERS as any)[id]; return !!detectVersionArgs(id === 'claude-code' ? 'claude' : a?.bin ?? id, a?.versionArgs ?? ['--version']); }).join(',')).split(',').filter(Boolean);
      return json(res, 200, { from: runtimeFacts(from), options: failoverOptions(from, installed) });
    }
    if (path === '/api/files' && method === 'GET') return json(res, 200, workspace(() => listDir(entry.root, url.searchParams.get('dir') ?? '')));
    if (path === '/api/file' && method === 'GET') return json(res, 200, workspace(() => p.readWorkspaceFile(url.searchParams.get('path') ?? '')));
    if (path === '/api/file' && method === 'POST') {
      const b = z.object({ path: z.string().min(1).max(1000), content: z.string(), baseHash: z.string().nullable() }).parse(await readBody(req));
      return json(res, 200, workspace(() => {
        if (p.isProtectedPath(b.path.replace(/\\/g, '/'))) throw new WorkspaceError(403, 'This is a protected file: goals, safety and instruction files, and agent hooks change only through the confirmation path. Use Save protected file.');
        return p.saveWorkspaceFile(b.path, b.content, b.baseHash, 'workspace');
      }));
    }
    if (path === '/api/spec/check' && method === 'GET') return json(res, 200, workspace(() => checkSpec(p.readWorkspaceFile(url.searchParams.get('path') ?? '').content, entry.root)));
    if (path === '/api/analytics' && method === 'GET') return json(res, 200, computeAnalytics(p));
    if (path === '/api/actions' && method === 'GET') {
      return json(res, 200, p.store.byType(['action.requested', 'action.observed', 'effect.mismatch', 'effect.reverted', 'workspace.drift'], 200).reverse().map(eventView));
    }
    const ev = /^\/api\/event\/(\d+)$/.exec(path);
    if (ev && method === 'GET') {
      const e = p.store.eventAt(Number(ev[1]));
      if (!e) throw new HttpError(404, 'No such event');
      return json(res, 200, e);
    }
    if (path === '/api/evaluations' && method === 'GET') {
      const read = (f: string) => { try { return JSON.parse(readFileSync(join(benchmarksDir, f), 'utf8')); } catch { return null; } };
      return json(res, 200, { heldout: read('heldout.json'), dev: read('dev.json'), live: read('live-claude-code.json'), matched: read('matched-v4.json') ?? read('matched-v3.json'), matchedHistory: read('matched-v2.json') ? 'v2 is superseded: it had a broken fixture and a goal-text confound' : null, securityCampaign: read('security-campaign.json'), performance: read('performance.json') });
    }

    if (path === '/api/runs' && method === 'GET') return json(res, 200, [...runs.values()].filter((r) => r.project === entry.id).map(({ id, status, started, events }) => ({ id, status, started, events: events.slice(-40) })));
    if (path === '/api/runs' && method === 'POST') {
      const run = startRun(entry, p, RunInput.parse(await readBody(req)));
      return json(res, 200, { id: run.id, status: run.status });
    }
    const stop = /^\/api\/runs\/(run_\w+)\/stop$/.exec(path);
    if (stop && method === 'POST') {
      const run = runs.get(stop[1]!);
      if (!run || run.project !== entry.id) throw new HttpError(404, 'No such run');
      run.status = 'stopped';
      run.child.kill();
      return json(res, 200, { status: 'stopped' });
    }

    if (path === '/api/verify' && method === 'POST') {
      const body = z.object({ taskId: z.string() }).parse(await readBody(req));
      return json(res, 200, p.verifyTask(body.taskId));
    }

    const humanOps: Record<string, { schema: z.ZodType<any>; action: (b: any) => string; run: (b: any, ctx: { method: string }) => unknown }> = {
      '/api/approvals/approve': { schema: z.object({ id: z.string(), ttlMinutes: z.number().positive().max(1440).default(60), uses: z.number().int().positive().max(20).default(1), portable: z.boolean().default(false), challengeId: z.string(), ...HumanFields }), action: (b) => `approve ${b.id}`, run: (b, ctx) => p.human.approve(b.id, { uses: b.uses, ttlMs: b.ttlMinutes * 60_000, portable: b.portable, ctx }) },
      '/api/approvals/deny': { schema: z.object({ id: z.string(), note: z.string().max(500).default(''), challengeId: z.string(), ...HumanFields }), action: (b) => `deny ${b.id}`, run: (b, ctx) => p.human.deny(b.id, b.note, ctx) },
      '/api/approvals/revoke': { schema: z.object({ id: z.string(), challengeId: z.string(), ...HumanFields }), action: (b) => `revoke ${b.id}`, run: (b) => p.human.revoke(b.id) },
      '/api/goal': { schema: z.object({ goal: z.unknown(), expectGoalVersion: z.number().int().nullable().optional(), challengeId: z.string(), ...HumanFields }), action: () => 'change the goal', run: (b) => {
        // A window that was showing an older goal must not replace a newer one.
        if (b.expectGoalVersion !== undefined && (s().goal?.version ?? null) !== b.expectGoalVersion) throw new Error(`The goal is at version ${s().goal?.version ?? 'none'}, not ${b.expectGoalVersion}. Reload and review it first.`);
        return p.human.setGoal(b.goal);
      } },
      '/api/team': { schema: z.object({ members: z.array(z.unknown()), expectVersion: z.number().int().optional(), challengeId: z.string(), ...HumanFields }), action: () => 'set the agent team', run: (b) => { p.human.setTeam(b.members, b.expectVersion); return s().team; } },
      '/api/worktrees/merge': { schema: z.object({ id: z.string(), challengeId: z.string(), ...HumanFields }), action: (b) => `merge worktree ${b.id} into the project`, run: (b) => p.mergeWorktree(b.id) },
      '/api/worktrees/discard': { schema: z.object({ id: z.string(), challengeId: z.string(), ...HumanFields }), action: (b) => `discard worktree ${b.id}`, run: (b) => { p.discardWorktree(b.id); return { discarded: true }; } },
      '/api/handoffs/accept-stale': { schema: z.object({ id: z.string(), to: z.string().regex(/^[a-z0-9][a-z0-9-]{1,29}$/), challengeId: z.string(), ...HumanFields }), action: (b) => `accept handoff ${b.id} for ${b.to}, knowing it is stale`, run: (b) => acceptHandoff2(p, loadHandoff(p, b.id), b.to, { acknowledge: true }) },
      '/api/file/protected': { schema: z.object({ path: z.string().min(1).max(1000), content: z.string(), baseHash: z.string().nullable(), challengeId: z.string(), ...HumanFields }), action: (b) => `save protected file ${b.path}`, run: (b) => workspace(() => p.saveWorkspaceFile(b.path, b.content, b.baseHash, 'workspace-protected')) },
      '/api/goal/close': { schema: z.object({ outcome: z.enum(['completed', 'abandoned']), challengeId: z.string(), ...HumanFields }), action: () => 'close the goal', run: (b) => p.human.closeGoal(b.outcome) },
      '/api/goal/reopen': { schema: z.object({ challengeId: z.string(), ...HumanFields }), action: () => 'reopen the goal', run: () => p.human.reopenGoal() },
      '/api/proposals/accept': { schema: z.object({ id: z.string(), challengeId: z.string(), ...HumanFields }), action: (b) => `accept ${b.id}`, run: (b) => p.human.acceptProposal(b.id) },
      '/api/proposals/reject': { schema: z.object({ id: z.string(), note: z.string().max(500).default(''), challengeId: z.string(), ...HumanFields }), action: (b) => `reject ${b.id}`, run: (b) => p.human.rejectProposal(b.id, b.note) },
      '/api/policy/profile': { schema: z.object({ profile: z.enum(['standard', 'strict']), challengeId: z.string(), ...HumanFields }), action: (b) => `switch policy to ${b.profile}`, run: (b) => p.human.setProfile(b.profile) },
      '/api/tasks': { schema: TaskInput.extend({ challengeId: z.string(), ...HumanFields }), action: () => 'create a task', run: (b) => ({ id: p.human.createTask({ title: b.title, criteria: b.criteria, limits: b.limits }) }) },
      '/api/tasks/activate': { schema: z.object({ id: z.string(), challengeId: z.string(), ...HumanFields }), action: (b) => `activate ${b.id}`, run: (b) => p.human.activateTask(b.id) },
      '/api/tasks/close': { schema: z.object({ id: z.string(), outcome: z.string().max(100).default('closed'), challengeId: z.string(), ...HumanFields }), action: (b) => `close ${b.id}`, run: (b) => p.human.closeTask(b.id, b.outcome) },
      '/api/verification/accept-weak': { schema: z.object({ taskId: z.string(), note: z.string().max(500).default(''), challengeId: z.string(), ...HumanFields }), action: (b) => `accept weak checks on ${b.taskId}`, run: (b) => ({ accepted: p.human.acceptWeakChecks(b.taskId, b.note) }) },
      '/api/mismatch/ack': { schema: z.object({ seq: z.number().int(), note: z.string().max(500).default(''), challengeId: z.string(), ...HumanFields }), action: (b) => `acknowledge ${b.seq}`, run: (b) => p.human.acknowledgeMismatch(b.seq, b.note) },
      '/api/verification/accept': { schema: z.object({ taskId: z.string(), note: z.string().max(500).default(''), challengeId: z.string(), ...HumanFields }), action: (b) => `accept test changes on ${b.taskId}`, run: (b) => p.human.acceptVerificationChanges(b.taskId, b.note) },
      '/api/data/delete': { schema: z.object({ challengeId: z.string(), ...HumanFields }), action: () => 'delete this project record', run: () => {
        p.close();
        projects.delete(entry.id);
        rmSync(stateDirFor(entry.root), { recursive: true, force: true, maxRetries: 3 });
        rmSync(p.witness.path, { force: true });
        saveRegistry(loadRegistry().filter((r) => r.id !== entry.id));
        return { deleted: true };
      } },
    };
    const op = humanOps[path];
    if (op && method === 'POST') {
      const body = op.schema.parse(await readBody(req));
      const ctx = requireHumanProof(req, key, body, p, op.action(body));
      try {
        return json(res, 200, op.run(body, ctx) ?? { ok: true });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, (err as Error).message);
      } finally {
        if (path !== '/api/data/delete') p.lock();
      }
    }

    if (path === '/api/settings' && method === 'GET') {
      const st = loadSettings();
      return json(res, 200, { ...st, sessions: [...sessions.entries()].map(([k, v]) => ({ id: k.slice(0, 8), current: k === key, createdAt: v.createdAt, expiresAt: v.expiresAt, userAgent: v.userAgent })) });
    }
    if (path === '/api/settings' && method === 'POST') {
      const body = z.object({ telemetry: z.boolean().optional(), diagnostics: z.boolean().optional(), theme: z.enum(['dark', 'light']).optional(), environment: z.object({ show: z.boolean(), userGridGCo2PerKwh: z.number().nonnegative().nullable() }).optional() }).parse(await readBody(req));
      saveSettings({ ...loadSettings(), ...body } as Settings);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/data/export' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="agentontrack-${entry.id}.json"`, 'cache-control': 'no-store' });
      res.end(JSON.stringify({ exportedAt: new Date().toISOString(), project: entry, events: p.store.all() }));
      return;
    }
    if (path === '/api/feedback' && method === 'POST') {
      const body = z.object({ rating: z.enum(['helpful', 'not-helpful']).nullable(), text: z.string().max(4000).default(''), contact: z.string().max(200).default(''), mayQuote: z.boolean().default(false) }).parse(await readBody(req));
      const file = join(agentontrackHome(), 'feedback.jsonl');
      writeFileSync(file, `${JSON.stringify({ ...body, at: new Date().toISOString() })}\n`, { flag: 'a' });
      return json(res, 200, { savedLocally: true, sent: false, note: 'Saved on this machine only. Nothing was sent anywhere.' });
    }
    if (path === '/api/unpair' && method === 'POST') {
      sessions.delete(key);
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (path === '/api/sessions/revoke' && method === 'POST') {
      const body = z.object({ id: z.string().min(8) }).parse(await readBody(req));
      for (const k of sessions.keys()) if (k.startsWith(body.id)) sessions.delete(k);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };

  const serveStatic = (res: ServerResponse, pathname: string) => {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = resolve(uiDir, rel);
    if (relative(uiDir, file).startsWith('..') || isAbsolute(relative(uiDir, file))) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(uiDir, 'index.html');
    if (!existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Dashboard UI is not built. Run pnpm build.'); return; }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'cache-control': 'no-cache',
    });
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    (async () => {
      guard(req);
      const origin = req.headers.origin;
      if (origin && allowed.has(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type, x-agentontrack-csrf', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600' });
          res.end();
          return;
        }
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) await route(req, res, url);
      else if (req.method === 'GET') serveStatic(res, url.pathname);
      else throw new HttpError(405, 'Method not allowed');
    })().catch((err) => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof z.ZodError) return json(res, 400, { error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      const status = err instanceof HttpError ? err.status : 500;
      return json(res, status, { error: err instanceof HttpError ? err.message : 'Internal error', ...err?.extra });
    });
  });

  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(opts.port ?? 0, '127.0.0.1', ok); });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    server,
    newPairingCode() {
      // Unambiguous alphabet; 8 chars with a 5-try limit and a 5-minute life.
      const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const value = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
      code = { value, expires: Date.now() + CODE_TTL_MS, failures: 0 };
      return value;
    },
    async close() {
      for (const r of runs.values()) { if (r.status === 'running') r.child.kill(); }
      for (const t of streams) clearInterval(t);
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      for (const p of projects.values()) { try { p.close(); } catch { /* already closed */ } }
    },
  };
}
