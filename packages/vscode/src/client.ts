/**
 * The extension's whole conversation with the companion, with no editor in it, so it can be tested against the real companion.
 * It sends its token only to this machine.
 */

export class NeedsCode extends Error {
  constructor(readonly challengeId: string, readonly action: string) { super('Enter the code shown in your terminal'); }
}

export class CompanionError extends Error {
  constructor(readonly status: number, message: string, readonly data: Record<string, unknown> = {}) { super(message); }
}

/** The companion is on this machine. Anything else is refused, so a changed setting cannot send the token elsewhere. */
export function checkCompanionUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`Not a web address: ${raw}`); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('The companion address must be http://127.0.0.1 or http://localhost, because it runs on this machine.');
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) throw new Error('The companion address is only a host and a port.');
  return `${u.protocol}//${u.host}`;
}

export interface Session { token: string; csrf: string }

export type Fetch = typeof fetch;

export class CompanionClient {
  readonly base: string;
  constructor(base: string, private session: Session | null = null, private readonly fetchImpl: Fetch = fetch) { this.base = checkCompanionUrl(base); }

  get connected(): boolean { return !!this.session; }
  getSession(): Session | null { return this.session; }

  /** Pairing names this as an editor, which is why the companion will not let it confirm anything itself. */
  async pair(code: string): Promise<Session> {
    const r = await this.fetchImpl(`${this.base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentontrack-surface': 'editor' }, body: JSON.stringify({ code: code.trim().toUpperCase() }) });
    const body = await r.json().catch(() => ({})) as { token?: string; csrf?: string; error?: string };
    if (!r.ok || !body.token || !body.csrf) throw new CompanionError(r.status, body.error ?? `Pairing failed (${r.status})`);
    this.session = { token: body.token, csrf: body.csrf };
    return this.session;
  }

  forget(): void { this.session = null; }

  private headers(json: boolean): Record<string, string> {
    if (!this.session) throw new CompanionError(401, 'Not connected');
    return { authorization: `Bearer ${this.session.token}`, 'x-agentontrack-csrf': this.session.csrf, ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  private qs(path: string, project?: string): string {
    return project ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : path;
  }

  private async read<T>(r: Response): Promise<T> {
    const body = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (r.status === 428) throw new NeedsCode(String(body.challengeId ?? ''), String(body.action ?? ''));
    if (r.status === 401) this.session = null;
    if (!r.ok) throw new CompanionError(r.status, String(body.error ?? `Request failed (${r.status})`), body);
    return body as T;
  }

  async get<T = any>(path: string, project?: string): Promise<T> {
    return this.read<T>(await this.fetchImpl(`${this.base}${this.qs(path, project)}`, { headers: this.headers(false) }));
  }

  /** A change. The companion answers with the need for a code from the terminal, and does nothing until it has one. */
  async post<T = any>(path: string, body: Record<string, unknown>, project?: string): Promise<T> {
    return this.read<T>(await this.fetchImpl(`${this.base}${this.qs(path, project)}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) }));
  }

  /** The two-step: ask, show the person what was asked, take the code they read in their terminal, send it with the same request. */
  async postConfirmed<T = any>(path: string, body: Record<string, unknown>, askCode: (action: string) => Promise<string | undefined>, project?: string): Promise<T | undefined> {
    try { return await this.post<T>(path, body, project); } catch (err) {
      if (!(err instanceof NeedsCode)) throw err;
      const confirm = await askCode(err.action);
      if (!confirm) return undefined;
      return this.post<T>(path, { ...body, challengeId: err.challengeId, confirm: confirm.trim() }, project);
    }
  }
}

export interface Snapshot {
  connected: boolean;
  projectId: string | null;
  goal: { version: number; statement: string } | null;
  task: { id: string; title: string; status: string; criteria: { id: string; state: string }[] } | null;
  pending: { id: string; kind: string; target: string; runtime: string; reason: string | null }[];
  team: { version: number; members: { agent: string; role: string }[] };
  handoffs: { id: string; from: string; to: string | null; task: string; outcome: string }[];
  usage: { input: number; output: number; sessions: number } | null;
  head: number;
  integrityOk: boolean;
}

/** Everything the sidebar shows, in one read of the companion, so every view agrees. */
export async function snapshot(c: CompanionClient, project: string | undefined): Promise<Snapshot> {
  const [state, handoffs, analytics] = await Promise.all([c.get('/api/state', project), c.get('/api/handoffs', project), c.get('/api/analytics', project)]);
  const t = state.activeTask;
  return {
    connected: true, projectId: state.project?.id ?? null,
    goal: state.goal ? { version: state.goal.version, statement: state.goal.statement } : null,
    task: t ? { id: t.id, title: t.title, status: t.evaluation.status, criteria: t.evaluation.criteria.map((x: any) => ({ id: x.id, state: x.state })) } : null,
    pending: state.approvals.filter((a: any) => a.view === 'pending').map((a: any) => ({ id: a.id, kind: a.effect.kind, target: a.effect.target, runtime: a.runtime, reason: a.reason ?? null })),
    team: { version: state.team?.version ?? 0, members: (state.team?.members ?? []).map((m: any) => ({ agent: m.agent, role: m.role })) },
    handoffs, usage: analytics.totals ? { input: analytics.totals.input, output: analytics.totals.output, sessions: analytics.totals.sessions } : null,
    head: state.head, integrityOk: !!state.integrity?.ok,
  };
}

/** The prompts the editor commands send. Each says what it may not do, since an agent is told only what it is told. */
export function selectionPrompt(kind: 'review' | 'explain' | 'fix' | 'tests', file: string, startLine: number, endLine: number, code: string): string {
  const MAX = 12_000;
  const body = code.length > MAX ? `${code.slice(0, MAX)}\n… (cut: ${code.length - MAX} more characters)` : code;
  const where = `${file}, lines ${startLine} to ${endLine}`;
  const head = {
    review: `Review this code from ${where}. List real problems and risks, with the line for each. Do not change any file.`,
    explain: `Explain this code from ${where}, in plain language. Do not change any file.`,
    fix: `Fix the problem in this code from ${where}. Change only what is needed, and only inside the approved scope. Say what you changed.`,
    tests: `Write tests for this code from ${where}, in the project's own test style. Add them in the project's test folder, and run them.`,
  }[kind];
  return `${head}\n\n\`\`\`\n${body}\n\`\`\``;
}
