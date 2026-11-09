// e.env through the real companion: with paid API mode off an agent never sees a key, with it on only its own key, and no API returns a value.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
const FAKE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SEEN, JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));`;
const SECRET = 'sk-test-DO-NOT-PRINT-9876543210';

let dir = ''; let c: Companion | null = null;
afterEach(async () => { delete process.env.SEEN; await c?.close(); c = null; try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const CLAUDE_FAKE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SEEN, JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, modelUsage: {} }));`;

const boot = async (envText: string | null, agent: 'codex' | 'claude-code' = 'codex') => {
  dir = mkdtempSync(join(tmpdir(), 'aot-envc-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  process.env.SEEN = join(dir, 'seen.json');
  const root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake-codex.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  writeFileSync(join(dir, 'fake-claude.mjs'), CLAUDE_FAKE);
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  const envFile = envText === null ? null : join(dir, 'e.env');
  if (envFile) writeFileSync(envFile, envText!);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), codexMode: 'exec', codexCommand: [process.execPath, join(dir, 'fake-codex.mjs')], claudeCommand: [process.execPath, join(dir, 'fake-claude.mjs')], envFile });
  const origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  const s = { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
  const api = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const runOnce = async () => { expect((await api('/api/runs', { runtime: agent, prompt: 'go', model: 'm1', maxBudgetUsd: 0.1 })).status).toBe(200); for (let i = 0; i < 200; i++) { const rs = (await (await api('/api/runs')).json()) as any[]; if (rs.every((x) => x.status !== 'running')) break; await new Promise((ok) => setTimeout(ok, 100)); } return JSON.parse(readFileSync(process.env.SEEN!, 'utf8')); };
  return { api, runOnce };
};

describe('e.env in the companion', () => {
  it('gives Claude Code only its own key when paid API mode is on, and Codex only its own', async () => {
    const { runOnce } = await boot(`AOT_ALLOW_PAID_API=1
OPENAI_API_KEY=${SECRET}
ANTHROPIC_API_KEY=${SECRET}2
`, 'claude-code');
    expect(await runOnce()).toEqual({ openai: null, anthropic: `${SECRET}2` });
  });

  it('works with no file at all', async () => {
    const { api, runOnce } = await boot(null);
    expect(await runOnce()).toEqual({ openai: null, anthropic: null });
    expect(await (await api('/api/env-status')).json()).toMatchObject({ file: null, paidApiMode: false });
  });

  it('keeps keys from the agent while paid API mode is off, even if they are in the file', async () => {
    process.env.ANTHROPIC_API_KEY = `${SECRET}-shell`;
    try {
      const { api, runOnce } = await boot(`OPENAI_API_KEY=${SECRET}\nANTHROPIC_API_KEY=${SECRET}2\n`);
      expect(await runOnce()).toEqual({ openai: null, anthropic: null });
      const status = JSON.stringify(await (await api('/api/env-status')).json());
      expect(status).not.toContain('DO-NOT-PRINT');
      expect(JSON.parse(status).paidApiMode).toBe(false);
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });

  it('gives the agent only its own key when paid API mode is on, and still returns no value from any API', async () => {
    const { api, runOnce } = await boot(`AOT_ALLOW_PAID_API=1\nOPENAI_API_KEY=${SECRET}\nANTHROPIC_API_KEY=${SECRET}2\n`);
    expect(await runOnce()).toEqual({ openai: SECRET, anthropic: null });
    const status = JSON.stringify(await (await api('/api/env-status')).json());
    expect(status).not.toContain('DO-NOT-PRINT');
    expect(JSON.parse(status)).toMatchObject({ paidApiMode: true, keys: expect.arrayContaining([{ name: 'OPENAI_API_KEY', set: true, secret: true }]) });
  });
});
