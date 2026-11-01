import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { coverageFor, hookSelfTest, installHooks } from '@agentontrack/adapters';
import { Project, registerProject } from '@agentontrack/core';
import { applyProjectFiles, planProjectFiles } from './init.js';

const AGENTS = [{ id: 'claude-code', bin: 'claude' }, { id: 'codex', bin: 'codex' }, { id: 'hermes', bin: 'hermes' }] as const;
const found = (bin: string) => {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: true, timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim().split('\n')[0]! : null;
};

/** First-run path. Connecting is safe to do unattended. Goals are human decisions, so those need a real terminal. */
export async function runSetup(o: { root: string; selfCommand: string; yes: boolean; human: (p: Project, action: string) => Promise<unknown>; requireTty: (action: string) => void }): Promise<void> {
  const say = (s: string) => console.log(s);
  say(`Setting up AgentOnTrack in ${o.root}\n`);
  if (!found('git')) say('git was not found. Most checks still work, but pushes cannot be observed and anchoring needs it.');
  const interactive = !o.yes && process.stdin.isTTY && process.stdout.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, dflt = '') => (rl ? (await rl.question(`${q}${dflt ? ` [${dflt}]` : ''}: `)).trim() || dflt : dflt);
  registerProject(o.root);
  let connected = 0;
  for (const a of AGENTS) {
    const version = found(a.bin);
    if (!version) { say(`${a.id}: not installed, skipped`); continue; }
    say(`${a.id}: found ${version}`);
    if (a.id === 'hermes') { say('  Hermes hooks live in your own config. Run `agentontrack install hermes` to see what to add.'); continue; }
    if ((await ask(`  Connect ${a.id} to this project?`, 'y')).toLowerCase() !== 'y') continue;
    const cfg = installHooks(a.id, o.root, o.selfCommand);
    const check = hookSelfTest(a.id, o.root);
    say(`  Wrote ${cfg.path}. Hook self-test: ${check.ok ? 'passed' : `FAILED: ${check.detail}`}`);
    if (coverageFor(a.id).hostFailMode === 'open') say(`  ${a.id} runs actions anyway if its hook is missing. Start it with: agentontrack run ${a.id}`);
    if (check.ok) connected++;
  }
  say(process.platform === 'win32'
    ? '\nNot contained in the standard profile: what a script does on the network or outside this project. Windows has no agent sandbox for this. For that protection, run: agentontrack policy profile strict, which holds scripts for your approval.'
    : '\nNot contained in the standard profile: what a script does on the network or outside this project. For that protection, run: agentontrack install claude-code --sandbox, or start Codex with agentontrack run codex, or use: agentontrack policy profile strict.');
  if (!connected) say('\nNo agent is connected yet. Nothing is being gated. Install one, then run this again.');
  applyProjectFiles(o.root, planProjectFiles(o.root));
  if (!interactive) {
    say('\nGoals and tasks are human decisions, so they need your terminal:\n  agentontrack setup\nOr by file: agentontrack goal set --file goal.json, then agentontrack task create --file task.json');
    rl?.close();
    return;
  }
  const statement = await ask('\nWhat is the goal of this work? Leave empty to skip');
  if (statement) {
    const include = (await ask('Which paths may change?', '**')).split(',').map((x) => x.trim()).filter(Boolean);
    const title = await ask('First task', statement);
    const command = await ask('Command that proves it is done, such as npm test');
    rl?.close();
    const p = new Project(o.root);
    try {
      await o.human(p, `Approve goal: ${statement}`);
      p.human.setGoal({ statement, scope: { include } });
      const criteria = command ? [{ id: 'check', description: command, kind: 'command', command }] : [];
      await o.human(p, `Create task: ${title}${command ? `\nThis command will run on your machine: ${command}` : ''}`);
      say(`Task ${p.human.createTask({ title, criteria })} is active.${command ? '' : ' It has no check, so it cannot reach VERIFIED.'}`);
    } finally {
      p.close();
    }
  } else rl?.close();
  say('\nNext:\n  agentontrack dashboard                  Open the local dashboard\n  agentontrack dashboard --allow-public-site   Use it from the public site\n  agentontrack doctor                     See what is and is not enforced');
}
