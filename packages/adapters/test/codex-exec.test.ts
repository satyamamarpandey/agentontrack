import { describe, expect, it } from 'vitest';
import { LineSplitter, buildCodexExecArgs, codexUsageRecord, parseCodexLine } from '../src/index.js';

describe('codex exec arguments', () => {
  it('starts a session in workspace-write, with the prompt after --', () => {
    expect(buildCodexExecArgs({ prompt: 'fix it', model: 'gpt-x' })).toEqual(['exec', '--json', '--model', 'gpt-x', '--sandbox', 'workspace-write', '--', 'fix it']);
  });
  it('resumes by id without setting a sandbox the docs do not list for resume', () => {
    const a = buildCodexExecArgs({ prompt: 'go on', resumeSessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(a).not.toContain('--sandbox');
    expect(a.at(-2)).toBe('--');
  });
  it('never emits a bypass flag and refuses option-like prompts, models and ids', () => {
    expect(buildCodexExecArgs({ prompt: 'x' }).join(' ')).not.toMatch(/yolo|bypass|danger/);
    expect(() => buildCodexExecArgs({ prompt: '--yolo' })).toThrow();
    expect(() => buildCodexExecArgs({ prompt: 'x', model: '--yolo' })).toThrow();
    expect(() => buildCodexExecArgs({ prompt: 'x', resumeSessionId: '--last' })).toThrow();
  });
});

describe('codex event parsing', () => {
  it('reads the documented example events', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}')).toEqual({ kind: 'session', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
    expect(parseCodexLine('{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}')).toEqual({ kind: 'tool', tool: 'shell', summary: 'bash -lc ls', phase: 'started' });
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"done"}}')).toEqual({ kind: 'message', text: 'done' });
    const u = parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}');
    expect(u).toEqual({ kind: 'usage', inputTokens: 24763, cachedInputTokens: 24448, outputTokens: 122, reasoningOutputTokens: 0 });
    expect(codexUsageRecord(u as never, 'm')).toMatchObject({ inputTokens: 315, cacheReadTokens: 24448, outputTokens: 122 });
  });
  it('ignores noise and malformed or hostile fields instead of inventing values', () => {
    for (const l of ['', 'not json', '42', 'null', '{"type":"mystery"}', '{"type":"thread.started","thread_id":"--last"}']) expect(parseCodexLine(l), l).toBeNull();
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":-5,"output_tokens":"9"}}')).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(parseCodexLine('{"type":"error"}')).toMatchObject({ kind: 'error' });
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"private"}}')).toBeNull();
  });
  it('reassembles lines split across chunks', () => {
    const s = new LineSplitter();
    expect([...s.push('{"type":"turn.sta'), ...s.push('rted"}\n{"type":"turn.failed"}\n{"ty')]).toEqual(['{"type":"turn.started"}', '{"type":"turn.failed"}']);
    expect(s.flush()).toEqual(['{"ty']);
  });
});

describe('codex default model', () => {
  it("'default' sends no --model, so a ChatGPT sign-in uses its own default", () => {
    expect(buildCodexExecArgs({ prompt: 'x', model: 'default' })).not.toContain('--model');
    expect(buildCodexExecArgs({ prompt: 'x', model: 'gpt-5' })).toContain('--model');
  });
});
