// Contract tests from each vendor's documented payloads. These check our translation, and say nothing about whether a real host
// behaves as documented: that is what benchmarks/live/provider-checks.mjs and the certification file are for.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { effectsFor, handleProviderHook, handleProviderHookSafely, installMcpClient, isProvider, MCP_CLIENTS, PROVIDERS, providerInstalled, providerSelfTest } from '../src/providers.js';

let dir: string; let root: string; let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-prov-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 't' });
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const PUSH: Record<string, unknown> = {
  cursor: { hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'git push origin main' }, conversation_id: 'c', cwd: '.' },
  copilot: { toolName: 'bash', toolArgs: JSON.stringify({ command: 'git push origin main' }), sessionId: 'c', cwd: '.' },
  devin: { hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: 'git push origin main' }, session_id: 'c' },
  gemini: { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push origin main' }, session_id: 'c', cwd: '.' },
  opencode: { hook_event_name: 'tool.execute.before', tool: 'bash', sessionID: 'c', args: { command: 'git push origin main' } },
  kiro: { hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command: 'git push origin main' }, session_id: 'c', cwd: '.' },
  cline: { hookName: 'PreToolUse', taskId: 'c', workspaceRoots: ['.'], preToolUse: { toolName: 'execute_command', parameters: { command: 'git push origin main' } } },
};
const blocked = (id: string, o: { exitCode: number; stdout?: string }) => (id === 'cline' ? JSON.parse(o.stdout!).cancel === true : o.exitCode === 2);

describe.each(Object.keys(PROVIDERS))('%s contract', (id) => {
  const a = PROVIDERS[id]!;
  it('holds a push for approval, in the form this host honours, then allows it once after approval', () => {
    const out = handleProviderHook(p, a, JSON.stringify(PUSH[id]));
    expect(blocked(id, out)).toBe(true);
    expect(`${out.stderr}${out.stdout}`).toMatch(/approve apr_/);
    const pending = [...p.state().approvals.values()].find((x) => x.status === 'pending')!;
    expect(pending.effect.kind).toBe('vcs.push');
    expect(pending.runtime).toBe(id);
    p.human.approve(pending.id);
    expect(blocked(id, handleProviderHook(p, a, JSON.stringify(PUSH[id])))).toBe(false);
    expect(blocked(id, handleProviderHook(p, a, JSON.stringify(PUSH[id])))).toBe(true);
  });

  it('an approval for this host does not work for another', () => {
    handleProviderHook(p, a, JSON.stringify(PUSH[id]));
    p.human.approve([...p.state().approvals.values()].find((x) => x.status === 'pending')!.id);
    const other = id === 'gemini' ? 'kiro' : 'gemini';
    expect(blocked(other, handleProviderHook(p, PROVIDERS[other]!, JSON.stringify(PUSH[other])))).toBe(true);
  });

  it('refuses when anything of ours breaks: bad state, or unreadable input', () => {
    const out = handleProviderHookSafely(() => { throw new Error('boom'); }, a, JSON.stringify(PUSH[id]));
    expect(blocked(id, out)).toBe(true);
    expect(blocked(id, handleProviderHookSafely(() => p.store && new Project(root), a, ''))).toBe(true);
  });

  it('an unknown tool is opaque, never harmless', () => {
    expect(effectsFor(a, 'brand_new_tool', {})).toMatchObject({ opaque: true, readOnly: false });
    expect(effectsFor(a, 'brand_new_tool', {}).effects[0]!.kind).toBe('exec.opaque');
  });

  it('install is safe to repeat, reports itself, and uninstall removes it', () => {
    const cmd = '"node" "cli.js"';
    a.install(root, cmd);
    a.install(root, cmd);
    expect(providerInstalled(a, root)).toBe(true);
    expect(a.uninstall(root)).toBe(true);
    expect(providerInstalled(a, root)).toBe(false);
  });

  it('the real program, called as installed with --root first, refuses a push; and the self-test passes, then fails if the program goes', () => {
    p.close();
    const cli = resolve('packages/cli/dist/index.js').replace(/\\/g, '/');
    const cmd = `"${process.execPath.replace(/\\/g, '/')}" "${cli}" --root "${root.replace(/\\/g, '/')}"`;
    a.install(root, cmd);
    const r = spawnSync(`${cmd} hook ${id}`, { shell: true, input: JSON.stringify(PUSH[id]), encoding: 'utf8', env: process.env });
    p = new Project(root);
    expect(blocked(id, { exitCode: r.status ?? -1, stdout: r.stdout }), r.stderr).toBe(true);
    expect(p.store.byType(['action.requested']).at(-1)?.payload.effects[0].kind).toBe('vcs.push');
    const before = p.store.byType(['action.requested']).length;
    expect(providerSelfTest(a, root)).toMatchObject({ ok: true });
    expect(p.store.byType(['action.requested']).length, 'self-test leaves no trace in analytics').toBe(before);
    a.uninstall(root);
    expect(providerSelfTest(a, root).ok).toBe(false);
    a.install(root, `"${process.execPath.replace(/\\/g, '/')}" "${join(dir, 'gone.js').replace(/\\/g, '/')}"`);
    expect(providerSelfTest(a, root).ok).toBe(false);
  });

  it('declares failure behaviour and limitations, so nothing reads as fully supported by default', () => {
    expect(a.failure.crash.length).toBeGreaterThan(0);
    expect(a.limitations.length).toBeGreaterThan(0);
  });
});

describe('host specifics', () => {
  it('Cursor sets failClosed on the pre-action hook, keeps other hooks, and parses tool_input given as a string', () => {
    mkdirSync(join(root, '.cursor'));
    writeFileSync(join(root, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'mine.sh' }] } }));
    PROVIDERS.cursor!.install(root, 'x');
    const cfg = JSON.parse(readFileSync(join(root, '.cursor/hooks.json'), 'utf8'));
    expect(cfg.hooks.preToolUse.map((h: any) => h.command)).toEqual(['mine.sh', 'x hook cursor']);
    expect(cfg.hooks.preToolUse[1].failClosed).toBe(true);
    expect(PROVIDERS.cursor!.normalize({ hook_event_name: 'preToolUse', tool_name: 'MCP:x', tool_input: '{"a":1}' }).input).toEqual({ a: 1 });
    PROVIDERS.cursor!.uninstall(root);
    expect(JSON.parse(readFileSync(join(root, '.cursor/hooks.json'), 'utf8')).hooks.preToolUse.map((h: any) => h.command)).toEqual(['mine.sh']);
  });

  it('Copilot accepts both documented payload shapes and gives no decision on allow, so it cannot auto-approve', () => {
    const a = PROVIDERS.copilot!;
    expect(a.normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's' })).toMatchObject({ phase: 'pre', tool: 'Bash', sessionId: 's' });
    expect(a.normalize({ toolName: 'bash', toolArgs: '{"command":"ls"}' })).toMatchObject({ phase: 'pre', input: { command: 'ls' } });
    expect(a.normalize({ toolName: 'bash', toolArgs: '{}', toolResult: { x: 1 } }).phase).toBe('post');
    expect(a.allow().stdout).toBeUndefined();
  });

  it('Cline: reads the payload the real CLI sends, as captured from 3.0.74', () => {
    const real = { hookName: 'tool_call', taskId: 'conv_1', workspaceRoots: ['.'], tool_call: { id: 'x', name: 'run_commands', input: { commands: ['git push origin main'] } }, preToolUse: { toolName: 'run_commands', parameters: { commands: '["git push origin main"]' } } };
    const out = handleProviderHook(p, PROVIDERS.cline!, JSON.stringify(real), { event: 'PreToolUse' });
    expect(JSON.parse(out.stdout!).cancel).toBe(true);
    expect([...p.state().approvals.values()].at(-1)!.effect.kind).toBe('vcs.push');
  });

  it('a hook installed for a pre-action event refuses a payload it cannot read, rather than allowing it', () => {
    const out = handleProviderHook(p, PROVIDERS.cline!, JSON.stringify({ somethingNew: true }), { event: 'PreToolUse' });
    expect(JSON.parse(out.stdout!).cancel).toBe(true);
    expect(out.stderr).toMatch(/could not/);
  });

  it('Gemini keeps other settings and hooks, in milliseconds', () => {
    mkdirSync(join(root, '.gemini'));
    writeFileSync(join(root, '.gemini/settings.json'), JSON.stringify({ theme: 'x' }));
    PROVIDERS.gemini!.install(root, 'x', { timeoutSec: 5 });
    const cfg = JSON.parse(readFileSync(join(root, '.gemini/settings.json'), 'utf8'));
    expect(cfg.theme).toBe('x');
    expect(cfg.hooks.BeforeTool[0].hooks[0].timeout).toBe(5000);
    PROVIDERS.gemini!.uninstall(root);
    expect(JSON.parse(readFileSync(join(root, '.gemini/settings.json'), 'utf8'))).toEqual({ theme: 'x' });
  });

  it('OpenCode plugin throws on any hook failure, for V1 and V2', () => {
    for (const v2 of [false, true]) {
      const [f] = PROVIDERS.opencode!.install(root, 'x', { v2 });
      const body = readFileSync(f!, 'utf8');
      expect(body).toMatch(/status !== 0\) throw/);
      expect(body.includes('@opencode/plugin')).toBe(v2);
    }
  });

  it('host config folders are protected from the agent', () => {
    for (const f of ['.cursor/hooks.json', '.github/hooks/x.json', '.github/copilot/settings.json', '.gemini/settings.json', '.devin/hooks.v1.json', '.opencode/plugins/x.js', '.kiro/hooks/x.json', '.cline/hooks/PreToolUse', '.clinerules/hooks/PreToolUse', '.continue/settings.json']) {
      const r = p.preAction({ runtime: 'cursor', tool: 'Write', effects: [{ kind: 'fs.write', target: f }], opaque: false, coverage: 'enforced', rawInput: f });
      expect(r.reasons.join(), f).toMatch(/protected path/);
    }
  });

  it('isProvider does not match inherited names', () => {
    expect(isProvider('cursor')).toBe(true);
    expect(isProvider('constructor')).toBe(false);
  });
});

describe('MCP clients get state, and no claim of enforcement', () => {
  it('writes each client config, keeps other servers, and is separate from native adapters', () => {
    process.env.CLINE_DATA_DIR = join(dir, 'cline');
    for (const id of Object.keys(MCP_CLIENTS)) expect(existsSync(installMcpClient(id, ['node', 'cli.js'], root))).toBe(true);
    const f = join(root, '.roo/mcp.json');
    writeFileSync(f, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
    installMcpClient('roo', ['node', 'cli.js'], root);
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers).sort()).toEqual(['agentontrack', 'mine']);
    expect(() => installMcpClient('nope', [], root)).toThrow(/Unknown/);
    delete process.env.CLINE_DATA_DIR;
  });
});
