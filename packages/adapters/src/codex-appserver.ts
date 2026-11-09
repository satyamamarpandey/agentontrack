/**
 * Codex through `codex app-server`: JSON-RPC messages, one per line, over the child's stdin and stdout. This is the interface that lets an
 * action wait for an answer, so an approval is enforced at the moment Codex asks to run it.
 *
 * Written from the public Codex app-server documentation and its generated schema as remembered; NOT TESTED against a real Codex (none is
 * installed on the build machine). Method and field names are therefore treated as unconfirmed: anything unrecognised is ignored, an
 * approval request that cannot be understood is declined, and nothing here ever answers "accept for session". The fixture test in
 * test/codex-appserver.test.ts drives a script that speaks this protocol; it proves this client's behaviour, not Codex's.
 *
 * Authentication is Codex's own (`codex login`, ChatGPT subscription). Nothing here reads, copies or forwards a login file or token.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { LineSplitter } from './codex-exec.js';
import { killTree } from './proctree.js';

export type ApprovalKind = 'command' | 'file';
export interface ApprovalRequest { kind: ApprovalKind; threadId: string; itemId: string; command?: string; cwd?: string; reason?: string; paths?: string[] }
/** Only a one-time accept or a decline exists. There is deliberately no way to grant for a session. */
export type ApprovalAnswer = 'accept' | 'decline';

export type AppServerEvent =
  | { kind: 'session'; threadId: string }
  | { kind: 'turn'; status: 'started' | 'completed' | 'interrupted' | 'failed'; turnId?: string }
  | { kind: 'message'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; tool: 'shell' | 'file' | 'mcp' | 'web' | 'other'; summary: string; phase: 'started' | 'completed'; /** Only on a completed command: how it ended, so a command that failed or was declined is not mistaken for one that worked. */ outcome?: { status: string; exitCode?: number; output?: string } }
  | { kind: 'usage'; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
  | { kind: 'approval'; request: ApprovalRequest; answer: ApprovalAnswer }
  | { kind: 'error'; message: string };

export interface AppServerOptions {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  /** The OS sandbox. A policy may only narrow it: `read-only` is the narrower. */
  sandbox?: 'workspace-write' | 'read-only';
  /** Called for every approval Codex asks for. A throw, a timeout or a malformed request is a decline. */
  onApproval: (r: ApprovalRequest) => Promise<ApprovalAnswer>;
  onEvent: (e: AppServerEvent) => void;
  approvalTimeoutMs?: number;
  /** Per-request wait for a reply from the server, so a hung server cannot hang the run forever. */
  rpcTimeoutMs?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const THREAD = /^[\w-]{8,80}$/;
const MODEL = /^\w[\w.:-]{0,79}$/;

function itemTool(item: any): { tool: 'shell' | 'file' | 'mcp' | 'web' | 'other'; summary: string } | null {
  const t = str(item?.type);
  if (t === 'commandExecution') return { tool: 'shell', summary: str(item.command).slice(0, 300) };
  if (t === 'fileChange') return { tool: 'file', summary: Array.isArray(item.changes) ? item.changes.map((c: any) => str(c?.path)).filter(Boolean).join(', ').slice(0, 300) : 'file change' };
  if (t === 'mcpToolCall') return { tool: 'mcp', summary: `${str(item.server)}/${str(item.tool)}`.slice(0, 300) };
  if (t === 'webSearch') return { tool: 'web', summary: str(item.query).slice(0, 300) };
  if (t === 'agentMessage' || t === 'reasoning' || t === 'userMessage' || !t) return null;
  return { tool: 'other', summary: t };
}

/** One server notification to zero or more events. Unknown methods and odd shapes give nothing. */
export function mapNotification(method: string, params: any): AppServerEvent[] {
  switch (method) {
    case 'thread/started': return THREAD.test(str(params?.thread?.id)) ? [{ kind: 'session', threadId: params.thread.id }] : [];
    case 'turn/started': return [{ kind: 'turn', status: 'started', turnId: str(params?.turn?.id) || undefined } as AppServerEvent];
    case 'turn/completed': {
      const s = str(params?.turn?.status);
      const status = s === 'interrupted' ? 'interrupted' : s === 'failed' ? 'failed' : 'completed';
      const out: AppServerEvent[] = [{ kind: 'turn', status }];
      const msg = str(params?.turn?.error?.message);
      if (status === 'failed') out.push({ kind: 'error', message: (msg || 'The turn failed').slice(0, 500) });
      return out;
    }
    case 'item/agentMessage/delta': return str(params?.delta) ? [{ kind: 'delta', text: str(params.delta).slice(0, 4000) }] : [];
    case 'item/started': case 'item/completed': {
      const phase = method === 'item/started' ? 'started' : 'completed';
      if (params?.item?.type === 'agentMessage') return phase === 'completed' ? [{ kind: 'message', text: str(params.item.text).slice(0, 4000) }] : [];
      const t = itemTool(params?.item);
      const it = params?.item;
      const outcome = phase === 'completed' && it?.type === 'commandExecution' ? { status: str(it.status) || 'unknown', ...(typeof it.exitCode === 'number' ? { exitCode: it.exitCode } : {}), ...(str(it.aggregatedOutput) ? { output: str(it.aggregatedOutput).slice(-300) } : {}) } : undefined;
      return t ? [{ kind: 'tool', ...t, phase, ...(outcome ? { outcome } : {}) }] : [];
    }
    case 'thread/tokenUsage/updated': {
      const u = params?.tokenUsage?.total;
      return u && typeof u === 'object' ? [{ kind: 'usage', inputTokens: num(u.inputTokens), cachedInputTokens: num(u.cachedInputTokens), outputTokens: num(u.outputTokens), reasoningOutputTokens: num(u.reasoningOutputTokens) }] : [];
    }
    case 'error': return [{ kind: 'error', message: (str(params?.error?.message) || str(params?.message) || 'Codex reported an error').slice(0, 500) }];
    default: return [];
  }
}

/** Server-initiated approval request to our request type, or null when it cannot be understood (which the caller declines). */
export function parseApprovalRequest(method: string, params: any): ApprovalRequest | null {
  if (!params || typeof params !== 'object') return null;
  const base = { threadId: str(params.threadId), itemId: str(params.itemId), ...(str(params.reason) ? { reason: str(params.reason).slice(0, 500) } : {}) };
  if (method === 'item/commandExecution/requestApproval') {
    const command = Array.isArray(params.command) ? params.command.map(str).join(' ') : str(params.command);
    if (!command) return null;
    return { kind: 'command', ...base, command: command.slice(0, 2000), ...(str(params.cwd) ? { cwd: str(params.cwd) } : {}) };
  }
  if (method === 'item/fileChange/requestApproval') {
    const paths = Array.isArray(params.changes) ? params.changes.map((c: any) => str(c?.path)).filter(Boolean) : [];
    if (str(params.grantRoot)) paths.push(str(params.grantRoot));
    return { kind: 'file', ...base, paths: paths.slice(0, 50) };
  }
  return null;
}

export interface TurnInput { prompt: string; images?: string[] }

export class CodexAppServer {
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private split = new LineSplitter();
  threadId: string | null = null;
  private turnId: string | null = null;
  private turnDone: ((s: 'completed' | 'interrupted' | 'failed') => void) | null = null;
  private closed = false;
  exitCode: number | null = null;

  constructor(private o: AppServerOptions) {}

  private send(msg: object): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private request(method: string, params: object): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex did not answer ${method}`)); }, this.o.rpcTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private onLine(line: string): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.method === 'string' && m.id !== undefined) { void this.onServerRequest(m.id, m.method, m.params); return; }
    if (typeof m.method === 'string') {
      for (const e of mapNotification(m.method, m.params)) {
        this.o.onEvent(e);
        if (e.kind === 'turn' && e.status !== 'started') this.turnDone?.(e.status);
        if (e.kind === 'turn' && e.status === 'started' && (e as any).turnId) this.turnId = (e as any).turnId;
      }
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(str(m.error?.message) || 'Codex returned an error'));
      else p.resolve(m.result);
    }
  }

  private async onServerRequest(id: unknown, method: string, params: any): Promise<void> {
    const req = parseApprovalRequest(method, params);
    if (!req) {
      // Not an approval we understand. Declining is the safe answer to an approval-shaped request; any other server request gets an error reply.
      if (method.endsWith('requestApproval')) { this.send({ id, result: { decision: 'decline' } }); this.o.onEvent({ kind: 'error', message: `Declined a ${method} that could not be understood` }); }
      else this.send({ id, error: { code: -32601, message: 'Not supported by AgentOnTrack' } });
      return;
    }
    let answer: ApprovalAnswer = 'decline';
    // A read-only run never has an approval accepted, whatever the callback would say: the narrowing must not depend on the callback.
    if (this.o.sandbox === 'read-only') { this.o.onEvent({ kind: 'approval', request: req, answer: 'decline' }); this.send({ id, result: { decision: 'decline' } }); return; }
    try {
      answer = await Promise.race([
        this.o.onApproval(req),
        new Promise<ApprovalAnswer>((r) => setTimeout(() => r('decline'), this.o.approvalTimeoutMs ?? 10 * 60_000).unref()),
      ]);
    } catch { answer = 'decline'; }
    if (answer !== 'accept') answer = 'decline';
    this.o.onEvent({ kind: 'approval', request: req, answer });
    this.send({ id, result: { decision: answer === 'accept' ? 'accept' : 'decline' } });
  }

  /** Starts the process and the thread (or resumes one). Rejects if the server does not follow the handshake. */
  async start(resumeThreadId?: string): Promise<string> {
    if (this.o.model !== undefined && !MODEL.test(this.o.model)) throw new Error('Not a model name');
    if (resumeThreadId !== undefined && !THREAD.test(resumeThreadId)) throw new Error('Not a session id');
    const [cmd, ...pre] = this.o.command;
    this.child = spawn(cmd!, [...pre, 'app-server'], { cwd: this.o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.o.env ?? process.env });
    this.child.stdout!.setEncoding('utf8').on('data', (d: string) => { for (const l of this.split.push(d)) this.onLine(l); });
    this.child.stderr!.resume();
    this.child.on('error', (e) => this.fail(new Error(`Could not start Codex: ${e.message}`)));
    this.child.on('close', (code) => { this.exitCode = code; this.closed = true; this.fail(new Error('Codex exited')); this.turnDone?.('failed'); });
    await this.request('initialize', { clientInfo: { name: 'agentontrack', title: 'AgentOnTrack', version: '1.0.0' } });
    this.send({ method: 'initialized', params: {} });
    // `untrusted` makes Codex ask before anything it does not know to be safe; `workspace-write` keeps the OS sandbox on as a second layer.
    const common = { cwd: this.o.cwd, approvalPolicy: 'untrusted', sandbox: this.o.sandbox ?? 'workspace-write', ...(this.o.model && this.o.model !== 'default' ? { model: this.o.model } : {}) };
    const r = resumeThreadId ? await this.request('thread/resume', { threadId: resumeThreadId, ...common }) : await this.request('thread/start', common);
    const id = str(r?.thread?.id);
    if (!THREAD.test(id)) throw new Error('Codex did not return a session id');
    this.threadId = id;
    this.o.onEvent({ kind: 'session', threadId: id });
    return id;
  }

  /** Sends one prompt and resolves when the turn ends. */
  async turn(input: TurnInput): Promise<'completed' | 'interrupted' | 'failed'> {
    if (!this.threadId) throw new Error('Not started');
    const done = new Promise<'completed' | 'interrupted' | 'failed'>((r) => { this.turnDone = r; });
    const items = [{ type: 'text', text: input.prompt }, ...(input.images ?? []).map((path) => ({ type: 'localImage', path }))];
    try { await this.request('turn/start', { threadId: this.threadId, input: items }); } catch (e) { this.turnDone = null; throw e; }
    return done;
  }

  /** Asks Codex to stop the current turn; the process is killed if it does not end the turn in time. */
  async interrupt(graceMs = 3000): Promise<void> {
    if (this.threadId && this.turnId) { try { await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); } catch { /* fall through to kill */ } }
    await new Promise((r) => setTimeout(r, graceMs).unref());
    this.kill();
  }

  kill(): void { if (!this.closed) { killTree(this.child?.pid); this.child?.kill(); } }

  private fail(e: Error): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id); }
  }
}
