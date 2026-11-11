import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, hostname } from 'node:os';
import { basename, dirname, extname, relative, sep, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failoverOptions, runtimeFacts, coverageFor, PROVIDERS, providerInstalled, hooksInstalled, hookSelfTest, agentEnv, killTree, apiKeyVarsPresent, classifyClaudeMethod, classifyCodexStatus, mayStartUnder, type AuthMode, buildCodexExecArgs, mirrorHooksToWorktree, CodexAppServer, mapCodexTool, parseCodexLine, LineSplitter, codexUsageRecord, installHooks, probeLocalModel, uninstallHooks, discoverModels, describeAgents, type InitReport, type Seen } from '@agentontrack/adapters';
import { isProviderSessionId, newSessionId, projectSessions, searchSessions, type SessionView } from '@agentontrack/core';
import { planFacts as planFactsOf, planView as planViewOf } from './plan-view.js';
import { makeExecutor, snapshotOf, stillTheSameFolder } from './remote-actions.js';
import { terminate, type Killable } from './terminate.js';
import { IdempotencyStore } from './idempotency.js';
import { loadRemote, newRemoteFile, Refusal, saveRemote, type RemoteFile } from './remote-host.js';
import { RemoteService } from './remote-service.js';
import { fingerprint as fingerprintOf } from '@agentontrack/remote';
import { FirestoreTransport, type Emulators, type FirebaseConfig } from './remote-transport.js';
import { loadEnvFile, findEnvFile, askRecord, saveAttachment, findAttachment, attachmentNote, attachmentDir, AttachmentError, MAX_ATTACHMENT_BYTES, renderHandoffMarkdown, checkSlashCommand, CommandRefused, orchestrate, acceptHandoff2, buildHandoff, listHandoffs, loadHandoff, planWorkflow, checkSpec, decompose, phasePrompt, PhasePlanSchema, planSha, startBlock, saveHandoff, validateHandoff, hashText, listDir, WorkspaceError, updateRegistered, approvalView, agentontrackHome, computeAnalytics, isPendingLive, loadRegistry, Project, registerProject, saveRegistry, stateDirFor, type Registered } from '@agentontrack/core';
import * as z from 'zod/v4';

const SESSION_TTL_MS = 8 * 3_600_000;
const REMOTE_SESSION_TTL_MS = 2 * 3_600_000;
/** Things a paired outside page may do without a terminal code: none of them grants or disables anything. */
const REMOTE_FREE = new Set(['/api/challenge', '/api/unpair', '/api/feedback', '/api/files/revoke', '/api/plan/draft']);
const MAX_TERMINAL_FAILURES = 5;
const MAX_SHOWN_REQUEST = 4000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_PAIR_FAILURES = 5;
const MAX_BODY = 256 * 1024;
const MAX_FEEDBACK_FILE = 1024 * 1024;
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
  /** Same, for Codex. */
  codexCommand?: string[];
  /** `app-server` (default): approvals are answered by AgentOnTrack at the moment Codex asks. `exec`: the older non-interactive mode, gated by hooks only. */
  codexMode?: 'app-server' | 'exec';
  /** Test seams for how long an approval is waited for. */
  codexApprovalWaitMs?: number; codexApprovalPollMs?: number; /** How many times to tell Codex its last command failed, after a turn that ended on a failure. Default 1. */ codexRecoveryTurns?: number;
  /** Off unless the person turns it on. While off, API-key variables are removed from the environment of every agent this companion starts, and an agent signed in with a metered account is not started. */
  allowPaidApi?: boolean;
  /** The e.env to read, or null for none. Default: found automatically (see findEnvFile). */
  envFile?: string | null;
  benchmarksDir?: string;
  /** Exact origins allowed to call the API. Empty by default. They still need a pairing code. */
  allowedOrigins?: string[];
  /** For tests: where the Firebase emulators are, and how often snapshots go out. A real build leaves both unset. */
  remote?: { emulators?: Emulators; snapshotEveryMs?: number; heartbeatEveryMs?: number };
  /** Hook command for this install. Without it, the dev build's own path is used. */
  selfCommand?: string;
  /** Test-only: the sign-in kind this runtime would use. Production reads it from the agent's own status command (never from credentials). */
  detectedAuthMode?: (runtime: string) => AuthMode;
  /** Test-only: how many milliseconds one minute of a run's time limit lasts (60000 in production). */
  minuteMsForTests?: number;
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

interface Session { tokenHash: string; csrf: string; createdAt: number; expiresAt: number; userAgent: string; origin?: string; surface?: 'editor'; terminalFailures?: number; fileGrant?: { project: string; until: number } }
interface Run { limitReached?: boolean; id: string; project: string; child: { kill: () => unknown; pid?: number | undefined }; started: number; events: string[]; status: string; runtime?: string; sessionId?: string; linkedProvider?: string }

/** Ends an agent and the programs it started. A bare kill() leaves those running. */
/** At most this many agent processes run at once across every way of starting one (dashboard, sessions, phone, plan phases, cross-review). */
export const MAX_CONCURRENT_RUNS = 4;
/** The in-memory lines kept per run; older lines are dropped. The project record is separate. */
export const MAX_RUN_EVENT_LINES = 2000;
/** The first line once older lines have been dropped, so a reader knows the output is not complete. */
export const RUN_LINES_DROPPED_MARKER = '[earlier output dropped]';
class RunLines extends Array<string> {
  static override get [Symbol.species]() { return Array; }
  override push(...items: string[]): number {
    const n = super.push(...items);
    if (n > MAX_RUN_EVENT_LINES) {
      const body = this.slice(this[0] === RUN_LINES_DROPPED_MARKER ? 1 : 0);
      this.length = 0;
      super.push(RUN_LINES_DROPPED_MARKER, ...body.slice(body.length - (MAX_RUN_EVENT_LINES - 1)));
    }
    return this.length;
  }
}
export const newRunLines = (): string[] => new RunLines();
/** What the person sees when an agent cannot start or fails: a plain sentence, with no folder paths or token-like strings from the program's own output. */
/** A provider saying a usage, rate or quota limit was reached. Matched on the agent's own error text. */
export const isUsageLimitText = (raw: string): boolean => /usage limit|rate[ -]?limit|limit (?:has been )?reached|reached (?:your|the|its) (?:\w+ )?limit|try again (?:at|in|after)|\b429\b|quota|too many requests/i.test(raw);
export const usageLimitMessage = (agent: string): string => `${agent === 'codex' ? 'Codex' : 'Claude Code'} says its usage limit was reached. Your session and context are kept: resume it later, or start the same task with another connected agent.`;
export function agentFailureText(agent: string, raw: string): string {
  const name = agent === 'codex' ? 'Codex' : 'Claude Code';
  if (isUsageLimitText(raw)) return usageLimitMessage(agent);
  if (/ENOENT|not found|not recognized|cannot find/i.test(raw) && /ENOENT|spawn|command|program/i.test(raw)) return `${name} was not found on this computer. Install it, sign in with its own login command in a terminal, then try again.`;
  if (/log ?in|logged out|not signed|sign in|unauthori[sz]ed|authenticat|expired|invalid api key|\b401\b/i.test(raw)) return `${name} is not signed in, or its sign-in expired. Sign in with its own login command in a terminal, then try again.`;
  return raw.replace(/\s+/g, ' ').replace(/[A-Za-z]:[\\/][^\s'"]*|(?:\/[\w.@-]+){2,}/g, '[path]').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').trim().slice(0, 200);
}
const DRAFT_PER_MINUTE = 20;
const MAX_DRAFT_BYTES = 100 * 1024;
const UNATTENDED_OFF = 'Unattended runs are off, so more than one phase or round in a row is refused: no person would be acting between the runs. Turn them on in Settings, under Unattended runs (it needs the terminal code and gives a limited, expiring grant for this project), or run one phase at a time.';
const CHAIN_AUTH_REFUSAL = 'Chained runs (several phases or rounds in a row with nobody acting between them) are refused for this agent: it would use a subscription sign-in or a sign-in AgentOnTrack cannot identify, and provider permission for unattended subscription automation is unresolved. They are allowed only when the agent is signed in with your own API key and paid API mode is on for this companion. Use your own API key in paid API mode, or start each phase yourself.';
const CROSS_REVIEW_REFUSAL = 'Cross-review runs a builder and then a reviewer with nobody acting in between, so it is off by default. It is allowed only with an unattended-runs grant for this project and an agent signed in with your own API key while paid API mode is on. Compliant paths: use your own API key in paid API mode with a grant, or start the build and then the review yourself as two separate runs (Review this run).';
/** Idempotency-Key on the routes that start an agent: 22 to 64 characters of letters, digits, underscore and hyphen. Entries are kept this long, and no more than this many. */
const START_KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const START_KEY_TTL_MS = 10 * 60_000;
const START_KEY_MAX = 500;

const killChild = (c: { kill: () => unknown; pid?: number | undefined }): void => { killTree(c.pid); c.kill(); };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const settingsPath = () => join(agentontrackHome(), 'settings.json');
/**
 * A person-issued, limited, expiring permission for runs that follow one another with nobody acting between them. Scope is one project.
 * `remainingRuns` is persisted and falls by one for every run a chained sequence starts.
 */
export interface UnattendedGrant { projectId: string; maxRuns: number; remainingRuns: number; maxPhasesPerSequence: number; maxRounds: number; expiresAt: string; createdAt: string }
export const GRANT_DEFAULT_HOURS = 4;
export const GRANT_MAX_HOURS = 24;
export const DEFAULT_SETTINGS = { telemetry: false, diagnostics: false, keepTranscripts: false, unattendedGrant: null as UnattendedGrant | null, allowMobileExecution: false, theme: 'dark', environment: { show: true, userGridGCo2PerKwh: null as number | null } };
type Settings = typeof DEFAULT_SETTINGS;
const loadSettings = (): Settings => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }; } catch { return structuredClone(DEFAULT_SETTINGS); } };
const saveSettings = (s: Settings) => { mkdirSync(dirname(settingsPath()), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); };

const TaskInput = z.object({ title: z.string().min(1).max(300), criteria: z.array(z.unknown()).max(50).default([]), limits: z.unknown().optional() });
/** What the working tree looks like, per changed or untracked file, or null outside a git repository. Used to say what an agent changed. */
function snapshotChanges(root: string): Map<string, string> | null {
  const r = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1 << 24 });
  if (r.status !== 0) return null;
  const m = new Map<string, string>();
  for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
    const f = line.slice(3).replace(/^"|"$/g, '');
    try { const st = statSync(join(root, f)); m.set(f, `${st.size}:${st.mtimeMs}`); } catch { m.set(f, 'gone'); }
  }
  return m;
}
const changedBetween = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f)).sort();

/** The tools and permission mode for a Claude run. Read-only takes the write tools away and stops asking for edits to be accepted; it never adds a tool the standard run does not have. */
const claudeToolArgs = (policy: 'standard' | 'read-only'): string[] => policy === 'read-only'
  ? ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,PowerShell,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch', '--permission-mode', 'default']
  : ['--allowedTools', 'Bash,Write,Edit,Read,Grep,Glob', '--permission-mode', 'acceptEdits'];
const RunInput = z.object({ runtime: z.enum(['claude-code', 'codex', 'hermes']), prompt: z.string().min(1).max(20_000).regex(/^[^-]/, 'A prompt cannot start with a hyphen').refine((s) => !s.includes('\0'), 'A prompt cannot contain a NUL character'), model: z.string().regex(/^\w[\w.:-]{0,79}$/).default('haiku'), maxBudgetUsd: z.number().positive().max(5).default(0.5), /** Provider-independent time limit; the companion stops the run's process tree when it is reached. */ maxMinutes: z.number().int().min(1).max(240).default(30), resumeRunId: z.string().regex(/^run_[a-z0-9]{1,40}$/).optional(), attachments: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(5).default([]), /** Run inside this worktree instead of the project folder. */ worktreeId: z.string().regex(/^wt_[a-z0-9]{1,40}$/).optional(), /** Continue this AgentOnTrack session (it resumes the provider session behind it). */ sessionId: z.string().regex(/^ses_[a-f0-9]{8,32}$/).optional(), /** A title for a NEW session. */ title: z.string().trim().max(120).optional(), /** What the agent may do. A policy can only NARROW the default: it never widens it. */ policy: z.enum(['standard', 'read-only']).default('standard') });
const HumanFields = { confirm: z.string(), passphrase: z.string().optional() };

/** Only github.com over https, as owner/repo with an optional .git. Anything else, such as a local path or another scheme, is refused. */
export function parseGithubUrl(raw: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw.trim());
  return m && m[1] !== '.' && m[1] !== '..' && m[2] !== '.' && m[2] !== '..' ? `https://github.com/${m[1]}/${m[2]}.git` : null;
}

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__', 'venv', 'AppData', 'Library']);
/** Breadth-first, bounded in depth, in folders visited, and in results. A repository is reported and not entered. */
export function discoverRepos(top: string, depth: number, registered: Set<string>): { dir: string; found: { path: string; name: string; registered: boolean }[]; truncated: boolean } {
  const found: { path: string; name: string; registered: boolean }[] = [];
  let visited = 0; let truncated = false;
  let level = [top];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const dir of level) {
      if (++visited > 2000 || found.length >= 200) { truncated = true; break; }
      if (existsSync(join(dir, '.git'))) { found.push({ path: dir, name: basename(dir), registered: registered.has(dir) }); continue; }
      if (d === depth) continue;
      let names: string[] = [];
      try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => e.name); } catch { continue; }
      for (const n of names) next.push(join(dir, n));
    }
    level = next;
  }
  return { dir: top, found: found.sort((a, b) => a.name.localeCompare(b.name)), truncated };
}

/** Runs git without ever waiting for a person: a prompt for credentials is a failure, not a hang. */
function runGit(args: string[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((done) => {
    const child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    const timer = setTimeout(() => { child.kill(); done({ ok: false, message: 'it took longer than 5 minutes' }); }, 300_000);
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, message: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, message: err.trim().split('\n').pop()?.slice(0, 200) ?? 'git failed' }); });
  });
}

function detectVersionArgs(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0]!.slice(0, 80) : null;
}

const seenCache = new Map<string, { at: number; v: string | null; refreshing?: boolean }>();
const PROBE_TTL_MS = 60_000;
/** The same probe without blocking: used to refresh an expired answer while the request is served from the old one. */
function probeAsync(cmd: string, args: string[], timeout: number, pick: (stdout: string, stderr: string) => string | null): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout, shell: process.platform === 'win32', windowsHide: true }, (err, stdout, stderr) => resolve(err ? null : pick(String(stdout), String(stderr))));
  });
}
const firstLine = (stdout: string) => stdout.trim().split('\n')[0]!.slice(0, 80) || null;
/**
 * A program's version (or login state), remembered for a minute: starting a process per agent on every request would be slow.
 * The first answer is probed on the spot, since the page needs it. After that an expired answer is served as it is and refreshed in the
 * background, so the dashboard never waits several seconds for a `--version` just because a minute has passed.
 */
function cachedVersion(key: string, probe: () => string | null, refresh?: () => Promise<string | null>): string | null {
  const hit = seenCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.v;
  if (hit && refresh) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      refresh().then((v) => seenCache.set(key, { at: Date.now(), v }), () => seenCache.set(key, { at: Date.now(), v: hit.v }));
    }
    return hit.v;
  }
  const v = probe();
  seenCache.set(key, { at: Date.now(), v });
  return v;
}
/** A program's first `--version` line (or null when it is not installed), through the cache. */
const programVersion = (cmd: string, args: string[] = ['--version']) => cachedVersion(cmd, () => detectVersionArgs(cmd, args), () => probeAsync(cmd, args, 8000, firstLine));
/** Claude Code's own `auth status` JSON, through the cache: one process at most per minute, never a credential file. */
const cachedClaudeAuth = () => parseClaudeAuth(cachedVersion('claude-auth-json', claudeAuthRaw, () => probeAsync('claude', ['auth', 'status'], 10_000, (out) => out.slice(0, 2000) || null)));

/** Every agent this computer knows about, and whether the product can really start it. With no project given, nothing is claimed startable. */
function runtimeList(root: string | undefined, claudeOverride = false, codexOverride = false): { id: string; name: string; installed: boolean; authenticated: boolean | null; canStart: boolean; authMode: AuthMode; apiKeyVarsInEnvironment: string[]; how: string | null; reason: string | null }[] {
  const terminal = (name: string) => `Starting ${name} from AgentOnTrack is not built yet. Start it in its own terminal: its hooks still report to this project.`;
  // A configured command (tests, or a person pointing at a wrapper) is what will actually be run, so it counts as installed.
  const version = programVersion;
  const claudeInstalled = claudeOverride || !!version('claude');
  const claudeHooked = root ? hooksInstalled('claude-code', root) : false;
  const claudeAuthed = claudeOverride ? null : claudeInstalled ? cachedClaudeAuth().authenticated : null;
  const claudeMode: AuthMode = claudeOverride || !claudeInstalled ? 'unknown' : classifyClaudeMethod(cachedClaudeAuth().method);
  const keyVars = apiKeyVarsPresent(process.env);
  const codexInstalled = codexOverride || !!version('codex');
  const codexHooked = root ? hooksInstalled('codex', root) : false;
  const codexText = codexOverride || !codexInstalled ? null : cachedVersion('codex-login', codexLoginText, () => probeAsync('codex', ['login', 'status'], 10_000, (out, err) => `${out}${err}`.trim().slice(0, 200) || null));
  const codexMode: AuthMode = classifyCodexStatus(codexText);
  return [
    { id: 'claude-code', name: 'Claude Code', installed: claudeInstalled, authenticated: claudeAuthed, authMode: claudeMode, apiKeyVarsInEnvironment: keyVars, canStart: claudeInstalled && claudeHooked, how: 'claude -p, started by AgentOnTrack in this project, with its hooks reporting here', reason: !claudeInstalled ? 'Claude Code is not installed on this computer.' : !root ? 'Open a project to see whether it can start there.' : !claudeHooked ? 'Connect Claude Code to this project first, so its hooks are in place.' : null },
    { id: 'codex', name: 'Codex', installed: codexInstalled, authenticated: codexOverride || !codexInstalled ? null : codexText !== null, authMode: codexMode, apiKeyVarsInEnvironment: keyVars, canStart: codexInstalled && codexHooked, how: 'codex exec --json, started by AgentOnTrack in this project. It starts only after its hook program refuses a test request, because Codex runs actions if the hook is missing', reason: !codexInstalled ? 'Codex is not installed on this computer.' : !root ? 'Open a project to see whether it can start there.' : !codexHooked ? 'Connect Codex to this project first, so its hooks are in place.' : null },
    { id: 'hermes', name: 'Hermes', installed: !!version('hermes'), authenticated: null, authMode: 'unknown' as AuthMode, apiKeyVarsInEnvironment: keyVars, canStart: false, how: null, reason: terminal('Hermes') },
    ...Object.values(PROVIDERS).map((a) => ({ id: a.id, name: a.name, installed: !!version(a.bin, a.versionArgs), authenticated: null, authMode: 'unknown' as AuthMode, apiKeyVarsInEnvironment: keyVars, canStart: false, how: null, reason: terminal(a.name) })),
  ];
}

/** Reports login state without ever reading credentials: only the official CLI's own status command. */
/** Asks Codex itself (`codex login status`); never reads its login files. Wording seen on a real login: 'Logged in using ChatGPT'. */
function codexLoginText(): string | null {
  const r = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim().slice(0, 200) : null;
}

function parseClaudeAuth(text: string | null): { authenticated: boolean; method: string | null; subscription: string | null } {
  try {
    const o = JSON.parse(text ?? '');
    return { authenticated: !!o.loggedIn, method: o.authMethod ?? null, subscription: o.subscriptionType ?? null };
  } catch { return { authenticated: false, method: null, subscription: null }; }
}
function claudeAuthRaw(): string | null {
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' });
  return r.status === 0 ? String(r.stdout).slice(0, 2000) || null : null;
}

export async function startCompanion(opts: CompanionOptions = {}): Promise<Companion> {
  // Optional settings. Values stay in this object: they are never put in process.env, logged or returned by an API. See packages/core/src/envfile.ts.
  const envCfg = loadEnvFile(opts.envFile === undefined ? findEnvFile() : opts.envFile);
  const paidApi = opts.allowPaidApi ?? envCfg.allowPaidApi;
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

  /** Why a phase could not be started, with the HTTP status the dashboard should show. */
  class PhaseBlocked extends Error { constructor(readonly status: number, message: string) { super(message); } }

  /** Starts one phase of the approved plan, or says why not. The dashboard's route and the phone link both come through here, so both obey the same limits. */
  const startPhaseRun = (entry: Registered, p: Project, phaseId: string, extra: string, source?: string): Run => {
    const view = planViewOf(entry, p, (id) => runs.get(id)?.status === 'running');
    if (!view.plan || !view.views || !view.runs) throw new PhaseBlocked(409, 'There is no plan');
    const phase = view.plan.phases.find((x) => x.id === phaseId);
    if (!phase) throw new PhaseBlocked(404, 'No such phase');
    const cur = p.state().plan!;
    const why = startBlock(view.plan, phase.id, cur.approvedSha, view.views, view.runs, Date.now(), cur.approvedAt ? Date.parse(cur.approvedAt) : null);
    if (why) throw new PhaseBlocked(409, why);
    const pick = view.plan.defaults[phase.role];
    const runtime = phase.agent ?? pick?.agent ?? 'claude-code';
    if (runtime !== 'claude-code') throw new PhaseBlocked(409, `Starting ${runtime} from AgentOnTrack is not built yet, so this phase cannot run here. Assign it to an agent that can start, or run it yourself in that agent's terminal.`);
    const remainingUsd = view.plan.limits.maxUsd - view.spent!.usd;
    // The phase's own task becomes the active one first, so anything the agent asks for is bound to it.
    try { p.activatePhase(phase.id); } catch (err) { throw new PhaseBlocked(409, (err as Error).message); }
    return startRun(entry, p, RunInput.parse({ runtime: 'claude-code', prompt: phasePrompt(view.plan, phase, extra), model: phase.model ?? pick?.model ?? 'haiku', maxBudgetUsd: Math.max(0.01, Math.min(phase.budget.maxUsd ?? 1, remainingUsd, 5)) }), { planId: view.plan.id, phaseId: phase.id, ...(source ? { source } : {}) });
  };

  /*
   * WHO MAY START AN AGENT, route by route. Authority is decided here on the companion, never by a flag the caller sends.
   *
   *   single, user-initiated (allowed):      POST /api/runs, POST /api/agent-sessions, POST /api/agent-sessions/:id/resume, POST /api/plan/phases/start,
   *                                          POST /api/plan/continue and /api/plan/loop with one phase or one round.
   *   cross-review (CHAINED, gated):         POST /api/workflows/cross-review: two runs with nobody acting between them. Needs a grant for the project (it spends
   *                                          both runs) AND an API-key sign-in under paid API mode for both agents; otherwise 409. Off by default.
   *   manual review (allowed):               POST /api/workflows/review: a person picks a finished run and starts exactly ONE reviewer run from a handoff. No grant.
   *   bounded multi-phase / retry loop:      POST /api/plan/continue with maxPhases > 1, POST /api/plan/loop with rounds > 1, and their phone twins.
   *                                          Need an unattended GRANT (a person's terminal-code proof; one project; limited runs; expires) AND an agent
   *                                          signed in with an API key while paid API mode is on. A subscription or unknown sign-in is refused even with a grant.
   *   mobile-originated:                     phone run.start, session.new, plan.continue, plan.loop need the separate allowMobileExecution setting
   *                                          (terminal-code proof), then their own route's rules above.
   *   automatic retry inside one run:        the Codex failed-command recovery turn (see startCodexAppServerRun) is one bounded extra turn of the SAME run,
   *                                          not a new run, so it needs no grant. Nothing else retries by itself.
   *
   * TRUST BOUNDARY of POST /api/plan/phases/start: it starts exactly one run per request. Separate manually authorized requests from a paired session are
   * indistinguishable from a person clicking Start each time, so a client that sends N requests is not a chain this companion can see or refuse; the
   * grant covers only sequences this companion itself runs (continue and loop).
   */
  interface Sequence { cancel: boolean; kind: 'sequence' | 'cross-review'; /** needs a grant: more than one phase or round */ chained: boolean }
  const continuing = new Map<string, Sequence>();
  /** How the last sequence in a project ended, so a page that only polls the plan can say why it stopped. */
  const sequenceEnded = new Map<string, { reason: string; message: string; at: number }>();
  const sequenceView = (projectId: string) => ({ active: continuing.get(projectId)?.kind === 'sequence', ended: sequenceEnded.get(projectId) ?? null });
  const runningCount = () => { let n = 0; for (const r of runs.values()) if (r.status === 'running') n++; return n; };

  /** Why this project has no usable grant right now, or null. Read at use time from the settings file: cancelling or expiry takes effect on the next run. */
  const grantOf = (projectId: string, now = Date.now()): { grant: UnattendedGrant } | { problem: string } => {
    const g = loadSettings().unattendedGrant as UnattendedGrant | null;
    if (!g || typeof g !== 'object') return { problem: UNATTENDED_OFF };
    const exp = Date.parse(g.expiresAt); const made = Date.parse(g.createdAt);
    if (!(exp > made) || exp - made > GRANT_MAX_HOURS * 3_600_000 + 1000 || !Number.isInteger(g.remainingRuns) || !Number.isInteger(g.maxRuns) || g.maxRuns < 1 || g.maxRuns > 10 || g.remainingRuns > g.maxRuns || !Number.isInteger(g.maxPhasesPerSequence) || g.maxPhasesPerSequence < 1 || g.maxPhasesPerSequence > 10 || !Number.isInteger(g.maxRounds) || g.maxRounds < 1 || g.maxRounds > 5 || typeof g.projectId !== 'string' || !g.projectId) return { problem: 'The unattended-runs grant on this computer is not valid. Create a new one in Settings, under Unattended runs.' };
    if (g.projectId !== projectId) return { problem: 'The unattended-runs grant on this computer is for a different project. Create one for this project in Settings, under Unattended runs.' };
    if (!(exp > now)) return { problem: 'The unattended-runs grant has expired. Create a new one in Settings, under Unattended runs, or run one phase at a time.' };
    if (!(g.remainingRuns > 0)) return { problem: 'The unattended-runs grant has no runs left. Create a new one in Settings, under Unattended runs, or run one phase at a time.' };
    return { grant: g };
  };
  const grantProblem = (projectId: string): string | null => { const g = grantOf(projectId); return 'problem' in g ? g.problem : null; };
  /** Spends one run of the grant (persisted). Call right after a chained run really started. */
  const spendGrantRun = (projectId: string) => {
    const st = loadSettings(); const g = grantOf(projectId);
    if ('problem' in g || !st.unattendedGrant) return;
    saveSettings({ ...st, unattendedGrant: { ...st.unattendedGrant, remainingRuns: Math.max(0, st.unattendedGrant.remainingRuns - 1) } });
  };
  /** The sign-in kind the agent would use. Read from the agent's own status command; credentials are never read. Tests inject it. */
  const authModeOf = (runtime: string): AuthMode => opts.detectedAuthMode ? opts.detectedAuthMode(runtime) : (runtimeList(undefined, !!opts.claudeCommand, !!opts.codexCommand).find((r) => r.id === runtime)?.authMode ?? 'unknown');
  /** Provider permission for unattended SUBSCRIPTION automation is unresolved (docs/product/PROVIDER_COMPLIANCE.md rows 3 and 4), so a chained run needs an API-key sign-in and paid API mode. */
  const chainAuthProblem = (runtime: string): string | null => (authModeOf(runtime) === 'api-key' && paidApi ? null : CHAIN_AUTH_REFUSAL);
  const runtimeOfPhase = (plan: { defaults: Record<string, { agent?: string } | undefined> }, phase: { agent?: string | undefined; role: string }): string => phase.agent ?? plan.defaults[phase.role]?.agent ?? 'claude-code';
  /** Everything a chained run (the 2nd, 3rd... in a row, or the first of a sequence that will chain) must pass. */
  const chainProblem = (projectId: string, runtime: string): string | null => grantProblem(projectId) ?? chainAuthProblem(runtime);

  /** A dollar cap is a spend limit on paid API use. A subscription or unknown sign-in has no dollar figure, so none is passed or recorded for it. */
  const dollarCapAllowed = (runtime: string): boolean => authModeOf(runtime) === 'api-key' && paidApi;
  /** Stops the run's process tree when its time limit is reached. */
  const armTimeLimit = (run: Run, minutes: number) => {
    const t = setTimeout(() => {
      if (run.status !== 'running') return;
      run.status = 'stopped';
      run.events.push(`Stopped: the time limit of ${minutes} minutes was reached`);
      killChild(run.child);
    }, minutes * (opts.minuteMsForTests ?? 60_000));
    t.unref();
  };

  /** Same Idempotency-Key and same request returns the original answer and starts nothing; the same key for a different request is a 409; no key, or a new key, is an ordinary start. */
  const startKeys = new Map<string, { sha: string; status: number; body: unknown; at: number }>();
  const startOnce = (req: IncomingMessage, sessionKey: string, scope: string, request: unknown, start: () => { status: number; body: unknown }): { status: number; body: unknown; replay: boolean } => {
    const raw = req.headers['idempotency-key'];
    if (raw === undefined) return { ...start(), replay: false };
    if (typeof raw !== 'string' || !START_KEY_RE.test(raw)) throw new HttpError(400, 'Idempotency-Key must be 22 to 64 letters, digits, underscores or hyphens.');
    const now = Date.now();
    for (const [k, e] of startKeys) { if (now - e.at > START_KEY_TTL_MS || startKeys.size >= START_KEY_MAX) startKeys.delete(k); else break; }
    const mk = `${sessionKey}:${raw}`;
    const sha = hash(JSON.stringify([scope, request]));
    const hit = startKeys.get(mk);
    if (hit) {
      if (hit.sha !== sha) throw new HttpError(409, 'That Idempotency-Key was already used for a different request. Nothing was started.');
      return { status: hit.status, body: hit.body, replay: true };
    }
    // Everything from the lookup to the record is synchronous, so two simultaneous requests with one key cannot both start. A start that throws records nothing.
    const out = start();
    startKeys.set(mk, { sha, status: out.status, body: out.body, at: now });
    return { ...out, replay: false };
  };
  const draftHits = new Map<string, number[]>();
  /** What this companion has seen runtimes report in this session. Nothing here is guessed or built in. */
  const inits: InitReport[] = [];
  const seenModels: Seen[] = [];
  const reportedCommands = (agent: string): string[] | null => { const last = inits.filter((x) => x.agent === agent).at(-1); return last ? last.commands : null; };
  const waitFor = async (run: Run, me: Sequence, pollMs: number) => {
    const until = Date.now() + 30 * 60_000;
    while (run.status === 'running' && Date.now() < until) {
      await new Promise((ok) => setTimeout(ok, pollMs));
      if (me.cancel && run.status === 'running') { run.status = 'stopped'; killChild(run.child); }
    }
  };
  const holdsApproval = (p: Project) => [...p.state().approvals.values()].some((a) => approvalView(a, new Date()) === 'pending');

  /**
   * Bounded continuation of an approved plan, run here and not in a browser, so it goes on while a phone (or a page that only polls) is watching.
   * With maxPhases of 1 it is a single start and needs nothing more. With more, it is a chained sequence: it needs a valid grant for this project and an API-key
   * sign-in under paid API mode, spends one run of the grant per phase it starts, and stops the moment the grant is spent, expired or cancelled.
   */
  const continuePlan = (entry: Registered, p: Project, maxPhases: number, source: string) => {
    const chained = maxPhases > 1;
    if (chained) {
      const g = grantOf(entry.id);
      if ('problem' in g) throw new PhaseBlocked(409, g.problem);
      if (maxPhases > g.grant.maxPhasesPerSequence) throw new PhaseBlocked(409, `The grant allows up to ${g.grant.maxPhasesPerSequence} phases in one sequence.`);
      const v0 = planViewOf(entry, p, (id) => runs.get(id)?.status === 'running');
      const next = v0.views?.find((x) => x.status === 'ready'); const ph = next && v0.plan?.phases.find((x) => x.id === next.id);
      const why = chainAuthProblem(v0.plan && ph ? runtimeOfPhase(v0.plan as never, ph) : 'claude-code');
      if (why) throw new PhaseBlocked(409, why);
    }
    if (continuing.has(entry.id)) return { started: false, note: 'It is already continuing.' };
    const me: Sequence = { cancel: false, kind: 'sequence', chained };
    continuing.set(entry.id, me);
    sequenceEnded.delete(entry.id);
    const running = (id: string) => runs.get(id)?.status === 'running';
    let ended: { reason: string; message: string } | null = null;
    const end = (reason: string, message: string) => { ended ??= { reason, message }; };
    void (async () => {
      try {
        for (let i = 0; i < maxPhases && !me.cancel; i++) {
          // A held approval always stops it. It never decides anything itself.
          if (holdsApproval(p)) { end('approval', 'Paused: an action is waiting for your approval. Decide it, then run again.'); break; }
          let v = planViewOf(entry, p, running);
          if (!v.views || !v.plan) { end('no-plan', 'Stopped: there is no plan.'); break; }
          const needs = v.views.find((x) => ['needs-evidence', 'stale'].includes(x.status));
          if (needs && v.plan.phases.find((x) => x.id === needs.id)?.taskId) { p.verifyTask(v.plan.phases.find((x) => x.id === needs.id)!.taskId!); v = planViewOf(entry, p, running); }
          if (v.views!.some((x) => x.status === 'failed')) { end('failed', 'Stopped: a check failed. Look at it before going on.'); break; }
          const ready = v.views!.find((x) => x.status === 'ready');
          const phase = ready && v.plan!.phases.find((x) => x.id === ready.id);
          if (!phase) { end('nothing-ready', v.views!.every((x) => ['verified', 'done-unchecked', 'skipped'].includes(x.status)) ? 'Nothing left to run.' : 'Stopped: nothing is ready to run.'); break; }
          if (phase.kind === 'release') { end('release', 'Stopped before the release phase. A release is always your decision.'); break; }
          if (chained) { const why = chainProblem(entry.id, runtimeOfPhase(v.plan as never, phase)); if (why) { end('grant', `Stopped: ${why}`); break; } }
          const run = startPhaseRun(entry, p, phase.id, '', source);
          if (chained) spendGrantRun(entry.id);
          await waitFor(run, me, 400);
          const after = planViewOf(entry, p, running);
          const done = after.plan?.phases.find((x) => x.id === phase.id);
          if (done?.taskId && done.acceptance.some((a) => a.kind === 'command') && !me.cancel) p.verifyTask(done.taskId);
        }
        if (me.cancel) end('cancelled', 'Stopped.'); else end('limit', `Stopped after ${maxPhases} phase${maxPhases === 1 ? '' : 's'}, the number asked for.`);
      } catch (err) { end('error', `Stopped: ${(err as Error).message}`); /* a phase that cannot start ends the continuation; the plan view says why */ } finally { continuing.delete(entry.id); sequenceEnded.set(entry.id, { ...(ended ?? { reason: 'done', message: 'Stopped.' }), at: Date.now() }); }
    })();
    return { started: true, note: `Running up to ${maxPhases} phase${maxPhases === 1 ? '' : 's'}, and stopping at any failure, held approval or release.` };
  };

  /**
   * A managed loop: run one phase, run its own checks, and if they fail run it again with what failed, up to a number of rounds the person set.
   * It stops at the first pass, at a held approval, at the phase's or plan's own limits (which startPhaseRun enforces), or when cancelled.
   * It needs a command check, because that is the only way it can know when to stop.
   * With more than one round it is a retry loop with nobody acting between the runs, so it is gated exactly like a chained continuation (grant, API-key sign-in under paid API mode).
   */
  const loopPhase = (entry: Registered, p: Project, phaseId: string, rounds: number, source: string) => {
    const chained = rounds > 1;
    const running = (id: string) => runs.get(id)?.status === 'running';
    const v0 = planViewOf(entry, p, running);
    const phase0 = v0.plan?.phases.find((x) => x.id === phaseId);
    if (chained) {
      const g = grantOf(entry.id);
      if ('problem' in g) throw new PhaseBlocked(409, g.problem);
      if (rounds > g.grant.maxRounds) throw new PhaseBlocked(409, `The grant allows up to ${g.grant.maxRounds} rounds.`);
      const why = chainAuthProblem(v0.plan && phase0 ? runtimeOfPhase(v0.plan as never, phase0) : 'claude-code');
      if (why) throw new PhaseBlocked(409, why);
    }
    if (continuing.has(entry.id)) return { started: false, note: 'A sequence is already running for this project. Stop it first.' };
    if (!phase0) throw new PhaseBlocked(404, 'No such phase');
    if (!phase0.taskId || !phase0.acceptance.some((a) => a.kind === 'command')) throw new PhaseBlocked(409, 'A loop needs a command check on this phase, because the check is how it knows when to stop.');
    const me: Sequence = { cancel: false, kind: 'sequence', chained };
    continuing.set(entry.id, me);
    sequenceEnded.delete(entry.id);
    let ended: { reason: string; message: string } | null = null;
    const end = (reason: string, message: string) => { ended ??= { reason, message }; };
    void (async () => {
      try {
        let extra = '';
        for (let round = 1; round <= rounds && !me.cancel; round++) {
          if (holdsApproval(p)) { end('approval', 'Paused: an action is waiting for your approval. Decide it, then run again.'); break; }
          if (chained) { const why = chainProblem(entry.id, runtimeOfPhase(planViewOf(entry, p, running).plan as never, phase0)); if (why) { end('grant', `Stopped: ${why}`); break; } }
          const run = startPhaseRun(entry, p, phaseId, extra, source);
          if (chained) spendGrantRun(entry.id);
          await waitFor(run, me, 300);
          if (me.cancel) break;
          p.verifyTask(phase0.taskId!);
          const st = planViewOf(entry, p, running).views?.find((x) => x.id === phaseId)?.status;
          if (st === 'verified') { end('passed', 'The checks passed.'); break; }
          const bad = p.state().receipts.filter((r) => r.taskId === phase0.taskId && !r.passed).at(-1);
          extra = `Round ${round} did not pass the phase's checks.${bad ? ` The check printed: ${String(bad.observed ?? '').slice(0, 600)}` : ''} Find the cause and fix it in the code. Do not change or weaken the checks.`;
        }
        if (me.cancel) end('cancelled', 'Stopped.'); else end('limit', `Stopped after ${rounds} round${rounds === 1 ? '' : 's'}, the number asked for.`);
      } catch (err) { end('error', `Stopped: ${(err as Error).message}`); /* a round that cannot start (a limit, an approval) ends the loop; the plan view says why */ } finally { continuing.delete(entry.id); sequenceEnded.set(entry.id, { ...(ended ?? { reason: 'done', message: 'Stopped.' }), at: Date.now() }); }
    })();
    return { started: true, note: `Running this phase up to ${rounds} time${rounds === 1 ? '' : 's'}, stopping as soon as its checks pass, at any held approval or limit, or when you stop it.` };
  };

  /**
   * One agent builds, a different agent reviews, the project's own checks run, and every step is recorded.
   * The reviewer gets a validated handoff (goal, decisions, changed source, evidence, limits) and no approval from the builder.
   * The review is read-only by instruction; what the reviewer is allowed to do is still decided by its own hooks.
   * Swap builder and reviewer to reverse the roles.
   */
  const crossReview = (entry: Registered, p: Project, o: { builder: 'claude-code' | 'codex'; reviewer: 'claude-code' | 'codex'; prompt: string; builderModel: string; reviewerModel: string; taskId?: string; maxUsd: number }) => {
    // Nobody acts between the two runs, so it is a chained sequence: a grant for this project (both runs are spent from it) and an API-key sign-in under paid API mode for both agents.
    const gate = grantProblem(entry.id) ?? chainAuthProblem(o.builder) ?? chainAuthProblem(o.reviewer);
    if (gate) throw new HttpError(409, `${CROSS_REVIEW_REFUSAL} (${gate})`.slice(0, 1500));
    const grantNow = grantOf(entry.id);
    if ('grant' in grantNow && grantNow.grant.remainingRuns < 2) throw new HttpError(409, `${CROSS_REVIEW_REFUSAL} (The unattended-runs grant has fewer than the two runs a cross-review needs.)`);
    if (o.builder === o.reviewer) throw new HttpError(409, 'Pick two different agents. A review by the author is a weaker check.');
    if (continuing.has(entry.id)) throw new HttpError(409, 'A sequence is already running for this project. Stop it first.');
    // The reviewer starts after the builder has finished, so one free slot is what the click needs now.
    if (runningCount() >= MAX_CONCURRENT_RUNS) throw new HttpError(409, `The computer is busy: ${MAX_CONCURRENT_RUNS} agents are already running. Wait for one to finish or stop one, then try again.`);
    for (const id of [o.builder, o.reviewer]) if (!runtimeList(entry.root, !!opts.claudeCommand, !!opts.codexCommand).find((r) => r.id === id)?.canStart) throw new HttpError(409, `${id} cannot be started in this project. Connect it first.`);
    // Both agents are proven startable before the first one runs, so work is never built and then left without a reviewer.
    if ([o.builder, o.reviewer].includes('codex')) { const st = hookSelfTest('codex', entry.root); if (!st.ok) throw new HttpError(409, `Codex was not started: ${st.detail}. ${st.fix ?? ''}`.trim()); }
    const wf = `wf_${randomBytes(5).toString('hex')}`;
    const me: Sequence = { cancel: false, kind: 'cross-review', chained: false };
    continuing.set(entry.id, me);
    const note = (type: string, payload: Record<string, unknown>) => p.store.append({ type, actor: { kind: 'system', runtime: 'agentontrack' }, payload: { workflow: wf, kind: 'cross-review', ...payload } });
    const wait = (run: Run) => waitFor(run, me, 300);
    const before = snapshotChanges(entry.root);
    note('workflow.started', { builder: o.builder, reviewer: o.reviewer, taskId: o.taskId ?? null, gitRepository: before !== null });
    void (async () => {
      let ended = 'unknown';
      try {
        const b = startRun(entry, p, RunInput.parse({ runtime: o.builder, prompt: o.prompt, model: o.builderModel, maxBudgetUsd: o.maxUsd }), { source: `cross-review:${wf}` });
        spendGrantRun(entry.id);
        note('workflow.step', { step: 'build', runId: b.id });
        await wait(b);
        if (b.status !== 'finished') { ended = `builder-${b.status}`; return; }
        const after = before ? snapshotChanges(entry.root) : null;
        const changed = before && after ? changedBetween(before, after) : null;
        note('workflow.step', { step: 'changes', files: changed ? changed.slice(0, 200) : null, count: changed?.length ?? null, note: changed ? 'By comparing the working tree before and after the builder ran.' : 'Not a git repository, so changes were not recorded.', ...(changed?.length === 0 ? { warning: 'The builder changed nothing. Its run ending as finished does not mean the work was done; check what its last command did.' } : {}) });
        // A project the builder left unchanged is not an implemented task. Seen in real runs: Codex gave up after one failed command and the run still said finished.
        if (changed?.length === 0) { ended = 'builder-changed-nothing'; return; }
        let brief: string; let handoffId: string;
        try {
          const h = buildHandoff(p, { from: o.builder, to: o.reviewer, ...(o.taskId ? { taskId: o.taskId } : {}), reason: { kind: 'review' }, limits: ['Nothing the builder was approved to do carries over to the reviewer.'] });
          saveHandoff(p, h);
          const acc = acceptHandoff2(p, h, o.reviewer);
          if (!acc.accepted || !acc.brief) { ended = `handoff-refused: ${acc.problems.map((x) => x.code).join(',')}`; return; }
          brief = acc.brief; handoffId = h.id;
        } catch (err) { ended = `no-handoff: ${(err as Error).message.slice(0, 200)}`; return; }
        note('workflow.step', { step: 'handoff', handoffId, approvalsCarried: 0 });
        if (me.cancel) { ended = 'cancelled'; return; }
        const stop = chainProblem(entry.id, o.reviewer);
        if (stop) { ended = `grant: ${stop.slice(0, 160)}`; return; }
        const r = startRun(entry, p, RunInput.parse({ runtime: o.reviewer, prompt: `Review the work described below. Report problems with file and line. Do not edit files and do not weaken any check.${changed ? `

Files the builder changed (${changed.length}): ${changed.slice(0, 40).join(', ')}${changed.length > 40 ? ', ...' : ''}` : ''}

${brief}`.slice(0, 19_900), model: o.reviewerModel, maxBudgetUsd: o.maxUsd }), { source: `cross-review:${wf}` });
        spendGrantRun(entry.id);
        note('workflow.step', { step: 'review', runId: r.id });
        await wait(r);
        if (r.status !== 'finished') { ended = `reviewer-${r.status}`; return; }
        let checks: string | null = null;
        if (o.taskId && !me.cancel) { p.verifyTask(o.taskId); checks = 'ran'; }
        note('workflow.step', { step: 'checks', ran: checks === 'ran', taskId: o.taskId ?? null });
        ended = me.cancel ? 'cancelled' : 'finished';
      } catch (err) { ended = `failed: ${(err as Error).message.slice(0, 200)}`; } finally { continuing.delete(entry.id); try { note('workflow.ended', { status: ended }); } catch { /* project closed */ } }
    })();
    return { started: true, workflow: wf, note: `${o.builder} builds, then ${o.reviewer} reviews from a handoff that carries no approvals, then the project's checks run.` };
  };

  /**
   * Manual second step of a review: a person chose a finished run and asks a different agent to review it. Exactly one reviewer run, started now, from a validated
   * handoff that carries no approvals. Because a person starts each run, it needs no unattended grant and works with a subscription sign-in.
   */
  const reviewRun = (entry: Registered, p: Project, o: { runId: string; reviewer: 'claude-code' | 'codex'; model: string; taskId?: string; maxUsd: number }) => {
    const live = runs.get(o.runId);
    if (live && live.project !== entry.id) throw new HttpError(404, 'No such run in this project.');
    if (live?.status === 'running') throw new HttpError(409, 'That run is still going. Wait for it to finish, then start the review.');
    const started = p.store.byType(['run.started']).find((e) => e.payload?.id === o.runId);
    if (!started) throw new HttpError(404, 'No such run in this project.');
    const finished = p.store.byType(['run.finished']).find((e) => e.payload?.id === o.runId);
    if (!finished && !live) throw new HttpError(409, 'That run did not record an end, so there is nothing finished to review.');
    const from = String(started.payload.runtime ?? '');
    if (!['claude-code', 'codex'].includes(from)) throw new HttpError(409, 'Only a Claude Code or Codex run can be reviewed this way.');
    if (from === o.reviewer) throw new HttpError(409, 'Pick a different agent from the one that did the work. A review by the author is a weaker check.');
    if (!runtimeList(entry.root, !!opts.claudeCommand, !!opts.codexCommand).find((r) => r.id === o.reviewer)?.canStart) throw new HttpError(409, `${o.reviewer} cannot be started in this project. Connect it first.`);
    if (o.reviewer === 'codex') { const st = hookSelfTest('codex', entry.root); if (!st.ok) throw new HttpError(409, `Codex was not started: ${st.detail}. ${st.fix ?? ''}`.trim()); }
    let brief: string; let handoffId: string;
    try {
      const h = buildHandoff(p, { from, to: o.reviewer, ...(o.taskId ? { taskId: o.taskId } : {}), reason: { kind: 'review' }, limits: ['Nothing the builder was approved to do carries over to the reviewer.'] });
      saveHandoff(p, h);
      const acc = acceptHandoff2(p, h, o.reviewer);
      if (!acc.accepted || !acc.brief) throw new HttpError(409, `The handoff was refused: ${acc.problems.map((x) => x.code).join(', ')}`);
      brief = acc.brief; handoffId = h.id;
    } catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(409, `No handoff could be made from that run: ${(err as Error).message.slice(0, 200)}`); }
    const r = startRun(entry, p, RunInput.parse({ runtime: o.reviewer, prompt: `Review the work described below. Report problems with file and line. Do not edit files and do not weaken any check.\n\n${brief}`.slice(0, 19_900), model: o.model, maxBudgetUsd: o.maxUsd }), { source: `review:${o.runId}` });
    return { started: true, runId: r.id, handoffId, note: `${o.reviewer} is reviewing run ${o.runId} from a handoff that carries no approvals. This is one run; nothing follows it.` };
  };

  /* ---------- The phone link ---------- */
  let remote: RemoteService | null = null;
  const remoteFileNow = (): RemoteFile | null => loadRemote();
  /** For the desktop only: the name and the resolved folder, and whether the folder is still the one that was chosen. */
  const defaultProjectView = (d: RemoteFile['defaultProject'] | null) => {
    if (!d) return null;
    const r = loadRegistry().find((x) => x.id === d.projectId);
    let valid = false; try { valid = !!r && !r.archived && realpathSync.native(r.root) === d.realRoot; } catch { valid = false; }
    return { projectId: d.projectId, name: r?.name ?? null, path: d.realRoot, valid, setAt: d.setAt };
  };
  /**
   * Stops a run and says truthfully whether it stopped. The status becomes "stopped" first, so the process's own end is recorded as a stop; if the process cannot be
   * ended (a signal that could not be delivered, or a process that survives a hard kill) the status goes back to "running" and the failure is returned, not hidden.
   */
  const stopRunNow = async (run: Run): Promise<{ ok: true } | { ok: false; kind: 'not-running' | 'failed'; reason: string }> => {
    if (run.status !== 'running') return { ok: false, kind: 'not-running', reason: run.status === 'stopped' ? 'That run was already stopped.' : 'That run is not running.' };
    run.status = 'stopped';
    const out = await terminate(run.child as Killable);
    if (out.ok) return { ok: true };
    if (run.status === 'stopped') run.status = 'running';
    run.events.push(`[stop failed] ${out.reason}`.slice(0, 400));
    return { ok: false, kind: 'failed', reason: out.reason };
  };
  const stopRunOf = async (projectId: string, runId: string): Promise<boolean> => {
    const r = runs.get(runId);
    if (!r || r.project !== projectId || r.status !== 'running') return false;
    const out = await stopRunNow(r);
    if (out.ok) return true;
    if (out.kind === 'not-running') return false;
    throw new Refusal('stop-failed', out.reason);
  };
  const asRefusal = <T,>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof PhaseBlocked || e instanceof HttpError) throw new Refusal('blocked', (e as Error).message);
      throw e;
    }
  };
  const makeRemote = async (file: RemoteFile): Promise<RemoteService> => {
    const link = file.link!;
    const exec = makeExecutor({
      registry: () => loadRegistry(),
      projectFor: (id) => projectFor(id),
      isRunning: (id) => runs.get(id)?.status === 'running',
      stopRun: stopRunOf,
      recentRuns: (pid) => [...runs.values()].filter((r) => r.project === pid).map((r) => ({ id: r.id, status: r.status, started: r.started, events: r.events })),
      startPhase: (entry, p, phaseId, extra, source) => asRefusal(() => { const r = startPhaseRun(entry, p, phaseId, extra, source); return { id: r.id, status: r.status }; }),
      startPrompt: (entry, p, o, source) => asRefusal(() => {
        if (o.agent !== 'claude-code') throw new PhaseBlocked(409, `Starting ${o.agent} from AgentOnTrack is not built yet. Start it in its own terminal: its hooks still report to this project.`);
        const r = startRun(entry, p, RunInput.parse({ runtime: 'claude-code', prompt: o.prompt, model: o.model, maxBudgetUsd: o.maxUsd }), { source });
        return { id: r.id, status: r.status };
      }),
      allowUnattended: (projectId) => grantProblem(projectId) === null,
      allowMobileExecution: () => loadSettings().allowMobileExecution === true,
      continuePlan: (entry, p, n, source) => asRefusal(() => continuePlan(entry, p, n, source)),
      loopPhase: (entry, p, phaseId, n, source) => asRefusal(() => loopPhase(entry, p, phaseId, n, source)),
      cancelContinue: (pid) => { const c = continuing.get(pid); if (!c) return false; c.cancel = true; for (const r of runs.values()) if (r.project === pid && r.status === 'running') { r.status = 'stopped'; killChild(r.child); } return true; },
      models: async () => ({ models: await discoverModels({ seen: seenModels, inits }) }),
      agents: async (root) => describeAgents(runtimeList(root, !!opts.claudeCommand, !!opts.codexCommand), inits),
      maxUsdPerRun: () => remoteFileNow()?.maxUsdPerRun ?? 1,
      version: 'companion',
      // Phone-started sessions. The default project is the owner's, set on this computer; the phone only ever says "default".
      defaultProject: () => { const d = remoteFileNow()?.defaultProject; return d ? { projectId: d.projectId, realRoot: d.realRoot } : null; },
      defaultStillValid: (entry, realRoot) => stillTheSameFolder(entry.root, realRoot),
      runningCount: () => [...runs.values()].filter((r) => r.status === 'running').length,
      startSession: (entry, p, o, source) => asRefusal(() => {
        const r = startRun(entry, p, RunInput.parse({ runtime: o.agent, prompt: o.prompt, model: o.model, maxBudgetUsd: o.maxUsd, policy: o.policy }), { source });
        return { runId: r.id, sessionId: r.sessionId!, status: r.status };
      }),
      sessionDetail: (p, sid) => {
        const sv = sessionViews(p).find((v) => v.id === sid);
        return sv ? { id: sv.id, status: sv.status, title: sv.title, runtime: sv.runtime, canResume: sv.canResume, linked: !!sv.providerSessionId, runs: sv.runIds.map((id) => { const r = runs.get(id); return { id, status: r?.status ?? null, events: r?.events ?? [] }; }) } : null;
      },
      idem: new IdempotencyStore(join(agentontrackHome(), 'remote-idem.json')),
    });
    const svc = new RemoteService({
      file, save: (f2) => saveRemote(f2), executor: exec, version: 'companion',
      transport: new FirestoreTransport({ firebase: link.firebase as FirebaseConfig, uid: link.uid, cid: file.computerId, email: link.computer.email, password: link.computer.password, ...(opts.remote?.emulators ? { emulators: opts.remote.emulators } : {}) }),
      list: () => loadRegistry().filter((r) => existsSync(r.root)).map((r) => { try { const { p } = projectFor(r.id); const st = p.state(); const t = st.activeTaskId ? st.tasks.get(st.activeTaskId) : null; return { id: r.id, name: r.name, archived: !!r.archived, isDefault: remoteFileNow()?.defaultProject?.projectId === r.id, goal: st.goal?.statement ?? null, activeTask: t ? { title: t.title, status: p.evaluate(t.id).status } : null, pendingApprovals: [...st.approvals.values()].filter((x) => approvalView(x, new Date()) === 'pending').length }; } catch { return { id: r.id, name: r.name, archived: !!r.archived, missing: true }; } }),
      projects: () => loadRegistry().filter((r) => existsSync(r.root) && !r.archived).map((r) => ({ id: r.id, snapshot: () => { const { entry, p } = projectFor(r.id); return snapshotOf(entry, p, { isRunning: (id) => runs.get(id)?.status === 'running', recentRuns: (pid) => [...runs.values()].filter((x) => x.project === pid).map((x) => ({ id: x.id, status: x.status, started: x.started, events: x.events })) }, runtimeList(entry.root, !!opts.claudeCommand, !!opts.codexCommand).map((r) => ({ id: r.id, name: r.name, canStart: r.canStart }))); } })),
      ...(opts.remote?.snapshotEveryMs ? { snapshotEveryMs: opts.remote.snapshotEveryMs } : {}),
      ...(opts.remote?.heartbeatEveryMs ? { heartbeatEveryMs: opts.remote.heartbeatEveryMs } : {}),
    });
    await svc.start();
    return svc;
  };
  const startRemoteIfLinked = () => {
    const file = remoteFileNow();
    if (!file?.link || remote) return;
    void makeRemote(file).then((svc) => { remote = svc; }).catch(() => undefined);
  };
  startRemoteIfLinked();

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
    if (run.limitReached && run.status === 'failed') run.status = 'stopped';
    if (result?.modelUsage) {
      for (const [model, u] of Object.entries<any>(result.modelUsage)) {
        if (exitCode === 0) seenModels.push({ agent: 'claude-code', model, worked: true });
        p.recordUsage({
          runtime: 'claude-code', model, source: 'provider-reported', sessionId: result.session_id, runId: run.id, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
          cacheReadTokens: u.cacheReadInputTokens ?? 0, cacheCreationTokens: u.cacheCreationInputTokens ?? 0, ...(dollarCapAllowed('claude-code') ? { costUsd: u.costUSD, costBasis: u.costBasis ?? 'unknown' } : { costBasis: 'unknown' }), // a subscription run has no dollar figure of its own, so none is recorded and plan dollar limits do not count it
          durationMs: result.duration_ms,
        });
      }
    }
    keepTranscript(p, run);
    p.store.append({ type: 'run.finished', actor: { kind: 'system', runtime: 'claude-code' }, payload: { id: run.id, status: run.status, ...(run.limitReached ? { limitReached: true } : {}), exitCode, wallClockMs, durationApiMs: result?.duration_api_ms ?? null, totalCostUsd: result?.total_cost_usd ?? null, numTurns: result?.num_turns ?? null, sessionId: result?.session_id ?? null, resultText: keepTranscripts() && typeof result?.result === 'string' ? result.result.slice(0, 2000) : null, resultChars: typeof result?.result === 'string' ? result.result.length : null } });
  };

  /** Attachments by id, from this project's own folder. An id that is not there is refused, never guessed. */
  const attachmentsFor = (p: Project, ids: string[]) => ids.map((id) => { const a = findAttachment(p.stateDir, id); if (!a) throw new HttpError(404, 'An attached file is missing. Attach it again.'); return a; });

  /**
   * The session a finished run left behind, read from the project record and not from memory, so it survives a restart of the companion.
   * A resume must be the same agent in the same project, and the earlier run must be over.
   */
  const resumeTarget = (p: Project, runtime: string, runId: string | undefined): string | null => {
    if (!runId) return null;
    if (runs.get(runId)?.status === 'running') throw new HttpError(409, 'That run is still going. Stop it or wait for it to finish before resuming.');
    const ev = p.store.byType(['run.started', 'run.finished']).filter((e) => e.payload?.id === runId);
    const started = ev.find((e) => e.type === 'run.started');
    const finished = ev.find((e) => e.type === 'run.finished');
    if (!started) throw new HttpError(404, 'No such run in this project.');
    if (started.payload.runtime !== runtime) throw new HttpError(409, `That run was ${started.payload.runtime}, so it cannot be resumed with ${runtime}. Use a handoff to move work between agents.`);
    // The provider names its session at the start of a run, and that is recorded as session.linked, so a run that was stopped (and never reported one at its end) can still be resumed.
    const linked = p.store.byType(['session.linked']).filter((e) => e.payload?.runId === runId).at(-1)?.payload?.providerSessionId;
    const sid = isProviderSessionId(finished?.payload?.sessionId) ? finished!.payload.sessionId : linked;
    if (!isProviderSessionId(sid)) throw new HttpError(409, 'That run left no session to resume.');
    return sid;
  };

  /* ---------- Sessions: a projection of the project record (packages/core/src/sessions.ts) ---------- */
  const keepTranscripts = () => loadSettings().keepTranscripts === true;
  const liveRunIds = () => new Set([...runs.values()].filter((r) => r.status === 'running').map((r) => r.id));
  const SESSION_EVENTS = ['run.started', 'run.finished', 'session.created', 'session.run', 'session.linked', 'session.updated', 'session.prompt', 'session.message'];
  const sessionViews = (p: Project): SessionView[] => projectSessions(p.store.byType(SESSION_EVENTS), { live: liveRunIds() });
  /** Records which session a run belongs to, creating the session for a run that continues none. The text of the prompt is stored only if the owner turned that on. */
  const noteSession = (p: Project, run: Run, input: { runtime: string; model: string; prompt: string; title?: string | undefined; worktreeId?: string | undefined; policy?: string | undefined }, existing: string | null): string => {
    const id = existing ?? newSessionId();
    if (!existing) p.store.append({ type: 'session.created', actor: { kind: 'human' }, payload: { sessionId: id, runtime: input.runtime, model: input.model, ...(input.policy && input.policy !== 'standard' ? { policy: input.policy } : {}), ...(input.title ? { title: input.title } : {}), ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}) } });
    p.store.append({ type: 'session.run', actor: { kind: 'system', runtime: input.runtime }, payload: { sessionId: id, runId: run.id } });
    if (keepTranscripts()) p.store.append({ type: 'session.prompt', actor: { kind: 'human' }, payload: { sessionId: id, runId: run.id, text: input.prompt.slice(0, 4000) } });
    run.sessionId = id; run.runtime = input.runtime;
    return id;
  };
  /** Called when the provider names its own session, which is the moment it exists whether or not the run ever finishes cleanly. */
  const linkSession = (p: Project, run: Run, providerSessionId: unknown) => {
    if (!run.sessionId || !isProviderSessionId(providerSessionId) || run.linkedProvider === providerSessionId) return;
    run.linkedProvider = providerSessionId;
    try { p.store.append({ type: 'session.linked', actor: { kind: 'system', runtime: run.runtime ?? 'unknown' }, payload: { sessionId: run.sessionId, providerSessionId, runId: run.id } }); } catch { /* project closed during shutdown */ }
  };
  /** What the agent said, kept only if the owner turned transcript retention on. It is the lines the dashboard already shows, capped; it is not a full record. */
  const keepTranscript = (p: Project, run: Run) => {
    if (!run.sessionId || !keepTranscripts()) return;
    const text = run.events.filter((e) => !e.startsWith('[tool')).join('\n').slice(0, 8000);
    if (!text) return;
    try { p.store.append({ type: 'session.message', actor: { kind: 'system', runtime: run.runtime ?? 'unknown' }, payload: { sessionId: run.sessionId, runId: run.id, text } }); } catch { /* project closed during shutdown */ }
  };

  /** Codex through `codex exec --json`. Refused unless its hook program is proven to refuse a test request, since Codex runs actions when the hook is missing. */
  const startCodexRun = (entry: Registered, p: Project, input: z.infer<typeof RunInput>, meta?: { planId?: string; phaseId?: string; source?: string }, resumeSessionId?: string): Run => {
    if (!opts.codexCommand) { const g = mayStartUnder(classifyCodexStatus(cachedVersion('codex-login', codexLoginText)), paidApi); if (!g.ok) throw new HttpError(409, g.reason); }
    if (input.worktreeId) throw new HttpError(409, 'A Codex run in a worktree needs the app-server mode.');
    if (input.policy === 'read-only' && resumeSessionId) throw new HttpError(409, 'A read-only policy cannot be enforced when resuming a Codex session through `codex exec`, which takes no sandbox flag on resume. Use the app-server mode, or start a new session.');
    if (!hooksInstalled('codex', entry.root)) throw new HttpError(409, 'Connect Codex to this project first, so its hooks are in place');
    const st = hookSelfTest('codex', entry.root);
    if (!st.ok) throw new HttpError(409, `Codex was not started: ${st.detail}. ${st.fix ?? ''}`.trim());
    try { checkSlashCommand(input.prompt, reportedCommands('codex')); } catch (err) { if (err instanceof CommandRefused) throw new HttpError(409, err.message); throw err; }
    const [cmd, ...pre] = opts.codexCommand ?? ['codex'];
    const att = attachmentsFor(p, input.attachments);
    const args = [...pre, ...buildCodexExecArgs({ prompt: input.prompt + attachmentNote(att), model: input.model, images: att.filter((a) => a.kind === 'image').map((a) => a.path), ...(input.policy === 'read-only' ? { sandbox: 'read-only' } : {}), ...(resumeSessionId ? { resumeSessionId } : {}) })];
    const child = spawn(cmd!, args, { cwd: entry.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...agentEnv(process.env, paidApi), ...envCfg.keysFor('codex') } });
    const run: Run = { id: `run_${randomBytes(5).toString('hex')}`, project: entry.id, child, started: Date.now(), events: newRunLines(), status: 'running' };
    runs.set(run.id, run);
    p.store.append({ type: 'run.started', actor: { kind: 'human' }, payload: { id: run.id, runtime: 'codex', model: input.model, ...(resumeSessionId ? { resumedSession: resumeSessionId } : {}), ...(meta?.planId ? { planId: meta.planId, phaseId: meta.phaseId } : {}), ...(meta?.source ? { source: meta.source } : {}), promptSha256: hash(input.prompt), ...(input.policy !== 'standard' ? { policy: input.policy } : {}), costLimit: 'not enforceable: Codex has no spend cap flag, so only the time and turn of this one run bound it' } });
    const split = new LineSplitter();
    let sessionId: string | null = null; let failed = false; let usage: Parameters<typeof codexUsageRecord>[0] | null = null;
    const onLine = (line: string) => {
      const ev = parseCodexLine(line);
      if (!ev) return;
      if (ev.kind === 'session') { sessionId = ev.sessionId; linkSession(p, run, ev.sessionId); }
      else if (ev.kind === 'message') run.events.push(ev.text.slice(0, 400));
      else if (ev.kind === 'tool' && ev.phase === 'started') run.events.push(`[tool ${ev.tool}] ${ev.summary}`.slice(0, 400));
      else if (ev.kind === 'usage') usage = ev;
      else if (ev.kind === 'error') { failed = true; if (isUsageLimitText(ev.message)) run.limitReached = true; run.events.push(`error: ${run.limitReached ? usageLimitMessage('codex') : ev.message}`.slice(0, 400)); }
      else if (ev.kind === 'turn' && ev.status === 'failed') failed = true;
    };
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { for (const l of split.push(d)) onLine(l); });
    let stderrTail = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { stderrTail = (stderrTail + d).slice(-600); });
    child.on('error', (err) => { run.events.push(`Could not start the agent. ${agentFailureText('codex', err.message)}`); run.status = 'failed'; });
    child.on('close', (exit) => {
      for (const l of split.flush()) onLine(l);
      if (exit !== 0 && isUsageLimitText(stderrTail)) run.limitReached = true;
      if (exit !== 0 && !run.events.some((e) => e.startsWith('error:')) && stderrTail.trim()) run.events.push(`Codex said: ${agentFailureText('codex', stderrTail.trim().slice(-300))}`);
      try {
        const wallClockMs = Date.now() - run.started;
        run.status = exit === 0 && !failed ? 'finished' : run.status === 'stopped' ? 'stopped' : run.limitReached ? 'stopped' : 'failed';
        if (usage) { if (run.status === 'finished') seenModels.push({ agent: 'codex', model: input.model, worked: true }); p.recordUsage({ ...codexUsageRecord(usage, input.model), sessionId: sessionId ?? undefined, runId: run.id, costBasis: 'unknown', durationMs: wallClockMs }); }
        keepTranscript(p, run);
        p.store.append({ type: 'run.finished', actor: { kind: 'system', runtime: 'codex' }, payload: { id: run.id, status: run.status, ...(run.limitReached ? { limitReached: true } : {}), exitCode: exit, wallClockMs, sessionId } });
      } catch { /* project closed during shutdown */ }
    });
    return run;
  };

  /**
   * Where a run happens. Inside a worktree only if it is this agent's own, still active, and the project's hooks have been copied there and proven to
   * refuse a test request from that folder: a worktree is a different folder, so without that the agent would run with no gate at all.
   */
  const runCwd = (entry: Registered, p: Project, input: z.infer<typeof RunInput>): { cwd: string; worktree: boolean } => {
    if (!input.worktreeId) return { cwd: entry.root, worktree: false };
    const w = p.worktrees().find((x) => x.id === input.worktreeId);
    if (!w) throw new HttpError(404, 'No such worktree in this project.');
    if (w.status !== 'active') throw new HttpError(409, `That worktree is ${w.status}.`);
    if (w.agent !== input.runtime) throw new HttpError(409, `That worktree belongs to ${w.agent}. Each agent works in its own folder.`);
    if (input.runtime === 'claude-code') {
      const st = mirrorHooksToWorktree(entry.root, w.path);
      if (!st.ok) throw new HttpError(409, `Not started in the worktree: ${st.detail}. ${st.fix ?? ''}`.trim());
    } else if (input.runtime === 'codex' && (opts.codexMode ?? 'app-server') !== 'app-server') throw new HttpError(409, 'A Codex run in a worktree needs the app-server mode, which answers each approval itself.');
    return { cwd: w.path, worktree: true };
  };

  /**
   * Codex through `codex app-server`: every action Codex asks to take waits for AgentOnTrack's answer, which comes from the same decision engine
   * and approval records the hooks use. Codex's own sign-in is used; nothing is read or copied. NOT TESTED against a real Codex.
   */
  const startCodexAppServerRun = (entry: Registered, p: Project, input: z.infer<typeof RunInput>, meta?: { planId?: string; phaseId?: string; source?: string }, resumeSessionId?: string): Run => {
    if (!opts.codexCommand) { const g = mayStartUnder(classifyCodexStatus(cachedVersion('codex-login', codexLoginText)), paidApi); if (!g.ok) throw new HttpError(409, g.reason); }
    // Hooks stay a requirement: the approval channel is a second gate, and a Codex that reaches an unlisted tool must still meet the first.
    if (!hooksInstalled('codex', entry.root)) throw new HttpError(409, 'Connect Codex to this project first, so its hooks are in place');
    const st = hookSelfTest('codex', entry.root);
    if (!st.ok) throw new HttpError(409, `Codex was not started: ${st.detail}. ${st.fix ?? ''}`.trim());
    try { checkSlashCommand(input.prompt, reportedCommands('codex')); } catch (err) { if (err instanceof CommandRefused) throw new HttpError(409, err.message); throw err; }
    const att = attachmentsFor(p, input.attachments);
    const where = runCwd(entry, p, input);
    const run: Run = { id: `run_${randomBytes(5).toString('hex')}`, project: entry.id, child: { kill: () => {} }, started: Date.now(), events: newRunLines(), status: 'running' };
    runs.set(run.id, run);
    p.store.append({ type: 'run.started', actor: { kind: 'human' }, payload: { id: run.id, runtime: 'codex', transport: 'app-server', ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}), model: input.model, ...(resumeSessionId ? { resumedSession: resumeSessionId } : {}), ...(meta?.planId ? { planId: meta.planId, phaseId: meta.phaseId } : {}), ...(meta?.source ? { source: meta.source } : {}), promptSha256: hash(input.prompt), ...(input.policy !== 'standard' ? { policy: input.policy } : {}), costLimit: 'not enforceable: Codex has no spend cap flag, so only the time and turn of this one run bound it' } });
    let sessionId: string | null = null; let failed = false; let usage: Parameters<typeof codexUsageRecord>[0] | null = null; let acceptedEffects: any[] = [];
    // The exit code of the last command if it did not succeed and nothing has succeeded since; null otherwise.
    let unresolvedFailure = null as { code: number | null } | null;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const adjudicate = async (r: { kind: 'command' | 'file'; command?: string; cwd?: string; paths?: string[] }): Promise<'accept' | 'decline'> => {
      const mapped = r.kind === 'command' ? mapCodexTool('shell', { command: r.command }) : { effects: (r.paths ?? []).map((path) => ({ kind: 'fs.write' as const, target: path })), opaque: !(r.paths ?? []).length, coverage: 'enforced' as const };
      const effects = mapped.effects.length ? mapped.effects : [{ kind: 'exec.opaque' as const, target: 'codex' }];
      const what = (r.command ?? (r.paths ?? []).join(', ')).slice(0, 200);
      const call = { runtime: 'codex', ...(sessionId ? { sessionId } : {}), cwd: r.cwd ?? where.cwd, tool: r.kind === 'command' ? 'shell' : 'apply_patch', effects, opaque: mapped.opaque || !mapped.effects.length, coverage: mapped.coverage, rawInput: { command: r.command, paths: r.paths } };
      const first = p.preAction(call);
      if (first.decision === 'deny') { run.events.push(`[declined] ${what}: ${first.reasons.join('; ').slice(0, 200)}`); return 'decline'; }
      if (first.decision === 'allow') { acceptedEffects = effects; return 'accept'; }
      run.events.push(`[waiting for your approval ${first.approvalIds.join(', ')}] ${what}`);
      const deadline = Date.now() + (opts.codexApprovalWaitMs ?? 10 * 60_000);
      while (run.status === 'running' && Date.now() < deadline) {
        await sleep(opts.codexApprovalPollMs ?? 1000);
        const views = first.approvalIds.map((id) => { const a = p.state().approvals.get(id); return a ? approvalView(a, new Date()) : 'expired'; });
        if (views.some((v) => v === 'denied' || v === 'revoked' || v === 'expired' || v === 'consumed')) return 'decline';
        if (views.every((v) => v === 'approved')) {
          // With Codex's hooks in place the hook spends the approval when the action runs, so it is left unspent here; otherwise spending it is what allows the action.
          if (!where.worktree && hooksInstalled('codex', entry.root)) { acceptedEffects = effects; return 'accept'; }
          if (p.preAction(call).decision === 'allow') { acceptedEffects = effects; return 'accept'; }
          return 'decline';
        }
      }
      return 'decline';
    };
    const server = new CodexAppServer({
      command: opts.codexCommand ?? ['codex'], cwd: where.cwd, model: input.model, ...(input.policy === 'read-only' ? { sandbox: 'read-only' as const } : {}), env: { ...agentEnv(process.env, paidApi), ...envCfg.keysFor('codex') },
      onApproval: adjudicate,
      onEvent: (ev) => {
        if (ev.kind === 'session') { sessionId = ev.threadId; linkSession(p, run, ev.threadId); }
        else if (ev.kind === 'message') run.events.push(ev.text.slice(0, 400));
        else if (ev.kind === 'tool') {
          if (ev.phase === 'started') run.events.push(`[tool ${ev.tool}] ${ev.summary}`.slice(0, 400));
          else if (ev.outcome && (ev.outcome.status !== 'completed' || (ev.outcome.exitCode ?? 0) !== 0)) { unresolvedFailure = { code: ev.outcome.exitCode ?? null }; run.events.push(`[tool ${ev.tool} did not succeed: ${ev.outcome.status}${ev.outcome.exitCode !== undefined ? ', exit ' + ev.outcome.exitCode : ''}] ${(ev.outcome.output ?? '').replace(/\s+/g, ' ').trim()}`.slice(0, 400)); }
          else if (ev.phase === 'completed' && (ev.tool === 'shell' || ev.tool === 'file')) unresolvedFailure = null;
          if (ev.phase === 'completed' && acceptedEffects.length && (ev.tool === 'shell' || ev.tool === 'file')) {
            // After an approved action, compare what changed with what was approved, as the hooks do.
            try { const r = p.postAction({ runtime: 'codex', ...(sessionId ? { sessionId } : {}), tool: ev.tool, effects: acceptedEffects }); if (r.mismatches.length) run.events.push(`[unauthorized change] ${r.mismatches.map((m) => m.path).join(', ')}`.slice(0, 400)); } catch { /* project closed */ }
            acceptedEffects = [];
          }
        } else if (ev.kind === 'usage') usage = ev;
        else if (ev.kind === 'error') { failed = true; if (isUsageLimitText(ev.message)) run.limitReached = true; run.events.push(`error: ${run.limitReached ? usageLimitMessage('codex') : ev.message}`.slice(0, 400)); }
        else if (ev.kind === 'turn' && ev.status === 'failed') failed = true;
      },
    });
    run.child = { kill: () => { if (run.status === 'running') run.status = 'stopped'; void server.interrupt(); } };
    void (async () => {
      let outcome: 'completed' | 'interrupted' | 'failed' = 'failed';
      try {
        await server.start(resumeSessionId);
        outcome = await server.turn({ prompt: input.prompt + attachmentNote(att), images: att.filter((a) => a.kind === 'image').map((a) => a.path) });
        // AUTONOMY CLASSIFICATION: this extra turn is bounded (codexRecoveryTurns, default 1), happens inside the SAME run and the same cap/budget, and sends fixed text.
        // It is not a new run and not a retry loop across runs, so it needs no unattended grant.
        // Recovery: if the turn ended right after a failed command, say so once and let Codex try another way, in the same thread. The text is fixed and carries no command output.
        for (let tries = 0; tries < (opts.codexRecoveryTurns ?? 1) && outcome === 'completed' && !failed && run.status === 'running' && unresolvedFailure; tries++) {
          run.events.push(`[recovery] the last command failed${unresolvedFailure.code !== null ? ` (exit ${unresolvedFailure.code})` : ''} and nothing succeeded after it; asking Codex to try another way`);
          const code = unresolvedFailure.code;
          unresolvedFailure = null;
          outcome = await server.turn({ prompt: `Your last command ended with an error${code !== null ? ` (exit code ${code})` : ''}, and nothing you ran after it succeeded. If the request is not finished, try a different way. If you cannot do it, say plainly what is blocking you.` });
        }
        if (unresolvedFailure) run.events.push('[unresolved] the last command failed and nothing succeeded after it; the request may not be done');
      } catch (err) { if (isUsageLimitText((err as Error).message)) run.limitReached = true; run.events.push(`Could not run Codex. ${agentFailureText('codex', (err as Error).message)}`.slice(0, 400)); }
      server.kill();
      try {
        const wallClockMs = Date.now() - run.started;
        run.status = run.status === 'stopped' || outcome === 'interrupted' ? 'stopped' : outcome === 'completed' && !failed ? 'finished' : run.limitReached ? 'stopped' : 'failed';
        if (usage) { if (run.status === 'finished') seenModels.push({ agent: 'codex', model: input.model, worked: true }); p.recordUsage({ ...codexUsageRecord(usage, input.model), sessionId: sessionId ?? undefined, runId: run.id, costBasis: 'unknown', durationMs: wallClockMs }); }
        keepTranscript(p, run);
        p.store.append({ type: 'run.finished', actor: { kind: 'system', runtime: 'codex' }, payload: { id: run.id, status: run.status, ...(run.limitReached ? { limitReached: true } : {}), exitCode: server.exitCode, wallClockMs, sessionId } });
      } catch { /* project closed during shutdown */ }
    })();
    return run;
  };

  /** The one way a run starts. It works out which session the run continues (if any), starts it, and records the session. */
  const startRun = (entry: Registered, p: Project, input: z.infer<typeof RunInput>, meta?: { planId?: string; phaseId?: string; source?: string }): Run => {
    let existing: string | null = null;
    let effective = input;
    // A session started read-only stays read-only however it is continued (by session id or by run id): a policy only ever narrows.
    const wasReadOnly = (sid: string) => p.store.byType(['session.created']).some((e) => (e.payload as any)?.sessionId === sid && (e.payload as any)?.policy === 'read-only');
    if (input.sessionId) {
      const sv = sessionViews(p).find((v) => v.id === input.sessionId);
      if (!sv) throw new HttpError(404, 'No such session in this project.');
      if (sv.runtime !== input.runtime) throw new HttpError(409, `That session is ${sv.runtime}, so it cannot continue with ${input.runtime}. Use a handoff to move work between agents.`);
      if (sv.status === 'running') throw new HttpError(409, 'That session still has a run going. Stop it or wait for it to finish before continuing.');
      if (!sv.resumeRunId) throw new HttpError(409, 'That session left nothing to resume.');
      existing = sv.id;
      effective = { ...input, resumeRunId: sv.resumeRunId, ...(wasReadOnly(sv.id) ? { policy: 'read-only' as const } : {}) };
    } else if (input.resumeRunId) {
      existing = sessionViews(p).find((v) => v.runIds.includes(input.resumeRunId!))?.id ?? null;
      if (existing && wasReadOnly(existing)) effective = { ...input, policy: 'read-only' as const };
    }
    const run = startRunCore(entry, p, effective, meta);
    armTimeLimit(run, effective.maxMinutes);
    noteSession(p, run, effective, existing);
    return run;
  };

  const startRunCore = (entry: Registered, p: Project, input: z.infer<typeof RunInput>, meta?: { planId?: string; phaseId?: string; source?: string }): Run => {
    if (runningCount() >= MAX_CONCURRENT_RUNS) throw new HttpError(409, `The computer is busy: ${MAX_CONCURRENT_RUNS} agents are already running. Wait for one to finish or stop one, then try again.`);
    if (input.runtime === 'codex' && (opts.codexMode ?? 'app-server') === 'app-server') return startCodexAppServerRun(entry, p, input, meta, resumeTarget(p, 'codex', input.resumeRunId) ?? undefined);
    if (input.runtime === 'codex') return startCodexRun(entry, p, input, meta, resumeTarget(p, 'codex', input.resumeRunId) ?? undefined);
    const resumeSession = resumeTarget(p, input.runtime, input.resumeRunId);
    const att = attachmentsFor(p, input.attachments);
    if (input.runtime !== 'claude-code') throw new HttpError(409, `Starting ${input.runtime} from the dashboard is not built yet. Run it yourself: its hooks still report here.`);
    if (!hooksInstalled('claude-code', entry.root)) throw new HttpError(409, 'Connect Claude Code to this project first, so its hooks are in place');
    try { checkSlashCommand(input.prompt, reportedCommands('claude-code')); } catch (err) { if (err instanceof CommandRefused) throw new HttpError(409, err.message); throw err; }
    if (!opts.claudeCommand) { const g = mayStartUnder(classifyClaudeMethod(cachedClaudeAuth().method), paidApi); if (!g.ok) throw new HttpError(409, g.reason); }
    const [cmd, ...pre] = opts.claudeCommand ?? ['claude'];
    const args = [...pre, '-p', input.prompt + attachmentNote(att), ...(att.length ? ['--add-dir', attachmentDir(p.stateDir)] : []), ...(resumeSession ? ['--resume', resumeSession] : []), '--model', input.model, ...(dollarCapAllowed('claude-code') ? ['--max-budget-usd', String(input.maxBudgetUsd)] : []), '--output-format', 'stream-json', '--verbose', ...claudeToolArgs(input.policy), '--setting-sources', 'project,local'];
    const where = runCwd(entry, p, input);
    const child = spawn(cmd!, args, { cwd: where.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...agentEnv(process.env, paidApi), ...envCfg.keysFor('claude-code') } });
    const run: Run = { id: `run_${randomBytes(5).toString('hex')}`, project: entry.id, child, started: Date.now(), events: newRunLines(), status: 'running' };
    runs.set(run.id, run);
    p.store.append({ type: 'run.started', actor: { kind: 'human' }, payload: { id: run.id, runtime: input.runtime, ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}), model: input.model, ...(dollarCapAllowed('claude-code') ? { maxBudgetUsd: input.maxBudgetUsd } : {}), maxMinutes: input.maxMinutes, ...(input.resumeRunId ? { resumedFrom: input.resumeRunId } : {}), ...(meta?.planId ? { planId: meta.planId, phaseId: meta.phaseId } : {}), ...(meta?.source ? { source: meta.source } : {}), promptSha256: hash(input.prompt), ...(input.policy !== 'standard' ? { policy: input.policy } : {}) } });
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
          if (o.type === 'result') { result = o; linkSession(p, run, o.session_id); if (o.is_error === true && typeof o.result === 'string') { if (isUsageLimitText(o.result)) run.limitReached = true; run.events.push(`error: ${agentFailureText('claude-code', o.result)}`); } }
          if (o.type === 'system' && o.subtype === 'init') { linkSession(p, run, o.session_id); inits.push({ agent: 'claude-code', model: typeof o.model === 'string' ? o.model : null, commands: Array.isArray(o.slash_commands) ? o.slash_commands.filter((c: unknown): c is string => typeof c === 'string').slice(0, 300) : [], at: Date.now() }); if (inits.length > 20) inits.shift(); }
          const content = o.message?.content;
          const summary = o.type === 'assistant' && Array.isArray(content) ? content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[tool ${c.name}]` : '')).filter(Boolean).join(' ').slice(0, 400) : o.type === 'result' ? `result: ${o.subtype}` : '';
          if (summary) run.events.push(summary);
        } catch { /* a non-JSON line is not an event */ }
      }
    });
    let claudeErr = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { claudeErr = (claudeErr + d).slice(-600); });
    child.on('error', (err) => { run.events.push(`Could not start the agent. ${agentFailureText('claude-code', err.message)}`); run.status = 'failed'; });
    child.on('close', (exit) => { try { if (exit !== 0 && isUsageLimitText(claudeErr)) run.limitReached = true; if (exit !== 0 && claudeErr.trim() && !run.events.some((e) => e.startsWith('error:'))) run.events.push(`Claude Code said: ${agentFailureText('claude-code', claudeErr.trim())}`); } catch { /* ignore */ } try { finishRun(run, p, result, exit); } catch { /* project closed during shutdown */ } });
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
        return { ...r, missing, goal: s.goal?.statement ?? null, lastEventAt: ((h) => (h ? p.store.eventAt(h.seq)?.ts ?? null : null))(p.store.head()), goalVersion: s.goal?.version ?? null, activeTask: t ? { id: t.id, title: t.title, status: p.evaluate(t.id).status } : null, pendingApprovals: [...s.approvals.values()].filter((a) => isPendingLive(a, new Date())).length };
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
    // Finds Git repositories inside ONE folder the person names. It never walks the whole disk, never enters a repository, skips
    // dot-folders and dependency folders, and returns folder names only. An outside page needs a terminal code for it, like any POST.
    if (path === '/api/projects/discover' && method === 'POST') {
      const body = z.object({ dir: z.string().min(1).max(1000), depth: z.number().int().min(1).max(3).default(2) }).parse(await readBody(req));
      if (!isAbsolute(body.dir)) throw new HttpError(400, 'Use an absolute path');
      const top = resolve(body.dir);
      if (dirname(top) === top) throw new HttpError(400, 'Choose a folder such as your code folder, not a whole drive');
      if (!existsSync(top) || !statSync(top).isDirectory()) throw new HttpError(400, 'That folder does not exist');
      return json(res, 200, discoverRepos(top, body.depth, new Set(loadRegistry().map((r) => resolve(r.root)))));
    }
    // Clones a GitHub repository into a new folder, using the person's own git setup. No GitHub credential reaches AgentOnTrack.
    if (path === '/api/projects/clone' && method === 'POST') {
      const body = z.object({ url: z.string().min(1).max(300), dest: z.string().min(1).max(1000) }).parse(await readBody(req));
      const url = parseGithubUrl(body.url);
      if (!url) throw new HttpError(400, 'Use a GitHub address such as https://github.com/owner/repo');
      if (!isAbsolute(body.dest)) throw new HttpError(400, 'Use an absolute path for the new folder');
      const dest = resolve(body.dest);
      const home = resolve(agentontrackHome());
      if (dirname(dest) === dest || dest === resolve(homedir()) || dest === home || dest.startsWith(home + sep)) throw new HttpError(400, 'Choose a new folder for this project');
      if (existsSync(dest) && (!statSync(dest).isDirectory() || readdirSync(dest).length)) throw new HttpError(409, 'That folder already exists and is not empty. Choose a new one.');
      mkdirSync(dirname(dest), { recursive: true });
      const out = await runGit(['clone', '--', url, dest]);
      if (!out.ok) { rmSync(dest, { recursive: true, force: true }); throw new HttpError(409, `Could not clone it: ${out.message}`); }
      return json(res, 200, register(dest));
    }
    if (path === '/api/projects/update' && method === 'POST') {
      const body = z.object({ id: z.string().min(1), name: z.string().min(1).max(120).optional(), archived: z.boolean().optional() }).parse(await readBody(req));
      try { return json(res, 200, updateRegistered(body.id, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) })); } catch (err) { throw new HttpError(404, (err as Error).message); }
    }
    if (path === '/api/agents' && method === 'GET') {
      const { entry } = projectFor(projectId);
      // Through the same cache as /api/runtimes: this page is opened often, and a probe per request stalled the companion for seconds.
      const claudeV = programVersion('claude');
      const codexV = programVersion('codex');
      const hermesV = programVersion('hermes');
      const claude = claudeV ? cachedClaudeAuth() : { authenticated: false, method: null, subscription: null };
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
    // Which agents this companion can really start, and why not for the rest. The interface shows a Run control only where canStart is true.
    if (path === '/api/runtimes' && method === 'GET') {
      const { entry } = projectFor(projectId);
      return json(res, 200, runtimeList(entry.root, !!opts.claudeCommand, !!opts.codexCommand).map((r) => ({ ...r, dollarCap: dollarCapAllowed(r.id) })));
    }
    if (path === '/api/orchestrate' && method === 'POST') {
      const b = z.object({ text: z.string().max(4000), agent: z.string().max(40).default('claude-code') }).parse(await readBody(req));
      const { entry } = projectFor(projectId);
      const rt = runtimeList(entry.root, !!opts.claudeCommand, !!opts.codexCommand).find((r) => r.id === b.agent);
      return json(res, 200, orchestrate(b.text, { agentCanStart: !!rt?.canStart, reportedCommands: reportedCommands(b.agent) }));
    }
    if (path === '/api/discovery' && method === 'GET') {
      const { entry, p } = projectFor(projectId);
      const used: Seen[] = p.store.byType(['usage.recorded']).map((e: any) => ({ agent: String(e.payload.runtime ?? 'claude-code'), model: String(e.payload.model ?? ''), worked: true }));
      return json(res, 200, { agents: describeAgents(runtimeList(entry.root, !!opts.claudeCommand, !!opts.codexCommand), inits), models: await discoverModels({ seen: [...used, ...seenModels], inits }), note: 'A model listed here exists on this computer or was used by a run. Whether your plan allows it is not checked until a run uses it.' });
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
    /**
     * Source code is the most sensitive thing this companion can read. A page on an outside origin may read project files and diffs
     * only after the person allows it from the terminal, for a short time and for one project. The local address and editors are not affected.
     */
    if (method === 'GET' && session.origin && ['/api/files', '/api/file', '/api/worktrees/diff', '/api/spec/check'].includes(path)) {
      const g = session.fileGrant;
      if (!g || g.project !== entry.id || g.until < Date.now()) throw Object.assign(new HttpError(403, "This page is not allowed to read this project's files yet. Allow it for a short time first."), { extra: { needsGrant: true } });
    }
    if (path === '/api/files/grant' && method === 'POST') {
      const b = z.object({ minutes: z.number().int().min(1).max(120).default(30) }).parse(await readBody(req));
      session.fileGrant = { project: entry.id, until: Date.now() + b.minutes * 60_000 };
      return json(res, 200, { until: session.fileGrant.until });
    }
    if (path === '/api/files/revoke' && method === 'POST') { delete session.fileGrant; return json(res, 200, { ok: true }); }
    if (path === '/api/files/status' && method === 'GET') {
      const g = session.fileGrant;
      return json(res, 200, { needed: !!session.origin, granted: !session.origin || (!!g && g.project === entry.id && g.until > Date.now()), until: session.origin ? g?.until ?? null : null });
    }
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
    if (path === '/api/attachments' && method === 'POST') {
      // Raw bytes, so a file need not be wrapped in JSON. Only a local session may upload: a page on another origin cannot put files here.
      const sess = sessionOf(req)?.[1];
      if (!sess || sess.origin || sess.surface) throw new HttpError(403, 'Attachments can be added only from the local dashboard.');
      if (!(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) throw new HttpError(415, 'Send the file bytes as application/octet-stream.');
      const chunks: Buffer[] = []; let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'The file is too large.'); chunks.push(c as Buffer); }
      let name = 'attachment';
      try { name = decodeURIComponent(String(req.headers['x-attachment-name'] ?? 'attachment')); } catch { /* keep the default */ }
      try { const a = saveAttachment(p.stateDir, { name, bytes: Buffer.concat(chunks) }); return json(res, 200, { id: a.id, kind: a.kind, bytes: a.bytes, name: a.name }); }
      catch (err) { if (err instanceof AttachmentError) throw new HttpError(err.status, err.message); throw err; }
    }
    // Which optional settings are set. Names only, never a value.
    if (path === '/api/env-status' && method === 'GET') return json(res, 200, { ...envCfg.describe(), paidApiMode: paidApi });
    if (path === '/api/ask' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 500);
      return json(res, 200, askRecord(p.state(), q, { owner: 'human' }));
    }
    if (path === '/api/notes' && method === 'POST') {
      const b = z.object({ text: z.string().min(1).max(2000), scope: z.enum(['private', 'project']).default('private') }).parse(await readBody(req));
      return json(res, 200, { id: p.addNote(b.text, b.scope, { kind: 'human' }) });
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
      const input = RunInput.parse(await readBody(req));
      const o = startOnce(req, key, '/api/runs', [entry.id, input], () => { const run = startRun(entry, p, input); return { status: 200, body: { id: run.id, status: run.status } }; });
      return json(res, o.status, o.body, o.replay ? { 'idempotent-replay': 'true' } : {});
    }

    // ----- Agent sessions (not the browser pairing sessions): list, read, start a NEW one, continue one, rename/pin/archive.
    const publicSession = (sv: SessionView) => { const { providerSessionId, resumeRunId: _r, ...rest } = sv; return { ...rest, linked: !!providerSessionId }; };
    if (path === '/api/agent-sessions' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim();
      const showArchived = url.searchParams.get('archived') === '1';
      const hits = q ? new Map(searchSessions(p.store.byType(SESSION_EVENTS), q, { live: liveRunIds() }).map((h) => [h.sessionId, h])) : null;
      const list = sessionViews(p).filter((sv) => (showArchived || !sv.archived) && (!hits || hits.has(sv.id)));
      return json(res, 200, { keepTranscripts: keepTranscripts(), sessions: list.map((sv) => ({ ...publicSession(sv), ...(hits?.get(sv.id) ? { match: hits.get(sv.id) } : {}) })) });
    }
    if (path === '/api/agent-sessions' && method === 'POST') {
      const input = RunInput.omit({ resumeRunId: true, sessionId: true }).parse(await readBody(req));
      const o = startOnce(req, key, '/api/agent-sessions', [entry.id, input], () => { const run = startRun(entry, p, input); return { status: 200, body: { sessionId: run.sessionId, runId: run.id, status: run.status } }; });
      return json(res, o.status, o.body, o.replay ? { 'idempotent-replay': 'true' } : {});
    }
    const sessionRoute = /^\/api\/agent-sessions\/(ses_[a-f0-9]{8,32})(?:\/(resume|update))?$/.exec(path);
    if (sessionRoute) {
      const sid = sessionRoute[1]!;
      const sv = sessionViews(p).find((v) => v.id === sid);
      if (!sv) throw new HttpError(404, 'No such session in this project.');
      if (!sessionRoute[2] && method === 'GET') {
        const kept = keepTranscripts() ? p.store.byType(['session.prompt', 'session.message']).filter((e) => e.payload?.sessionId === sid).map((e) => ({ kind: e.type === 'session.prompt' ? 'prompt' : 'message', runId: e.payload.runId, text: e.payload.text, at: e.ts })) : [];
        return json(res, 200, { ...publicSession(sv), runs: sv.runIds.map((id) => { const r = runs.get(id); return { id, status: r?.status ?? null, events: r ? r.events.slice(-40) : [] }; }), transcript: kept });
      }
      if (sessionRoute[2] === 'resume' && method === 'POST') {
        const input = RunInput.omit({ runtime: true, resumeRunId: true, sessionId: true, title: true }).parse(await readBody(req));
        const resumeInput = { ...input, runtime: sv.runtime as 'claude-code' | 'codex', sessionId: sid };
        const o = startOnce(req, key, '/api/agent-sessions/resume', [entry.id, resumeInput], () => { const run = startRun(entry, p, resumeInput); return { status: 200, body: { sessionId: run.sessionId, runId: run.id, status: run.status } }; });
        return json(res, o.status, o.body, o.replay ? { 'idempotent-replay': 'true' } : {});
      }
      if (sessionRoute[2] === 'update' && method === 'POST') {
        const b = z.object({ title: z.string().trim().max(120).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict().refine((x) => Object.keys(x).length > 0, 'Nothing to change').parse(await readBody(req));
        p.store.append({ type: 'session.updated', actor: { kind: 'human' }, payload: { sessionId: sid, ...b } });
        return json(res, 200, publicSession(sessionViews(p).find((v) => v.id === sid)!));
      }
    }

    if (path === '/api/workflows/cross-review' && method === 'POST') {
      const A = z.enum(['claude-code', 'codex']);
      const b = z.object({ builder: A, reviewer: A, prompt: RunInput.shape.prompt, builderModel: RunInput.shape.model, reviewerModel: RunInput.shape.model, taskId: z.string().optional(), maxUsd: z.number().positive().max(5).default(0.5), stop: z.boolean().default(false) }).parse(await readBody(req));
      if (b.stop) return json(res, 200, { stopped: continuing.has(entry.id) && !!(continuing.get(entry.id)!.cancel = true) });
      const o = startOnce(req, key, '/api/workflows/cross-review', [entry.id, b], () => ({ status: 200, body: crossReview(entry, p, b) }));
      return json(res, o.status, o.body, o.replay ? { 'idempotent-replay': 'true' } : {});
    }

    if (path === '/api/workflows/review' && method === 'POST') {
      const b = z.object({ runId: z.string().regex(/^run_[a-z0-9]{1,40}$/), reviewer: z.enum(['claude-code', 'codex']), model: RunInput.shape.model, taskId: z.string().optional(), maxUsd: z.number().positive().max(5).default(0.5) }).parse(await readBody(req));
      const o = startOnce(req, key, '/api/workflows/review', [entry.id, b], () => ({ status: 200, body: reviewRun(entry, p, b) }));
      return json(res, o.status, o.body, o.replay ? { 'idempotent-replay': 'true' } : {});
    }

    /* ---------- Phase plans ---------- */
    const planFacts = () => planFactsOf(entry, p);
    const planView = () => planViewOf(entry, p, (id) => runs.get(id)?.status === 'running');
    if (path === '/api/plan' && method === 'GET') return json(res, 200, { ...planView(), sequence: sequenceView(entry.id) });
    // Saving a draft changes nothing about what is allowed: it grants nothing until a person approves exactly this content.
    if (path === '/api/plan/draft' && method === 'POST') {
      const now = Date.now();
      const hits = (draftHits.get(key) ?? []).filter((t) => now - t < 60_000);
      if (hits.length >= DRAFT_PER_MINUTE) throw new HttpError(429, 'Too many plan drafts in a minute. Wait a little and try again.');
      hits.push(now); draftHits.set(key, hits);
      if (JSON.stringify(await readBody(req)).length > MAX_DRAFT_BYTES) throw new HttpError(413, 'That plan draft is too large.');
      const b = z.object({ goal: z.string().min(1).max(2000).optional(), plan: z.unknown().optional(), expectVersion: z.number().int().min(0).optional(), agents: z.record(z.string(), z.object({ agent: z.string(), model: z.string().optional() })).optional() }).parse(await readBody(req));
      try {
        const doc = b.plan !== undefined ? b.plan : decompose(b.goal ?? '', planFacts(), { id: `plan-${(s().plan?.version ?? 0) + 1}`, ...(b.agents ? { agents: b.agents as never } : {}) });
        if (b.plan === undefined && !b.goal) throw new Error('Give a goal, or a plan');
        return json(res, 200, { ...p.savePlan(doc, b.expectVersion), ...planView() });
      } catch (err) { throw new HttpError(err instanceof z.ZodError ? 400 : 409, err instanceof z.ZodError ? `That plan is not valid: ${err.issues.map((i) => i.message).slice(0, 3).join('; ')}` : (err as Error).message); }
    }
    if (path === '/api/plan/phases/start' && method === 'POST') {
      const b = z.object({ phaseId: z.string(), extra: z.string().max(2000).default('') }).parse(await readBody(req));
      // Exactly one run per request, and no client-supplied flag changes that. TRUST BOUNDARY: separate manually authorized requests from a paired session are
      // indistinguishable from a person clicking Start each time. Only sequences this companion runs itself (/api/plan/continue, /api/plan/loop) are chained, and those need a grant.
      try {
        const o = startOnce(req, key, '/api/plan/phases/start', [entry.id, b], () => { const run = startPhaseRun(entry, p, b.phaseId, b.extra); return { status: 200, body: { id: run.id, status: run.status } }; });
        return json(res, o.status, o.body, o.replay ? { 'idempotent-replay': 'true' } : {});
      }
      catch (err) { if (err instanceof PhaseBlocked) throw new HttpError(err.status, err.message); throw err; }
    }
    if (path === '/api/plan/loop' && method === 'POST') {
      const b = z.object({ phaseId: z.string(), rounds: z.number().int().min(1).max(5).default(3), stop: z.boolean().default(false) }).parse(await readBody(req));
      if (b.stop) return json(res, 200, { stopped: continuing.has(entry.id) && !!(continuing.get(entry.id)!.cancel = true) });
      try { return json(res, 200, loopPhase(entry, p, b.phaseId, b.rounds, 'desktop')); }
      catch (err) { if (err instanceof PhaseBlocked) throw new HttpError(err.status, err.message); throw err; }
    }
    // The same function the phone action plan.continue calls. The page only starts it and then polls GET /api/plan (its `sequence` field) for progress.
    if (path === '/api/plan/continue' && method === 'POST') {
      const b = z.object({ maxPhases: z.number().int().min(1).max(10).default(1), stop: z.boolean().default(false) }).parse(await readBody(req));
      if (b.stop) return json(res, 200, { stopped: continuing.get(entry.id)?.kind === 'sequence' && !!(continuing.get(entry.id)!.cancel = true) });
      try { return json(res, 200, continuePlan(entry, p, b.maxPhases, 'desktop')); }
      catch (err) { if (err instanceof PhaseBlocked) throw new HttpError(err.status, err.message); throw err; }
    }
    if (path === '/api/plan/phases/prompt' && method === 'GET') {
      const view = planView();
      const phase = view.plan?.phases.find((x) => x.id === url.searchParams.get('phaseId'));
      if (!view.plan || !phase) throw new HttpError(404, 'No such phase');
      return json(res, 200, { prompt: phasePrompt(view.plan, phase) });
    }
    if (path === '/api/plan/phases/verify' && method === 'POST') {
      const b = z.object({ phaseId: z.string() }).parse(await readBody(req));
      const phase = s().plan?.doc.phases.find((x: any) => x.id === b.phaseId);
      if (!phase) throw new HttpError(404, 'No such phase');
      if (!phase.taskId || !phase.acceptance.some((a: any) => a.kind === 'command') || s().plan!.approvedSha !== planSha(PhasePlanSchema.parse(s().plan!.doc))) throw new HttpError(409, 'This phase has no check to run, or the plan changed since it was approved.');
      p.verifyTask(phase.taskId);
      return json(res, 200, planView());
    }
    /* ---------- The phone link, from the desktop ---------- */
    const RemoteHuman = { challengeId: z.string(), ...HumanFields };
    /** A change that gives a phone something needs a person here, with the usual confirmation, then runs, and always locks the approver again. */
    const humanThen = async <S extends z.ZodType<any>>(schema: S, action: (b: z.infer<S>) => string, fn: (b: z.infer<S>) => Promise<unknown>) => {
      const body = schema.parse(await readBody(req));
      requireHumanProof(req, key, body, p, action(body));
      try { return json(res, 200, await fn(body)); } catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(409, (err as Error).message); } finally { p.lock(); }
    };
    if (path === '/api/remote/status' && method === 'GET') {
      const file = remoteFileNow();
      if (!file) return json(res, 200, { exists: false });
      const fp = await fingerprintOf(file.identity.pub);
      if (remote) return json(res, 200, { exists: true, linked: true, ...(await remote.status()), defaultProject: defaultProjectView(file.defaultProject ?? null) });
      return json(res, 200, { exists: true, linked: !!file.link, running: false, online: false, lastError: file.link ? 'Starting, or not reachable yet' : '', degraded: null, computerId: file.computerId, name: file.name, fingerprint: fp, devices: [], pending: [], maxUsdPerRun: file.maxUsdPerRun, defaultProject: defaultProjectView(file.defaultProject ?? null) });
    }
    if (path === '/api/remote/prepare' && method === 'POST') {
      let file = remoteFileNow();
      if (!file) { file = await newRemoteFile(hostname().slice(0, 50) || 'This computer'); saveRemote(file); }
      return json(res, 200, { computerId: file.computerId, name: file.name, pub: file.identity.pub, fingerprint: await fingerprintOf(file.identity.pub), linked: !!file.link });
    }
    if (path === '/api/remote/link' && method === 'POST') {
      return humanThen(z.object({ uid: z.string().min(1).max(128), computerUid: z.string().min(1).max(128), email: z.string().email().max(200), password: z.string().min(8).max(200), firebase: z.object({ apiKey: z.string().min(1).max(200), projectId: z.string().min(1).max(100), authDomain: z.string().max(200).optional(), appId: z.string().max(200).optional() }), ...RemoteHuman }),
        (b) => `link this computer to the account ${b.uid.slice(0, 6)}… so a phone signed in to it can ask this computer for things (each phone is still approved here one by one)`,
        async (b) => {
          const file = remoteFileNow();
          if (!file) throw new HttpError(409, 'Prepare this computer first');
          if (remote) { await remote.stop(); remote = null; }
          file.link = { uid: b.uid, firebase: b.firebase, computer: { email: b.email, password: b.password }, linkedAt: new Date().toISOString() };
          saveRemote(file);
          try { remote = await makeRemote(file); } catch (err) { delete file.link; saveRemote(file); throw new HttpError(409, `Could not connect to Firebase with that link: ${(err as Error).message}`); }
          return { linked: true, ...(await remote.status()) };
        });
    }
    if (path === '/api/remote/devices/trust' && method === 'POST') {
      return humanThen(z.object({ did: z.string().min(1).max(64), level: z.enum(['view', 'control']), fingerprint: z.string().min(10).max(40), ...RemoteHuman }),
        (b) => `trust the phone ${b.did.slice(0, 8)}\u2026 with fingerprint ${b.fingerprint}, to ${b.level === 'control' ? 'look and control (start and stop runs, pause, continue, decline approvals, approve small file writes)' : 'look only'}`,
        async (b) => {
          if (!remote) throw new HttpError(409, 'This computer is not linked to an account yet');
          // What the person looked at is what is trusted: if the phone's key changed since, the fingerprints differ and nothing is trusted.
          const waiting = (await remote.status()).pending.find((d) => d.did === b.did);
          if (!waiting || waiting.fingerprint !== b.fingerprint) throw new HttpError(409, 'That phone changed or is no longer waiting. Look at its fingerprint again.');
          await remote.trust(b.did, b.level);
          return remote.status();
        });
    }
    if (path === '/api/remote/devices/level' && method === 'POST') {
      return humanThen(z.object({ did: z.string().min(1).max(64), level: z.enum(['view', 'control']), ...RemoteHuman }), (b) => `change what the phone ${b.did.slice(0, 8)}\u2026 may do to ${b.level}`,
        async (b) => { if (!remote?.host.setLevel(b.did, b.level)) throw new HttpError(404, 'No such phone'); return remote.status(); });
    }
    if (path === '/api/remote/settings' && method === 'POST') {
      return humanThen(z.object({ maxUsdPerRun: z.number().min(0.05).max(5).optional(), name: z.string().min(1).max(50).optional(), defaultProjectId: z.string().regex(/^[a-f0-9]{24}$/).nullable().optional(), ...RemoteHuman }), (b) => `change the phone link's settings: ${JSON.stringify({ maxUsdPerRun: b.maxUsdPerRun, name: b.name })}${b.defaultProjectId === undefined ? '' : b.defaultProjectId === null ? '; clear the default project for phone sessions' : (() => { const r = loadRegistry().find((x) => x.id === b.defaultProjectId); return r ? `; let a phone start new sessions in "${r.name}" (${r.root}) when it asks for the default project` : '; set a default project that is not registered (this will be refused)'; })()}`,
        async (b) => {
          const file = remoteFileNow(); if (!file) throw new HttpError(409, 'Nothing to change');
          if (b.maxUsdPerRun) file.maxUsdPerRun = b.maxUsdPerRun;
          if (b.name) file.name = b.name;
          if (b.defaultProjectId !== undefined) {
            if (b.defaultProjectId === null) file.defaultProject = null;
            else {
              // A registered, unarchived project whose folder exists. The path is recorded here, on this computer, resolved to its real location; a phone cannot supply one.
              const r = loadRegistry().find((x) => x.id === b.defaultProjectId);
              if (!r || r.archived) throw new HttpError(404, 'That project is not registered here, or is archived.');
              let real: string; try { real = realpathSync.native(r.root); } catch { throw new HttpError(409, 'That project\'s folder cannot be found.'); }
              file.defaultProject = { projectId: r.id, realRoot: real, setAt: new Date().toISOString() };
            }
          }
          saveRemote(file);
          if (remote) { remote.host.state.maxUsdPerRun = file.maxUsdPerRun; remote.host.state.name = file.name; remote.host.state.defaultProject = file.defaultProject ?? null; }
          return { ok: true, defaultProject: defaultProjectView(file.defaultProject ?? null) };
        });
    }
    // Taking access away needs no ceremony: it only ever does less.
    if (path === '/api/remote/devices/revoke' && method === 'POST') {
      const b = z.object({ did: z.string().min(1).max(64) }).parse(await readBody(req));
      if (!remote || !(await remote.revoke(b.did))) throw new HttpError(404, 'No such phone');
      return json(res, 200, await remote.status());
    }
    if (path === '/api/remote/unlink' && method === 'POST') {
      const file = remoteFileNow();
      if (remote) { for (const d of (await remote.status()).devices.filter((x) => !x.revokedAt)) await remote.revoke(d.did); await remote.stop(); remote = null; }
      if (file) { delete file.link; saveRemote(file); }
      return json(res, 200, { linked: false });
    }
    const stop = /^\/api\/runs\/(run_\w+)\/stop$/.exec(path);
    if (stop && method === 'POST') {
      const run = runs.get(stop[1]!);
      if (!run || run.project !== entry.id) throw new HttpError(404, 'No such run');
      // The same rule as the phone's stop: only a running run can be stopped, and "stopped" is said only once the process has gone.
      const out = await stopRunNow(run);
      if (!out.ok) throw new HttpError(out.kind === 'not-running' ? 409 : 500, out.reason);
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
      '/api/plan/approve': { schema: z.object({ sha256: z.string().length(64), expectVersion: z.number().int().min(1), challengeId: z.string(), ...HumanFields }), action: (b) => `approve plan version ${b.expectVersion} (${b.sha256.slice(0, 12)})`, run: (b) => { p.human.approvePlan(b.sha256, b.expectVersion); return planView(); } },
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
      const g = grantOf(entry.id);
      return json(res, 200, { ...st, unattended: { active: 'grant' in g, reason: 'problem' in g ? g.problem : null, grant: st.unattendedGrant ?? null }, sessions: [...sessions.entries()].map(([k, v]) => ({ id: k.slice(0, 8), current: k === key, createdAt: v.createdAt, expiresAt: v.expiresAt, userAgent: v.userAgent })) });
    }
    if (path === '/api/settings' && method === 'POST') {
      const body = z.object({ telemetry: z.boolean().optional(), diagnostics: z.boolean().optional(), keepTranscripts: z.boolean().optional(), theme: z.enum(['dark', 'light']).optional(), environment: z.object({ show: z.boolean(), userGridGCo2PerKwh: z.number().nonnegative().nullable() }).optional() }).parse(await readBody(req));
      saveSettings({ ...loadSettings(), ...body } as Settings);
      return json(res, 200, { ok: true });
    }
    // Not part of /api/settings on purpose: this one needs the terminal-code proof, from every caller, local or outside.
    if (path === '/api/settings/unattended' && method === 'POST') {
      return humanThen(z.object({ allow: z.boolean(), hours: z.number().positive().max(GRANT_MAX_HOURS).optional(), maxRuns: z.number().int().min(1).max(10).optional(), maxPhasesPerSequence: z.number().int().min(1).max(10).optional(), maxRounds: z.number().int().min(1).max(5).optional(), ...RemoteHuman }),
        (b) => b.allow ? `allow unattended runs for THIS project, for up to ${b.hours ?? GRANT_DEFAULT_HOURS} hours and ${b.maxRuns ?? 5} runs: plans may continue or retry for several phases or rounds with nobody acting between the runs. Even then they only run with an API-key sign-in and paid API mode; provider permission for unattended subscription automation is unresolved.` : 'cancel the unattended-runs grant and stop any sequence it is running',
        async (b) => {
          if (!b.allow) {
            saveSettings({ ...loadSettings(), unattendedGrant: null });
            // Cancelling aborts a running sequence (and the agent it is waiting on) at its next poll; a single-run start is not a sequence and is left alone.
            for (const c of continuing.values()) if (c.kind === 'sequence' && c.chained) c.cancel = true;
            return { ok: true, unattended: { active: false, grant: null } };
          }
          const now = Date.now(); const maxRuns = b.maxRuns ?? 5;
          const unattendedGrant: UnattendedGrant = { projectId: entry.id, maxRuns, remainingRuns: maxRuns, maxPhasesPerSequence: Math.min(b.maxPhasesPerSequence ?? maxRuns, 10), maxRounds: b.maxRounds ?? 3, expiresAt: new Date(now + (b.hours ?? GRANT_DEFAULT_HOURS) * 3_600_000).toISOString(), createdAt: new Date(now).toISOString() };
          saveSettings({ ...loadSettings(), unattendedGrant });
          return { ok: true, unattended: { active: true, grant: unattendedGrant } };
        });
    }
    // Phone-started agents are off until a person turns them on here, with the same proof. Viewing, stopping and approving from a phone do not depend on it.
    if (path === '/api/settings/mobile-execution' && method === 'POST') {
      return humanThen(z.object({ allow: z.boolean(), ...RemoteHuman }),
        (b) => b.allow ? 'allow a paired phone to START agent runs and sessions on this computer (viewing, stopping and approving stay as they are)' : 'stop phones from starting agent runs and sessions',
        async (b) => { saveSettings({ ...loadSettings(), allowMobileExecution: b.allow }); return { ok: true, allowMobileExecution: b.allow }; });
    }
    if (path === '/api/data/export' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="agentontrack-${entry.id}.json"`, 'cache-control': 'no-store' });
      res.end(JSON.stringify({ exportedAt: new Date().toISOString(), project: entry, events: p.store.all() }));
      return;
    }
    if (path === '/api/feedback' && method === 'POST') {
      const body = z.object({ rating: z.enum(['helpful', 'not-helpful']).nullable(), text: z.string().max(4000).default(''), contact: z.string().max(200).default(''), mayQuote: z.boolean().default(false) }).parse(await readBody(req));
      const file = join(agentontrackHome(), 'feedback.jsonl');
      // An outside page may post feedback without a terminal code, so the file is bounded: it cannot be used to fill the disk.
      try { if (statSync(file).size > MAX_FEEDBACK_FILE) throw new HttpError(429, 'The local feedback file is full. Delete or move feedback.jsonl in the AgentOnTrack data folder.'); } catch (err) { if (err instanceof HttpError) throw err; /* no file yet */ }
      mkdirSync(agentontrackHome(), { recursive: true });
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
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-agentontrack-csrf', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600' });
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
      for (const c of continuing.values()) c.cancel = true;
      try { await remote?.stop(); } catch { /* closing */ }
      for (const r of runs.values()) { if (r.status === 'running') killChild(r.child); }
      for (const t of streams) clearInterval(t);
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      for (const p of projects.values()) { try { p.close(); } catch { /* already closed */ } }
    },
  };
}
