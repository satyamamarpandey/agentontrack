import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyCommand, type Effect, type Project } from '@agentontrack/core';

/**
 * Versioned adapters over one engine. An adapter only translates: a host's payload into a canonical event, and a decision
 * back into that host's output. All policy lives in Project. Contracts are from each vendor's docs as read on 2026-11-01
 * (docs/research/provider-audit.md), and only a real run shows they hold: see certification below.
 */

export type Certification = 'NATIVE_ENFORCEMENT_VERIFIED' | 'OBSERVATION_VERIFIED' | 'MCP_VERIFIED' | 'RESEARCH_API_VERIFIED' | 'PARTIAL' | 'BLOCKED' | 'NOT_TESTED';
export type ToolKind = 'shell' | 'write' | 'delete' | 'read' | 'web' | 'mcp' | 'subagent' | 'unknown';
export type Support = 'yes' | 'no' | 'partial' | 'unknown';

export interface CanonicalEvent {
  phase: 'pre' | 'post' | 'session' | 'stop' | 'compact' | 'other';
  tool: string;
  input: Record<string, unknown>;
  sessionId?: string;
  cwd?: string;
}

export interface ProviderOutput { stdout?: string; stderr?: string; exitCode: number }

export interface ProviderCapabilities {
  discovery: Support; install: Support; lifecycle: Support; hooks: Support; preActionShell: Support; preActionEdit: Support; preActionMcp: Support;
  approvals: Support; postActionEvidence: Support; usage: Support; compaction: Support; handoff: Support; disconnect: Support; recovery: Support;
}

export interface FailureBehaviour { crash: string; timeout: string; malformed: string; missing: string; source: 'documented' | 'observed' | 'mixed' }

export interface InstallOptions { timeoutSec?: number; v2?: boolean }

export interface ProviderAdapter {
  id: string;
  name: string;
  /** What this entry is. An MCP client or a research tool never counts as enforcement. */
  kind: 'native-hooks' | 'plugin';
  bin: string;
  versionArgs: string[];
  surfaces: string;
  capabilities: ProviderCapabilities;
  failure: FailureBehaviour;
  limitations: string[];
  /** A pre-action request that must be refused, used by the self-test. */
  probe: (command: string) => Record<string, unknown>;
  /** Added by agentontrack run, where the host would otherwise skip the gate. */
  runArgs?: string[];
  /** Files this adapter writes, for install, uninstall and status. */
  hookFiles: string[];
  isPreRaw(raw: string): boolean;
  normalize(payload: any): CanonicalEvent;
  kindOf(tool: string): ToolKind;
  allow(): ProviderOutput;
  deny(reason: string): ProviderOutput;
  install(root: string, command: string, opts?: InstallOptions): string[];
  uninstall(root: string): boolean;
}

const parseMaybe = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : { command: v }; } catch { return { command: v }; } }
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
};
const pathOf = (i: Record<string, unknown>) => String(i.file_path ?? i.filePath ?? i.path ?? i.target_file ?? i.absolute_path ?? '');
const jsonFile = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

/** Turns a canonical tool call into effects. Unknown tools stay opaque, never harmless. */
export function effectsFor(a: ProviderAdapter, tool: string, input: Record<string, unknown>): { effects: Effect[]; opaque: boolean; readOnly: boolean } {
  switch (a.kindOf(tool)) {
    case 'shell': { const c = classifyCommand(Array.isArray(input.commands) ? input.commands.join('\n') : String(input.command ?? input.cmd ?? '')); return { effects: c.effects, opaque: c.opaque, readOnly: false }; }
    case 'write': {
      const p = pathOf(input);
      return p ? { effects: [{ kind: 'fs.write', target: p }], opaque: false, readOnly: false } : { effects: [{ kind: 'exec.opaque', target: tool }], opaque: true, readOnly: false };
    }
    case 'delete': { const p = pathOf(input); return { effects: [{ kind: 'fs.delete', target: p || tool }], opaque: !p, readOnly: false }; }
    case 'read': return { effects: [], opaque: false, readOnly: true };
    case 'web': return { effects: [{ kind: 'net.fetch', target: String(input.url ?? input.query ?? tool) }], opaque: false, readOnly: false };
    case 'mcp': return { effects: [{ kind: 'mcp.call', target: tool }], opaque: true, readOnly: false };
    default: return { effects: [{ kind: 'exec.opaque', target: tool }], opaque: true, readOnly: false };
  }
}

const SELF_TEST = 'agentontrack-selftest';

export function handleProviderHook(project: Project, a: ProviderAdapter, raw: string, opts: { event?: string } = {}): ProviderOutput {
  const payload = JSON.parse(raw);
  const ev = a.normalize(opts.event ? { hook_event_name: opts.event, hookName: opts.event, ...payload } : payload);
  // The hook was installed for a pre-action event, and the payload did not read as one: the host's format has changed, so refuse.
  if (opts.event && /pre/i.test(opts.event) && ev.phase !== 'pre') return a.deny(`AgentOnTrack could not read this request from ${a.name}, so it was refused. Its hook format may have changed.`);
  if (opts.event && /pre/i.test(opts.event) && !ev.tool) return a.deny(`AgentOnTrack could not tell which tool ${a.name} is calling, so it was refused.`);
  if (ev.sessionId === SELF_TEST && ev.phase === 'pre') return a.deny('AgentOnTrack self-test');
  const base = { runtime: a.id, ...(ev.sessionId ? { sessionId: ev.sessionId } : {}), ...(ev.cwd ? { cwd: ev.cwd } : {}) };
  switch (ev.phase) {
    case 'session':
      if (ev.sessionId) project.bindSession(ev.sessionId);
      return { exitCode: 0 };
    case 'compact':
      project.resetContext();
      return { exitCode: 0 };
    case 'pre': {
      const m = effectsFor(a, ev.tool, ev.input);
      const r = project.preAction({ ...base, tool: ev.tool, effects: m.effects, opaque: m.opaque, coverage: 'enforced', rawInput: ev.input, skipObservation: m.readOnly });
      if (r.decision === 'deny') return a.deny(`AgentOnTrack denied this: ${r.reasons.join('; ')}. Do not try another way to do it.`);
      if (r.decision === 'request_approval') return a.deny(`AgentOnTrack needs human approval: ${r.reasons.join('; ')}. Do not retry or work around this. Tell the user to run ${r.approvalIds.map((i) => `agentontrack approve ${i}`).join(' && ')} in their own terminal.`);
      return a.allow();
    }
    case 'post': {
      const m = effectsFor(a, ev.tool, ev.input);
      project.postAction({ ...base, tool: ev.tool, effects: m.effects, skipObservation: m.readOnly });
      return { exitCode: 0 };
    }
    default:
      return { exitCode: 0 };
  }
}

/** Any failure of ours on a pre-action event refuses the action, in the form that host honours. */
export function handleProviderHookSafely(open: () => Project, a: ProviderAdapter, raw: string, opts: { event?: string } = {}): ProviderOutput {
  let project: Project | undefined;
  try {
    project = open();
    return handleProviderHook(project, a, raw, opts);
  } catch (err) {
    const message = `AgentOnTrack hook error, blocking as a precaution: ${(err as Error).message}`;
    return a.isPreRaw(raw) || !raw.trim() || (opts.event && /pre/i.test(opts.event)) ? a.deny(message) : { exitCode: 0, stderr: message };
  } finally {
    project?.close();
  }
}

const caps = (o: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  discovery: 'yes', install: 'yes', lifecycle: 'partial', hooks: 'yes', preActionShell: 'yes', preActionEdit: 'yes', preActionMcp: 'unknown', approvals: 'yes',
  postActionEvidence: 'yes', usage: 'no', compaction: 'unknown', handoff: 'yes', disconnect: 'yes', recovery: 'yes', ...o,
});
const table = (m: Record<string, ToolKind>, mcp: (t: string) => boolean) => (t: string): ToolKind => (m[t] ?? (mcp(t) ? 'mcp' : 'unknown'));
const exit2 = (reason: string, stdout?: string): ProviderOutput => ({ exitCode: 2, stderr: reason, ...(stdout ? { stdout } : {}) });
const preRe = (s: string) => { const re = new RegExp(s); return (raw: string) => re.test(raw); };

const cursorFile = '.cursor/hooks.json';
const cursor: ProviderAdapter = {
  id: 'cursor', name: 'Cursor', kind: 'native-hooks', bin: 'agent', versionArgs: ['--version'], surfaces: 'IDE and CLI. Cloud agents have no MCP or session hooks',
  capabilities: caps({ preActionMcp: 'yes', compaction: 'partial' }),
  failure: { crash: 'Blocks with failClosed, which this install sets', timeout: 'Blocks with failClosed', malformed: 'Blocks', missing: 'Not documented', source: 'documented' },
  limitations: ['Project hooks load only in a trusted workspace.', 'Team dashboard hooks cannot be made fail-closed.', 'A user report says Linux CLI hooks can fail silently, and that preToolUse may not fire on the CLI.'],
  probe: (command) => ({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command }, conversation_id: SELF_TEST }),
  hookFiles: [cursorFile],
  isPreRaw: preRe('"hook_event_name"\\s*:\\s*"preToolUse"'),
  normalize: (p) => {
    const e = String(p.hook_event_name ?? '');
    const phase = e === 'preToolUse' ? 'pre' : e === 'postToolUse' ? 'post' : e === 'sessionStart' ? 'session' : e === 'stop' ? 'stop' : e === 'preCompact' ? 'compact' : 'other';
    return { phase, tool: String(p.tool_name ?? ''), input: parseMaybe(p.tool_input), sessionId: p.conversation_id, cwd: p.cwd ?? p.workspace_roots?.[0] };
  },
  kindOf: (t) => (t.startsWith('MCP:') ? 'mcp' : ({ Shell: 'shell', Write: 'write', Delete: 'delete', Read: 'read', Grep: 'read', Task: 'subagent' } as Record<string, ToolKind>)[t] ?? 'unknown'),
  allow: () => ({ exitCode: 0, stdout: JSON.stringify({ permission: 'allow' }) }),
  deny: (reason) => exit2(reason, JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason })),
  install: (root, command, o = {}) => {
    const path = join(root, cursorFile);
    const cfg = jsonFile(path) ?? { version: 1, hooks: {} };
    cfg.hooks ??= {};
    for (const ev of ['preToolUse', 'postToolUse', 'sessionStart', 'stop', 'preCompact']) {
      const others = (cfg.hooks[ev] ?? []).filter((h: any) => !/ hook cursor\b/.test(h.command ?? ''));
      cfg.hooks[ev] = [...others, { command: `${command} hook cursor`, timeout: o.timeoutSec ?? 60, ...(ev === 'preToolUse' ? { matcher: '*', failClosed: true } : {}) }];
    }
    writeJson(path, cfg);
    return [path];
  },
  uninstall: (root) => removeHookEntries(join(root, cursorFile), / hook cursor\b/),
};

const copilotFile = '.github/hooks/agentontrack.json';
const copilot: ProviderAdapter = {
  id: 'copilot', name: 'GitHub Copilot', kind: 'native-hooks', bin: 'copilot', versionArgs: ['version'], surfaces: 'CLI and VS Code (Preview) read the same file. The cloud agent needs a paid plan and a hosted sandbox',
  capabilities: caps({ compaction: 'partial' }),
  failure: { crash: 'Blocks (observed)', timeout: 'RUNS THE ACTION (observed). No fail-closed setting exists', malformed: 'RUNS THE ACTION (observed)', missing: 'Blocks (observed)', source: 'observed' },
  limitations: ['In copilot -p, repo hooks load only in a trusted folder, or the gate is silently off (observed). agentontrack run copilot adds --trust-folder.', 'A hook that times out lets the action run.', 'disableAllHooks in repo settings skips the gate, so that file is a protected path here.', 'After 8 consecutive blocks the CLI ends the turn.'],
  probe: (command) => ({ toolName: 'bash', toolArgs: JSON.stringify({ command }), sessionId: SELF_TEST }),
  runArgs: ['--trust-folder'],
  hookFiles: [copilotFile],
  isPreRaw: preRe('"(hook_event_name"\\s*:\\s*"PreToolUse|toolName"|tool_name")'),
  normalize: (p) => {
    const name = String(p.hook_event_name ?? p.hookEventName ?? p.event ?? '');
    const pre = /pretooluse/i.test(name) || (!name && p.toolName && p.toolResult === undefined && p.tool_response === undefined);
    const post = /posttooluse/i.test(name) || (!name && p.toolName && (p.toolResult !== undefined || p.tool_response !== undefined));
    const phase = pre ? 'pre' : post ? 'post' : /sessionstart/i.test(name) ? 'session' : /agentstop/i.test(name) ? 'stop' : /precompact/i.test(name) ? 'compact' : 'other';
    return { phase, tool: String(p.toolName ?? p.tool_name ?? ''), input: parseMaybe(p.toolArgs ?? p.tool_input), sessionId: p.sessionId ?? p.session_id, cwd: p.cwd };
  },
  kindOf: table({ bash: 'shell', powershell: 'shell', Bash: 'shell', create: 'write', edit: 'write', Write: 'write', Edit: 'write', view: 'read', Read: 'read', glob: 'read', grep: 'read', web_fetch: 'web', task: 'subagent', ask_user: 'read' }, (t) => t.includes('mcp') || t.includes('/')),
  allow: () => ({ exitCode: 0 }),
  deny: (reason) => exit2(reason, JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })),
  install: (root, command, o = {}) => {
    const entry = () => ({ type: 'command', bash: `${command} hook copilot`, powershell: `& ${command} hook copilot`, timeoutSec: o.timeoutSec ?? 60 });
    const path = join(root, copilotFile);
    writeJson(path, { version: 1, hooks: Object.fromEntries(['preToolUse', 'postToolUse', 'sessionStart', 'agentStop', 'preCompact'].map((e) => [e, [entry()]])) });
    return [path];
  },
  uninstall: (root) => removeFile(join(root, copilotFile)),
};

const devinFile = '.devin/hooks.v1.json';
const devin: ProviderAdapter = {
  id: 'devin', name: 'Devin (formerly Windsurf)', kind: 'native-hooks', bin: 'devin', versionArgs: ['version'], surfaces: 'Devin CLI and Devin Desktop, which replaced Windsurf',
  capabilities: caps({ preActionMcp: 'yes', compaction: 'yes' }),
  failure: { crash: 'Blocks only if fail_closed works: its guide says hooks fail open, and fail_closed appears only in a changelog', timeout: 'Same', malformed: 'Same', missing: 'Not documented', source: 'documented' },
  limitations: ['Its own guide says not to rely on hooks for crucial guardrails yet.', 'In Restricted Mode hooks neither load nor run.'],
  probe: (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command }, session_id: SELF_TEST }),
  hookFiles: [devinFile],
  isPreRaw: preRe('"hook_event_name"\\s*:\\s*"PreToolUse"'),
  normalize: (p) => {
    const e = String(p.hook_event_name ?? '');
    const phase = e === 'PreToolUse' ? 'pre' : e === 'PostToolUse' ? 'post' : e === 'SessionStart' ? 'session' : e === 'Stop' ? 'stop' : /Compact/.test(e) ? 'compact' : 'other';
    return { phase, tool: String(p.tool_name ?? ''), input: parseMaybe(p.tool_input), sessionId: p.session_id, cwd: p.cwd ?? process.env.DEVIN_PROJECT_DIR };
  },
  kindOf: table({ exec: 'shell', write: 'write', edit: 'write', notebook_edit: 'write', read: 'read', grep: 'read', glob: 'read', notebook_read: 'read', webfetch: 'web', run_subagent: 'subagent', mcp_call_tool: 'mcp', apply_patch: 'unknown' }, (t) => t.startsWith('mcp__')),
  allow: () => ({ exitCode: 0 }),
  deny: (reason) => exit2(reason, JSON.stringify({ decision: 'block', reason })),
  install: (root, command, o = {}) => {
    const path = join(root, devinFile);
    const hook = (extra = {}) => [{ matcher: '.*', hooks: [{ type: 'command', command: `${command} hook devin`, timeout: o.timeoutSec ?? 60, ...extra }] }];
    writeJson(path, { PreToolUse: hook({ fail_closed: true }), PostToolUse: hook(), SessionStart: hook(), Stop: hook(), PostCompaction: hook() });
    return [path];
  },
  uninstall: (root) => removeFile(join(root, devinFile)),
};

const geminiFile = '.gemini/settings.json';
const GEMINI_EVENTS = ['BeforeTool', 'AfterTool', 'SessionStart', 'AfterAgent', 'PreCompress'];
const gemini: ProviderAdapter = {
  id: 'gemini', name: 'Gemini CLI', kind: 'native-hooks', bin: 'gemini', versionArgs: ['--version'], surfaces: 'CLI. Replaced by Antigravity CLI for unpaid and Google One users, which has a different hook contract and is not covered',
  capabilities: caps({ preActionMcp: 'yes', compaction: 'partial' }),
  failure: { crash: 'RUNS THE ACTION on exit 1 or 3 (observed). Errors inside AgentOnTrack exit 2, which blocks', timeout: 'RUNS THE ACTION (observed)', malformed: 'RUNS THE ACTION (observed)', missing: 'Blocks (observed)', source: 'observed' },
  limitations: ['No fail-closed setting.', 'hooksConfig.enabled false disables the gate, so the settings file is a protected path here.', 'Project hooks are untrusted by default.'],
  probe: (command) => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command }, session_id: SELF_TEST }),
  hookFiles: [geminiFile],
  isPreRaw: preRe('"hook_event_name"\\s*:\\s*"BeforeTool"'),
  normalize: (p) => {
    const e = String(p.hook_event_name ?? '');
    const phase = e === 'BeforeTool' ? 'pre' : e === 'AfterTool' ? 'post' : e === 'SessionStart' ? 'session' : e === 'AfterAgent' ? 'stop' : e === 'PreCompress' ? 'compact' : 'other';
    return { phase, tool: String(p.tool_name ?? ''), input: parseMaybe(p.tool_input), sessionId: p.session_id, cwd: p.cwd };
  },
  kindOf: table({ run_shell_command: 'shell', write_file: 'write', replace: 'write', read_file: 'read', read_many_files: 'read', list_directory: 'read', glob: 'read', grep_search: 'read', web_fetch: 'web', google_web_search: 'web', write_todos: 'read', ask_user: 'read' }, (t) => t.startsWith('mcp_')),
  allow: () => ({ exitCode: 0, stdout: '{}' }),
  deny: (reason) => exit2(reason),
  install: (root, command, o = {}) => {
    const path = join(root, geminiFile);
    const cfg = jsonFile(path) ?? {};
    cfg.hooks ??= {};
    for (const ev of GEMINI_EVENTS) {
      const others = (cfg.hooks[ev] ?? []).filter((g: any) => !(g.hooks ?? []).some((h: any) => / hook gemini\b/.test(h.command ?? '')));
      cfg.hooks[ev] = [...others, { matcher: '.*', hooks: [{ name: 'agentontrack', type: 'command', command: `${command} hook gemini`, timeout: (o.timeoutSec ?? 60) * 1000 }] }];
    }
    writeJson(path, cfg);
    return [path];
  },
  uninstall: (root) => {
    const path = join(root, geminiFile);
    const cfg = jsonFile(path);
    if (!cfg?.hooks) return false;
    for (const ev of Object.keys(cfg.hooks)) {
      cfg.hooks[ev] = cfg.hooks[ev].filter((g: any) => !(g.hooks ?? []).some((h: any) => / hook gemini\b/.test(h.command ?? '')));
      if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
    }
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
    writeJson(path, cfg);
    return true;
  },
};

const opencodeV1 = (command: string, ms: number) => `// Written by agentontrack install opencode. Any failure refuses the action, so a broken gate cannot pass as an allow.
import { spawnSync } from 'node:child_process';
const run = (payload) => spawnSync(${JSON.stringify(`${command} hook opencode`)}, { shell: true, input: JSON.stringify(payload), encoding: 'utf8', timeout: ${ms} });
export const AgentOnTrack = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    const r = run({ hook_event_name: 'tool.execute.before', tool: input.tool, sessionID: input.sessionID, args: output.args, cwd: directory });
    if (r.status !== 0) throw new Error(r.stderr || 'AgentOnTrack could not check this action, so it was refused');
  },
  'tool.execute.after': async (input) => { run({ hook_event_name: 'tool.execute.after', tool: input.tool, sessionID: input.sessionID, args: input.args, cwd: directory }); },
  event: async ({ event }) => { if (event.type === 'session.compacted') run({ hook_event_name: 'session.compacted', cwd: directory }); },
});
`;
const opencodeV2 = (command: string, ms: number) => `// Written by agentontrack install opencode --v2. Any failure refuses the action, so a broken gate cannot pass as an allow.
import { spawnSync } from 'node:child_process';
import { Plugin } from '@opencode/plugin';
const run = (payload) => spawnSync(${JSON.stringify(`${command} hook opencode`)}, { shell: true, input: JSON.stringify(payload), encoding: 'utf8', timeout: ${ms} });
export default Plugin.define({ id: 'agentontrack', async setup(ctx) {
  await ctx.tool.hook('execute.before', (event) => {
    const r = run({ hook_event_name: 'tool.execute.before', tool: event.tool, args: event.input });
    if (r.status !== 0) throw new Error(r.stderr || 'AgentOnTrack could not check this action, so it was refused');
  });
  await ctx.tool.hook('execute.after', (event) => { run({ hook_event_name: 'tool.execute.after', tool: event.tool, args: event.input }); });
} });
`;
const opencode: ProviderAdapter = {
  id: 'opencode', name: 'OpenCode', kind: 'plugin', bin: 'opencode', versionArgs: ['--version'], surfaces: 'CLI and TUI. V1 and V2 have incompatible plugin APIs and are installed separately',
  capabilities: caps({ compaction: 'partial' }),
  failure: { crash: 'Blocks (observed): the plugin throws on any failure', timeout: 'Blocks (observed)', malformed: 'Not applicable: exit status decides', missing: 'Blocks if the program is gone (observed). A plugin that fails to load is not tested, and would leave the gate off', source: 'observed' },
  limitations: ['opencode --pure, or OPENCODE_PURE, disables external plugins and so the gate.', 'A report says tools run through its batch tool skip plugin hooks.', 'A V1 plugin does not run on V2.'],
  probe: (command) => ({ hook_event_name: 'tool.execute.before', tool: 'bash', sessionID: SELF_TEST, args: { command } }),
  hookFiles: ['.opencode/plugins/agentontrack.js', '.opencode/plugins/agentontrack/index.js'],
  isPreRaw: preRe('"hook_event_name"\\s*:\\s*"tool\\.execute\\.before"'),
  normalize: (p) => {
    const e = String(p.hook_event_name ?? '');
    return { phase: e === 'tool.execute.before' ? 'pre' : e === 'tool.execute.after' ? 'post' : e === 'session.compacted' ? 'compact' : 'other', tool: String(p.tool ?? ''), input: parseMaybe(p.args), sessionId: p.sessionID, cwd: p.cwd };
  },
  kindOf: table({ bash: 'shell', shell: 'shell', edit: 'write', write: 'write', read: 'read', glob: 'read', grep: 'read', list: 'read', webfetch: 'web', websearch: 'web', task: 'subagent', subagent: 'subagent', todowrite: 'read', todoread: 'read', patch: 'unknown', batch: 'unknown' }, () => false),
  allow: () => ({ exitCode: 0 }),
  deny: (reason) => exit2(reason),
  install: (root, command, o = {}) => {
    const path = join(root, o.v2 ? '.opencode/plugins/agentontrack/index.js' : '.opencode/plugins/agentontrack.js');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, (o.v2 ? opencodeV2 : opencodeV1)(command, (o.timeoutSec ?? 60) * 1000));
    return [path];
  },
  uninstall: (root) => { const a = removeFile(join(root, '.opencode/plugins/agentontrack.js')); const b = removeFile(join(root, '.opencode/plugins/agentontrack/index.js')); return a || b; },
};

const kiroFile = '.kiro/hooks/agentontrack.json';
const kiro: ProviderAdapter = {
  id: 'kiro', name: 'Kiro', kind: 'native-hooks', bin: 'kiro-cli', versionArgs: ['--version'], surfaces: 'IDE and CLI. Powers carry MCP and skills, not enforcement',
  capabilities: caps({ compaction: 'no', preActionMcp: 'yes' }),
  failure: { crash: 'CLI docs: warns and continues. IDE docs: blocks. These conflict', timeout: 'Not documented', malformed: 'Not documented', missing: 'Not documented', source: 'documented' },
  limitations: ['No fail-closed setting.', 'A report says custom-agent hooks fire on the orchestrator only, not subagents.'],
  probe: (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command }, session_id: SELF_TEST }),
  hookFiles: [kiroFile],
  isPreRaw: preRe('"hook_event_name"\\s*:\\s*"(PreToolUse|preToolUse)"'),
  normalize: (p) => {
    const e = String(p.hook_event_name ?? '').toLowerCase();
    return { phase: e === 'pretooluse' ? 'pre' : e === 'posttooluse' ? 'post' : e === 'sessionstart' || e === 'agentspawn' ? 'session' : e === 'stop' ? 'stop' : 'other', tool: String(p.tool_name ?? ''), input: parseMaybe(p.tool_input), sessionId: p.session_id, cwd: p.cwd };
  },
  kindOf: table({ execute_bash: 'shell', execute_pwsh: 'shell', fs_write: 'write', fs_append: 'write', str_replace: 'write', delete_file: 'delete', read_file: 'read', list_directory: 'read', file_search: 'read', grep_search: 'read', web_fetch: 'web', remote_web_search: 'web', invoke_sub_agent: 'subagent' }, (t) => t.startsWith('mcp_')),
  allow: () => ({ exitCode: 0 }),
  deny: (reason) => exit2(reason),
  install: (root, command, o = {}) => {
    const path = join(root, kiroFile);
    const hook = (trigger: string) => ({ name: `agentontrack-${trigger}`, trigger, ...(/ToolUse/.test(trigger) ? { matcher: '*' } : {}), action: { type: 'command', command: `${command} hook kiro` }, timeout: o.timeoutSec ?? 60 });
    writeJson(path, { version: 'v1', hooks: ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'].map(hook) });
    return [path];
  },
  uninstall: (root) => removeFile(join(root, kiroFile)),
};

const CLINE_DIRS = ['.cline/hooks', '.clinerules/hooks'];
const CLINE_EVENTS = ['PreToolUse', 'PostToolUse', 'TaskStart', 'TaskResume'];
const cline: ProviderAdapter = {
  id: 'cline', name: 'Cline', kind: 'native-hooks', bin: 'cline', versionArgs: ['--version'], surfaces: 'CLI and VS Code extension script hooks. Linux and macOS only: Windows script hooks are not supported',
  capabilities: caps({ compaction: 'no' }),
  failure: { crash: 'RUNS THE ACTION (observed)', timeout: 'Waits, and a long hang can stall the run (observed)', malformed: 'RUNS THE ACTION (observed)', missing: 'RUNS THE ACTION (observed)', source: 'observed' },
  limitations: ['A refusal ends the whole run, not just that action (observed).', 'Real payloads differ from its README, so this was built from a real capture and may shift between versions.', 'Script hooks do not run on Windows.', 'The extension may need hooks enabled in settings.', 'SDK plugin hooks ignore errors by default; this adapter uses script hooks.'],
  probe: (command) => ({ hookName: 'PreToolUse', taskId: SELF_TEST, preToolUse: { toolName: 'execute_command', parameters: { command } } }),
  hookFiles: CLINE_DIRS.flatMap((d) => CLINE_EVENTS.map((e) => `${d}/${e}`)),
  isPreRaw: preRe('"(hookName"\\s*:\\s*"(PreToolUse|tool_call)|preToolUse")'),
  normalize: (p) => {
    // Real Cline CLI 3.0.74 sends hookName tool_call and tool_result, with the true input under tool_call. Its README names PreToolUse and stringifies parameters.
    const e = String(p.hookName ?? '');
    const call = p.tool_call ?? p.tool_result;
    const body = p.preToolUse ?? p.postToolUse ?? {};
    const phase = e === 'tool_call' || e === 'PreToolUse' ? 'pre' : e === 'tool_result' || e === 'PostToolUse' ? 'post' : /^(agent_start|Task(Start|Resume))$/.test(e) ? 'session' : 'other';
    return { phase, tool: String(call?.name ?? body.toolName ?? ''), input: parseMaybe(call?.input ?? body.parameters), sessionId: p.taskId, cwd: p.workspaceRoots?.[0] };
  },
  kindOf: table({ execute_command: 'shell', run_commands: 'shell', bash: 'shell', write_to_file: 'write', replace_in_file: 'write', editor: 'write', submit_and_exit: 'read', read_file: 'read', read_files: 'read', search_files: 'read', search_codebase: 'read', list_files: 'read', list_code_definition_names: 'read', web_fetch: 'web', fetch_web_content: 'web', use_mcp_tool: 'mcp', access_mcp_resource: 'mcp', attempt_completion: 'read', ask_followup_question: 'read' }, () => false),
  allow: () => ({ exitCode: 0, stdout: JSON.stringify({ cancel: false }) }),
  deny: (reason) => ({ exitCode: 0, stdout: JSON.stringify({ cancel: true, errorMessage: reason }), stderr: reason }),
  install: (root, command) => {
    const out: string[] = [];
    for (const d of CLINE_DIRS) for (const e of CLINE_EVENTS) {
      const path = join(root, d, e);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n# Written by agentontrack install cline\n${command} hook cline --event ${e}\n`);
      chmodSync(path, 0o755);
      out.push(path);
    }
    return out;
  },
  uninstall: (root) => { let any = false; for (const d of CLINE_DIRS) for (const e of CLINE_EVENTS) any = removeFile(join(root, d, e)) || any; return any; },
};

function removeFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
function removeHookEntries(path: string, re: RegExp): boolean {
  const cfg = jsonFile(path);
  if (!cfg?.hooks) return false;
  for (const ev of Object.keys(cfg.hooks)) {
    cfg.hooks[ev] = cfg.hooks[ev].filter((h: any) => !re.test(h.command ?? ''));
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  writeJson(path, cfg);
  return true;
}

export const PROVIDERS: Record<string, ProviderAdapter> = { cursor, copilot, devin, gemini, opencode, kiro, cline };
export const isProvider = (id: string | undefined): boolean => !!id && Object.hasOwn(PROVIDERS, id);
export const providerInstalled = (a: ProviderAdapter, root: string) => a.hookFiles.some((f) => existsSync(join(root, f)) && (readFileSync(join(root, f), 'utf8').includes('agentontrack') || readFileSync(join(root, f), 'utf8').includes(`hook ${a.id}`)));

/** Clients with no usable pre-action hook here. MCP gives them goals, evidence and state, and enforces nothing. */
export const MCP_CLIENTS: Record<string, { name: string; path: (root: string) => string; render: (command: string[], root: string) => string; merge?: boolean }> = {
  continue: { name: 'Continue', path: (root) => join(root, '.continue/mcpServers/agentontrack.yaml'), render: (c, root) => `name: agentontrack\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: agentontrack\n    type: stdio\n    command: ${JSON.stringify(c[0])}\n    args: ${JSON.stringify([...c.slice(1), 'mcp', 'continue'])}\n    env:\n      AGENTONTRACK_ROOT: ${JSON.stringify(root)}\n` },
  roo: { name: 'Roo Code (discontinued)', path: (root) => join(root, '.roo/mcp.json'), merge: true, render: (c, root) => JSON.stringify({ mcpServers: { agentontrack: { command: c[0], args: [...c.slice(1), 'mcp', 'roo'], env: { AGENTONTRACK_ROOT: root } } } }, null, 2) },
  cline: { name: 'Cline', path: () => join(process.env.CLINE_DATA_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.cline'), 'data/settings/cline_mcp_settings.json'), merge: true, render: (c, root) => JSON.stringify({ mcpServers: { agentontrack: { command: c[0], args: [...c.slice(1), 'mcp', 'cline'], env: { AGENTONTRACK_ROOT: root }, disabled: false, autoApprove: [] } } }, null, 2) },
};

export function installMcpClient(id: string, command: string[], root: string): string {
  const c = MCP_CLIENTS[id];
  if (!c) throw new Error(`Unknown MCP client ${id}. Known: ${Object.keys(MCP_CLIENTS).join(', ')}`);
  const path = c.path(root);
  mkdirSync(dirname(path), { recursive: true });
  const body = c.render(command, root);
  if (c.merge) {
    const cur = jsonFile(path) ?? {};
    writeJson(path, { ...cur, mcpServers: { ...cur.mcpServers, ...JSON.parse(body).mcpServers } });
  } else writeFileSync(path, body);
  return path;
}

/** Research only: optional, on the user's own key, and billed by Perplexity. It enforces nothing, and an answer is never evidence of completion. */
export const perplexityMcpConfig = () => ({ mcpServers: { perplexity: { command: 'npx', args: ['-y', '@perplexity-ai/mcp-server'], env: { PERPLEXITY_API_KEY: '<your key, from your own Perplexity account>' } } } });

/** The hook command as written for this host. Reading it back tests what the host will really run. */
export function providerHookCommand(a: ProviderAdapter, root: string): string | null {
  const ends = new RegExp(`hook ${a.id}$`);
  for (const f of a.hookFiles) {
    const path = join(root, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (f.endsWith('.json')) {
      const stack: unknown[] = [JSON.parse(text)];
      while (stack.length) {
        const v = stack.pop();
        if (typeof v === 'string' && ends.test(v) && !v.startsWith('& ')) return v;
        if (v && typeof v === 'object') stack.push(...Object.values(v));
      }
    } else {
      const js = new RegExp(`spawnSync\\(("(?:[^"\\\\]|\\\\.)*hook ${a.id}")`).exec(text);
      if (js) return JSON.parse(js[1]!);
      const line = text.split('\n').find((l) => ends.test(l.trim()));
      if (line) return line.trim();
    }
  }
  return null;
}

/** Runs the installed hook on a request it must refuse. A host that fails open cannot do this check for itself. */
export function providerSelfTest(a: ProviderAdapter, root: string): { ok: boolean; detail: string } {
  const command = providerHookCommand(a, root);
  if (!command) return { ok: false, detail: `no hook is installed. Run: agentontrack install ${a.id}` };
  const r = spawnSync(command, { shell: true, input: JSON.stringify(a.probe('agentontrack approve selftest')), encoding: 'utf8', timeout: 30_000, cwd: root });
  const refused = a.id === 'cline' ? /"cancel":true/.test(r.stdout ?? '') : r.status === 2;
  return refused ? { ok: true, detail: 'The hook program ran and refused a test request' } : { ok: false, detail: `the hook program did not refuse a test request (exit ${r.status ?? 'none'}). Run: agentontrack install ${a.id}` };
}
