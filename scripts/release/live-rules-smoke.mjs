// A production smoke test of the Firestore rules that needs no browser: what an outsider with only the public web key can and cannot do.
// It makes ONE disposable application for an address at example.com, checks it, and removes it with the owner's CLI login
// (scripts/release/firestore-admin.mjs). Everything else it tries must be refused, so nothing else is stored.
//   node scripts/release/live-rules-smoke.mjs --project <id> [--config .local/firebase-web-config.json] [--out file.json]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PROJECT = opt('--project');
const cfg = JSON.parse(readFileSync(opt('--config', '.local/firebase-web-config.json'), 'utf8'));
if (!PROJECT || cfg.projectId !== PROJECT) { console.error('Give --project, matching the web config.'); process.exit(2); }
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DB}`;
const str = (stringValue) => ({ stringValue });
const list = (...v) => ({ arrayValue: { values: v.map(str) } });
const commit = async (path, fields, serverTime = []) => (await fetch(`${BASE}:commit?key=${cfg.apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writes: [{ update: { name: `${DB}/${path}`, fields }, updateTransforms: serverTime.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }] }) })).status;
const read = async (path) => (await fetch(`${BASE}/${path}?key=${cfg.apiKey}`)).status;

const email = `rules-smoke-${Date.now()}@example.com`;
const id = createHash('sha256').update(email).digest('hex');
const application = (over = {}) => ({ name: str('Rules smoke test'), email: str(email), os: list('linux'), tools: list('codex'), useCases: list('other'), frequency: str('weekly'), privacyAccepted: { booleanValue: true }, marketingConsent: { booleanValue: false }, source: str('page'), status: str('pending'), schema: { integerValue: '1' }, ...over });
const checks = [];
const check = (name, got, want) => { checks.push({ name, got, want, ok: got === want }); console.error(`${got === want ? 'ok  ' : 'FAIL'} ${name}: ${got} (want ${want})`); };
const week = '2026-W47';
const usage = (installId, runtimes) => commit(`telemetry/${installId}_${week}`, { week: str(week), version: str('1'), installId: str(installId), tasksVerified: { integerValue: '0' }, tasksTotal: { integerValue: '0' }, activeDays: { integerValue: '0' }, runtimesConnected: list(...runtimes) }, ['createdAt']);

let created = false;
try {
  // Refused: each of these would be a flaw if it were stored.
  check('an application born approved', await commit(`applications/${id}`, application({ status: str('approved') }), ['createdAt']), 403);
  check('an application with an extra field', await commit(`applications/${id}`, application({ notes: str('x') }), ['createdAt']), 403);
  check('an application under an id that is not the hash of its address', await commit('applications/not-the-hash', application(), ['createdAt']), 403);
  // Accepted once.
  const first = await commit(`applications/${id}`, application(), ['createdAt']);
  created = first === 200;
  check('a valid application is accepted', first, 200);
  check('the same address a second time', await commit(`applications/${id}`, application(), ['createdAt']), 403);
  check('an outsider reads that application', await read(`applications/${id}`), 403);
  check('an outsider lists applications', await read('applications'), 403);
  check('an outsider approves it', await commit(`applications/${id}`, { ...application(), status: str('approved') }), 403);
  check('an outsider reads the private notes', await read(`applicationNotes/${id}`), 403);
  check('an outsider writes a private note', await commit(`applicationNotes/${id}`, { notes: str('x') }, ['updatedAt']), 403);
  check('an outsider makes themselves administrator', await commit('admins/outsider', { note: str('me') }, ['addedAt']), 403);
  check('an outsider makes themselves a member', await commit('members/outsider', { email: str(email), status: str('active') }, ['joinedAt']), 403);
  check('an outsider writes an invitation', await commit('invites/x', { email: str(email), status: str('sent') }, ['createdAt']), 403);
  check('an outsider forges a review entry', await commit('audit/x', { action: str('approve'), target: str('application:x'), by: str('outsider') }, ['at']), 403);
  check('usage counts with twelve very long entries', await usage(`smoke${Date.now()}a`, Array.from({ length: 12 }, () => 'x'.repeat(80_000))), 403);
  check('usage counts with a path as an entry', await usage(`smoke${Date.now()}b`, ['D:\\work\\project']), 403);
  check('an outsider writes into an account', await commit('users/outsider', { profile: { mapValue: { fields: { name: str('x') } } } }, ['updatedAt']), 403);
  check('an outsider writes a phone-link answer', await commit('users/x/computers/c/responses/r', { v: { integerValue: '1' } }), 403);
} finally {
  if (created) {
    const del = spawnSync(process.execPath, ['scripts/release/firestore-admin.mjs', '--project', PROJECT, 'delete', `applications/${id}`], { encoding: 'utf8' });
    const gone = spawnSync(process.execPath, ['scripts/release/firestore-admin.mjs', '--project', PROJECT, 'get', `applications/${id}`], { encoding: 'utf8' });
    check('the disposable application was removed afterwards', /null|not found|404/i.test(`${gone.stdout}${gone.stderr}`) && del.status === 0 ? 'removed' : `still there (${del.status}: ${(del.stderr || del.stdout).slice(0, 80)})`, 'removed');
  }
}
const out = { project: PROJECT, at: new Date().toISOString(), address: email.replace(/^(.{6}).*(@.*)$/, '$1***$2'), passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, checks };
if (opt('--out')) writeFileSync(opt('--out'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${out.passed} passed, ${out.failed} failed`);
process.exit(out.failed ? 1 : 0);
