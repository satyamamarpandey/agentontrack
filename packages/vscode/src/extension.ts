import * as vscode from 'vscode';
import { CompanionClient, CompanionError, NeedsCode, selectionPrompt, snapshot, type Snapshot } from './client.js';

/**
 * The editor surface. It shows what the companion has, and asks the companion for changes. It cannot confirm a change itself: the code
 * for that is shown in the terminal where `agentontrack dashboard` runs, and typed here by the person.
 */

const SECRET = 'agentontrack.session';
const COMMON_FILES = ['AGENTS.md', 'CLAUDE.md', 'GOAL.md', 'DECISIONS.md', 'HANDOFF.md', 'EVALS.md', 'SAFETY.md'];

export interface Api {
  snapshot(): Snapshot | null;
  refresh(): Promise<void>;
  client(): CompanionClient | null;
}

class Section implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly items: () => vscode.TreeItem[]) {}
  fire(): void { this.changed.fire(); }
  getTreeItem(e: vscode.TreeItem): vscode.TreeItem { return e; }
  getChildren(): vscode.TreeItem[] { return this.items(); }
}

const leaf = (label: string, description?: string, o: Partial<vscode.TreeItem> = {}): vscode.TreeItem => Object.assign(new vscode.TreeItem(label), { description, ...o });

export async function activate(ctx: vscode.ExtensionContext): Promise<Api> {
  let client: CompanionClient | null = null;
  let snap: Snapshot | null = null;
  let projectId: string | undefined;
  let lastPending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let error = '';

  const out = vscode.window.createOutputChannel('AgentOnTrack');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'agentontrack.diagnostics';
  ctx.subscriptions.push(out, status);
  const trusted = () => vscode.workspace.isTrusted;
  const cfg = () => vscode.workspace.getConfiguration('agentontrack');
  const wsRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const sections = {
    project: new Section(() => {
      if (!client?.connected) return [];
      if (error) return [leaf('Cannot read the project', error, { iconPath: new vscode.ThemeIcon('warning') })];
      if (!snap) return [leaf('Loading…')];
      const items = [leaf('Goal', snap.goal ? `v${snap.goal.version}: ${snap.goal.statement}` : 'None approved', { iconPath: new vscode.ThemeIcon('target') })];
      if (snap.task) {
        items.push(leaf('Task', `${snap.task.title}: ${snap.task.status.replace(/_/g, ' ')}`, { iconPath: new vscode.ThemeIcon(snap.task.status === 'VERIFIED' ? 'pass' : 'circle-outline') }));
        for (const c of snap.task.criteria) items.push(leaf(`  ${c.id}`, c.state, { iconPath: new vscode.ThemeIcon(c.state === 'pass' ? 'check' : c.state === 'fail' ? 'error' : 'question') }));
      } else items.push(leaf('Task', 'None active'));
      if (!snap.integrityOk) items.push(leaf('Record', 'Failed its integrity check. Run agentontrack audit.', { iconPath: new vscode.ThemeIcon('error') }));
      return items;
    }),
    approvals: new Section(() => (snap?.pending ?? []).map((a) => Object.assign(leaf(`${a.kind}: ${a.target}`, a.runtime, { contextValue: 'approval', tooltip: a.reason ?? '', iconPath: new vscode.ThemeIcon('shield') }), { id: a.id }))),
    team: new Section(() => (snap?.team.members.length ? snap.team.members.map((m) => leaf(m.agent, m.role, { iconPath: new vscode.ThemeIcon('person') })) : [leaf('No team set', 'agentontrack team set claude-code:implement codex:review')])),
    handoffs: new Section(() => (snap?.handoffs ?? []).slice().reverse().map((h) => Object.assign(leaf(`${h.from} to ${h.to ?? '?'}`, `${h.outcome}, task ${h.task}`, { contextValue: 'handoff', iconPath: new vscode.ThemeIcon('arrow-swap') }), { id: h.id }))),
    usage: new Section(() => (snap?.usage ? [leaf('Tokens in', String(snap.usage.input)), leaf('Tokens out', String(snap.usage.output)), leaf('Sessions', String(snap.usage.sessions)), leaf('Source', 'Reported by the agent. Savings appear in the dashboard only against a baseline you enter.')] : [leaf('Unavailable', 'No usage has been recorded')])),
  };
  for (const [name, s] of Object.entries(sections)) ctx.subscriptions.push(vscode.window.registerTreeDataProvider(`agentontrack.${name}`, s));
  const fireAll = () => Object.values(sections).forEach((s) => s.fire());

  const render = () => {
    vscode.commands.executeCommand('setContext', 'agentontrack.connected', !!client?.connected);
    if (!client?.connected) { status.text = '$(plug) AgentOnTrack: not connected'; status.tooltip = 'Click for diagnostics'; status.show(); return; }
    const n = snap?.pending.length ?? 0;
    status.text = `$(shield) AgentOnTrack: ${snap?.task ? snap.task.status.replace(/_/g, ' ').toLowerCase() : 'no task'}${n ? ` · ${n} to approve` : ''}`;
    status.tooltip = snap?.goal?.statement ?? 'No approved goal';
    status.show();
  };

  async function pickProject(): Promise<string | undefined> {
    if (!client) return undefined;
    const list = await client.get<{ id: string; name: string; root: string; archived?: boolean }[]>('/api/projects');
    const here = wsRoot()?.replace(/\\/g, '/').toLowerCase();
    const match = list.find((p) => p.root.replace(/\\/g, '/').toLowerCase() === here);
    return (match ?? list.find((p) => !p.archived))?.id;
  }

  async function refresh(): Promise<void> {
    if (!client?.connected) { snap = null; render(); fireAll(); return; }
    try {
      projectId ??= await pickProject();
      snap = await snapshot(client, projectId);
      error = '';
      const pending = new Set(snap.pending.map((p) => p.id));
      for (const a of snap.pending) if (!lastPending.has(a.id)) {
        void vscode.window.showInformationMessage(`${a.runtime} asks to ${a.kind}: ${a.target}`, 'Approve', 'Deny').then((c) => c && vscode.commands.executeCommand(c === 'Approve' ? 'agentontrack.approve' : 'agentontrack.deny', { id: a.id }));
      }
      lastPending = pending;
    } catch (err) {
      error = (err as Error).message;
      if (err instanceof CompanionError && err.status === 401) { client.forget(); await ctx.secrets.delete(SECRET); }
    }
    render(); fireAll();
  }

  /** Live: the companion's own event list, from the last event seen. A new event, from any surface, is a reason to read again. */
  async function poll(): Promise<void> {
    if (!client?.connected) return;
    try {
      const r = await client.get<{ head: number }>('/api/revision', projectId);
      if (r.head !== snap?.head) await refresh();
    } catch { await refresh(); }
  }

  async function connect(code?: string): Promise<boolean> {
    try {
      const url = cfg().get<string>('companionUrl') ?? 'http://127.0.0.1:47631';
      const c = new CompanionClient(url);
      const given = code ?? await vscode.window.showInputBox({ title: 'Pair with the AgentOnTrack companion', prompt: 'Run `agentontrack dashboard` in a terminal, then type the pairing code it prints', ignoreFocusOut: true, validateInput: (v) => (v.trim().length < 4 ? 'Type the whole code' : undefined) });
      if (!given) return false;
      const s = await c.pair(given);
      await ctx.secrets.store(SECRET, JSON.stringify({ url, ...s }));
      client = c; projectId = undefined;
      await refresh();
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(`AgentOnTrack: ${(err as Error).message}. Is \`agentontrack dashboard\` running?`);
      return false;
    }
  }

  /** The code comes from the terminal, not from here, and is typed by the person. */
  const askCode = async (action: string): Promise<string | undefined> => vscode.window.showInputBox({ title: 'Confirm in your terminal', prompt: `Your terminal shows a code for this request. Check that it matches: ${action.slice(0, 300)}`, ignoreFocusOut: true, placeHolder: 'The code from the terminal' });

  async function change<T>(path: string, body: Record<string, unknown>, code?: string): Promise<T | undefined> {
    if (!client?.connected) { void vscode.window.showWarningMessage('AgentOnTrack is not connected.'); return undefined; }
    if (!trusted()) { void vscode.window.showWarningMessage('This workspace is not trusted, so AgentOnTrack will not start or confirm anything from it.'); return undefined; }
    try {
      return await client.postConfirmed<T>(path, body, code ? async () => code : askCode, projectId);
    } catch (err) {
      if (err instanceof NeedsCode) return undefined;
      void vscode.window.showErrorMessage(`AgentOnTrack: ${(err as Error).message}`);
      return undefined;
    } finally { void refresh(); }
  }

  const runPrompt = async (prompt: string, code?: string) => {
    const agent = cfg().get<string>('agentId') ?? 'claude-code';
    if (agent !== 'claude-code') { void vscode.window.showWarningMessage(`A run can be started from here for Claude Code only. ${agent} can be started in its own terminal, and its hooks report here.`); return undefined; }
    const r = await change<{ id: string }>('/api/runs', { runtime: 'claude-code', prompt, model: cfg().get('model') ?? 'haiku', maxBudgetUsd: cfg().get('maxBudgetUsd') ?? 0.5 }, code);
    if (r) { out.appendLine(`Started run ${r.id}`); out.show(true); void watchRun(r.id); }
    return r;
  };

  async function watchRun(id: string): Promise<void> {
    let shown = 0;
    for (let i = 0; i < 600; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      try {
        const runs = await client!.get<{ id: string; status: string; events: string[] }[]>('/api/runs', projectId);
        const run = runs.find((x) => x.id === id);
        if (!run) return;
        for (const e of run.events.slice(shown)) out.appendLine(e);
        shown = run.events.length;
        if (run.status !== 'running') { out.appendLine(`Run ${id}: ${run.status}`); void refresh(); return; }
      } catch { return; }
    }
  }

  const selection = (kind: 'review' | 'explain' | 'fix' | 'tests') => async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) { void vscode.window.showInformationMessage('Select some code first.'); return; }
    const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
    await runPrompt(selectionPrompt(kind, rel, ed.selection.start.line + 1, ed.selection.end.line + 1, ed.document.getText(ed.selection)));
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(`agentontrack.${id}`, fn));

  reg('connect', (a?: { code?: string }) => connect(a?.code));
  reg('disconnect', async () => { client?.forget(); client = null; snap = null; await ctx.secrets.delete(SECRET); render(); fireAll(); });
  reg('refresh', refresh);
  reg('selectProject', async () => {
    if (!client?.connected) return connect();
    const list = await client.get<{ id: string; name: string; root: string; goal: string | null; archived?: boolean }[]>('/api/projects');
    const pick = await vscode.window.showQuickPick(list.filter((p) => !p.archived).map((p) => ({ label: p.name, description: p.goal ?? 'no goal', detail: p.root, id: p.id })), { title: 'AgentOnTrack project' });
    if (pick) { projectId = pick.id; await refresh(); }
  });
  reg('openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(client?.base ?? cfg().get<string>('companionUrl') ?? 'http://127.0.0.1:47631')));
  reg('diagnostics', async () => {
    const lines = [`Companion address: ${cfg().get('companionUrl')}`, `Connected: ${client?.connected ? 'yes' : 'no'}`, `Workspace trusted: ${trusted() ? 'yes' : 'no'}`, `Workspace folder: ${wsRoot() ?? 'none'}`, `Project: ${projectId ?? 'none'}`, `Last error: ${error || 'none'}`];
    try {
      const h = await (await fetch(`${new CompanionClient(cfg().get<string>('companionUrl') ?? '').base}/api/health`)).json() as { ok?: boolean };
      lines.push(`Companion answers: ${h.ok ? 'yes' : 'no'}`);
    } catch (err) { lines.push(`Companion answers: no (${(err as Error).message}). Run: agentontrack dashboard`); }
    out.clear(); lines.forEach((l) => out.appendLine(l)); out.show(true);
  });
  reg('runPrompt', async (a?: { prompt?: string; code?: string }) => {
    const prompt = a?.prompt ?? await vscode.window.showInputBox({ title: 'Prompt for the agent', prompt: 'It runs in this project, under the approved goal. Anything consequential waits for your approval.', ignoreFocusOut: true });
    if (prompt) return runPrompt(prompt, a?.code);
  });
  reg('reviewSelection', selection('review'));
  reg('explainSelection', selection('explain'));
  reg('fixSelection', selection('fix'));
  reg('generateTests', selection('tests'));
  reg('checkGoal', () => runPrompt('Check whether the current changes in this project meet the approved goal. List what is done, what is missing, and anything outside the goal. Do not change any file.'));
  reg('verifyChanges', async (a?: { code?: string }) => {
    if (!snap?.task) { void vscode.window.showInformationMessage('There is no active task to verify.'); return; }
    const r = await change<{ status: string; reasons: string[] }>('/api/verify', { taskId: snap.task.id }, a?.code);
    if (r) void vscode.window.showInformationMessage(`Task ${snap.task.id}: ${r.status.replace(/_/g, ' ')}${r.reasons.length ? `. ${r.reasons[0]}` : ''}`);
  });
  reg('createHandoff', async (a?: { to?: string }) => {
    if (!client?.connected) return;
    const from = cfg().get<string>('agentId') ?? 'claude-code';
    const opts = await client.get<{ options: { id: string; name: string; usable: boolean; why: string[]; warnings: string[] }[] }>(`/api/failover?from=${encodeURIComponent(from)}`, projectId).catch(() => ({ options: [] }));
    const to = a?.to ?? (await vscode.window.showQuickPick(opts.options.map((o) => ({ label: o.name, description: o.usable ? o.warnings[0] : `cannot: ${o.why[0]}`, id: o.id })), { title: `Hand off from ${from} to…` }))?.id;
    if (!to) return;
    const r = await change<{ id: string; problems: { message: string }[] }>('/api/handoffs', { from, to, reason: 'planned', writeMarkdown: false });
    if (r) void vscode.window.showInformationMessage(`Handoff ${r.id} saved. Approvals do not carry over: ${to} asks for its own.`);
  });
  reg('showHandoff', async (a?: { id?: string } | vscode.TreeItem) => {
    const id = (a as { id?: string })?.id ?? (await vscode.window.showQuickPick((snap?.handoffs ?? []).map((h) => ({ label: h.id, description: `${h.from} to ${h.to ?? '?'}: ${h.outcome}` })), { title: 'Handoff' }))?.label;
    if (!id || !client) return;
    const r = await client.get<{ markdown: string }>(`/api/handoffs/markdown?id=${encodeURIComponent(id)}`, projectId);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: r.markdown }));
  });
  reg('acceptHandoff', async (a?: { id?: string; to?: string }) => {
    const id = a?.id ?? (await vscode.window.showQuickPick((snap?.handoffs ?? []).filter((h) => h.outcome === 'prepared').map((h) => h.id), { title: 'Handoff to accept' }));
    if (!id || !client) return;
    const to = a?.to ?? cfg().get<string>('agentId') ?? 'claude-code';
    const r = await client.post<{ accepted: boolean; problems: { message: string }[]; reusable: string[] }>('/api/handoffs/accept', { id, to }, projectId).catch((e) => { if (e instanceof NeedsCode) return null; throw e; });
    if (r === null) { const done = await change('/api/handoffs/accept', { id, to }); void done; return; }
    void vscode.window.showInformationMessage(r.accepted ? `Accepted for ${to}. Verified work kept: ${r.reusable.join(', ') || 'none'}.` : `Refused: ${r.problems.map((p) => p.message).join(' ')}`);
  });
  const decide = (verb: 'approve' | 'deny') => async (a?: { id?: string; code?: string }) => {
    const id = a?.id ?? (await vscode.window.showQuickPick((snap?.pending ?? []).map((p) => ({ label: p.id, description: `${p.kind}: ${p.target}` })), { title: `Request to ${verb}` }))?.label;
    if (!id) return;
    await change(`/api/approvals/${verb}`, verb === 'approve' ? { id, ttlMinutes: 60, uses: 1, portable: false } : { id, note: '' }, a?.code);
  };
  reg('approve', decide('approve'));
  reg('deny', decide('deny'));
  reg('openProjectFile', async () => {
    const root = wsRoot();
    if (!root) return;
    const found: { label: string; uri: vscode.Uri }[] = [];
    for (const f of COMMON_FILES) { const uri = vscode.Uri.joinPath(vscode.Uri.file(root), f); try { await vscode.workspace.fs.stat(uri); found.push({ label: f, uri }); } catch { /* absent */ } }
    const pick = await vscode.window.showQuickPick(found, { title: found.length ? 'Project file' : 'None of the usual project files exist yet' });
    if (pick) await vscode.window.showTextDocument(pick.uri);
  });
  reg('showWorktreeDiff', async () => {
    if (!client) return;
    const v = await client.get<{ worktrees: { id: string; agent: string; status: string; changed?: { path: string; status: string }[] }[] }>('/api/worktrees', projectId);
    const files = v.worktrees.filter((w) => w.status === 'active').flatMap((w) => (w.changed ?? []).map((c) => ({ label: c.path, description: `${w.agent}: ${c.status}`, wt: w.id })));
    const pick = await vscode.window.showQuickPick(files, { title: files.length ? 'Changed in a worktree' : 'No worktree has changes' });
    if (!pick) return;
    const d = await client.get<{ before: string | null; after: string | null; path: string }>(`/api/worktrees/diff?id=${pick.wt}&path=${encodeURIComponent(pick.label)}`, projectId);
    const doc = (text: string | null) => vscode.workspace.openTextDocument({ content: text ?? '' });
    const [a, b] = await Promise.all([doc(d.before), doc(d.after)]);
    await vscode.commands.executeCommand('vscode.diff', a.uri, b.uri, `${d.path} (before and after, in the worktree)`);
  });

  // Restore the last pairing for this session, if it is still valid.
  try {
    const saved = await ctx.secrets.get(SECRET);
    if (saved) { const s = JSON.parse(saved) as { url: string; token: string; csrf: string }; client = new CompanionClient(cfg().get<string>('companionUrl') ?? s.url, { token: s.token, csrf: s.csrf }); }
  } catch { /* a bad saved session is just a missing one */ }
  render();
  await refresh();
  timer = setInterval(() => { void poll(); }, 2000);
  ctx.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });

  return { snapshot: () => snap, refresh, client: () => client };
}

export function deactivate(): void { /* subscriptions are disposed by the host */ }
