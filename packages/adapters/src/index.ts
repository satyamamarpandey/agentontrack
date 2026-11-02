import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyCommand, type Coverage, type Effect, type Project } from '@agentontrack/core';
import * as z from 'zod/v4';

export type RuntimeId = 'claude-code' | 'codex' | 'hermes';

export interface MappedAction { effects: Effect[]; opaque: boolean; coverage: Coverage; readOnlyTool?: boolean }

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell']);

export function mapClaudeTool(tool: string, input: any): MappedAction {
  if (SHELL_TOOLS.has(tool)) {
    const c = classifyCommand(String(input?.command ?? ''));
    return { effects: c.effects, opaque: c.opaque, coverage: 'enforced' };
  }
  switch (tool) {
    case 'Write': case 'Edit': case 'MultiEdit':
      return { effects: [{ kind: 'fs.write', target: String(input?.file_path ?? '') }], opaque: false, coverage: 'enforced' };
    case 'NotebookEdit':
      return { effects: [{ kind: 'fs.write', target: String(input?.notebook_path ?? '') }], opaque: false, coverage: 'enforced' };
    case 'Read': case 'Grep': case 'Glob': case 'LS': case 'TodoWrite':
      return { effects: [], opaque: false, coverage: 'enforced', readOnlyTool: true };
    case 'WebFetch': case 'WebSearch':
      return { effects: [{ kind: 'net.fetch', target: String(input?.url ?? input?.query ?? '') }], opaque: false, coverage: 'enforced' };
    default:
      // MCP and unknown tools: the gate fired, but we cannot tell what they do.
      return { effects: [{ kind: tool.startsWith('mcp__') ? 'mcp.call' : 'exec.opaque', target: tool }], opaque: true, coverage: 'enforced' };
  }
}

/** Codex carries file edits as patch text in tool_input.command, with no file_path field. */
export function parseApplyPatch(patch: string): Effect[] {
  const effects: Effect[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (m) effects.push({ kind: m[1] === 'Delete File' ? 'fs.delete' : 'fs.write', target: m[2]!.trim() });
  }
  return effects;
}

export function mapCodexTool(tool: string, input: any): MappedAction {
  if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') {
    const effects = parseApplyPatch(String(input?.command ?? ''));
    // An unparseable patch is treated as opaque, never as harmless.
    return effects.length ? { effects, opaque: false, coverage: 'enforced' } : { effects: [{ kind: 'exec.opaque', target: tool }], opaque: true, coverage: 'enforced' };
  }
  if (tool === 'Bash' || tool === 'shell') {
    const c = classifyCommand(String(input?.command ?? ''));
    return { effects: c.effects, opaque: c.opaque, coverage: 'enforced' };
  }
  return { effects: [{ kind: tool.startsWith('mcp__') ? 'mcp.call' : 'exec.opaque', target: tool }], opaque: true, coverage: 'enforced' };
}

/** Hermes tool names come from its docs and from real runs: `tool_call` was only found by running it. */
export function mapHermesTool(tool: string, input: any): MappedAction {
  // Seen on a real Hermes 0.22.5: tool_call is a wrapper whose inner calls would otherwise pass as one opaque tool.
  if (tool === 'tool_call' && Array.isArray(input?.calls) && input.calls.length) {
    const inner = input.calls.map((c: any) => mapHermesTool(String(c?.name ?? ''), c?.arguments));
    return { effects: inner.flatMap((m: MappedAction) => m.effects), opaque: inner.some((m: MappedAction) => m.opaque), coverage: 'enforced' };
  }
  switch (tool) {
    case 'terminal': {
      const c = classifyCommand(String(input?.command ?? ''));
      return { effects: c.effects, opaque: c.opaque, coverage: 'enforced' };
    }
    case 'write_file': case 'patch':
      return { effects: [{ kind: 'fs.write', target: String(input?.path ?? input?.file_path ?? '') }], opaque: false, coverage: 'enforced' };
    case 'read_file': case 'search_files':
      return { effects: [], opaque: false, coverage: 'enforced', readOnlyTool: true };
    case 'web_search': case 'web_extract':
      return { effects: [{ kind: 'net.fetch', target: String(input?.query ?? input?.url ?? '') }], opaque: false, coverage: 'enforced' };
    default:
      // execute_code and delegate_task run code whose inner calls may not pass through this hook.
      return { effects: [{ kind: tool.startsWith('mcp') ? 'mcp.call' : 'exec.opaque', target: tool }], opaque: true, coverage: 'enforced' };
  }
}

/** Sums usage per message id, since a message spans several transcript lines. The vendor disclaims this format, so the source is labelled. */
export function parseClaudeTranscriptUsage(path: string): { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const byId = new Map<string, { model: string; u: any }>();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const o = JSON.parse(line);
      const m = o.message;
      if (m?.usage && m.id) byId.set(m.id, { model: m.model ?? 'unknown', u: m.usage });
    } catch { /* partial or unrecognised line */ }
  }
  if (byId.size === 0) return null;
  const out = { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const { model, u } of byId.values()) {
    out.model = model;
    out.inputTokens += u.input_tokens ?? 0;
    out.outputTokens += u.output_tokens ?? 0;
    out.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    out.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
  }
  return out;
}

const HookPayload = z.looseObject({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  source: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  transcript_path: z.string().optional(),
  error: z.unknown().optional(),
});

/** Heuristic. It only decides whether to add a reminder: status itself never depends on this. */
const CLAIMS_COMPLETION = /\b(task|work|everything|all|it|this)\b[^.\n]{0,40}\b(is |are |now )?(done|complete|completed|finished|fixed|resolved|verified)\b|\b(successfully|all tests pass|tests are passing)\b|^(done|complete|finished|fixed)\b/im;

export interface HookOutput { stdout?: string; exitCode: number; stderr?: string; isStop?: boolean }

const deny = (event: string, reason: string): HookOutput => ({
  exitCode: 0,
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } }),
});
const context = (event: string, text: string): HookOutput => ({
  exitCode: 0,
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
});

/** Same flow for both runtimes. Codex's `ask` fails open, so neither uses it: approval means deny and retry after a human grants it. */
export function handleHook(project: Project, runtime: RuntimeId, rawStdin: string): HookOutput {
  if (runtime === 'hermes') return handleHermesHook(project, rawStdin);
  const p = HookPayload.parse(JSON.parse(rawStdin));
  // The self-test opened the record to get here, which is what it checks. Its fake request stays out of the analytics, and is refused anyway.
  if (p.session_id === 'agentontrack-selftest') return deny('PreToolUse', 'AgentOnTrack self-test');
  const event = p.hook_event_name ?? '';
  const sessionId = p.session_id;
  const map = runtime === 'codex' ? mapCodexTool : mapClaudeTool;
  const base = { runtime, ...(sessionId ? { sessionId } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) };

  switch (event) {
    case 'SessionStart': case 'PostCompact':
      if (sessionId) project.bindSession(sessionId);
      if (p.source === 'compact' || event === 'PostCompact') project.resetContext();
      if (event === 'PostCompact') return { exitCode: 0 };
      return context(event, project.rehydrate(sessionId));
    case 'UserPromptSubmit':
      return { exitCode: 0 };
    case 'PreToolUse': {
      const tool = p.tool_name ?? '';
      const m = map(tool, p.tool_input);
      if (tool === 'Read' && typeof (p.tool_input as any)?.file_path === 'string' && project.checkRead((p.tool_input as any).file_path).duplicate) {
        return deny(event, 'AgentOnTrack: this file is unchanged since you last read it in this context, so reading it again was skipped. Use what you already have.');
      }
      const r = project.preAction({ ...base, tool, effects: m.effects, opaque: m.opaque, coverage: m.coverage, rawInput: p.tool_input, skipObservation: !!m.readOnlyTool });
      if (r.decision === 'deny') return deny(event, `AgentOnTrack denied this: ${r.reasons.join('; ')}. Do not try another way to do it.`);
      if (r.decision === 'request_approval') {
        return deny(event, `AgentOnTrack needs human approval: ${r.reasons.join('; ')}. Do not retry or work around this. Tell the user to run ${r.approvalIds.map((i) => `agentontrack approve ${i}`).join(' && ')} in their own terminal, then carry on with anything else.`);
      }
      return r.warnings.length ? context(event, `AgentOnTrack: ${r.warnings.join('; ')}`) : { exitCode: 0 };
    }
    case 'PostToolUse': {
      const tool = p.tool_name ?? '';
      const m = map(tool, p.tool_input);
      const r = project.postAction({ ...base, tool, effects: m.effects, result: p.tool_response, skipObservation: !!m.readOnlyTool });
      if (r.mismatches.length) return context(event, mismatchText(r));
      return { exitCode: 0 };
    }
    case 'PostToolUseFailure':
      project.recordFailure({ runtime, ...(sessionId ? { sessionId } : {}), tool: p.tool_name ?? '', rawInput: p.tool_input, summary: String(p.error ?? 'tool failed') });
      return { exitCode: 0 };
    case 'Stop': {
      if (runtime === 'claude-code' && p.transcript_path) {
        const u = parseClaudeTranscriptUsage(p.transcript_path);
        if (u) project.recordUsage({ ...u, runtime, source: 'transcript-derived', ...(sessionId ? { sessionId } : {}) });
      }
      const task = project.taskForSession(project.state(), sessionId);
      // stop_hook_active bounds this to one extra turn, so a task that cannot verify never traps the agent.
      if (!task || p.stop_hook_active) return { exitCode: 0 };
      const ev = project.evaluate(task.id);
      if (ev.status === 'VERIFIED' || task.criteria.length === 0) return { exitCode: 0 };
      // Blocking replaces the agent's answer with another turn, so it happens only when the answer claims completion.
      const last = String((p as any).last_assistant_message ?? '');
      if (!CLAIMS_COMPLETION.test(last)) return { exitCode: 0 };
      project.recordClaim(last.slice(0, 500), { kind: 'agent', runtime, ...(sessionId ? { sessionId } : {}) }, task.id);
      // A block costs a whole extra model turn, so the default tells the human and leaves the record as the authority.
      if (project.state().policy.stopCheck === 'report') return { exitCode: 0, stdout: JSON.stringify({ systemMessage: `AgentOnTrack: the agent's last message reads as finished, but task ${task.id} is ${ev.status}, not verified (${ev.reasons.join('; ')}). Run \`agentontrack verify\`.` }) };
      return { exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: `AgentOnTrack: your last message reads as if the work is finished, but task ${task.id} is ${ev.status}, not verified (${ev.reasons.join('; ')}). Repeat your answer, and add one sentence saying it is not yet verified. The user can run \`agentontrack verify\`.` }) };
    }
    default:
      return { exitCode: 0 };
  }
}

const mismatchText = (r: { mismatches: { path: string; reason: string }[]; reverted: { path: string; how: string }[] }) =>
  `AgentOnTrack observed unauthorized changes: ${r.mismatches.map((x) => `${x.path} (${x.reason})`).join('; ')}.${r.reverted.length ? ` Reversal: ${r.reverted.map((x) => `${x.path}: ${x.how}`).join('; ')}.` : ''} The task cannot be VERIFIED until a human reviews this. Tell the user.`;

/** Hermes shell-hook contract: {"decision":"block","reason"}. Its action "approve" escalates, so it is never used. */
function handleHermesHook(project: Project, rawStdin: string): HookOutput {
  const p = z.looseObject({ hook_event_name: z.string().optional(), tool_name: z.string().optional(), tool_input: z.unknown().optional(), session_id: z.string().optional(), cwd: z.string().optional(), extra: z.unknown().optional() }).parse(JSON.parse(rawStdin));
  const runtime = 'hermes';
  const base = { runtime, ...(p.session_id ? { sessionId: p.session_id } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) };
  const block = (reason: string): HookOutput => ({ exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason }) });
  switch (p.hook_event_name) {
    case 'on_session_start':
      if (p.session_id) project.bindSession(p.session_id);
      return { exitCode: 0 };
    case 'post_compaction':
      project.resetContext();
      return { exitCode: 0 };
    case 'pre_tool_call': {
      const tool = p.tool_name ?? '';
      const m = mapHermesTool(tool, p.tool_input);
      const r = project.preAction({ ...base, tool, effects: m.effects, opaque: m.opaque, coverage: m.coverage, rawInput: p.tool_input, skipObservation: !!m.readOnlyTool });
      if (r.decision === 'deny') return block(`AgentOnTrack denied this: ${r.reasons.join('; ')}`);
      if (r.decision === 'request_approval') return block(`AgentOnTrack needs human approval: ${r.reasons.join('; ')}. Ask the user to run: ${r.approvalIds.map((i) => `agentontrack approve ${i}`).join(' && ')}, then retry.`);
      return { exitCode: 0 };
    }
    case 'post_tool_call': {
      const tool = p.tool_name ?? '';
      const m = mapHermesTool(tool, p.tool_input);
      project.postAction({ ...base, tool, effects: m.effects, skipObservation: !!m.readOnlyTool });
      return { exitCode: 0 };
    }
    case 'post_api_request': {
      // Field names inside usage are UNVERIFIED against a live Hermes, so missing ones are recorded as zero with this source label.
      const u: any = (p as any).usage ?? (p.extra as any)?.usage;
      if (u) project.recordUsage({ runtime, model: String((p as any).model ?? 'unknown'), source: 'provider-reported', ...(p.session_id ? { sessionId: p.session_id } : {}), inputTokens: u.input_tokens ?? u.prompt_tokens ?? 0, outputTokens: u.output_tokens ?? u.completion_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? u.cached_tokens ?? 0 });
      return { exitCode: 0 };
    }
    default:
      return { exitCode: 0 };
  }
}

/** Fail closed: if the hook itself breaks, a controlled tool does not silently run unguarded. */
export function handleHookSafely(open: () => Project, runtime: RuntimeId, rawStdin: string): HookOutput {
  let project: Project | undefined;
  try {
    project = open();
    const out = handleHook(project, runtime, rawStdin);
    return /"hook_event_name"\s*:\s*"Stop"/.test(rawStdin) ? { ...out, isStop: true } : out;
  } catch (err) {
    const message = `AgentOnTrack hook error, blocking as a precaution: ${(err as Error).message}`;
    if (runtime === 'hermes') return /"hook_event_name"\s*:\s*"pre_tool_call"/.test(rawStdin) ? { exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: message }) } : { exitCode: 0 };
    if (/"hook_event_name"\s*:\s*"PreToolUse"/.test(rawStdin)) return deny('PreToolUse', message);
    return { exitCode: 0, stdout: JSON.stringify({ systemMessage: message }) };
  } finally {
    project?.close();
  }
}

export interface CoverageReport {
  runtime: RuntimeId;
  /** What the host does if the hook program cannot run, as seen on the real host. */
  hostFailMode: 'closed' | 'open';
  /** What contains a script's network and outside-project effects. */
  containment: 'none' | 'claude-sandbox-available' | 'codex-sandbox';
  enforced: string[];
  observedOnly: string[];
  unsupported: string[];
  evidence: 'live-tested' | 'live-local-model' | 'hook-fired-live' | 'documentation-only' | 'real-host-scripted-model';
  notes: string[];
}

export function coverageFor(runtime: RuntimeId): CoverageReport {
  if (runtime === 'hermes') {
    return {
      runtime,
      hostFailMode: 'closed',
      containment: 'none',
      enforced: ['terminal commands', 'write_file and patch paths'],
      observedOnly: ['file effects of execute_code inside the project root'],
      unsupported: ['subprocess calls inside execute_code', 'pre_tool_call on MCP tools and delegate_task children (unverified)'],
      evidence: 'real-host-scripted-model',
      notes: ['On real Hermes 0.22.5 with a scripted model, a terminal push was held, denied, then allowed once after approval, and a missing hook program failed closed with fail_closed: true.', 'Set fail_closed: true on the shell hook, since the default fails open.', 'New shell hooks need first-use consent, and gateway, cron and ACP surfaces never prompt.'],
    };
  }
  if (runtime === 'claude-code') {
    const windows = process.platform === 'win32';
    return {
      runtime,
      hostFailMode: 'closed',
      containment: windows ? 'none' : 'claude-sandbox-available',
      enforced: ['Write/Edit/NotebookEdit paths', 'Bash and PowerShell commands that classify statically', 'MCP tool calls (gate only, effect opaque)', 'subagent tool calls'],
      observedOnly: ['file effects of opaque scripts inside the project root (detected after they happen)'],
      unsupported: ['network and process effects of opaque scripts', 'files outside the project root changed by opaque scripts', 'runtime actions that fire no hook'],
      evidence: 'live-tested',
      notes: windows ? ['Native Windows has no Claude Code OS sandbox, so nothing contains an opaque script. Use the strict profile, which holds scripts for approval.'] : ['Run `agentontrack install claude-code --sandbox` to contain opaque scripts.'],
    };
  }
  return {
    runtime,
    hostFailMode: 'open',
    containment: 'codex-sandbox',
    enforced: ['shell commands', 'apply_patch files', 'MCP and local function tools (gate only)'],
    observedOnly: ['file effects of opaque scripts inside the project root'],
    unsupported: ['hosted tools such as WebSearch', 'specialized tool paths that opt out of hooks', 'network and process effects of opaque scripts'],
    evidence: 'live-local-model',
    notes: ['Codex 0.166.0 was run for real in a cloud runner with a small local model: a push was held, then allowed after approval. Not tested with OpenAI models.', 'Codex skips a hook until its definition hash is trusted, so installing it does not by itself enforce anything.', 'If the hook program is missing, Codex runs the action anyway: FAIL-OPEN, observed on the real host, so the gate cannot be a hard boundary on Codex. Start it with `agentontrack run codex`, which refuses to launch unless the hook answers, and uses the Codex OS sandbox with the network off. Files changed with no gate firing are caught at verify. A push made that way is not.'],
  };
}

const HOOK_COMMAND = / hook (claude-code|codex)$/;

const EVENTS: Record<'claude-code' | 'codex', string[]> = {
  'claude-code': ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'],
  codex: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'],
};

/** Hermes hooks live in the user's global config, so AgentOnTrack prints this for the user to add rather than editing it. */
export function hermesHookConfig(cliCommand: string): string {
  const events = ['on_session_start', 'pre_tool_call', 'post_tool_call', 'post_compaction', 'post_api_request'];
  return ['hooks:', ...events.flatMap((e) => [`  ${e}:`, `    - command: '${cliCommand} hook hermes'`, ...(e === 'pre_tool_call' ? ['      fail_closed: true'] : [])])].join('\n');
}

function configPath(runtime: 'claude-code' | 'codex', root: string): string {
  return runtime === 'claude-code' ? join(root, '.claude', 'settings.local.json') : join(root, '.codex', 'hooks.json');
}

const isOurs = (h: any) => typeof h?.command === 'string' && HOOK_COMMAND.test(h.command);

export function installHooks(runtime: 'claude-code' | 'codex', root: string, cliCommand: string, opts: { sandbox?: boolean } = {}): { path: string; before: string; after: string } {
  const path = configPath(runtime, root);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const cfg = before ? JSON.parse(before) : {};
  cfg.hooks ??= {};
  for (const event of EVENTS[runtime]) {
    const groups = (cfg.hooks[event] ?? []).filter((g: any) => !(g.hooks ?? []).some(isOurs));
    const hook: Record<string, unknown> = { type: 'command', command: `${cliCommand} hook ${runtime}`, timeout: 60 };
    if (runtime === 'claude-code') hook.onFailure = 'block';
    const group: Record<string, unknown> = { hooks: [hook] };
    // Dedicated read tools have no effects to gate, so they start no process. Anything unknown still reaches the gate.
    if (event === 'PreToolUse') group.matcher = runtime === 'claude-code' ? '^(?!(Read|Grep|Glob|LS|TodoWrite)$).*' : '*';
    // Read-only tools skip observation anyway, so not starting a process for them saves a hook per read.
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') group.matcher = runtime === 'claude-code' ? 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*' : '*';
    cfg.hooks[event] = [...groups, group];
  }
  // Claude Code's own OS sandbox contains network and outside-root effects where it exists (macOS, Linux). failIfUnavailable stops a silent downgrade.
  if (opts.sandbox && runtime === 'claude-code') cfg.sandbox = { ...cfg.sandbox, enabled: true, failIfUnavailable: true };
  const after = `${JSON.stringify(cfg, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  if (runtime === 'codex') writeCodexSandbox(root);
  return { path, before, after };
}

const CODEX_BEGIN = '# agentontrack:begin';
const CODEX_END = '# agentontrack:end';
const CODEX_BLOCK = `${CODEX_BEGIN}\nsandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = false\nexclude_slash_tmp = true\nexclude_tmpdir_env_var = true\n${CODEX_END}\n`;
const codexConfig = (root: string) => join(root, '.codex', 'config.toml');

/** TOML tables must come last, so the block goes after existing top-level keys. A file that already sets these is left alone. */
function writeCodexSandbox(root: string): void {
  const path = codexConfig(root);
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (cur.includes(CODEX_BEGIN) || /^\s*sandbox_mode\s*=/m.test(cur) || /^\s*\[sandbox_workspace_write\]/m.test(cur)) return;
  if (/^\s*\[/m.test(cur)) writeFileSync(path, `${CODEX_BLOCK}${cur}`);
  else writeFileSync(path, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${CODEX_BLOCK}`);
}

function removeCodexSandbox(root: string): void {
  const path = codexConfig(root);
  if (!existsSync(path)) return;
  const cur = readFileSync(path, 'utf8');
  const start = cur.indexOf(CODEX_BEGIN);
  const end = cur.indexOf(CODEX_END);
  if (start >= 0 && end > start) writeFileSync(path, `${cur.slice(0, start)}${cur.slice(end + CODEX_END.length).replace(/^\r?\n/, '')}`);
}

export interface HookSelfTest { ok: boolean; detail: string; fix?: string }

/**
 * Runs the exact command the host would run, on a request that must be refused. This is what makes up for a host that
 * fails open: if the program is gone or broken, the caller refuses to start the agent.
 */
export function hookSelfTest(runtime: 'claude-code' | 'codex', root: string): HookSelfTest {
  const path = configPath(runtime, root);
  const fix = `Run: agentontrack install ${runtime}`;
  if (!existsSync(path)) return { ok: false, detail: `No hook file at ${path}`, fix };
  let command: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    command = (cfg.hooks?.PreToolUse ?? []).flatMap((g: any) => g.hooks ?? []).find(isOurs)?.command;
  } catch (err) { return { ok: false, detail: `Hook file is not valid JSON: ${(err as Error).message}`, fix }; }
  if (!command) return { ok: false, detail: 'The hook file has no AgentOnTrack PreToolUse hook', fix };
  const input = JSON.stringify({ session_id: 'agentontrack-selftest', cwd: root, hook_event_name: 'PreToolUse', tool_name: runtime === 'codex' ? 'shell' : 'Bash', tool_input: { command: 'agentontrack approve selftest' } });
  const r = spawnSync(command, { shell: true, input, encoding: 'utf8', timeout: 30_000, cwd: root, env: { ...process.env, AGENTONTRACK_ROOT: root } });
  if (r.status === 0 && /"permissionDecision":"deny"/.test(r.stdout ?? '')) return { ok: true, detail: 'The hook program ran and refused a test request' };
  return { ok: false, detail: `The hook program did not refuse a test request (exit ${r.status ?? 'none'}): ${`${r.stderr ?? ''}${r.error?.message ?? ''}`.trim().slice(0, 200)}`, fix };
}

export function uninstallHooks(runtime: 'claude-code' | 'codex', root: string): boolean {
  const path = configPath(runtime, root);
  if (!existsSync(path)) return false;
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  for (const event of Object.keys(cfg.hooks ?? {})) {
    cfg.hooks[event] = cfg.hooks[event].filter((g: any) => !(g.hooks ?? []).some(isOurs));
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  if (runtime === 'codex') removeCodexSandbox(root);
  return true;
}

export function hooksInstalled(runtime: 'claude-code' | 'codex', root: string): boolean {
  const path = configPath(runtime, root);
  if (!existsSync(path)) return false;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    return EVENTS[runtime].every((e) => (cfg.hooks?.[e] ?? []).some((g: any) => (g.hooks ?? []).some(isOurs)));
  } catch { return false; }
}

export interface LocalModelCapabilities {
  baseUrl: string;
  reachable: boolean;
  models: string[];
  model?: string;
  chatCompletions: boolean;
  toolCalling: 'verified' | 'not-observed' | 'untested';
  usageReported: boolean;
  isAgentRuntime: false;
  notes: string[];
}

/**
 * Tests what an OpenAI-compatible endpoint does, rather than assuming from the fact it answers. A model server is
 * not an agent: enforcement comes from the agent harness pointed at it, such as Claude Code or Codex with hooks.
 */
export async function probeLocalModel(baseUrl: string, model?: string, fetchImpl: typeof fetch = fetch): Promise<LocalModelCapabilities> {
  const url = baseUrl.replace(/\/$/, '');
  const out: LocalModelCapabilities = { baseUrl: url, reachable: false, models: [], chatCompletions: false, toolCalling: 'untested', usageReported: false, isAgentRuntime: false, notes: ['A raw model endpoint has no tools, approvals or session state of its own. AgentOnTrack enforcement needs an agent harness in front of it.'] };
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) out.notes.push('Endpoint is not on loopback, so prompts and code would leave this machine.');
  try {
    const res = await fetchImpl(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { out.notes.push(`/v1/models returned ${res.status}`); return out; }
    out.reachable = true;
    out.models = ((await res.json() as any).data ?? []).map((m: any) => String(m.id));
  } catch (err) {
    out.notes.push(`Not reachable: ${(err as Error).message}`);
    return out;
  }
  const chosen = model ?? out.models[0];
  if (!chosen) { out.notes.push('No model is loaded.'); return out; }
  out.model = chosen;
  try {
    const res = await fetchImpl(`${url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: chosen, max_tokens: 64, messages: [{ role: 'user', content: 'Call the ping tool with value "ok".' }], tools: [{ type: 'function', function: { name: 'ping', description: 'Ping', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }] }),
    });
    if (!res.ok) { out.notes.push(`chat/completions returned ${res.status}`); return out; }
    const body: any = await res.json();
    out.chatCompletions = true;
    out.usageReported = typeof body.usage?.prompt_tokens === 'number';
    out.toolCalling = body.choices?.[0]?.message?.tool_calls?.length ? 'verified' : 'not-observed';
    if (out.toolCalling === 'not-observed') out.notes.push('The model answered without calling the tool in one trial, which is not reliable enough for a coding agent.');
  } catch (err) {
    out.notes.push(`Chat probe failed: ${(err as Error).message}`);
  }
  return out;
}

export * from './providers.js';
export * from './discovery.js';
