import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';

// Black-box tests against the built CLI, over real stdio. Run `pnpm build` first.
const CLI = resolve('packages/cli/dist/index.js');
let dir: string;
let root: string;
let env: Record<string, string>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl-m-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  env = { ...(process.env as Record<string, string>), AGENTONTRACK_HOME: join(dir, 'home'), AGENTONTRACK_ROOT: root };
  const p = new Project(root);
  p.human.setGoal({ statement: 'Test goal' });
  p.human.createTask({ id: 't', title: 'task' });
  p.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.each(['legacy', 'auto'] as const)('MCP over stdio, %s negotiation', (mode) => {
  const connect = async () => {
    const client = new Client({ name: 'test', version: '0' }, mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {});
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', 'test-runtime'], env, cwd: root }));
    return client;
  };

  it('exposes no way to approve, set policy or create tasks', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('project.status');
    // approvals.list is the one read-only exception, and it is checked to be exactly that.
    for (const n of names.filter((x) => x !== 'approvals.list')) expect(n).not.toMatch(/approv|policy|grant|revoke|task\.create|shell|exec/i);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'approvals.list')!;
    expect(Object.keys((tool.inputSchema as any).properties ?? {})).toEqual([]);
    await client.close();
  });

  it('survives concurrent calls and keeps the record intact', async () => {
    const client = await connect();
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.callTool({ name: i % 2 ? 'project.status' : 'evidence.claim', arguments: i % 2 ? {} : { taskId: 't', text: `c${i}` } })));
    const d: any = await client.callTool({ name: 'runtime.diagnostics', arguments: {} });
    expect(JSON.parse(d.content[0].text).integrityOk).toBe(true);
    await client.close();
  });

  it('a second client keeps working after another disconnects', async () => {
    const a = await connect();
    const b = await connect();
    await a.close();
    const r: any = await b.callTool({ name: 'goal.history', arguments: {} });
    expect(JSON.parse(r.content[0].text)[0].statement).toBe('Test goal');
    await b.close();
  });

  it('suggests workflows without inventing commands', async () => {
    const client = await connect();
    const r: any = await client.callTool({ name: 'workflow.suggest', arguments: { intent: 'repair failing tests' } });
    expect(JSON.parse(r.content[0].text).workflow).toBe('repair');
    expect(JSON.parse(r.content[0].text).native).toBeNull();
    await client.close();
  });

  it('never leaks secrets in evidence output', async () => {
    const client = await connect();
    const r: any = await client.callTool({ name: 'evidence.list', arguments: { taskId: 't' } });
    expect(r.content[0].text).not.toContain('"observed"');
    await client.close();
  });

  it('serves state, and a goal proposal does not change the goal', async () => {
    const client = await connect();
    const r: any = await client.callTool({ name: 'goal.propose', arguments: { statement: 'Delete everything' } });
    expect(JSON.parse(r.content[0].text).effective).toBe(false);
    const st: any = await client.callTool({ name: 'project.status', arguments: {} });
    expect(JSON.parse(st.content[0].text).goal.statement).toBe('Test goal');
    await client.close();
  });

  it('a claim cannot verify a task', async () => {
    const client = await connect();
    await client.callTool({ name: 'evidence.claim', arguments: { taskId: 't', text: 'done' } });
    const ev: any = await client.callTool({ name: 'evidence.list', arguments: { taskId: 't' } });
    expect(JSON.parse(ev.content[0].text).evaluation.status).not.toBe('VERIFIED');
    await client.close();
  });

  it('rejects invalid input, and serves resources and prompts', async () => {
    const client = await connect();
    const bad: any = await client.callTool({ name: 'evidence.list', arguments: {} });
    expect(bad.isError).toBe(true);
    const res: any = await client.readResource({ uri: 'agentontrack://state' });
    expect(res.contents[0].text).toContain('Test goal');
    const prompt: any = await client.getPrompt({ name: 'safe-continuation', arguments: {} });
    expect(prompt.messages[0].content.text).toContain('Test goal');
    await client.close();
  });
});

describe('CLI authority boundary (black box)', () => {
  const run = (args: string[], input = '') => spawnSync(process.execPath, [CLI, ...args], { env, cwd: root, input, encoding: 'utf8' });

  it('refuses every human operation without a TTY', () => {
    const goal = join(dir, 'goal.json');
    writeFileSync(goal, JSON.stringify({ statement: 'hijack' }));
    const task = join(dir, 'task.json');
    writeFileSync(task, JSON.stringify({ title: 'hijack' }));
    const hook = run(['hook', 'claude-code'], JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }));
    const id = /agentontrack approve (apr_\w+)/.exec(hook.stdout)![1]!;
    for (const args of [['approve', id], ['goal', 'set', '--file', goal], ['task', 'create', '--file', task], ['revoke', id], ['ack', '1']]) {
      const r = run(args, 'anything\n');
      expect(r.status, args.join(' ')).toBe(3);
      expect(r.stderr).toMatch(/interactive terminal/);
    }
    const p = new Project(root);
    expect(p.state().approvals.get(id)?.granted).toBe(false);
    expect(p.state().goal?.statement).toBe('Test goal');
    p.close();
  });

  it('hook process denies via real stdin and stdout', () => {
    const r = run(['hook', 'codex'], JSON.stringify({ session_id: 's2', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'agentontrack approve apr_1' } }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('fails closed on malformed hook input claiming PreToolUse', () => {
    const r = run(['hook', 'claude-code'], '{"hook_event_name":"PreToolUse", bad');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('init is a dry run by default and preserves existing files', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Mine\nKeep me\n');
    const dry = run(['init']);
    expect(dry.stdout).toMatch(/Dry run/);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Mine\nKeep me\n');
    run(['init', '--apply']);
    const after = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(after).toContain('Keep me');
    expect(after).toContain('agentontrack:begin');
    run(['init', '--apply']);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(after);
  });
});
