import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { coverageFor, handleHook, handleHookSafely, hermesHookConfig, mapHermesTool, parseClaudeTranscriptUsage, probeLocalModel } from '../src/index.js';

// Contract tests from Hermes documentation payloads. They do NOT show a live Hermes works: that remains BLOCKED.
let dir: string;
let root: string;
let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl-hl-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 't' });
});
afterEach(() => { p.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const hermes = (hook_event_name: string, tool_name: string, tool_input: unknown, extra = {}) => JSON.stringify({ hook_event_name, tool_name, tool_input, session_id: 'sess_abc123', cwd: root, profile: 'default', extra: { task_id: 'x', tool_call_id: 'y' }, ...extra });

describe('Hermes contract (documentation fixtures)', () => {
  it('blocks with the documented shape, and never uses action approve', () => {
    const out = handleHook(p, 'hermes', hermes('pre_tool_call', 'terminal', { command: 'git push' }));
    const body = JSON.parse(out.stdout!);
    expect(body.decision).toBe('block');
    expect(body.reason).toMatch(/agentontrack approve/);
    expect(out.stdout).not.toContain('"action"');
  });

  it('looks inside the tool_call wrapper seen on a real Hermes', () => {
    const out = handleHook(p, 'hermes', hermes('pre_tool_call', 'tool_call', { calls: [{ name: 'terminal', arguments: { command: 'git push origin main' } }] }));
    expect(JSON.parse(out.stdout!).decision).toBe('block');
    expect(mapHermesTool('tool_call', {}).opaque).toBe(true);
  });

  it('allows silently', () => {
    expect(handleHook(p, 'hermes', hermes('pre_tool_call', 'terminal', { command: 'git status' }))).toEqual({ exitCode: 0 });
    expect(handleHook(p, 'hermes', hermes('pre_tool_call', 'read_file', { path: 'src/a' }))).toEqual({ exitCode: 0 });
  });

  it('gates write_file and patch by path', () => {
    expect(JSON.parse(handleHook(p, 'hermes', hermes('pre_tool_call', 'write_file', { path: 'prod.conf' })).stdout!).decision).toBe('block');
    expect(handleHook(p, 'hermes', hermes('pre_tool_call', 'patch', { path: 'src/a.ts' }))).toEqual({ exitCode: 0 });
  });

  it('treats execute_code and delegate_task as opaque', () => {
    expect(mapHermesTool('execute_code', { code: 'x' }).opaque).toBe(true);
    expect(mapHermesTool('delegate_task', {}).opaque).toBe(true);
  });

  it('observes after execute_code', () => {
    handleHook(p, 'hermes', hermes('pre_tool_call', 'execute_code', {}));
    writeFileSync(join(root, 'prod.conf'), 'x');
    handleHook(p, 'hermes', hermes('post_tool_call', 'execute_code', {}));
    expect(p.state().mismatches[0]?.path).toBe('prod.conf');
  });

  it('records usage from post_api_request, labelled by source', () => {
    handleHook(p, 'hermes', JSON.stringify({ hook_event_name: 'post_api_request', session_id: 's', model: 'm', usage: { prompt_tokens: 10, completion_tokens: 4 } }));
    expect(p.store.byType(['usage.recorded'])[0]!.payload).toMatchObject({ runtime: 'hermes', inputTokens: 10, outputTokens: 4, source: 'provider-reported' });
  });

  it('blocks when the handler fails', () => {
    const out = handleHookSafely(() => { throw new Error('boom'); }, 'hermes', hermes('pre_tool_call', 'terminal', { command: 'ls' }));
    expect(JSON.parse(out.stdout!).decision).toBe('block');
  });

  it('prints a fail-closed hook config for the user, and says how it was tested', () => {
    expect(hermesHookConfig('bl')).toContain('fail_closed: true');
    expect(coverageFor('hermes').evidence).toBe('real-host-scripted-model');
    expect(coverageFor('hermes').notes[0]).toMatch(/scripted model/);
  });
});

describe('transcript usage', () => {
  it('counts each message id once, and survives bad lines', () => {
    const f = join(dir, 't.jsonl');
    const line = (id: string, input: number, output: number) => JSON.stringify({ message: { id, model: 'm', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5 } } });
    writeFileSync(f, [line('a', 1, 2), line('a', 1, 9), 'not json "usage"', line('b', 3, 4)].join('\n'));
    expect(parseClaudeTranscriptUsage(f)).toMatchObject({ inputTokens: 4, outputTokens: 13, cacheReadTokens: 10 });
    expect(parseClaudeTranscriptUsage(join(dir, 'none'))).toBeNull();
  });
});

// A stand-in OpenAI-compatible server, to test the probe's logic. It is not a real model.
describe('local-model probe (stand-in server)', () => {
  let srv: Server;
  const serve = async (mode: { tools: boolean; usage?: boolean; models?: string[]; chat500?: boolean }) => {
    srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: (mode.models ?? ['m1']).map((id) => ({ id })) })); return; }
      if (mode.chat500) { res.statusCode = 500; res.end('{}'); return; }
      res.end(JSON.stringify({ choices: [{ message: mode.tools ? { tool_calls: [{ function: { name: 'ping' } }] } : { content: 'hello' } }], ...(mode.usage ? { usage: { prompt_tokens: 1 } } : {}) }));
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  };
  afterEach(() => { srv?.close(); });

  it('reports tool calling only when actually observed', async () => {
    expect(await probeLocalModel(await serve({ tools: true, usage: true }))).toMatchObject({ reachable: true, chatCompletions: true, toolCalling: 'verified', usageReported: true, isAgentRuntime: false });
  });

  it('does not claim tool calling because the endpoint answered', async () => {
    const r = await probeLocalModel(await serve({ tools: false }));
    expect(r.toolCalling).toBe('not-observed');
    expect(r.usageReported).toBe(false);
  });

  it('handles an empty model list and server errors', async () => {
    expect((await probeLocalModel(await serve({ tools: true, models: [] }))).notes.join()).toMatch(/No model/);
    srv.close();
    expect((await probeLocalModel(await serve({ tools: true, chat500: true }))).chatCompletions).toBe(false);
  });

  it('reports an unreachable server, and warns about non-loopback endpoints', async () => {
    expect((await probeLocalModel('http://127.0.0.1:1')).reachable).toBe(false);
    const r = await probeLocalModel('https://example.test', 'm', (async () => { throw new Error('no'); }) as any);
    expect(r.notes.join()).toMatch(/not on loopback/);
  });
});
