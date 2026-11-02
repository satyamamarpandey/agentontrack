import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeConfiguredModel, codexConfiguredModel, describeAgents, discoverModels, localServerModels } from '../src/index.js';

let home = '';
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'aot-disc-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const fakeFetch = (routes: Record<string, unknown>): typeof fetch => (async (url: string) => {
  const hit = routes[url];
  return hit === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => hit };
}) as never;

describe('model discovery', () => {
  it('finds nothing when nothing is reported, configured or listening, and invents nothing', async () => {
    expect(await discoverModels({ seen: [], inits: [], home, probeLocal: false })).toEqual([]);
  });
  it('reads only the model line of each config, and ignores a value that is not a model name', () => {
    mkdirSync(join(home, '.codex'), { recursive: true }); mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'api_key = "sk-secret"\nmodel = "gpt-test-1"\n');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus-test', env: { KEY: 'secret' } }));
    expect(codexConfiguredModel(home)).toBe('gpt-test-1');
    expect(claudeConfiguredModel(home)).toBe('opus-test');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'bad name; rm -rf' }));
    expect(claudeConfiguredModel(home)).toBeNull();
  });
  it('marks a model "worked" only when a recorded run used it, and never claims entitlement for the rest', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet-test' }));
    const got = await discoverModels({
      home, probeLocal: false,
      seen: [{ agent: 'claude-code', model: 'sonnet-test', worked: true }, { agent: 'claude-code', model: 'failed-model', worked: false }],
      inits: [{ agent: 'claude-code', model: 'haiku-test', commands: [], at: 1 }],
    });
    const by = Object.fromEntries(got.map((m) => [m.id, m]));
    expect(by['sonnet-test']).toMatchObject({ entitlement: 'worked', source: 'used-in-a-run' });
    expect(by['haiku-test']).toMatchObject({ entitlement: 'unknown', source: 'runtime-default' });
    expect(by['failed-model']).toBeUndefined();
    expect(got.filter((m) => m.entitlement === 'worked')).toHaveLength(1);
  });
  it('lists what local servers say they have loaded (Ollama and OpenAI-compatible), as models and not agents', async () => {
    const got = await localServerModels(fakeFetch({ 'http://127.0.0.1:11434/api/tags': { models: [{ name: 'llama-test:8b' }] }, 'http://127.0.0.1:1234/v1/models': { data: [{ id: 'qwen-test' }] } }));
    expect(got).toEqual([{ base: 'http://127.0.0.1:11434', models: ['llama-test:8b'] }, { base: 'http://127.0.0.1:1234', models: ['qwen-test'] }]);
    const all = await discoverModels({ seen: [], inits: [], home, fetchImpl: fakeFetch({ 'http://127.0.0.1:11434/api/tags': { models: [{ name: 'llama-test:8b' }] } }) });
    expect(all[0]).toMatchObject({ agent: 'local-model', source: 'listed-by-local-server', entitlement: 'unknown' });
    expect(all[0]!.note).toMatch(/not an agent/);
  });
  it('survives a server that is down', async () => {
    const down = (async () => { throw new Error('refused'); }) as never;
    expect(await localServerModels(down)).toEqual([]);
  });
});

describe('agent status', () => {
  it('says ready, needs setup, terminal-only or missing, and reports commands only when the runtime reported them', () => {
    const list = describeAgents([
      { id: 'claude-code', name: 'Claude Code', installed: true, authenticated: true, canStart: true, reason: null },
      { id: 'codex', name: 'Codex', installed: true, authenticated: null, canStart: false, reason: 'Start it in its own terminal' },
      { id: 'hermes', name: 'Hermes', installed: false, authenticated: null, canStart: false, reason: 'x' },
      { id: 'x', name: 'X', installed: true, authenticated: false, canStart: false, reason: 'login' },
    ], [{ agent: 'claude-code', model: 'm', commands: ['goal', 'review'], at: 5 }]);
    expect(list.map((a) => a.status)).toEqual(['ready', 'terminal-only', 'missing', 'needs-setup']);
    expect(list[0]).toMatchObject({ commands: ['goal', 'review'], commandsSource: 'reported-by-runtime' });
    expect(list[1]).toMatchObject({ commands: [], commandsSource: 'not-reported' });
  });
});
