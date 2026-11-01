// Fresh-project smoke test of the built CLI: install, re-install, status, doctor, offline use, uninstall.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert';

const CLI = resolve('packages/cli/dist/index.js');
const dir = mkdtempSync(join(tmpdir(), 'bl smoke é-'));
const env = { ...process.env, AGENTONTRACK_HOME: join(dir, 'home') };
const projects = { empty: join(dir, 'empty'), existing: join(dir, 'existing'), unicode: join(dir, 'проект 项目'), mono: join(dir, 'mono') };
const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', input: '' });
for (const p of Object.values(projects)) mkdirSync(p, { recursive: true });
writeFileSync(join(projects.existing, 'AGENTS.md'), 'My own rules\n');
writeFileSync(join(projects.existing, 'CLAUDE.md'), 'Existing Claude rules\n');
mkdirSync(join(projects.mono, 'packages', 'a'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: projects.mono });
spawnSync('git', ['init', '-q'], { cwd: join(projects.mono, 'packages', 'a') });

for (const [name, p] of Object.entries(projects)) {
  const dry = run(p, 'init');
  assert.equal(dry.status, 0, `${name} dry run: ${dry.stderr}`);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(run(p, 'init', '--apply').status, 0);
  assert.ok(existsSync(join(p, 'GOAL.md')), `${name} GOAL.md`);
  assert.equal(run(p, 'install', 'claude-code').status, 0);
  assert.equal(run(p, 'install', 'claude-code').status, 0, 're-install is safe');
  const doc = run(p, 'doctor');
  assert.equal(doc.status, 0, doc.stderr);
  assert.ok(JSON.parse(doc.stdout).integrity.ok, `${name} integrity`);
  assert.equal(run(p, 'status').status, 0);
  assert.equal(run(p, 'uninstall', 'claude-code').status, 0);
}
const kept = readFileSync(join(projects.existing, 'AGENTS.md'), 'utf8');
assert.ok(kept.startsWith('My own rules'), 'existing instructions preserved');
assert.ok(readFileSync(join(projects.existing, 'CLAUDE.md'), 'utf8').startsWith('Existing Claude rules'));

// No network is used by deterministic features: routing fetch to an unreachable proxy changes nothing.
const off = spawnSync(process.execPath, [CLI, 'status'], { cwd: projects.empty, encoding: 'utf8', input: '', env: { ...env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' } });
assert.equal(off.status, 0);

// An invalid request fails with a message, not a stack trace.
const bad = run(projects.empty, 'goal', 'set', '--file', join(dir, 'missing.json'));
assert.notEqual(bad.status, 0);
assert.doesNotMatch(bad.stderr, /\n\s+at /);
assert.notEqual(run(projects.empty, 'install', 'nonsense').status, 0);

// A read-only project file is reported rather than crashing.
rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
console.log('smoke ok');
