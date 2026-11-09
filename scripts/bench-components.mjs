// Where does AgentOnTrack's overhead come from? Real Claude Code, signed-in subscription, haiku, the same one-line-file task, N trials per variant.
//   native      : claude -p with the permission flags only
//   hooks-quiet        : the companion's flags + AgentOnTrack hooks, without any SessionStart brief
//   hooks-brief-always : + the SessionStart brief injected every time (AGENTONTRACK_BRIEF=always, the earlier behaviour)
//   hooks-default      : all hooks as they run now (brief only when it carries something useful)
// An earlier run (flags only, no hooks) cost nothing measurable against native, so that variant was dropped.
// Variants are interleaved trial by trial so a slow minute does not fall on one variant. Results: benchmarks/results/bench-components.json
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../packages/adapters/dist/index.js';
import { Project } from '../packages/core/dist/index.js';

const N = Number(process.env.TRIALS ?? 3);
const PROMPT = 'Create a file named hello.txt containing exactly the text: hi. Then reply with the single word done.';
const CLI = join(process.cwd(), 'packages/cli/dist/index.js');
const dir = mkdtempSync(join(tmpdir(), 'aot-comp-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const cpu = () => { const r = process.platform === 'win32' ? spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8' }) : spawnSync('sh', ['-c', "top -bn1 | awk '/Cpu/ {print 100-$8}'"], { encoding: 'utf8' }); const v = Number(String(r.stdout).trim()); return Number.isFinite(v) ? v : null; };
const MAX_CPU = Number(process.env.MAX_CPU ?? 35);
const VARIANTS = ['native', 'hooks-quiet', 'hooks-brief-always', 'hooks-default'];
const out = { date: new Date().toISOString().slice(0, 10), what: 'Real Claude Code on the signed-in subscription. Script: scripts/bench-components.mjs', task: PROMPT, trialsEach: N, model: 'haiku', trials: Object.fromEntries(VARIANTS.map((v) => [v, []])) };

const repoFor = (variant, i) => {
  const root = join(dir, `${variant}-${i}`); mkdirSync(root); spawnSync('git', ['init', '-q'], { cwd: root }); writeFileSync(join(root, 'README.md'), '# t\n');
  if (variant.startsWith('hooks')) {
    // hooks-brief-always forces the earlier behaviour (a brief injected even when it holds only the goal); hooks-default is the current one.
    const p = new Project(root); p.human.setGoal({ statement: 'Create hello.txt', scope: { include: ['**'] } }); p.close();
    installHooks('claude-code', root, `"${process.execPath}" "${CLI}"`);
    if (variant === 'hooks-quiet') {
      const f = join(root, '.claude', 'settings.local.json'); const cfg = JSON.parse(readFileSync(f, 'utf8')); delete cfg.hooks.SessionStart; writeFileSync(f, JSON.stringify(cfg));
    }
  }
  return root;
};

for (let i = 0; i < N; i++) for (const v of VARIANTS) {
  const root = repoFor(v, i);
  const args = ['-p', PROMPT, '--model', 'haiku', '--allowedTools', 'Bash,Write,Edit,Read,Grep,Glob', '--permission-mode', 'acceptEdits'];
  if (v === 'native') args.push('--output-format', 'json');
  else args.push('--max-budget-usd', '0.5', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local');
  const cpuBefore = cpu();
  const t0 = Date.now();
  const r = spawnSync('claude', args, { cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, AGENTONTRACK_HOME: join(dir, 'home'), ...(v === 'hooks-brief-always' ? { AGENTONTRACK_BRIEF: 'always' } : {}) }, maxBuffer: 1 << 26 });
  const seconds = +((Date.now() - t0) / 1000).toFixed(1);
  let res = null;
  if (v === 'native') { try { res = JSON.parse(r.stdout); } catch { /* keep null */ } }
  else for (const l of r.stdout.split('\n')) { try { const o = JSON.parse(l); if (o.type === 'result') res = o; } catch { /* not json */ } }
  const mu = Object.values(res?.modelUsage ?? {})[0] ?? {};
  const cpuAfter = cpu();
  const row = { cpuBefore, cpuAfter, validCpu: cpuBefore !== null && cpuAfter !== null && cpuBefore <= MAX_CPU && cpuAfter <= MAX_CPU, seconds, correct: existsSync(join(root, 'hello.txt')) && readFileSync(join(root, 'hello.txt'), 'utf8').trim() === 'hi', input: mu.inputTokens ?? null, output: mu.outputTokens ?? null, cacheRead: mu.cacheReadInputTokens ?? null, cacheCreate: mu.cacheCreationInputTokens ?? null, turns: res?.num_turns ?? null };
  out.trials[v].push(row);
  console.log(v.padEnd(12), i, JSON.stringify(row));
}
const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
out.median = Object.fromEntries(VARIANTS.map((v) => [v, Object.fromEntries(['seconds', 'input', 'output', 'cacheRead', 'cacheCreate', 'turns'].map((k) => [k, med(out.trials[v].map((x) => x[k]))]))]));
out.correct = Object.fromEntries(VARIANTS.map((v) => [v, `${out.trials[v].filter((x) => x.correct).length}/${N}`]));
writeFileSync(join(process.cwd(), 'benchmarks/results', process.env.OUT ?? 'bench-components-v2.json'), JSON.stringify(out, null, 2));
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(JSON.stringify({ correct: out.correct, median: out.median }, null, 1));
