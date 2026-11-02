import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { acceptHandoff2, buildHandoff, computeAnalytics, listHandoffs, loadHandoff, loadRegistry, planWorkflow, Project, registerProject, renderHandoffMarkdown, saveHandoff, updateRegistered, validateHandoff, verifyHandoffFile, type Registered } from '@agentontrack/core';
import { failoverOptions, PROVIDERS, providerInstalled, providerSelfTest, runtimeFacts } from '@agentontrack/adapters';

/**
 * The commands that make the terminal a peer of the website and the editors. Each one reads or changes the same record, through the same
 * engine, so a task started here shows up there. Anything that grants authority goes through `human`, which needs a person at a terminal.
 */

export interface Ctx {
  root: string;
  argv: string[];
  json: boolean;
  opt: (name: string) => string | undefined;
  has: (name: string) => boolean;
  human: (p: Project, action: string) => Promise<unknown>;
  withProject: <T>(fn: (p: Project) => T | Promise<T>) => Promise<T>;
  print: (v: unknown) => void;
}

const ROLES_HELP = 'Roles: implement, review, debug, test, research, analyze, classify, verify';

/** Tables for a person at a terminal, JSON for everything else. A script never has to parse a table. */
function table(ctx: Ctx, rows: Record<string, unknown>[], columns: string[]): void {
  if (ctx.json || !process.stdout.isTTY) { ctx.print(rows); return; }
  if (!rows.length) { ctx.print('None.'); return; }
  const cell = (v: unknown) => (v === null || v === undefined ? '-' : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  ctx.print([columns.map((c, i) => c.toUpperCase().padEnd(widths[i]!)).join('  '), ...rows.map((r) => columns.map((c, i) => cell(r[c]).padEnd(widths[i]!)).join('  '))].join('\n'));
}

const version = (bin: string, args: string[]) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim().split('\n')[0]! : null;
};

const KNOWN: Record<string, { bin: string; args: string[] }> = { 'claude-code': { bin: 'claude', args: ['--version'] }, codex: { bin: 'codex', args: ['--version'] }, hermes: { bin: 'hermes', args: ['--version'] } };

export function resolveProject(ref: string): Registered {
  const reg = loadRegistry();
  const hit = reg.find((r) => r.id === ref) ?? reg.find((r) => r.name === ref) ?? reg.find((r) => r.root === ref) ?? reg.filter((r) => r.id.startsWith(ref))[0];
  if (!hit) throw new Error(`No project "${ref}". Run: agentontrack project list`);
  return hit;
}

const COMMANDS: Record<string, string[]> = {
  project: ['list', 'add', 'open', 'rename', 'archive', 'unarchive'], agents: ['list', 'connect', 'disconnect'], team: ['show', 'set', 'plan'], worktree: ['create', 'list', 'status', 'commit', 'conflicts', 'preview', 'merge', 'discard'],
  handoff: ['create', 'list', 'show', 'accept', 'verify-file'], failover: [], usage: [], completion: ['bash', 'zsh', 'powershell'],
};

export function completionScript(shell: string, all: string[]): string {
  const words = [...new Set([...all, ...Object.keys(COMMANDS)])].sort();
  if (shell === 'bash') return `_agentontrack() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"\n  case "$prev" in\n${Object.entries(COMMANDS).filter(([, v]) => v.length).map(([k, v]) => `    ${k}) COMPREPLY=($(compgen -W "${v.join(' ')}" -- "$cur")); return ;;`).join('\n')}\n  esac\n  COMPREPLY=($(compgen -W "${words.join(' ')}" -- "$cur"))\n}\ncomplete -F _agentontrack agentontrack aot\n`;
  if (shell === 'zsh') return `#compdef agentontrack aot\n_agentontrack() {\n  local -a cmds\n  cmds=(${words.join(' ')})\n  if (( CURRENT == 2 )); then _describe 'command' cmds; return; fi\n  case "$words[2]" in\n${Object.entries(COMMANDS).filter(([, v]) => v.length).map(([k, v]) => `    ${k}) _values 'subcommand' ${v.join(' ')} ;;`).join('\n')}\n  esac\n}\ncompdef _agentontrack agentontrack aot\n`;
  if (shell === 'powershell') return `Register-ArgumentCompleter -Native -CommandName agentontrack, aot -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $words = @(${words.map((w) => `'${w}'`).join(', ')})\n  $subs = @{ ${Object.entries(COMMANDS).filter(([, v]) => v.length).map(([k, v]) => `'${k}' = @(${v.map((x) => `'${x}'`).join(', ')})`).join('; ')} }\n  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }\n  $list = if ($tokens.Count -ge 2 -and $subs.ContainsKey($tokens[1])) { $subs[$tokens[1]] } else { $words }\n  $list | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
  throw new Error('Usage: agentontrack completion bash|zsh|powershell');
}

/** Returns true if it handled the command. */
export async function workspaceCommand(cmd: string | undefined, sub: string | undefined, arg: string | undefined, ctx: Ctx, allCommands: string[]): Promise<boolean> {
  const { opt, has, print, withProject, human } = ctx;
  switch (cmd) {
    case 'completion':
      print(completionScript(sub ?? '', allCommands));
      return true;

    case 'project': {
      if (!sub || sub === 'list') {
        const rows = loadRegistry().map((r) => {
          if (!existsSync(r.root)) return { id: r.id, name: r.name, state: 'FOLDER MISSING', goal: null, task: null, pending: null, archived: !!r.archived, root: r.root };
          const p = new Project(r.root);
          try {
            const s = p.state();
            const t = s.activeTaskId ? s.tasks.get(s.activeTaskId) : null;
            return { id: r.id, name: r.name, state: t ? p.evaluate(t.id).status : 'NO TASK', goal: s.goal?.statement ?? null, task: t?.title ?? null, pending: [...s.approvals.values()].filter((a) => a.status === 'pending').length, archived: !!r.archived, root: r.root };
          } finally { p.close(); }
        }).filter((r) => has('all') || !r.archived);
        table(ctx, rows, ['name', 'state', 'goal', 'pending', 'root']);
      } else if (sub === 'add') {
        const path = arg ?? ctx.root;
        if (!existsSync(path)) throw new Error(`No such folder: ${path}`);
        print(registerProject(path));
      } else if (sub === 'open') {
        if (!arg) throw new Error('Usage: agentontrack project open <name|id|path>');
        const r = resolveProject(arg);
        const p = new Project(r.root);
        try {
          const s = p.state();
          print({ ...r, goal: s.goal ? { version: s.goal.version, statement: s.goal.statement } : null, activeTask: s.activeTaskId, team: s.team, worktrees: p.worktrees().filter((w) => w.status === 'active').length, hint: `Use it with --project "${r.name}", or: cd "${r.root}"` });
        } finally { p.close(); }
      } else if (sub === 'rename' || sub === 'archive' || sub === 'unarchive') {
        if (!arg) throw new Error(`Usage: agentontrack project ${sub} <name|id>${sub === 'rename' ? ' --name "New name"' : ''}`);
        const r = resolveProject(arg);
        if (sub === 'rename') { const name = opt('name'); if (!name) throw new Error('Give --name'); print(updateRegistered(r.id, { name })); } else print(updateRegistered(r.id, { archived: sub === 'archive' }));
      } else throw new Error('Usage: agentontrack project list|add|open|rename|archive|unarchive');
      return true;
    }

    case 'agents': {
      if (!sub || sub === 'list') {
        const rows = [...Object.entries(KNOWN).map(([id, k]) => ({ id, name: runtimeFacts(id).name, kind: 'native hooks', version: version(k.bin, k.args) })), ...Object.values(PROVIDERS).map((a) => ({ id: a.id, name: a.name, kind: a.kind, version: version(a.bin, a.versionArgs) }))].map((r) => {
          const f = runtimeFacts(r.id);
          const connected = KNOWN[r.id] ? null : providerInstalled(PROVIDERS[r.id]!, ctx.root);
          return { ...r, installed: r.version !== null, connected, ifHookFails: f.hostFailMode, enforcesShell: f.enforcesShell, enforcesEdit: f.enforcesEdit, mcp: f.mcp };
        });
        table(ctx, rows, ['id', 'version', 'connected', 'ifHookFails']);
      } else if (sub === 'connect' || sub === 'disconnect') {
        if (!arg) throw new Error(`Usage: agentontrack agents ${sub} <id>. Known: ${[...Object.keys(KNOWN), ...Object.keys(PROVIDERS)].join(', ')}`);
        // The same command as before, so what it writes and what it says are unchanged.
        const r = spawnSync(process.execPath, [process.argv[1]!, sub === 'connect' ? 'install' : 'uninstall', arg, ...(has('sandbox') ? ['--sandbox'] : [])], { encoding: 'utf8', env: { ...process.env, AGENTONTRACK_ROOT: ctx.root } });
        process.exitCode = r.status ?? 1;
        const selfTest = sub === 'connect' && r.status === 0 && PROVIDERS[arg] ? providerSelfTest(PROVIDERS[arg]!, ctx.root) : null;
        if (ctx.json || !process.stdout.isTTY) print({ ok: r.status === 0, runtime: arg, output: `${r.stdout}${r.stderr}`.trim(), hookSelfTest: selfTest, note: 'Run: agentontrack doctor for the whole picture' });
        else { process.stdout.write(r.stdout); process.stderr.write(r.stderr); if (selfTest) print(`Hook self-test: ${selfTest.ok ? 'passed' : `FAILED: ${selfTest.detail}`}`); }
      } else throw new Error('Usage: agentontrack agents list|connect <id>|disconnect <id>');
      return true;
    }

    case 'team': {
      if (!sub || sub === 'show') { await withProject((p) => print(p.state().team)); return true; }
      if (sub === 'plan') {
        await withProject((p) => print(planWorkflow(p.state().team.members as never, (opt('kind') ?? 'implement-review-verify') as never)));
        return true;
      }
      if (sub === 'set') {
        const members = opt('file') ? JSON.parse(readFileSync(opt('file')!, 'utf8')) : ctx.argv.slice(2).filter((a) => /^[a-z0-9-]+:[a-z]+$/.test(a)).map((a) => { const [agent, role] = a.split(':'); return { agent, role }; });
        if (!members.length) throw new Error(`Usage: agentontrack team set claude-code:implement codex:review   (or --file team.json). ${ROLES_HELP}`);
        await withProject(async (p) => {
          await human(p, `Set the agent team:\n${members.map((m: { agent: string; role: string }) => `  ${m.agent}: ${m.role}`).join('\n')}`);
          p.human.setTeam(members, opt('expect-version') ? Number(opt('expect-version')) : undefined);
          print(p.state().team);
        });
        return true;
      }
      throw new Error('Usage: agentontrack team show|set|plan');
    }

    case 'worktree': {
      await withProject(async (p) => {
        const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`Usage: agentontrack worktree ${sub} <${what}>`); return v; };
        if (sub === 'create') print(p.createWorktree(need(arg, 'task id'), need(opt('agent'), '--agent id')));
        else if (!sub || sub === 'list') table(ctx, p.worktrees().map((w) => ({ id: w.id, agent: w.agent, task: w.taskId, status: w.status, branch: w.branch, committed: !!w.commit })), ['id', 'agent', 'task', 'status', 'branch']);
        else if (sub === 'status') print(p.worktreeStatus(need(arg, 'worktree id')));
        else if (sub === 'commit') print(p.commitWorktree(need(arg, 'worktree id'), opt('message') ?? 'Work recorded by AgentOnTrack'));
        else if (sub === 'conflicts') print(p.detectConflicts());
        else if (sub === 'preview') print(p.mergePreview(need(arg, 'worktree id')));
        else if (sub === 'merge') {
          const id = need(arg, 'worktree id');
          print(p.mergePreview(id));
          await human(p, `Merge worktree ${id} into the project`);
          print(p.mergeWorktree(id));
        } else if (sub === 'discard') {
          const id = need(arg, 'worktree id');
          await human(p, `Discard worktree ${id} and its branch`);
          p.discardWorktree(id);
          print({ discarded: id });
        } else throw new Error('Usage: agentontrack worktree create <task> --agent id|list|status|commit|conflicts|preview|merge|discard <id>');
      });
      return true;
    }

    case 'handoff': {
      await withProject(async (p) => {
        if (sub === 'create') {
          const from = opt('from');
          if (!from) throw new Error('Usage: agentontrack handoff create --from <agent> [--to <agent>] [--task id] [--reason planned|unavailable|limit|interrupted|review] [--markdown]');
          const to = opt('to');
          const f = to ? runtimeFacts(to) : null;
          const limits = f ? [!f.known ? 'AgentOnTrack has no adapter for this runtime.' : '', f.hostFailMode === 'open' ? 'If its hook cannot run, the host runs the action anyway.' : ''].filter(Boolean) : [];
          const h = buildHandoff(p, { from, ...(to ? { to } : {}), ...(opt('task') ? { taskId: opt('task')! } : {}), reason: { kind: (opt('reason') ?? 'planned') as never, ...(opt('detail') ? { detail: opt('detail')! } : {}) }, limits });
          const out = saveHandoff(p, h, { writeMarkdown: has('markdown') });
          print({ id: h.id, task: h.task.id, completed: h.completed.length, outstanding: h.outstanding.length, uncertainty: h.uncertainty, approvalsNotCarried: h.approvalsToRevalidate.length, problems: validateHandoff(p, h), wrote: out });
        } else if (!sub || sub === 'list') table(ctx, listHandoffs(p) as never, ['id', 'from', 'to', 'task', 'outcome']);
        else if (sub === 'show') {
          const h = loadHandoff(p, arg ?? '');
          if (ctx.json || !process.stdout.isTTY) print({ handoff: h, problems: validateHandoff(p, h) });
          else print(renderHandoffMarkdown(h));
        } else if (sub === 'accept') {
          const h = loadHandoff(p, arg ?? '');
          const to = opt('to');
          if (!to) throw new Error('Usage: agentontrack handoff accept <id> --to <agent> [--acknowledge]');
          if (has('acknowledge')) {
            print(validateHandoff(p, h));
            await human(p, `Accept handoff ${h.id} for ${to}, knowing the problems above`);
          }
          const r = acceptHandoff2(p, h, to, { acknowledge: has('acknowledge') });
          // The brief is built from the record, so what an agent might have written into HANDOFF.md never reaches the receiver.
          print(ctx.json || !process.stdout.isTTY ? r : r.accepted ? (r.brief ?? '') : `Refused:\n${r.problems.map((x) => `  ${x.blocking ? '[blocking] ' : ''}${x.message}`).join('\n')}\nIf a person has read these, accept anyway with --acknowledge.`);
          if (!r.accepted) process.exitCode = 2;
        } else if (sub === 'verify-file') {
          const r = verifyHandoffFile(p, arg ?? '');
          print(r);
          if (!r.ok) process.exitCode = 2;
        } else throw new Error('Usage: agentontrack handoff create|list|show <id>|accept <id>|verify-file <id>');
      });
      return true;
    }

    case 'failover': {
      const from = opt('from') ?? sub;
      if (!from) throw new Error('Usage: agentontrack failover --from <agent> [--installed a,b,c]');
      const installed = (opt('installed') ?? [...Object.keys(KNOWN), ...Object.keys(PROVIDERS)].filter((id) => (KNOWN[id] ? version(KNOWN[id].bin, KNOWN[id].args) : version(PROVIDERS[id]!.bin, PROVIDERS[id]!.versionArgs))).join(',')).split(',').filter(Boolean);
      print({ from: runtimeFacts(from), options: failoverOptions(from, installed), note: 'Ordered by what each can enforce. Nothing here says which model is better, or how much quota is left: AgentOnTrack does not know.' });
      return true;
    }

    case 'usage': {
      await withProject((p) => {
        const a = computeAnalytics(p);
        print({ totals: a.totals, byDay: a.byDay, tasks: a.taskTotals, note: 'Provider-reported where the agent reports it. Savings against a baseline are shown in the dashboard only when you enter one.' });
      });
      return true;
    }
    default:
      return false;
  }
}
