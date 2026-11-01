import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, classifyCommand, compareManifests, inspectVerificationFile, Project, sha256, type PreActionInput } from '../src/index.js';

let dir: string;
let root: string;
let p: Project;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl-h-'));
  process.env.AGENTONTRACK_HOME = join(dir, 'home');
  root = join(dir, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'a');
  p = new Project(root);
});
afterEach(() => {
  try { p.close(); } catch { /* closed by the test */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const shell = (command: string, over: Partial<PreActionInput> = {}) => {
  const c = classifyCommand(command);
  return p.preAction({ runtime: 'claude-code', tool: 'Bash', effects: c.effects, opaque: c.opaque, coverage: 'enforced', rawInput: command, ...over });
};
const setup = () => {
  p.human.setGoal({ statement: 'g', scope: { include: ['src/**'] } });
  p.human.createTask({ id: 't', title: 't', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
};
const dbPath = () => join(p.stateDir, 'events.sqlite');
const rawSql = (sql: string) => { const d = new DatabaseSync(dbPath()); d.exec(sql); d.close(); };

/** Rewrites an event and recomputes every later hash: what a same-user attacker can do to the database alone. */
function rewriteAndRechain(seq: number, payload: unknown) {
  const d = new DatabaseSync(dbPath());
  d.exec('DROP TRIGGER events_no_update');
  let prev = '0'.repeat(64);
  for (const r of d.prepare('SELECT * FROM events ORDER BY seq').all() as any[]) {
    const body = { seq: r.seq, ts: r.ts, type: r.type, actor: JSON.parse(r.actor), taskId: r.task_id, goalVersion: r.goal_version, policyVersion: r.policy_version, payload: r.seq === seq ? payload : JSON.parse(r.payload), prevHash: prev };
    const hash = sha256(canonical(body));
    d.prepare('UPDATE events SET payload=?, prev_hash=?, hash=? WHERE seq=?').run(JSON.stringify(body.payload), prev, hash, r.seq);
    prev = hash;
  }
  d.close();
}

describe('log integrity', () => {
  beforeEach(setup);

  it('passes when untouched, and says it is not immutable', () => {
    const r = p.verifyIntegrity();
    expect(r.ok).toBe(true);
    expect(r.assurance).toMatch(/Not immutable/);
  });

  it('detects a consistent rewrite of the database that a hash chain alone misses', () => {
    p.close();
    rewriteAndRechain(2, { goal: { statement: 'attacker goal' } });
    p = new Project(root);
    expect(p.store.verifyChain().ok).toBe(true);
    const r = p.verifyIntegrity();
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/rewritten history/);
  });

  it('detects truncation', () => {
    const head = p.store.head()!.seq;
    p.close();
    rawSql(`DROP TRIGGER events_no_delete; DELETE FROM events WHERE seq >= ${head - 1}`);
    p = new Project(root);
    expect(p.verifyIntegrity().problems.join()).toMatch(/truncation or rollback/);
    expect(p.quickIntegrity().ok).toBe(false);
  });

  it('detects rollback to an older copy of the database', () => {
    p.close();
    const backup = join(dir, 'backup.sqlite');
    const d = new DatabaseSync(dbPath());
    d.exec(`VACUUM INTO '${backup.replace(/\\/g, '/')}'`);
    d.close();
    p = new Project(root);
    shell('git status');
    shell('git log');
    p.close();
    for (const ext of ['-wal', '-shm']) rmSync(dbPath() + ext, { force: true });
    copyFileSync(backup, dbPath());
    p = new Project(root);
    expect(p.verifyIntegrity().ok).toBe(false);
  });

  it('detects a database replayed from another project', () => {
    const other = join(dir, 'other');
    mkdirSync(other);
    const q = new Project(other);
    q.human.setGoal({ statement: 'other' });
    const otherDb = join(q.stateDir, 'events.sqlite');
    const d = new DatabaseSync(otherDb);
    const out = join(dir, 'o.sqlite');
    d.exec(`VACUUM INTO '${out.replace(/\\/g, '/')}'`);
    d.close();
    q.close();
    p.close();
    for (const ext of ['-wal', '-shm']) rmSync(dbPath() + ext, { force: true });
    copyFileSync(out, dbPath());
    p = new Project(root);
    expect(p.verifyIntegrity().ok).toBe(false);
  });

  it('detects a deleted witness', () => {
    p.close();
    unlinkSync(p.witness.path);
    p = new Project(root);
    expect(p.verifyIntegrity().problems.join()).toMatch(/Witness file is missing/);
  });

  it('suspends approvals when integrity fails, instead of trusting the record', () => {
    const a = shell('git push').approvalIds[0]!;
    p.human.approve(a);
    p.close();
    rawSql(`DROP TRIGGER events_no_delete; DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events)`);
    p = new Project(root);
    const r = shell('git push');
    expect(r.decision).toBe('deny');
    expect(r.reasons[0]).toMatch(/Approvals are suspended/);
  });

  it('recovers: keeps the valid prefix, quarantines the damaged log and records the incident', () => {
    shell('git status');
    const before = p.store.head()!.seq;
    p.close();
    rewriteAndRechain(before, { tool: 'forged' });
    const rec = Project.recover(root);
    expect(rec.keptEvents).toBe(before - 1);
    expect(existsSync(join(rec.quarantined, 'events.sqlite'))).toBe(true);
    p = new Project(root);
    expect(p.verifyIntegrity().ok).toBe(true);
    expect(p.store.all().at(-1)!.type).toBe('integrity.incident');
  });

  it('documents the limit: an attacker who rewrites both the log and the witness is not detected', () => {
    const witness = p.witness.path;
    p.close();
    rewriteAndRechain(2, { goal: { statement: 'attacker goal' } });
    const d = new DatabaseSync(dbPath());
    const rows = d.prepare('SELECT seq, hash, payload FROM events ORDER BY seq').all() as any[];
    d.close();
    const inst = JSON.parse(rows[0].payload).instance;
    writeFileSync(witness, rows.map((r) => JSON.stringify({ seq: r.seq, hash: r.hash, ...(r.seq === 1 ? { instance: inst } : {}) })).join('\n') + '\n');
    p = new Project(root);
    expect(p.verifyIntegrity().ok).toBe(true);
  });
});

describe('approver key', () => {
  const PASS = 'correct horse battery';
  beforeEach(() => {
    setup();
    p.enrollApprover(PASS);
    p.lock();
  });

  it('refuses human operations without the passphrase', () => {
    const a = shell('git push').approvalIds[0]!;
    expect(() => p.human.approve(a)).toThrow(/unlock/);
    expect(() => p.unlock('wrong passphrase')).toThrow(/Wrong approver passphrase/);
  });

  it('grants with the passphrase and records who approved', () => {
    const a = shell('git push').approvalIds[0]!;
    p.unlock(PASS);
    p.human.approve(a, { ctx: { method: 'tty+passphrase' } });
    expect(p.state().approvals.get(a)).toMatchObject({ status: 'granted', approver: { method: 'tty+passphrase' } });
    expect(shell('git push').decision).toBe('allow');
  });

  it('ignores a forged grant written straight to the log', () => {
    const a = shell('git push').approvalIds[0]!;
    p.store.append({ type: 'approval.granted', actor: { kind: 'human' }, taskId: 't', payload: { id: a, uses: 5, fingerprint: 'x' } });
    const fresh = new Project(root);
    expect(fresh.state().approvals.get(a)?.status).toBe('pending');
    expect(fresh.state().rejectedEvents.at(-1)?.reason).toMatch(/signature/);
    fresh.close();
    expect(shell('git push').decision).toBe('request_approval');
  });

  it('ignores a replayed signed grant', () => {
    const a = shell('git push').approvalIds[0]!;
    p.unlock(PASS);
    p.human.approve(a);
    const signed = p.store.all().filter((e) => e.type === 'approval.granted').at(-1)!;
    shell('git push');
    p.store.append({ type: 'approval.granted', actor: { kind: 'human' }, taskId: 't', payload: signed.payload });
    expect(p.state().rejectedEvents.at(-1)?.reason).toMatch(/replayed/);
    expect(shell('git push').decision).toBe('request_approval');
  });

  it('cannot be silently re-enrolled by a process without the old passphrase', () => {
    expect(() => p.enrollApprover('attacker passphrase')).toThrow(/current passphrase/);
    p.store.append({ type: 'approver.enrolled', actor: { kind: 'human' }, payload: { publicKey: 'AAAA' } });
    expect(p.state().approverKey).not.toBe('AAAA');
  });

  it('writes signed checkpoints to the witness', () => {
    p.unlock(PASS);
    p.human.setGoal({ statement: 'next' });
    expect(p.verifyIntegrity()).toMatchObject({ ok: true });
    expect(p.verifyIntegrity().signedCheckpoints).toBeGreaterThan(0);
  });

  it('detects removal of the enrolment from the log', () => {
    p.close();
    const d = new DatabaseSync(dbPath());
    d.exec("DROP TRIGGER events_no_delete; DELETE FROM events WHERE type='approver.enrolled'; DELETE FROM projection");
    d.close();
    p = new Project(root);
    expect(p.verifyIntegrity().ok).toBe(false);
  });

  it('rejects a short passphrase', () => {
    const fresh = join(dir, 'f');
    mkdirSync(fresh);
    const q = new Project(fresh);
    expect(() => q.enrollApprover('short')).toThrow(/10 characters/);
    q.close();
  });
});

describe('approval lifecycle', () => {
  beforeEach(setup);

  it('denies: the request closes and the retry asks again', () => {
    const a = shell('git push').approvalIds[0]!;
    p.human.deny(a, 'not now');
    const again = shell('git push');
    expect(again.decision).toBe('request_approval');
    expect(again.approvalIds[0]).not.toBe(a);
    expect(() => p.human.approve(a)).toThrow(/it is denied/);
  });

  it('reuses a live request on duplicate attempts', () => {
    const a = shell('git push').approvalIds[0]!;
    expect(shell('git push').approvalIds[0]).toBe(a);
  });

  it('refuses double-granting the same request', () => {
    const a = shell('git push').approvalIds[0]!;
    p.human.approve(a);
    expect(() => p.human.approve(a)).toThrow(/cannot be granted/);
  });

  it('expires unanswered requests, so a task does not wait forever', () => {
    p.human.setPolicy({ ...p.state().policy, pendingTtlMs: 1 });
    p.human.createTask({ id: 'x', title: 'x', criteria: [{ id: 'c', description: 'c', kind: 'command', command: 'node -e "process.exit(0+0)"' }] });
    const a = shell('git push').approvalIds[0]!;
    const until = Date.now() + 5;
    while (Date.now() < until);
    const ev = p.evaluate('x');
    expect(ev.status).not.toBe('NEEDS_HUMAN_APPROVAL');
    expect(ev.reasons.join()).toMatch(/expired unanswered/);
    expect(() => p.human.approve(a)).toThrow(/it is expired/);
    expect(shell('git push').approvalIds[0]).not.toBe(a);
  });

  it('survives a restart with a pending request intact', () => {
    const a = shell('git push').approvalIds[0]!;
    p.close();
    p = new Project(root);
    p.human.approve(a);
    expect(shell('git push').decision).toBe('allow');
  });

  it('blocks an approved action once integrity of the grant target changes', () => {
    const a = shell('git push origin main').approvalIds[0]!;
    p.human.approve(a);
    p.human.revoke(a);
    expect(shell('git push origin main').decision).toBe('request_approval');
  });
});

describe('goal proposals', () => {
  beforeEach(setup);
  const agent = { kind: 'agent' as const, runtime: 'x' };

  it('lists, diffs and accepts; approvals and evidence are invalidated', () => {
    const a = shell('git push').approvalIds[0]!;
    p.human.approve(a);
    p.verifyTask('t');
    expect(p.evaluate('t').status).toBe('VERIFIED');
    const id = p.propose('goal', { statement: 'Expand to docs', scope: { include: ['src/**', 'docs/**'], exclude: [] }, rationale: 'needs docs' }, agent);
    expect(p.state().goal?.version).toBe(1);
    expect(p.diffProposal(id).map((d) => d.field)).toEqual(['statement', 'scope']);
    const impact = p.human.acceptProposal(id);
    expect(impact).toEqual({ invalidatedApprovals: 1, staleReceipts: 1 });
    expect(p.state().goal?.version).toBe(2);
    expect(p.state().goals.at(-1)?.fromProposal).toBe(id);
    expect(p.state().proposals.find((x) => x.id === id)?.status).toBe('accepted');
    expect(shell('git push').decision).toBe('request_approval');
    expect(p.evaluate('t').status).not.toBe('VERIFIED');
  });

  it('rejecting changes nothing and leaves an audit record', () => {
    const id = p.propose('goal', { statement: 'Delete everything' }, agent);
    p.human.rejectProposal(id, 'no');
    expect(p.state().goal?.statement).toBe('g');
    expect(p.state().proposals.find((x) => x.id === id)).toMatchObject({ status: 'rejected', note: 'no' });
    expect(() => p.human.acceptProposal(id)).toThrow(/No open proposal/);
  });

  it('accepted decisions reach the rehydrated context by relevance', () => {
    const id = p.propose('decision', { title: 'Use a parser combinator', rationale: 'simpler' }, agent);
    p.human.acceptProposal(id);
    expect(p.rehydrate()).toContain('Use a parser combinator');
  });

  it('closes and reopens a goal', () => {
    p.human.closeGoal('completed');
    expect(p.state().goal?.status).toBe('completed');
    p.human.reopenGoal();
    expect(p.state().goal?.status).toBe('active');
  });
});

describe('verification weakening', () => {
  const testFile = () => join(root, 'src', 'a.test.ts');
  beforeEach(() => {
    writeFileSync(testFile(), "it('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { a: '1' } }));
    writeFileSync(join(root, 'vitest.config.ts'), 'coverage: { lines: 90 }');
    setup();
  });
  const verified = () => p.verifyTask('t').status;

  it('passes when nothing changed', () => { expect(verified()).toBe('VERIFIED'); });

  it('flags a deleted test file', () => {
    unlinkSync(testFile());
    expect(verified()).toBe('IMPLEMENTED_UNVERIFIED');
    expect(p.evaluate('t').reasons.join()).toMatch(/deleted/);
  });

  it('flags removed assertions', () => {
    writeFileSync(testFile(), "it('a', () => { expect(1).toBe(1); });\n");
    expect(verified()).toBe('IMPLEMENTED_UNVERIFIED');
  });

  it('flags skip markers', () => {
    writeFileSync(testFile(), "it.skip('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\n");
    expect(verified()).toBe('IMPLEMENTED_UNVERIFIED');
  });

  it('flags a lowered coverage threshold', () => {
    writeFileSync(join(root, 'vitest.config.ts'), 'coverage: { lines: 10 }');
    expect(verified()).toBe('IMPLEMENTED_UNVERIFIED');
  });

  it('flags a neutered test script, but not a dependency bump', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { a: '2' } }));
    expect(p.verifyTask('t').reasons.join()).not.toMatch(/script changed/);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run || true' }, dependencies: { a: '2' } }));
    expect(verified()).toBe('IMPLEMENTED_UNVERIFIED');
  });

  it('does not flag legitimate additions', () => {
    writeFileSync(testFile(), "it('a', () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3); });\n");
    writeFileSync(join(root, 'src', 'b.test.ts'), "it('b', () => {});\n");
    expect(verified()).toBe('VERIFIED');
    expect(p.verificationFindings('t').map((f) => f.severity)).toEqual(['strengthened', 'strengthened']);
  });

  it('a human can accept a legitimate change', () => {
    unlinkSync(testFile());
    p.human.acceptVerificationChanges('t', 'test moved');
    expect(verified()).toBe('VERIFIED');
  });

  it('documents the limit: an assertion hollowed out with the same counts is not flagged', () => {
    writeFileSync(testFile(), "it('a', () => { expect(true).toBe(true); expect(true).toBe(true); });\n");
    expect(verified()).toBe('VERIFIED');
  });

  it('compares manifests directly', () => {
    const e = inspectVerificationFile(testFile(), 'src/a.test.ts')!;
    expect(compareManifests({ x: e }, {})[0]!.severity).toBe('suspected-weakening');
  });
});

describe('indirect effects', () => {
  beforeEach(setup);

  it('strict profile prevents opaque code, unless a human allow-listed the exact command', () => {
    p.human.setProfile('strict');
    p.human.createTask({ id: 's', title: 's' });
    expect(shell('node -e "1"').decision).toBe('request_approval');
    p.human.setPolicy({ ...p.state().policy, opaqueAllow: ['npm test'] });
    expect(shell('npm test').decision).toBe('allow');
    expect(shell('npm test && node evil.js').decision).toBe('request_approval');
    expect(shell('npm test 2>&1').decision).toBe('allow');
    expect(shell('npm test 2>&1 | tail -5').decision).toBe('allow');
    expect(shell('(npm test)').decision).toBe('allow');
    expect(shell('npm test > .env').decision).toBe('request_approval');
  });

  it('quarantine removes a new out-of-scope file and keeps a copy', () => {
    p.human.setProfile('strict');
    p.human.setPolicy({ ...p.state().policy, opaqueExec: 'allow' });
    shell('python x.py');
    writeFileSync(join(root, 'prod.conf'), 'evil');
    const r = p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] });
    expect(r.reverted).toEqual([{ path: 'prod.conf', how: 'new file moved to quarantine' }]);
    expect(existsSync(join(root, 'prod.conf'))).toBe(false);
    expect(p.state().mismatches[0]).toMatchObject({ path: 'prod.conf', acknowledged: false });
    expect(readFileSync(join(p.stateDir, 'quarantine', String(p.state().mismatches[0]!.seq), 'prod.conf'), 'utf8')).toBe('evil');
  });

  it('quarantine restores a modified or deleted protected file', () => {
    writeFileSync(join(root, '.env'), 'ORIGINAL');
    writeFileSync(join(root, 'GOAL.md'), 'KEEP');
    p.human.setProfile('strict');
    p.human.setPolicy({ ...p.state().policy, opaqueExec: 'allow' });
    shell('python x.py');
    writeFileSync(join(root, '.env'), 'STOLEN');
    unlinkSync(join(root, 'GOAL.md'));
    const r = p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] });
    expect(r.reverted.map((x) => x.how)).toEqual(['restored previous content', 'restored previous content']);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toBe('KEEP');
  });

  it('detects a change to a sensitive file outside the root (detection only)', () => {
    const fake = join(dir, 'fake-bashrc');
    writeFileSync(fake, 'a');
    p.human.setPolicy({ ...p.state().policy, sentinelPaths: [fake] });
    shell('python setup_shell.py');
    writeFileSync(fake, 'b');
    const r = p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] });
    expect(r.mismatches[0]!.reason).toMatch(/sensitive file outside the project/);
    expect(r.reverted).toEqual([]);
  });

  it('dynamic command names need approval instead of running unseen', () => {
    expect(shell('X=pu; git ${X}sh origin main').decision).toBe('request_approval');
    expect(shell('$TOOL --force').decision).toBe('request_approval');
    expect(shell('git log $REF').decision).toBe('allow');
  });

  it('looks inside command substitution', () => {
    expect(shell('echo $(git push origin main)').decision).toBe('request_approval');
  });

  it('documents the limit: a network-only script is not prevented or detected in standard mode', () => {
    const r = shell('python scripts/deploy.py --env prod');
    expect(r.decision).toBe('allow');
    expect(r.assurance).toBe('partial');
    expect(p.postAction({ runtime: 'claude-code', tool: 'Bash', effects: [] }).mismatches).toEqual([]);
  });
});

describe('incremental state and efficiency', () => {
  beforeEach(setup);

  it('projection state equals a full replay', () => {
    for (let i = 0; i < 120; i++) shell(`git log -${i}`);
    p.checkpoint();
    p.close();
    p = new Project(root);
    const fromProjection = p.state();
    const replay = new Project(root);
    (replay as any).store.saveProjection(1, replay.store.eventAt(1)!.hash, '{bad json');
    const rebuilt = (() => { const q = new Project(root); const s = q.state(); q.close(); return s; })();
    replay.close();
    expect(fromProjection.actionCounts.get('t')).toBe(120);
    expect(rebuilt.actionCounts.get('t')).toBe(120);
    expect(rebuilt.lastDigest).toBe(fromProjection.lastDigest);
  });

  it('does not trust a projection whose anchor event changed', () => {
    p.checkpoint();
    const head = p.store.head()!;
    p.store.saveProjection(head.seq, 'f'.repeat(64), '{"lastSeq":99999}');
    const q = new Project(root);
    expect(q.state().lastSeq).toBe(q.store.head()!.seq);
    q.close();
  });

  it('dedupes reads only when enabled, and only while the content and context are unchanged', () => {
    expect(p.checkRead('src/a.txt').duplicate).toBe(false);
    expect(p.checkRead('src/a.txt').duplicate).toBe(false);
    p.human.setPolicy({ ...p.state().policy, efficiency: { ...p.state().policy.efficiency, dedupeReads: true } });
    expect(p.checkRead('src/a.txt').duplicate).toBe(false);
    expect(p.checkRead('src/a.txt').duplicate).toBe(true);
    writeFileSync(join(root, 'src', 'a.txt'), 'changed');
    expect(p.checkRead('src/a.txt').duplicate).toBe(false);
    p.resetContext();
    expect(p.checkRead('src/a.txt').duplicate).toBe(false);
  });

  it('warns on a retried failure only when nothing changed', () => {
    const r1 = shell('npm run broken');
    expect(r1.warnings).toEqual([]);
    p.recordFailure({ runtime: 'claude-code', tool: 'Bash', rawInput: 'npm run broken', summary: 'exit 1 token=abc123' });
    expect(p.store.all().at(-1)!.payload.summary).not.toContain('abc123');
    const r2 = shell('npm run broken');
    expect(r2.warnings.join()).toMatch(/failed earlier/);
    writeFileSync(join(root, 'src', 'a.txt'), 'fix');
    expect(shell('npm run broken').warnings.join()).not.toMatch(/failed earlier/);
  });
});
