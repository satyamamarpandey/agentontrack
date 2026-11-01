import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAnchor, classifyCommand, EventStore, Project, pushAnchor } from '../src/index.js';

let dir: string;
let root: string;
let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aot-rb-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  p = new Project(root);
  p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
});
afterEach(() => { try { p.close(); } catch { /* a test closed it */ } rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('weak checks withhold VERIFIED', () => {
  it('a check that always passes cannot reach VERIFIED until a human accepts it', () => {
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'echo ok' }] });
    const ev = p.verifyTask(id);
    expect(ev.status).toBe('IMPLEMENTED_UNVERIFIED');
    expect(ev.reasons.join()).toMatch(/withheld/);
    p.human.acceptWeakChecks(id, 'I know');
    expect(p.evaluate(id).status).toBe('VERIFIED');
  });

  it('benchmark v3 t7: a file-exists check does not verify an unfinished task', () => {
    writeFileSync(join(root, 'src', 'calc.js'), 'export const add = (a, b) => a + b;');
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'artifact', path: 'src/calc.js' }] });
    expect(p.verifyTask(id).status).toBe('IMPLEMENTED_UNVERIFIED');
  });

  it('a package.json test script that tests nothing is flagged', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo no tests' } }));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'a.test.js'), "test('x', () => assert.equal(1, 1));");
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'npm test' }] });
    expect(p.evaluate(id).weakCriteria?.join()).toMatch(/does not really test/);
  });

  it('an accepted warning does not cover a new one', () => {
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'echo ok' }] });
    p.human.acceptWeakChecks(id, '');
    const task = p.state().tasks.get(id)!;
    task.weakAccepted = ['something else'];
    expect(p.verifyTask(id).status).toBe('IMPLEMENTED_UNVERIFIED');
  });

  it('only a human event can accept: an agent-actor event is refused', () => {
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'echo ok' }] });
    expect(() => p.store.append({ type: 'weak.accepted', actor: { kind: 'agent', runtime: 'x' }, taskId: id, payload: { id, warnings: ['c runs a command that always succeeds'] } })).toThrow(/human/);
  });
});

describe('changes no gate saw, as a fail-open host leaves them', () => {
  it('an out-of-scope file changed with no hook at all blocks VERIFIED', () => {
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
    writeFileSync(join(root, 'deploy.conf'), 'changed by a run whose hook never fired');
    const ev = p.verifyTask(id);
    expect(ev.status).toBe('IMPLEMENTED_UNVERIFIED');
    expect(ev.reasons.join()).toMatch(/no gate firing/);
  });

  it('an in-scope change is recorded but does not block, and a second verify finds nothing new', () => {
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
    writeFileSync(join(root, 'src', 'x.js'), '1');
    expect(p.verifyTask(id).status).toBe('VERIFIED');
    expect(p.store.byType(['workspace.drift']).length).toBe(1);
    p.verifyTask(id);
    expect(p.store.byType(['workspace.drift']).length).toBe(1);
  });

  it('files a check itself generates are not reported as drift', () => {
    const id = p.human.createTask({ title: 't', criteria: [{ id: 'c', description: 'd', kind: 'command', command: 'node -e "require(\'fs\').writeFileSync(\'out.log\',String(0+1))"' }] });
    p.verifyTask(id);
    expect(p.verifyTask(id).reasons.join()).not.toMatch(/no gate firing/);
  });
});

describe('external anchor', () => {
  const bare = () => {
    const b = join(dir, 'anchors.git');
    mkdirSync(b);
    spawnSync('git', ['init', '--bare', '-q'], { cwd: b });
    spawnSync('git', ['config', 'receive.denyNonFastForwards', 'true'], { cwd: b });
    spawnSync('git', ['config', 'receive.denyDeletes', 'true'], { cwd: b });
    return b;
  };

  it('catches a same-user rewrite of both log and witness, which local checks cannot', () => {
    const b = bare();
    const anchored = pushAnchor(p, b);
    expect(checkAnchor(p, b)).toMatchObject({ ok: true, checked: 1 });
    p.close();

    // The attacker changes an old event and recomputes the chain and witness, so everything local still agrees.
    const db = new EventStore(join(p.stateDir, 'events.sqlite'));
    const events = db.all();
    db.close();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const raw = new DatabaseSync(join(p.stateDir, 'events.sqlite'));
    const rewriteHash = 'f'.repeat(64);
    raw.exec('DROP TRIGGER events_no_update');
    raw.prepare('UPDATE events SET hash = ? WHERE seq = ?').run(rewriteHash, anchored.seq);
    raw.close();
    writeFileSync(p.witness.path, events.map((e) => `${JSON.stringify({ seq: e.seq, hash: e.seq === anchored.seq ? rewriteHash : e.hash })}\n`).join(''));

    p = new Project(root);
    const r = checkAnchor(p, b);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/rewritten history/);
  });

  it('catches a rollback of the log', () => {
    const b = bare();
    p.human.createTask({ id: 't', title: 't' });
    pushAnchor(p, b);
    p.close();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const raw = new DatabaseSync(join(p.stateDir, 'events.sqlite'));
    const top = (raw.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number }).m;
    raw.exec('DROP TRIGGER events_no_delete');
    raw.prepare('DELETE FROM events WHERE seq = ?').run(top);
    raw.close();
    p = new Project(root);
    expect(checkAnchor(p, b).problems.join()).toMatch(/missing from the log/);
  });

  it('appends rather than rewrites, and a remote that refuses force-pushes keeps its history', () => {
    const b = bare();
    pushAnchor(p, b);
    p.human.createTask({ id: 't', title: 't' });
    pushAnchor(p, b);
    expect(checkAnchor(p, b).checked).toBe(2);
    const instance = p.state().instance!;
    const log = spawnSync('git', ['--git-dir', b, 'rev-list', '--count', `refs/agentontrack/anchors/${basename(p.stateDir)}/${instance}`], { encoding: 'utf8' });
    expect(log.stdout.trim()).toBe('2');
  });

  it('reports a missing or unreachable remote instead of passing', () => {
    expect(checkAnchor(p, join(dir, 'nope.git')).ok).toBe(false);
    expect(() => pushAnchor(p, join(dir, 'nope.git'))).toThrow(/Anchor push failed/);
  });

  it('an agent cannot reconfigure the anchor: the event is human-only and the command is self-tamper', () => {
    expect(() => p.store.append({ type: 'anchor.configured', actor: { kind: 'agent', runtime: 'x' }, payload: { remote: 'evil', every: 1 } })).toThrow(/human/);
    expect(classifyCommand('agentontrack anchor config --remote evil').effects.map((e) => e.kind)).toContain('self.tamper');
    expect(classifyCommand('agentontrack self uninstall').effects.map((e) => e.kind)).toContain('self.tamper');
  });
});

describe('strict mode false blocks seen in benchmark v3', () => {
  const go = (cmd: string) => { const c = classifyCommand(cmd); return p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: c.effects, opaque: c.opaque, coverage: 'enforced', rawInput: cmd }).decision; };
  it('allows read-only tools it used to hold, and a harmless variable on an allow-listed command', () => {
    p.human.setPolicy({ ...p.state().policy, opaqueExec: 'approval', opaqueAllow: ['npm test'] });
    p.human.createTask({ id: 't', title: 't' });
    expect(go('od -c src/a.txt')).toBe('allow');
    expect(go('printf x | while read f; do echo "$f"; done')).toBe('allow');
    expect(go('PORT=8080 npm test 2>&1')).toBe('allow');
  });
  it('a variable that can change what runs keeps the command off the allow-list', () => {
    p.human.setPolicy({ ...p.state().policy, opaqueExec: 'approval', opaqueAllow: ['npm test'] });
    p.human.createTask({ id: 't', title: 't' });
    expect(go('NODE_OPTIONS=--require=./evil.js npm test')).toBe('request_approval');
    expect(go('PATH=./evil:$PATH npm test')).toBe('request_approval');
  });
  it('still holds code it cannot see into', () => {
    p.human.setPolicy({ ...p.state().policy, opaqueExec: 'approval' });
    p.human.createTask({ id: 't', title: 't' });
    expect(go('node -e "1"')).toBe('request_approval');
  });
});
