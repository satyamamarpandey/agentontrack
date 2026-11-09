// Seen in real runs: Codex's first PowerShell write failed (exit 1, constrained language mode) in 11 of 12 trials, and in 3 of 18 handoffs Codex stopped after
// that failure, so a run ended "finished" with no file and nothing in the record said why. A script that speaks the app-server protocol stands in for Codex:
// this tests what AgentOnTrack does with a failed command, not what Codex does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

// FAKE_MODE: recovers = the first turn fails a command and the second succeeds; stubborn = every turn fails; fine = the command works.
const FAKE = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let turns = 0;
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53' } } });
  if (m.method === 'turn/start') {
    turns++;
    appendFileSync(process.env.FAKE_LOG, 'turn ' + turns + ' ' + JSON.stringify(m.params.input).slice(0, 300) + '\\n');
    out({ id: m.id, result: { turn: { id: 't' + turns } } });
    out({ method: 'turn/started', params: { turn: { id: 't' + turns } } });
    const mode = process.env.FAKE_MODE;
    const ok = mode === 'fine' || (mode === 'recovers' && turns > 1);
    out({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'write hello.txt' } } });
    out({ method: 'item/completed', params: { item: ok ? { type: 'commandExecution', command: 'write hello.txt', status: 'completed', exitCode: 0 } : { type: 'commandExecution', command: 'write hello.txt', status: 'failed', exitCode: 1, aggregatedOutput: 'MethodInvocationNotSupportedInConstrainedLanguage' } } });
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: ok ? 'done' : '' } } });
    out({ method: 'turn/completed', params: { turn: { id: 't' + turns, status: 'completed' } } });
  }
});
`;

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
let dir: string; let c: Companion;
afterEach(async () => { await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const runIt = async (mode: string, extra: { codexRecoveryTurns?: number } = {}) => {
  dir = mkdtempSync(join(tmpdir(), 'aot-failcmd-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = join(dir, 'log.txt');
  writeFileSync(process.env.FAKE_LOG, '');
  const root = join(dir, 'repo'); mkdirSync(root);
  writeFileSync(join(dir, 'fake.mjs'), FAKE);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  installHooks('codex', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui'), codexCommand: [process.execPath, join(dir, 'fake.mjs')], ...extra });
  const origin = c.url.slice(0, -1);
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  const h = { cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'x-agentontrack-csrf': (await r.json()).csrf as string, 'content-type': 'application/json' };
  const start = await fetch(`${origin}/api/runs`, { method: 'POST', headers: h, body: JSON.stringify({ runtime: 'codex', model: 'default', prompt: 'write hello.txt' }) });
  const { id } = await start.json();
  let run: any;
  for (let i = 0; i < 100; i++) { run = (await (await fetch(`${origin}/api/runs`, { headers: h })).json()).find((x: any) => x.id === id); if (run && run.status !== 'running') break; await new Promise((ok) => setTimeout(ok, 100)); }
  const turns = readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean);
  return { run, turns, events: run.events as string[] };
};

describe('a Codex command that failed', () => {
  it('is shown in the run, with its exit code and output', async () => {
    const { events } = await runIt('stubborn');
    const line = events.find((e) => e.includes('did not succeed'));
    expect(line).toMatch(/failed, exit 1/);
    expect(line).toMatch(/ConstrainedLanguage/);
  });

  it('gets one recovery turn, in the same thread, with fixed text that carries no command output', async () => {
    const { run, turns, events } = await runIt('recovers');
    expect(run.status).toBe('finished');
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatch(/last command ended with an error \(exit code 1\)/);
    expect(turns[1]).not.toMatch(/ConstrainedLanguage/);
    expect(events.some((e) => e.startsWith('[recovery]'))).toBe(true);
    expect(events.some((e) => e.startsWith('[unresolved]'))).toBe(false);
  });

  it('is retried once only, then reported as unresolved, never in a loop', async () => {
    const { turns, events } = await runIt('stubborn');
    expect(turns).toHaveLength(2);
    expect(events.filter((e) => e.startsWith('[recovery]'))).toHaveLength(1);
    expect(events.some((e) => e.startsWith('[unresolved]'))).toBe(true);
  });

  it('is not retried when recovery is turned off, but is still reported as unresolved', async () => {
    const { turns, events } = await runIt('stubborn', { codexRecoveryTurns: 0 });
    expect(turns).toHaveLength(1);
    expect(events.some((e) => e.startsWith('[recovery]'))).toBe(false);
    expect(events.some((e) => e.startsWith('[unresolved]'))).toBe(true);
  });

  it('causes no recovery turn and no warning when the command worked', async () => {
    const { turns, events } = await runIt('fine');
    expect(turns).toHaveLength(1);
    expect(events.some((e) => e.startsWith('[recovery]') || e.startsWith('[unresolved]') || e.includes('did not succeed'))).toBe(false);
  });
});
