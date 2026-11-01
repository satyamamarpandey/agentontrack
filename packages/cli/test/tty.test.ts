import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from '@lydell/node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@agentontrack/core';

// Real pseudo-terminal, real built CLI, real child process. Run `pnpm build` first.
const CLI = resolve('packages/cli/dist/index.js');
let dir: string;
let root: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl-t-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  env = { ...(process.env as Record<string, string>), AGENTONTRACK_HOME: join(dir, 'home'), AGENTONTRACK_ROOT: root };
  const p = new Project(root);
  p.human.setGoal({ statement: 'g' });
  p.human.createTask({ id: 't', title: 't' });
  p.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

// oxlint-disable-next-line no-control-regex -- stripping terminal escape codes.
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

/** Drives the CLI as a person would: waits for a prompt, types an answer. `answer` sees all output so far. */
function runInTerminal(args: string[], steps: { when: RegExp; answer: (all: string) => string }[], opts: { killAfter?: RegExp } = {}) {
  return new Promise<{ exitCode: number | undefined; output: string }>((ok, fail) => {
    const term = pty.spawn(process.execPath, [CLI, ...args], { cwd: root, env, cols: 200, rows: 40 });
    let out = '';
    let i = 0;
    const timer = setTimeout(() => { term.kill(); fail(new Error(`Timed out. Output:\n${strip(out)}`)); }, 25_000);
    term.onData((d) => {
      out += d;
      const clean = strip(out);
      if (opts.killAfter?.test(clean)) { term.kill(); return; }
      const step = steps[i];
      if (step && step.when.test(clean)) {
        i++;
        term.write(`${step.answer(clean)}\r`);
      }
    });
    term.onExit((e) => { clearTimeout(timer); ok({ exitCode: e.exitCode, output: strip(out) }); });
  });
}
const lastCode = (all: string) => [...all.matchAll(/Type ([0-9a-f]{4}) to confirm/g)].at(-1)![1]!;
const request = (cmd = 'git push') => {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { env, cwd: root, encoding: 'utf8', input: JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }) });
  return { out: r.stdout, id: /agentontrack approve (apr_\w+)/.exec(r.stdout)?.[1] };
};
const state = () => { const p = new Project(root); const s = p.state(); p.close(); return s; };

describe('terminal approval in a real pty', () => {
  it('approves after the typed code, and the retried hook is allowed exactly once', async () => {
    const { id } = request();
    const r = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]);
    expect(r.output).toContain(`Approved ${id}`);
    expect(r.exitCode).toBe(0);
    expect(state().approvals.get(id!)).toMatchObject({ status: 'granted', approver: { method: 'tty' } });
    expect(request().out).toBe('');
    expect(request().id).toBeDefined();
  });

  it('a wrong code grants nothing', async () => {
    const { id } = request();
    const r = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: () => 'nope' }]);
    expect(r.exitCode).toBe(3);
    expect(state().approvals.get(id!)?.status).toBe('pending');
  });

  it('denies', async () => {
    const { id } = request();
    const r = await runInTerminal(['deny', id!, '--note', 'not today'], [{ when: /to confirm:/, answer: lastCode }]);
    expect(r.output).toContain(`Denied ${id}`);
    expect(state().approvals.get(id!)?.status).toBe('denied');
    expect(request().id).not.toBe(id);
  });

  it('a terminal lost mid-approval grants nothing, and the request is still answerable', async () => {
    const { id } = request();
    await runInTerminal(['approve', id!], [], { killAfter: /to confirm:/ });
    expect(state().approvals.get(id!)?.status).toBe('pending');
    const r = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]);
    expect(r.exitCode).toBe(0);
  });

  it('refuses to approve twice', async () => {
    const { id } = request();
    await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]);
    const r = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/cannot be granted/);
  });

  it('concurrent approvals of one request grant it once', async () => {
    const { id } = request();
    const [a, b] = await Promise.all([
      runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]),
      runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]),
    ]);
    expect([a.exitCode, b.exitCode].sort()).toEqual([0, 1]);
    expect(state().approvals.get(id!)?.usesLeft).toBe(1);
  });

  it('DEMONSTRATES THE WEAKNESS: a same-user program driving a pty passes the code check without a passphrase', async () => {
    const { id } = request();
    const r = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }]);
    expect(r.exitCode).toBe(0);
  });

  it('with an enrolled approver, the same pty attack fails without the passphrase', async () => {
    const pass = 'correct horse battery';
    const en = await runInTerminal(['approver', 'enroll'], [{ when: /New approver passphrase/, answer: () => pass }, { when: /Repeat it:/, answer: () => pass }]);
    expect(en.output).toMatch(/Key fingerprint: [0-9a-f]{16}/);
    expect(en.output).not.toContain(pass);
    const { id } = request();
    const attack = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }, { when: /Approver passphrase:/, answer: () => 'guessed passphrase' }]);
    expect(attack.exitCode).toBe(1);
    expect(attack.output).toMatch(/Wrong approver passphrase/);
    expect(state().approvals.get(id!)?.status).toBe('pending');
    const human = await runInTerminal(['approve', id!], [{ when: /to confirm:/, answer: lastCode }, { when: /Approver passphrase:/, answer: () => pass }]);
    expect(human.exitCode).toBe(0);
    expect(state().approvals.get(id!)).toMatchObject({ status: 'granted', approver: { method: 'tty+passphrase' } });
  });

  it('goal proposal accept and reject in a terminal', async () => {
    const p = new Project(root);
    const a = p.propose('goal', { statement: 'New goal' }, { kind: 'agent', runtime: 'x' });
    const b = p.propose('goal', { statement: 'Bad goal' }, { kind: 'agent', runtime: 'x' });
    p.close();
    const list = execFileSync(process.execPath, [CLI, 'goal', 'proposals'], { env, cwd: root, encoding: 'utf8' });
    expect(list).toContain(a);
    expect(execFileSync(process.execPath, [CLI, 'goal', 'diff', a], { env, cwd: root, encoding: 'utf8' })).toContain('New goal');
    expect((await runInTerminal(['goal', 'accept', a], [{ when: /to confirm:/, answer: lastCode }])).exitCode).toBe(0);
    expect((await runInTerminal(['goal', 'reject', b, '--note', 'no'], [{ when: /to confirm:/, answer: lastCode }])).exitCode).toBe(0);
    const s = state();
    expect(s.goal).toMatchObject({ statement: 'New goal', version: 2 });
    expect(s.proposals.find((x) => x.id === b)?.status).toBe('rejected');
  });

  it('all human commands still refuse without a terminal', () => {
    const { id } = request();
    const goal = join(dir, 'g.json');
    writeFileSync(goal, '{"statement":"x"}');
    for (const args of [['approve', id!], ['deny', id!], ['goal', 'set', '--file', goal], ['policy', 'profile', 'strict'], ['approver', 'enroll'], ['audit', '--recover'], ['dashboard']]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, cwd: root, input: 'x\n', encoding: 'utf8' });
      expect(r.status, args.join(' ')).toBe(3);
    }
    expect(readFileSync(goal, 'utf8')).toContain('x');
  });
});
