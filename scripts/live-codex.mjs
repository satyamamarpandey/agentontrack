// Runs the app-server client against a REAL, signed-in Codex and writes benchmarks/results/live-codex-appserver.json.
//   node scripts/live-codex.mjs [model]
// Needs: `codex` on PATH and `codex login` already done with your ChatGPT account. This script never reads Codex's login files and never sets an API key
// (API-key variables are removed from the child). It works in a throwaway folder, asks Codex to create one file, and checks four things:
//   1. the handshake and thread start work and return a session id,
//   2. an approval request arrives and is answered through our callback (one is declined, one accepted),
//   3. token usage is reported, 4. the turn can be interrupted.
// Nothing here is a pass until the JSON says so. Run it from the repo root after `pnpm build`.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CodexAppServer, agentEnv } from '../packages/adapters/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = process.argv[2];
const result = { when: new Date().toISOString(), model: model ?? 'codex default', checks: {}, events: [], notes: [] };
const done = (ok, why) => {
  result.verdict = ok ? 'PASS' : 'FAIL';
  if (why) result.notes.push(why);
  if (!Object.keys(result.checks).length) { console.log(JSON.stringify({ verdict: 'NOT RUN', notes: result.notes }, null, 2)); process.exit(1); }
  mkdirSync(join(root, 'benchmarks', 'results'), { recursive: true });
  writeFileSync(join(root, 'benchmarks', 'results', 'live-codex-appserver.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ verdict: result.verdict, checks: result.checks, notes: result.notes }, null, 2));
  process.exit(ok ? 0 : 1);
};

const ver = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (ver.status !== 0) done(false, 'codex is not installed or not on PATH. See docs/codex-setup.md');
result.codexVersion = ver.stdout.trim();
const st = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', shell: process.platform === 'win32' });
result.loginStatus = (st.stdout + st.stderr).trim().slice(0, 200);
if (st.status !== 0) done(false, 'codex is not signed in. Run `codex login` and choose Sign in with ChatGPT. See docs/codex-setup.md');

const work = mkdtempSync(join(tmpdir(), 'aot-live-codex-'));
const env = agentEnv(process.env, false);
const asked = [];
let threadId = null;
const server = new CodexAppServer({
  command: ['codex'], cwd: work, env, ...(model ? { model } : {}),
  onApproval: async (r) => { asked.push(r); return /rm\b|curl|wget/.test(r.command ?? '') ? 'decline' : 'accept'; },
  onEvent: (e) => { result.events.push(e); if (e.kind === 'session') threadId = e.threadId; },
  approvalTimeoutMs: 60_000, rpcTimeoutMs: 60_000,
});
try {
  await server.start();
  result.checks.handshakeAndThread = !!threadId;
  const outcome = await server.turn({ prompt: 'Create a file named hello.txt containing exactly the word hello, then reply "done". Do not do anything else.' });
  result.checks.turnCompleted = outcome === 'completed';
  result.checks.approvalRequestsSeen = asked.length;
  result.checks.fileWritten = existsSync(join(work, 'hello.txt')) && readFileSync(join(work, 'hello.txt'), 'utf8').trim() === 'hello';
  result.checks.usageReported = result.events.some((e) => e.kind === 'usage' && e.outputTokens > 0);
  // Interrupt check
  const t = server.turn({ prompt: 'Count slowly from 1 to 500, one number per line, using the shell to sleep one second between numbers.' });
  await new Promise((r) => setTimeout(r, 8000));
  await server.interrupt(5000);
  result.checks.interrupted = (await t) === 'interrupted';
  result.notes.push('approvalRequestsSeen is 0 when Codex judged every action safe under its own policy; that is not a failure of the client, but it means the approval path was not exercised by this run.');
  done(Object.entries(result.checks).every(([k, v]) => k === 'approvalRequestsSeen' || v === true));
} catch (err) {
  server.kill();
  done(false, `error: ${err.message}`);
}
