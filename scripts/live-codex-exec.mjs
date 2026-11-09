// REAL Codex (ChatGPT sign-in) through `codex exec --json` (companion codexMode 'exec'): resume, a text attachment, a PNG attachment, a write.
//   node scripts/live-codex-exec.mjs   Result: benchmarks/results/live-codex-exec.json (one trial; scripts/live-repeat.mjs repeats it).
// Needs `codex` on PATH and `codex login`. Never reads a login file, never sets an API key. Exec has no interactive approvals: a hook decides.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';
import { startCompanion } from '../packages/companion/dist/index.js';

const shell = process.platform === 'win32';
if (spawnSync('codex', ['login', 'status'], { shell }).status !== 0) { console.log('NOT RUN: codex missing or not signed in'); process.exit(1); }

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const solidPng = (r, g, b, n = 64) => {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: n }, () => [r, g, b]).flat())]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: n }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
};

const dir = mkdtempSync(join(tmpdir(), 'aot-livecx-exec-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const root = join(dir, 'repo'); mkdirSync(root);
writeFileSync(join(root, 'README.md'), '# t\n');
// Codex exec refuses a folder that is not a git repository ("Not inside a trusted directory"), found by the first run of this script.
for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) spawnSync('git', a, { cwd: root });
const p = new Project(root); p.human.setGoal({ statement: 'Answer questions briefly', scope: { include: ['**'] } }); p.close();
installHooks('codex', root, `"${process.execPath}" "${join(process.cwd(), 'packages/cli/dist/index.js')}"`);
const c = await startCompanion({ root, uiDir: join(dir, 'ui'), codexMode: 'exec' });
const origin = c.url.slice(0, -1);
const r = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
const s = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf };
const h = { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf };
const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...h, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const out = { date: new Date().toISOString(), what: 'Real Codex through codex exec --json, via the companion. Script: scripts/live-codex-exec.mjs', checks: {}, runs: [] };
const rt = (await (await api('/api/runtimes')).json()).find((x) => x.id === 'codex');
out.authMode = rt.authMode; out.canStart = rt.canStart; out.reason = rt.reason;
if (rt.authMode === 'api-key' || !rt.canStart) { out.verdict = 'NOT RUN'; console.log(JSON.stringify(out)); await c.close(); process.exit(1); }

const go = async (label, body) => {
  const t0 = Date.now();
  const start = await api('/api/runs', { runtime: 'codex', model: 'default', ...body });
  const j = await start.json();
  if (start.status !== 200) { out.runs.push({ label, status: start.status, error: j.error }); return null; }
  let last;
  for (let i = 0; i < 300; i++) { const rs = await (await api('/api/runs')).json(); last = rs.find((x) => x.id === j.id); if (last && last.status !== 'running') break; await new Promise((ok) => setTimeout(ok, 1000)); }
  const reply = (last?.events ?? []).filter((e) => !e.startsWith('[tool') && !e.startsWith('result:')).join(' ').slice(0, 300);
  out.runs.push({ label, id: j.id, status: last?.status, reply, seconds: Math.round((Date.now() - t0) / 1000) });
  return { id: j.id, reply, status: last?.status };
};
const att = async (name, body) => (await (await fetch(`${origin}/api/attachments`, { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-name': name }, body })).json()).id;

try {
  const a = await go('1 store a word', { prompt: 'Remember this code word: PELICAN. Reply with only the word stored.' });
  out.checks.execRunEnded = !!a && a.status !== 'running';
  out.checks.execRunNotFailed = !!a && a.status !== 'failed';
  const b = a && await go('2 resume', { prompt: 'What was the code word I gave you? Reply with only that word.', resumeRunId: a.id });
  out.checks.execResumeRecalled = !!b && /pelican/i.test(b.reply);
  const t = await go('3 text attachment', { prompt: 'What number is written in the attached file? Reply with only the number.', attachments: [await att('note.txt', Buffer.from('The secret number is 4417.'))] });
  out.checks.textAttachmentRead = !!t && /4417/.test(t.reply);
  const im = await go('4 image attachment', { prompt: 'The attached image is one solid colour. Name that colour in one word.', attachments: [await att('red.png', solidPng(255, 0, 0))] });
  out.checks.imageAttachmentSeen = !!im && /red/i.test(im.reply);
  await go('5 write inside project', { prompt: 'Create a file named out.txt containing exactly the word ok, then reply "done".' });
  out.checks.fileWritten = existsSync(join(root, 'out.txt'));
  out.checks.noRunRefused = out.runs.every((x) => !x.error);
  out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (err) { out.verdict = 'FAIL'; out.error = err.message; }
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync('benchmarks/results/live-codex-exec.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ verdict: out.verdict, checks: out.checks, runs: out.runs.map((x) => [x.label, x.status, x.reply?.slice(0, 60), x.error]), error: out.error }, null, 2));
await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(out.verdict === 'PASS' ? 0 : 1);
