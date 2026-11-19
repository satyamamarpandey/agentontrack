// Negative regressions from the 2026-11-19 audit of the companion. Each test is an attack that worked, or was unproven, before the fix.
// Everything runs against the real companion and engine in a temporary folder. In every case the refused request must leave things as they were.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hooksInstalled, installHooks } from '@agentontrack/adapters';
import { Project } from '@agentontrack/core';
import { startCompanion, unsuitableProjectRoot, type Companion } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'index.js');
let dir: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-audit-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'GOAL.md'), 'the goal\n');
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  const p = new Project(root);
  p.human.setGoal({ statement: 'Fix the crash', scope: { include: ['**'] } });
  p.close();
  installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* temp */ } });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('a protected file cannot be saved through another spelling of its name', () => {
  const hookFile = () => join(root, '.claude', 'settings.local.json');
  it.each(['./GOAL.md', './/GOAL.md', 'src/../GOAL.md', '.\\GOAL.md', 'GOAL.md.', 'GOAL.md ', 'GOAL.md::$DATA', 'GOAL.md:x', './.claude/settings.local.json', '.claude//settings.local.json', '.\\.claude\\settings.local.json', './.env', 'src/./../.env'])('%s', async (path) => {
    const s = await pair();
    const goalBefore = readFileSync(join(root, 'GOAL.md'), 'utf8');
    const hooksBefore = readFileSync(hookFile(), 'utf8');
    const r = await api(s, '/api/file', { path, content: '{}', baseHash: null });
    expect([400, 403], `${path} answered ${r.status}`).toContain(r.status);
    expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toBe(goalBefore);
    expect(readFileSync(hookFile(), 'utf8')).toBe(hooksBefore);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });
  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('a different case of the name is the same file where the file system says so', async () => {
    const s = await pair();
    for (const path of ['goal.md', 'Goal.MD', '.CLAUDE/settings.local.json', '.Claude/Settings.Local.json']) {
      expect((await api(s, '/api/file', { path, content: '{}', baseHash: null })).status, path).toBe(403);
    }
    expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toBe('the goal\n');
  });
  it('a link to a protected folder is the protected folder', async () => {
    try { symlinkSync(join(root, '.claude'), join(root, 'notes'), 'junction'); } catch { return; } // links may be unavailable to this user
    const s = await pair();
    const before = readFileSync(hookFile(), 'utf8');
    expect((await api(s, '/api/file', { path: 'notes/settings.local.json', content: '{}', baseHash: null })).status).toBe(403);
    expect(readFileSync(hookFile(), 'utf8')).toBe(before);
  });
  it('an ordinary file still saves', async () => {
    const s = await pair();
    expect((await api(s, '/api/file', { path: './src/b.txt', content: 'b', baseHash: null })).status).toBe(200);
    expect(readFileSync(join(root, 'src', 'b.txt'), 'utf8')).toBe('b');
  });
});

describe('removing an agent\'s hooks removes the gate, so it needs a person', () => {
  it('a session without a fresh confirmation code cannot disconnect', async () => {
    const s = await pair();
    for (const body of [{}, { challengeId: 'nope', confirm: '0000' }, { confirm: 'abcd' }]) {
      expect((await api(s, '/api/agents/claude-code/disconnect', body)).status).toBe(403);
      expect(hooksInstalled('claude-code', root)).toBe(true);
    }
  });
  it('a code issued for something else is used up and does not carry over', async () => {
    const s = await pair();
    const ch = await (await api(s, '/api/challenge', {})).json();
    expect((await api(s, '/api/agents/claude-code/disconnect', { challengeId: ch.challengeId, confirm: 'zzzz' })).status).toBe(403);
    // The wrong guess consumed the challenge: the right code no longer works.
    expect((await api(s, '/api/agents/claude-code/disconnect', { challengeId: ch.challengeId, confirm: ch.code })).status).toBe(403);
    expect(hooksInstalled('claude-code', root)).toBe(true);
  });
  it('with the code, the person can disconnect', async () => {
    const s = await pair();
    const ch = await (await api(s, '/api/challenge', {})).json();
    expect((await api(s, '/api/agents/claude-code/disconnect', { challengeId: ch.challengeId, confirm: ch.code })).status).toBe(200);
    expect(hooksInstalled('claude-code', root)).toBe(false);
  });
});

describe('a folder of secrets cannot be registered as a project under another spelling', () => {
  const data = () => join(dir, 'home');
  it('the data folder, in any case and through a link, and folders around the home folder', async () => {
    const s = await pair();
    const before = JSON.stringify(await (await api(s, '/api/projects')).json());
    const spellings = [data(), join(data(), 'projects'), dirname(homedir()), join(homedir(), '.ssh'), join(homedir(), '.aws', 'x'), join(homedir(), '.config', 'gh')];
    if (process.platform === 'win32' || process.platform === 'darwin') spellings.push(data().toUpperCase(), data().toLowerCase(), homedir().toUpperCase(), homedir().toLowerCase());
    try { symlinkSync(data(), join(dir, 'innocent'), 'junction'); spellings.push(join(dir, 'innocent'), join(dir, 'innocent', 'projects')); } catch { /* links unavailable */ }
    for (const path of spellings) {
      expect((await api(s, '/api/projects', { path })).status, path).toBe(400);
      expect((await api(s, '/api/projects', { path, create: true })).status, path).toBe(400);
      expect(unsuitableProjectRoot(path), path).not.toBeNull();
    }
    expect(JSON.stringify(await (await api(s, '/api/projects')).json())).toBe(before);
    expect(existsSync(join(homedir(), '.aws', 'x'))).toBe(false);
  });
  it('an ordinary folder is still accepted', async () => {
    const s = await pair();
    expect(unsuitableProjectRoot(join(dir, 'work', 'app'))).toBeNull();
    expect((await api(s, '/api/projects', { path: join(dir, 'work', 'app'), create: true })).status).toBe(200);
  });
});

describe('a phone can be revoked while the link service is not running', () => {
  const remoteFile = () => join(dir, 'home', 'remote.json');
  const device = (did: string) => ({ did, name: did, pub: { sign: 'a', agree: 'b' }, fingerprint: 'AAAA-BBBB', level: 'control', trustedAt: '2026-11-01T00:00:00.000Z', lastCtr: 0 });
  const stored = () => JSON.parse(readFileSync(remoteFile(), 'utf8'));
  beforeEach(() => {
    // No link in the file, so the service does not start: the state a computer is in when it is offline or the link failed to start.
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(remoteFile(), JSON.stringify({ computerId: 'c1', name: 'pc', identity: { pub: { sign: 'x', agree: 'y' }, priv: { sign: 'x', agree: 'y' } }, devices: [device('phone-a'), device('phone-b')], cache: [], seen: {}, maxUsdPerRun: 1 }));
  });
  it('the phones are listed, so there is something to revoke', async () => {
    const s = await pair();
    const st = await (await api(s, '/api/remote/status')).json();
    expect(st.devices.map((d: any) => d.did).sort()).toEqual(['phone-a', 'phone-b']);
    expect(JSON.stringify(st)).not.toContain('"priv"');
  });
  it('revoking one phone works, is stored, and an unknown phone is still a 404', async () => {
    const s = await pair();
    expect((await api(s, '/api/remote/devices/revoke', { did: 'nope' })).status).toBe(404);
    expect((await api(s, '/api/remote/devices/revoke', { did: 'phone-a' })).status).toBe(200);
    expect(stored().devices.find((d: any) => d.did === 'phone-a').revokedAt).toBeTruthy();
    expect(stored().devices.find((d: any) => d.did === 'phone-b').revokedAt).toBeUndefined();
  });
  it('unlinking revokes every phone in the stored state', async () => {
    const s = await pair();
    expect((await api(s, '/api/remote/unlink', {})).status).toBe(200);
    expect(stored().devices.every((d: any) => !!d.revokedAt)).toBe(true);
    expect(stored().link).toBeUndefined();
  });
});
