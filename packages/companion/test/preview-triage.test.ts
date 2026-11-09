// Checks behind docs/security/PREVIEW_TRIAGE.md. They run against the real companion over HTTP, with no cloud account and no Firebase config, which is the
// state of the public desktop build: what an unpaired caller and a paired local caller can reach of the phone link, malformed input, and the local feedback file.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';
import { phoneSafeMessage } from '../src/remote-host.js';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string; let home: string; let root: string; let c: Companion; let origin: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aot-triage-'));
  home = join(dir, 'home');
  process.env.AGENTONTRACK_HOME = home;
  root = join(dir, 'repo'); mkdirSync(root);
  const p = new Project(root); p.human.setGoal({ statement: 'g', scope: { include: ['**'] } }); p.close();
  c = await startCompanion({ root, uiDir: join(dir, 'ui') }); // no remote option, no allowed origins, no Firebase: the public desktop build
  origin = c.url.slice(0, -1);
});
afterEach(async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: (await r.json()).csrf as string };
};
type S = Awaited<ReturnType<typeof pair>>;
const api = (s: S, path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proof = async (s: S) => { const ch = await (await api(s, '/api/challenge', {})).json(); return { challengeId: ch.challengeId, confirm: ch.code }; };

describe('the phone link in a build with no cloud account', () => {
  const REMOTE_PATHS = ['/api/remote/status', '/api/remote/prepare', '/api/remote/link', '/api/remote/devices/trust', '/api/remote/devices/level', '/api/remote/settings', '/api/remote/devices/revoke', '/api/remote/unlink'];

  it('is unreachable by a local caller that has not paired, and creates nothing', async () => {
    for (const path of REMOTE_PATHS) {
      const get = await fetch(`${origin}${path}`);
      const post = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect([get.status, post.status], path).toEqual([401, 401]);
    }
    expect(existsSync(join(home, 'remote.json'))).toBe(false);
  });

  it('cannot be paired by guessing: no code is active until the terminal makes one, and five wrong codes spend it', async () => {
    const post = (code: string) => fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect((await post('AAAAAAAA')).status).toBe(403);
    const real = c.newPairingCode();
    for (let i = 0; i < 5; i++) expect((await post('ZZZZZZZZ')).status).toBe(403);
    expect((await post(real)).status).toBe(403); // the right code no longer works: it was spent by the failures
  });

  it('is not running for a paired local session either: status says so, and no service or key file exists until something asks for one', async () => {
    const s = await pair();
    expect(await (await api(s, '/api/remote/status')).json()).toEqual({ exists: false });
    expect(existsSync(join(home, 'remote.json'))).toBe(false);
    // Linking needs a prepared computer, so a paired session cannot link by accident, and a link also needs the usual confirmation.
    const noProof = await api(s, '/api/remote/link', { uid: 'u', computerUid: 'c', email: 'a@b.co', password: 'password1', firebase: { apiKey: 'k', projectId: 'p' } });
    expect(noProof.status).toBe(400); // the request must carry a challenge, so it is refused before anything is read
    const withProof = await api(s, '/api/remote/link', { uid: 'u', computerUid: 'c', email: 'a@b.co', password: 'password1', firebase: { apiKey: 'k', projectId: 'p' }, ...(await proof(s)) });
    expect(withProof.status).toBe(409);
    expect(existsSync(join(home, 'remote.json'))).toBe(false);
  });
});

describe('malformed input', () => {
  it('a NUL character in a prompt, a title, a model, a path or a project folder is refused or harmless: no crash, no 5xx from a handled field, nothing started', async () => {
    const s = await pair();
    const cases: [string, string, unknown][] = [
      ['/api/runs', 'POST', { runtime: 'claude-code', prompt: 'a\0b' }],
      ['/api/agent-sessions', 'POST', { runtime: 'claude-code', prompt: 'ok', title: 'a\0b' }],
      ['/api/runs', 'POST', { runtime: 'claude-code', prompt: 'ok', model: 'a\0b' }],
      ['/api/file?path=a%00b.md', 'GET', undefined],
      ['/api/files?dir=a%00b', 'GET', undefined],
      ['/api/projects', 'POST', { path: join(dir, 'x\0y') }],
    ];
    for (const [path, method, body] of cases) {
      const r = method === 'GET' ? await api(s, path) : await api(s, path, body);
      expect(r.status, `${method} ${path}`).toBeLessThan(500);
    }
    // The companion is still serving.
    expect((await api(s, '/api/session')).status).toBe(200);
  });

  it('an oversized or non-JSON body is refused', async () => {
    const s = await pair();
    const big = await fetch(`${origin}/api/notes`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(300_000) }) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${origin}/api/notes`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
  });
});

describe('what a phone is told when something fails', () => {
  it('has file paths taken out and is cut short', () => {
    const win = phoneSafeMessage('Project folder is missing: C:\\Users\\sam\\work\\secret-project. It may have been moved');
    expect(win).not.toMatch(/secret-project|sam/);
    const posix = phoneSafeMessage("ENOENT: no such file or directory, open '/home/sam/work/secret-project/notes.md'");
    expect(posix).not.toMatch(/secret-project|sam/);
    expect(phoneSafeMessage('\\\\server\\share\\secret-project\\x')).not.toMatch(/secret-project/);
    // Ordinary words with a slash survive, and so do the executor's own sentences.
    expect(phoneSafeMessage('Approve and/or deny it. That is not a project id')).toBe('Approve and/or deny it. That is not a project id');
    expect(phoneSafeMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
    expect(phoneSafeMessage(undefined)).toBe('The computer refused this request.');
  });
});

describe('the local feedback file', () => {
  it('stops growing at its cap, so a page that may post feedback without a terminal code cannot fill the disk', async () => {
    const s = await pair();
    mkdirSync(home, { recursive: true });
    const file = join(home, 'feedback.jsonl');
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    const before = statSync(file).size;
    const r = await api(s, '/api/feedback', { rating: 'helpful', text: 'more' });
    expect(r.status).toBe(429);
    expect(statSync(file).size).toBe(before);
  });
});

describe('phoneSafeMessage paths with spaces and URLs', () => {
  it('removes a whole folder name that contains spaces, on Windows and POSIX', () => {
    expect(phoneSafeMessage(String.raw`Project folder is missing: D:\Standalone AI Agent Control Platform`)).not.toMatch(/Standalone|Agent|Platform/);
    expect(phoneSafeMessage(String.raw`cannot read C:\Users\John Smith\proj\a.ts`)).not.toMatch(/John|Smith|proj/);
    expect(phoneSafeMessage('cannot read /home/john smith/x/y.ts')).not.toMatch(/john|smith|y\.ts/);
  });
  it('leaves a URL alone', () => {
    expect(phoneSafeMessage('see https://example.com/a/b for help')).toContain('https://example.com/a/b');
  });
});
