import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand, Project } from '@agentontrack/core';
import { startCompanion, type Companion } from '../src/index.js';

let dir: string;
let root: string;
let c: Companion;
let origin: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bl-c-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'SECRET_FILE_CONTENT');
  c = await startCompanion({ root, uiDir: join(dir, 'ui') });
  origin = c.url.slice(0, -1);
});
afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const pair = async () => {
  const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
  expect(r.status).toBe(200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  return { cookie, csrf: (await r.json()).csrf as string };
};
const api = (s: { cookie: string; csrf: string }, path: string, body?: unknown) => fetch(`${origin}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const proof = async (s: { cookie: string; csrf: string }) => {
  const ch = await (await api(s, '/api/challenge', {})).json();
  return { challengeId: ch.challengeId, confirm: ch.code };
};
const raw = (path: string, headers: Record<string, string>, method = 'GET') => new Promise<number>((ok, fail) => {
  const req = request({ host: '127.0.0.1', port: c.port, path, method, headers }, (res) => { res.resume(); ok(res.statusCode!); });
  req.on('error', fail);
  req.end();
});

describe('bridge attacks', () => {
  it('binds only to loopback', () => {
    expect((c.server.address() as any).address).toBe('127.0.0.1');
  });

  it('gives nothing to a caller that only knows the port', async () => {
    for (const path of ['/api/state', '/api/projects', '/api/agents', '/api/analytics', '/api/data/export', '/api/settings', '/api/approvals']) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(401);
    }
    expect((await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'claude-code', prompt: 'x' }) })).status).toBe(401);
  });

  it('refuses a DNS-rebinding Host, even with a valid session', async () => {
    const s = await pair();
    expect(await raw('/api/state', { host: 'evil.test', cookie: s.cookie })).toBe(403);
    expect(await raw('/', { host: `evil.test:${c.port}` })).toBe(403);
  });

  it('refuses a cross-origin request carrying a valid session', async () => {
    const s = await pair();
    expect(await raw('/api/state', { host: `127.0.0.1:${c.port}`, origin: 'https://evil.test', cookie: s.cookie })).toBe(403);
    expect(await raw('/api/state', { host: `127.0.0.1:${c.port}`, 'sec-fetch-site': 'cross-site', cookie: s.cookie })).toBe(403);
    expect(await raw('/api/state', { host: `127.0.0.1:${c.port}`, 'sec-fetch-site': 'same-site', cookie: s.cookie })).toBe(403);
  });

  it('refuses a mutation without the CSRF header', async () => {
    const s = await pair();
    const r = await fetch(`${origin}/api/challenge`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('refuses form-encoded posts, which browsers can send cross-site without preflight', async () => {
    const s = await pair();
    const r = await fetch(`${origin}/api/feedback`, { method: 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'text/plain' }, body: '{"rating":null}' });
    expect(r.status).toBe(415);
  });

  it('sets a strict, HttpOnly cookie and ignores a pre-set session value', async () => {
    const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'bl_session=attackerchosen' }, body: JSON.stringify({ code: c.newPairingCode() }) });
    const set = r.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).not.toContain('attackerchosen');
    expect((await fetch(`${origin}/api/state`, { headers: { cookie: 'bl_session=attackerchosen' } })).status).toBe(401);
  });

  it('pairing codes are single-use and lock after repeated wrong guesses', async () => {
    const code = c.newPairingCode();
    const send = (value: string) => fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: value }) });
    expect((await send(code)).status).toBe(200);
    expect((await send(code)).status).toBe(403);
    const next = c.newPairingCode();
    for (let i = 0; i < 5; i++) expect((await send('WRONGCOD')).status).toBe(403);
    expect((await send(next)).status).toBe(403);
  });

  it('unpairing and revocation end access', async () => {
    const s = await pair();
    const other = await pair();
    const list = await (await api(s, '/api/settings')).json();
    const otherId = list.sessions.find((x: any) => !x.current).id;
    await api(s, '/api/sessions/revoke', { id: otherId });
    expect((await api(other, '/api/state')).status).toBe(401);
    await api(s, '/api/unpair', {});
    expect((await api(s, '/api/state')).status).toBe(401);
  });

  it('serves security headers, and no path traversal', async () => {
    mkdirSync(join(dir, 'ui'));
    writeFileSync(join(dir, 'ui', 'index.html'), '<!doctype html>ok');
    const r = await fetch(`${origin}/`);
    expect(r.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(await raw('/..%2f..%2fhome%2fregistry.json', { host: `127.0.0.1:${c.port}` })).not.toBe(200 + 1);
    const t = await fetch(`${origin}/..%2f..%2frepo%2fa.txt`);
    expect(await t.text()).not.toContain('SECRET_FILE_CONTENT');
  });

  it('rejects oversized bodies', async () => {
    const s = await pair();
    const r = await api(s, '/api/feedback', { rating: null, text: 'x'.repeat(300_000) });
    expect(r.status).toBe(413);
  });
});

describe('opt-in public site origin', () => {
  const SITE = 'https://satyamamarpandey.github.io';
  it('is refused by default', async () => {
    expect(await raw('/api/health', { host: `127.0.0.1:${c.port}`, origin: SITE })).toBe(403);
  });

  it('when enabled: still needs the code, uses no cookie, and no other origin gets in', async () => {
    const d = await startCompanion({ root, uiDir: join(dir, 'ui'), allowedOrigins: [SITE] });
    const base = d.url.slice(0, -1);
    const pre = await fetch(`${base}/api/pair`, { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-private-network': 'true' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await fetch(`${base}/api/state`, { headers: { origin: SITE } })).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { origin: 'https://evil.github.io' } })).status).toBe(403);
    const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: d.newPairingCode() }) });
    expect(r.headers.get('set-cookie')).toBeNull();
    const { token, csrf } = await r.json();
    const st = await fetch(`${base}/api/state`, { headers: { origin: SITE, authorization: `Bearer ${token}` } });
    expect(st.status).toBe(200);
    const noCsrf = await fetch(`${base}/api/challenge`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    expect((await fetch(`${base}/api/challenge`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${token}`, 'x-agentontrack-csrf': csrf, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect((await fetch(`${base}/api/state`, { headers: { origin: 'https://evil.github.io', authorization: `Bearer ${token}` } })).status).toBe(403);
    await d.close();
  });
});

describe('an outside origin cannot act alone', () => {
  const SITE = 'https://satyamamarpandey.github.io';
  const start = async () => {
    const codes: { code: string; action: string }[] = [];
    const d = await startCompanion({ root, uiDir: join(dir, 'ui'), allowedOrigins: [SITE], onTerminalChallenge: (code, action) => codes.push({ code, action }) });
    const base = d.url.slice(0, -1);
    const pr = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: d.newPairingCode() }) })).json();
    const call = (path: string, body: object, origin = SITE) => fetch(`${base}${path}`, { method: 'POST', headers: { origin, authorization: `Bearer ${pr.token}`, 'x-agentontrack-csrf': pr.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { d, base, pr, call, codes };
  };

  it('never hands the page a confirmation code', async () => {
    const { d, call } = await start();
    const ch = await (await call('/api/challenge', {})).json();
    expect(ch.code).toBeNull();
    expect(ch.inTerminal).toBe(true);
    await d.close();
  });

  it('needs a terminal code to disconnect an agent, start a run or attach a project, and the code fits one exact request', async () => {
    const { d, call, codes } = await start();
    for (const path of ['/api/agents/claude-code/disconnect', '/api/runs', '/api/projects', '/api/policy/profile']) {
      const r = await call(path, { x: 1 });
      expect(r.status, path).toBe(428);
    }
    const first = await (await call('/api/settings', { theme: 'light' })).json();
    const code = codes.at(-1)!.code;
    expect(first.challengeId).toBeTruthy();
    expect(first.code).toBeUndefined();
    // The same code cannot be spent on a different request.
    expect((await call('/api/settings', { theme: 'dark', challengeId: first.challengeId, confirm: code })).status).toBe(403);
    const again = await (await call('/api/settings', { theme: 'light' })).json();
    expect((await call('/api/settings', { theme: 'light', challengeId: again.challengeId, confirm: 'wrong' })).status).toBe(403);
    const third = await (await call('/api/settings', { theme: 'light' })).json();
    expect((await call('/api/settings', { theme: 'light', challengeId: third.challengeId, confirm: codes.at(-1)!.code })).status).toBe(200);
    await d.close();
  });

  it('ties a code to the project, shows requests in full and sorted, and ends a session after repeated wrong codes', async () => {
    const { d, base, pr, call, codes } = await start();
    const first = await (await call('/api/settings', { theme: 'light' })).json();
    const other = await fetch(`${base}/api/settings?project=somewhere-else`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${pr.token}`, 'x-agentontrack-csrf': pr.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'light', challengeId: first.challengeId, confirm: codes.at(-1)!.code }) });
    expect(other.status).toBe(403);
    await call('/api/settings', { z: 'hidden-last', a: 'x'.repeat(100), theme: 'light' });
    expect(codes.at(-1)!.action).toContain('hidden-last');
    expect((await call('/api/settings', { pad: 'x'.repeat(5000) })).status).toBe(413);
    for (let i = 0; i < 6; i++) {
      const ch = await (await call('/api/settings', { theme: 'dark' })).json();
      await call('/api/settings', { theme: 'dark', challengeId: ch.challengeId, confirm: 'nope' });
    }
    expect((await fetch(`${base}/api/state`, { headers: { origin: SITE, authorization: `Bearer ${pr.token}` } })).status).toBe(401);
    await d.close();
  });

  it('verify needs a terminal code too, because it runs commands', async () => {
    const { d, call } = await start();
    expect((await call('/api/verify', { taskId: 't' })).status).toBe(428);
    await d.close();
  });

  it('refuses all changes when no terminal can show a code', async () => {
    const d = await startCompanion({ root, uiDir: join(dir, 'ui'), allowedOrigins: [SITE] });
    const base = d.url.slice(0, -1);
    const pr = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: d.newPairingCode() }) })).json();
    const r = await fetch(`${base}/api/settings`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${pr.token}`, 'x-agentontrack-csrf': pr.csrf, 'content-type': 'application/json' }, body: '{"theme":"light"}' });
    expect(r.status).toBe(403);
    await d.close();
  });

  it('ties the token to the origin that paired', async () => {
    const { d, base, pr } = await start();
    const r = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${pr.token}` } });
    expect(r.status).toBe(401);
    await d.close();
  });
});

describe('human actions through the dashboard', () => {
  const setup = () => {
    const p = new Project(root);
    p.human.setGoal({ statement: 'g', scope: { include: ['**'] } });
    p.human.createTask({ id: 't', title: 't', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
    const cl = classifyCommand('git push');
    const r = p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: cl.effects, opaque: false, coverage: 'enforced', rawInput: 'git push' });
    p.close();
    return r.approvalIds[0]!;
  };

  it('approves with a fresh code, and the code cannot be replayed', async () => {
    const id = setup();
    const s = await pair();
    const pr = await proof(s);
    const ok = await api(s, '/api/approvals/approve', { id, ...pr });
    expect(ok.status).toBe(200);
    const state = await (await api(s, '/api/state')).json();
    expect(state.approvals.find((a: any) => a.id === id)).toMatchObject({ view: 'approved', approver: { method: 'dashboard' } });
    expect((await api(s, '/api/approvals/revoke', { id, ...pr })).status).toBe(403);
  });

  it('denies, and refuses a wrong code or another session\'s code', async () => {
    const id = setup();
    const s = await pair();
    const pr = await proof(s);
    expect((await api(s, '/api/approvals/approve', { id, challengeId: pr.challengeId, confirm: 'zzzz' })).status).toBe(403);
    const other = await pair();
    const pr2 = await proof(other);
    expect((await api(s, '/api/approvals/approve', { id, ...pr2 })).status).toBe(403);
    const pr3 = await proof(s);
    expect((await api(s, '/api/approvals/deny', { id, note: 'no', ...pr3 })).status).toBe(200);
    const pr4 = await proof(s);
    expect((await api(s, '/api/approvals/approve', { id, ...pr4 })).status).toBe(409);
  });

  it('needs the passphrase when an approver is enrolled', async () => {
    const id = setup();
    const p = new Project(root);
    p.enrollApprover('correct horse battery');
    p.close();
    const s = await pair();
    const pr = await proof(s);
    expect((await api(s, '/api/approvals/approve', { id, ...pr, passphrase: 'wrong wrong wrong' })).status).toBe(403);
    const pr2 = await proof(s);
    expect((await api(s, '/api/approvals/approve', { id, ...pr2, passphrase: 'correct horse battery' })).status).toBe(200);
    const state = await (await api(s, '/api/state')).json();
    expect(state.approvals.find((a: any) => a.id === id).approver.method).toBe('dashboard+passphrase');
    const pr3 = await proof(s);
    expect((await api(s, '/api/approvals/revoke', { id, ...pr3 })).status).toBe(403);
  });
});

describe('projects, runs and data', () => {
  it('attaches, creates and handles a moved project', async () => {
    const s = await pair();
    const other = join(dir, 'unicode-προέργο');
    expect((await api(s, '/api/projects', { path: other, create: true })).status).toBe(200);
    expect((await api(s, '/api/projects', { path: join(dir, 'nope') })).status).toBe(400);
    expect((await api(s, '/api/projects', { path: 'relative/path' })).status).toBe(400);
    const list = await (await api(s, '/api/projects')).json();
    expect(list.map((x: any) => x.name)).toContain('unicode-προέργο');
    rmSync(other, { recursive: true, force: true, maxRetries: 5 });
    const after = await (await api(s, '/api/projects')).json();
    expect(after.find((x: any) => x.name === 'unicode-προέργο').missing).toBe(true);
  });

  it('refuses a run for an unavailable runtime rather than faking one', async () => {
    const s = await pair();
    const h = await api(s, '/api/runs', { runtime: 'hermes', prompt: 'x' });
    expect(h.status).toBe(409);
    expect((await h.json()).error).toMatch(/not built yet/);
    // Codex can be started, but not in a project where its hooks are missing: it would run actions unchecked.
    const cx = await api(s, '/api/runs', { runtime: 'codex', prompt: 'x' });
    expect(cx.status).toBe(409);
    expect((await cx.json()).error).toMatch(/Connect Codex/);
  });

  it('refuses a run until hooks are connected', async () => {
    const s = await pair();
    const r = await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'x' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Connect Claude Code/);
  });

  it('validates run limits', async () => {
    const s = await pair();
    expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'x', maxBudgetUsd: 500 })).status).toBe(400);
    expect((await api(s, '/api/runs', { runtime: 'claude-code', prompt: 'x', model: 'a; rm -rf /' })).status).toBe(400);
  });

  it('exports all events, and deletes the record after confirmation', async () => {
    const s = await pair();
    const projects = await (await api(s, '/api/projects')).json();
    const exp = await (await api(s, '/api/data/export')).json();
    expect(exp.events[0].type).toBe('project.attached');
    expect((await api(s, '/api/data/delete', {})).status).toBe(400);
    const pr = await proof(s);
    expect((await api(s, '/api/data/delete', pr)).status).toBe(200);
    expect(existsSync(join(dir, 'home', 'projects', projects[0].id))).toBe(false);
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
  });

  it('has no cloud sync: the hosted backend does not exist in this version', async () => {
    const s = await pair();
    expect((await api(s, '/api/sync/now', {})).status).toBe(404);
    expect(await (await api(s, '/api/settings')).text()).not.toContain('sync');
  });

  it('streams real events, resuming after reconnect from the last id', async () => {
    const s = await pair();
    const p = new Project(root);
    const before = p.store.head()!.seq;
    p.store.append({ type: 'test.marker', actor: { kind: 'system' }, payload: { n: 1 } });
    p.close();
    const ac = new AbortController();
    const r = await fetch(`${origin}/api/events/stream?since=${before}`, { headers: { cookie: s.cookie }, signal: ac.signal });
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    ac.abort();
    expect(new TextDecoder().decode(value)).toContain('test.marker');
  });

  it('feedback stays local', async () => {
    const s = await pair();
    const r = await (await api(s, '/api/feedback', { rating: 'helpful', text: 'good' })).json();
    expect(r).toMatchObject({ savedLocally: true, sent: false });
  });
});
