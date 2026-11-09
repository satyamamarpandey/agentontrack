// REAL Codex (signed in with ChatGPT): resume a thread in a second app-server process, and decline a command through the approval callback.
//   node scripts/live-codex-resume.mjs      Result: benchmarks/results/live-codex-resume.json. One trial. Needs `codex` on PATH and `codex login`.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexAppServer, agentEnv } from '../packages/adapters/dist/index.js';

const shell = process.platform === 'win32';
if (spawnSync('codex', ['login', 'status'], { shell }).status !== 0) { console.log('NOT RUN: codex missing or not signed in'); process.exit(1); }
const work = mkdtempSync(join(tmpdir(), 'aot-livecx-'));
const out = { date: new Date().toISOString(), what: 'Real Codex: resume across processes; decline via approval callback. Script: scripts/live-codex-resume.mjs', checks: {}, asked: [] };
const mk = (onApproval, events) => new CodexAppServer({ command: ['codex'], cwd: work, env: agentEnv(process.env, false), onApproval, onEvent: (e) => events.push(e), approvalTimeoutMs: 60_000, rpcTimeoutMs: 60_000 });
const text = (ev) => ev.filter((e) => e.kind === 'message').map((e) => e.text).join(' ');
try {
  const e1 = []; const s1 = mk(async () => 'decline', e1);
  const id = await s1.start();
  await s1.turn({ prompt: 'Remember this secret word for later: pineapple. Reply only "noted".' });
  s1.kill();
  const e2 = []; const s2 = mk(async () => 'decline', e2);
  const id2 = await s2.start(id);
  out.checks.sameThread = id2 === id;
  await s2.turn({ prompt: 'What was the secret word I asked you to remember? Reply with that one word.' });
  out.checks.rememberedAcrossProcesses = /pineapple/i.test(text(e2));
  s2.kill();
  // Decline: ask for a file deletion; the callback declines every approval, so the file must survive.
  writeFileSync(join(work, 'keep.txt'), 'keep');
  const e3 = []; const s3 = mk(async (r) => { out.asked.push((r.command ?? (r.paths ?? []).join(',')).slice(0, 120)); return 'decline'; }, e3);
  await s3.start();
  await s3.turn({ prompt: 'Delete the file keep.txt using the shell command rm or del, then reply "done".' });
  out.checks.declinedActionDidNotRun = existsSync(join(work, 'keep.txt'));
  out.checks.approvalWasAsked = out.asked.length > 0;
  s3.kill();
  out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (err) { out.verdict = 'FAIL'; out.error = err.message; }
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync('benchmarks/results/live-codex-resume.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ verdict: out.verdict, checks: out.checks, asked: out.asked, error: out.error }, null, 2));
process.exit(out.verdict === 'PASS' ? 0 : 1);
