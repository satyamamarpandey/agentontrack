// Live check: Plan → Build → Review → Verify through the real companion and the REAL Claude Code on this computer's subscription login.
// Each stage is authorized separately; the model each run reported is read back from the record. Fable is only probed WITHOUT consent
// (it must be refused before anything starts). It is never run. Prompts are trivial and use no tools.
// Usage: node benchmarks/live/pipeline-live.mjs [outfile]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installHooks } from '../../packages/adapters/dist/index.js';
import { Project } from '../../packages/core/dist/index.js';
import { startCompanion } from '../../packages/companion/dist/index.js';

const CLI = resolve('packages/cli/dist/index.js');
const dir = mkdtempSync(join(tmpdir(), 'aot-pipe-live-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const root = join(dir, 'repo'); mkdirSync(root);
const p = new Project(root); p.human.setGoal({ statement: 'Say OK', scope: { include: ['**'] } }); p.close();
installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
const c = await startCompanion({ root, uiDir: join(dir, 'ui') });
const origin = c.url.slice(0, -1);
const r0 = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.newPairingCode() }) });
const s = { cookie: r0.headers.get('set-cookie').split(';')[0], csrf: (await r0.json()).csrf };
const api = (path, body) => fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: s.cookie, 'x-agentontrack-csrf': s.csrf, 'content-type': 'application/json', ...(body === undefined ? {} : { 'idempotency-key': [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('') }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const out = { at: new Date().toISOString(), runtime: 'real Claude Code, subscription login', stages: [], fable: null };
try {
  await api('/api/pipeline', { goal: 'Say OK' });
  const f = await api('/api/pipeline/authorize', { stage: 'plan', agent: 'claude-code', model: 'fable' });
  out.fable = { withoutConsentStatus: f.status, body: (await f.json()).error };
  for (const [stage, model] of [['plan', 'haiku'], ['build', 'sonnet'], ['review', 'opus'], ['verify', 'haiku']]) {
    const a = await api('/api/pipeline/authorize', { stage, agent: 'claude-code', model });
    const rec = { stage, chosen: model, authorizeStatus: a.status };
    if (a.status !== 200) { rec.error = (await a.json()).error; out.stages.push(rec); break; }
    const st = await api('/api/pipeline/start', { stage, prompt: 'Reply with the single word OK. Do not use any tools.' });
    rec.startStatus = st.status;
    if (st.status !== 200) { rec.error = (await st.json()).error; out.stages.push(rec); break; }
    let view;
    for (let i = 0; i < 120; i++) { await new Promise((ok) => setTimeout(ok, 2000)); view = await (await api('/api/pipeline')).json(); if (view.pipeline.stages.find((x) => x.stage === stage).status !== 'running') break; }
    const done = view.pipeline.stages.find((x) => x.stage === stage);
    Object.assign(rec, { status: done.status, reportedModel: done.actualModel ?? null, substituted: !!done.substituted });
    out.stages.push(rec);
    if (done.status !== 'done') break;
  }
  out.summary = (await (await api('/api/pipeline')).json()).summary;
} finally { await c.close(); }
writeFileSync(process.argv[2] ?? join(dir, 'pipeline-live.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
