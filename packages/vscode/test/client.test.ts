// The extension's client against the REAL companion. This is not an editor test: the editor itself is exercised by test/host in a real VS Code.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCompanion, type Companion } from '@agentontrack/companion';
import { classifyCommand, Project } from '@agentontrack/core';
import { installHooks } from '@agentontrack/adapters';
import { checkCompanionUrl, CompanionClient, CompanionError, NeedsCode, selectionPrompt, snapshot } from '../src/client.js';

let dir: string; let root: string; let c: Companion; let url: string; let codes: { code: string; action: string }[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-vsc-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  const p = new Project(root);
  p.human.setGoal({ statement: 'Ship it', scope: { include: ['**'] } });
  p.human.createTask({ id: 't', title: 'The task', criteria: [{ id: 'c', description: 'x', kind: 'command', command: `node -e "process.exit(1)"` }] });
  p.human.setTeam([{ agent: 'claude-code', role: 'implement' }]);
  const push = classifyCommand('git push origin main');
  p.preAction({ runtime: 'codex', tool: 'Bash', effects: push.effects, opaque: false, coverage: 'enforced', rawInput: 'git push origin main' });
  p.close();
  codes = [];
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), onTerminalChallenge: (code, action) => codes.push({ code, action }) });
  url = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('where the token may go', () => {
  it('only to this machine', () => {
    expect(checkCompanionUrl('http://127.0.0.1:47631')).toBe('http://127.0.0.1:47631');
    expect(checkCompanionUrl('http://localhost:5000/')).toBe('http://localhost:5000');
    for (const bad of ['https://127.0.0.1:47631', 'http://example.com', 'http://127.0.0.1.evil.com', 'http://evil.com@127.0.0.1', 'http://user:pw@127.0.0.1', 'http://127.0.0.1:1/api', 'http://0.0.0.0:1', 'file:///etc/passwd', 'not a url', 'http://192.168.1.5:47631']) {
      expect(() => checkCompanionUrl(bad), bad).toThrow();
    }
  });

  it('every request goes to the companion\'s own address, and carries no cookie', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = (input, init) => { seen.push(String(input)); return fetch(input, init); };
    const client = new CompanionClient(url, null, spy);
    await client.pair(c.newPairingCode());
    await client.get('/api/state');
    await client.get('/api/projects');
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) expect(s.startsWith(url)).toBe(true);
  });
});

describe('pairing and reading', () => {
  it('refuses a wrong code, then pairs as an editor, and shows one consistent picture', async () => {
    const client = new CompanionClient(url);
    await expect(client.pair('WRONGCODE')).rejects.toBeInstanceOf(CompanionError);
    expect(client.connected).toBe(false);
    await client.pair(c.newPairingCode());
    const s = await snapshot(client, undefined);
    expect(s).toMatchObject({ connected: true, goal: { version: 1, statement: 'Ship it' }, task: { id: 't', title: 'The task' }, integrityOk: true });
    expect(s.pending).toEqual([expect.objectContaining({ kind: 'vcs.push', runtime: 'codex' })]);
    expect(s.team.members).toEqual([{ agent: 'claude-code', role: 'implement' }]);
    expect(s.head).toBeGreaterThan(0);
  });

  it('forgets a session the companion no longer knows', async () => {
    const client = new CompanionClient(url);
    await client.pair(c.newPairingCode());
    await client.post('/api/unpair', {}).catch(() => undefined);
    await expect(client.get('/api/state')).rejects.toMatchObject({ status: 401 });
    expect(client.connected).toBe(false);
  });
});

describe('confirming', () => {
  it('approves only with the code from the terminal, which names what is being approved', async () => {
    const client = new CompanionClient(url);
    await client.pair(c.newPairingCode());
    const [a] = (await snapshot(client, undefined)).pending;
    expect(a).toBeDefined();
    await expect(client.post('/api/approvals/approve', { id: a!.id, ttlMinutes: 60, uses: 1, portable: false })).rejects.toBeInstanceOf(NeedsCode);
    expect(codes.at(-1)!.action).toContain(a!.id);
    // A wrong code changes nothing.
    await expect(client.postConfirmed('/api/approvals/approve', { id: a!.id, ttlMinutes: 60, uses: 1, portable: false }, async () => 'wrong')).rejects.toMatchObject({ status: 403 });
    expect((await snapshot(client, undefined)).pending).toHaveLength(1);
    // Cancelling the prompt changes nothing.
    expect(await client.postConfirmed('/api/approvals/approve', { id: a!.id, ttlMinutes: 60, uses: 1, portable: false }, async () => undefined)).toBeUndefined();
    expect((await snapshot(client, undefined)).pending).toHaveLength(1);
    // The person reads the code in the terminal and types it.
    await client.postConfirmed('/api/approvals/approve', { id: a!.id, ttlMinutes: 60, uses: 1, portable: false }, async () => codes.at(-1)!.code);
    expect((await snapshot(client, undefined)).pending).toEqual([]);
    const p = new Project(root);
    expect([...p.state().approvals.values()][0]).toMatchObject({ status: 'granted', approver: expect.objectContaining({ method: 'dashboard' }) });
    p.close();
  });

  it('a code for one request does not confirm another', async () => {
    const client = new CompanionClient(url);
    await client.pair(c.newPairingCode());
    const [a] = (await snapshot(client, undefined)).pending;
    let stolen = '';
    await client.postConfirmed('/api/settings', { theme: 'light' }, async () => { stolen = codes.at(-1)!.code; return undefined; });
    await expect(client.postConfirmed('/api/approvals/approve', { id: a!.id, ttlMinutes: 60, uses: 1, portable: false }, async () => stolen)).rejects.toMatchObject({ status: 403 });
    expect((await snapshot(client, undefined)).pending).toHaveLength(1);
  });

  it('cannot start a run on its own, and a run starts only after the code, for the agent the companion can really start', async () => {
    const client = new CompanionClient(url);
    await client.pair(c.newPairingCode());
    await expect(client.post('/api/runs', { runtime: 'claude-code', prompt: 'do something', model: 'haiku', maxBudgetUsd: 0.1 })).rejects.toBeInstanceOf(NeedsCode);
    await expect(client.postConfirmed('/api/runs', { runtime: 'claude-code', prompt: 'do something', model: 'haiku', maxBudgetUsd: 0.1 }, async () => codes.at(-1)!.code)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Connect Claude Code/) });
    await expect(client.postConfirmed('/api/runs', { runtime: 'codex', prompt: 'x', model: 'haiku', maxBudgetUsd: 0.1 }, async () => codes.at(-1)!.code)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not built/) });
  });
});

describe('the prompts the editor commands send', () => {
  it('say where the code is, what the agent may not do, and cut what is too long', () => {
    const p = selectionPrompt('review', 'src/a.ts', 3, 9, 'const a = 1;');
    expect(p).toContain('src/a.ts, lines 3 to 9');
    expect(p).toMatch(/Do not change any file/);
    expect(selectionPrompt('explain', 'a', 1, 1, 'x')).toMatch(/Do not change any file/);
    expect(selectionPrompt('fix', 'a', 1, 1, 'x')).toMatch(/inside the approved scope/);
    expect(selectionPrompt('tests', 'a', 1, 1, 'x')).toMatch(/test folder/);
    const big = selectionPrompt('review', 'a', 1, 99, 'y'.repeat(50_000));
    expect(big.length).toBeLessThan(13_000);
    expect(big).toMatch(/cut: 38000 more characters/);
    for (const k of ['review', 'explain', 'fix', 'tests'] as const) expect(selectionPrompt(k, 'a', 1, 1, 'x').startsWith('-')).toBe(false);
  });
});

describe('a run through the companion, with a stand-in for the agent', () => {
  it('starts after the code, is watched to its end, and is recorded', async () => {
    // A stand-in program, so this checks the plumbing only. The real Claude Code run is in live.test.ts, behind AGENTONTRACK_LIVE.
    const fake = join(dir, 'fake-agent.mjs');
    writeFileSync(fake, `console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }));\nconsole.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's', modelUsage: { 'test-model': { inputTokens: 11, outputTokens: 7 } } }));\n`);
    await c.close();
    installHooks('claude-code', root, '"x" "y"');
    c = await startCompanion({ root, uiDir: join(dir, 'ui'), claudeCommand: [process.execPath, fake], onTerminalChallenge: (code, action) => codes.push({ code, action }) });
    url = c.url.slice(0, -1);
    const client = new CompanionClient(url);
    await client.pair(c.newPairingCode());
    const r = await client.postConfirmed<{ id: string }>('/api/runs', { runtime: 'claude-code', prompt: 'Explain the code', model: 'haiku', maxBudgetUsd: 0.1 }, async () => codes.at(-1)!.code);
    expect(r!.id).toMatch(/^run_/);
    let run: { status: string; events: string[] } | undefined;
    for (let i = 0; i < 50 && run?.status !== 'finished'; i++) { await new Promise((ok) => setTimeout(ok, 100)); run = (await client.get<{ id: string; status: string; events: string[] }[]>('/api/runs')).find((x) => x.id === r!.id); }
    expect(run).toMatchObject({ status: 'finished' });
    expect(run!.events.join(' ')).toContain('working');
    expect((await client.get('/api/analytics')).totals).toMatchObject({ input: 11, output: 7 });
  });
});
