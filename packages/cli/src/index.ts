#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { approvalView, checkAnchor, isPendingLive, Project, pushAnchor, registerProject, routeIntent, type ProjectState } from '@agentontrack/core';
import { coverageFor, handleHookSafely, handleProviderHookSafely, installMcpClient, isProvider, MCP_CLIENTS, perplexityMcpConfig, PROVIDERS, providerInstalled, providerSelfTest, hermesHookConfig, hookSelfTest, hooksInstalled, installHooks, probeLocalModel, uninstallHooks, type RuntimeId } from '@agentontrack/adapters';
import { runSelf, stableCommand, VERSION } from './self.js';
import { planProjectFiles, applyProjectFiles } from './init.js';

// github.io redirects to the account's custom domain, so that domain is the only origin a browser reports.
const PUBLIC_SITE_ORIGINS = ['https://pandeysatyam.com'];
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const rootFlag = opt('root');
// A hook command names its project first, so this comes out before the command is read.
if (rootFlag) argv.splice(argv.indexOf('--root'), 2);
const root = rootFlag ?? process.env.AGENTONTRACK_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const has = (name: string) => argv.includes(`--${name}`);
const print = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function requireTty(action: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`Refused: "${action}" needs an interactive terminal, so an agent's tool call cannot run it.`);
    process.exit(3);
  }
}

/**
 * Raises the bar against an agent granting itself authority through its shell: requires a real TTY and a fresh
 * typed code. A same-user process driving a pty passes this, which is why `approver enroll` exists.
 */
async function confirm(action: string): Promise<void> {
  requireTty(action);
  const code = randomBytes(2).toString('hex');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${action}\nType ${code} to confirm: `);
  rl.close();
  if (answer.trim() !== code) { console.error('Not confirmed.'); process.exit(3); }
}

async function askSecret(prompt: string): Promise<string> {
  // Echo goes off before the prompt appears, so a secret typed early is never shown.
  process.stdin.setRawMode(true);
  process.stdout.write(prompt);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

/** Confirms, and unlocks the approver key if one is enrolled. Returns how the human was checked, for the record. */
async function human(p: Project, action: string): Promise<{ method: string }> {
  await confirm(action);
  if (!p.approverEnrolled()) return { method: 'tty' };
  p.unlock(await askSecret('Approver passphrase: '));
  return { method: 'tty+passphrase' };
}

function selfCommand(): string {
  return stableCommand(process.execPath, realpathSync.native(fileURLToPath(import.meta.url)));
}

const toolVersion = (cmd: string) => {
  const v = spawnSync(cmd.includes(' ') ? cmd : `${cmd} --version`, { encoding: 'utf8', shell: true, timeout: 15_000 });
  return v.status === 0 ? v.stdout.trim().split('\n')[0]! : null;
};

/** Only a detached, best-effort push: anchoring must never slow or fail the hook that triggers it. */
function maybeAnchorInBackground(): void {
  try {
    const p = new Project(root);
    const a = p.state().anchor;
    const head = p.store.head()?.seq ?? 0;
    const marker = join(p.stateDir, 'anchor.last');
    const last = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
    p.close();
    if (!a || head - last < a.every) return;
    // The push records its own success, so a failure is retried at the next stop.
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'anchor', 'push', '--mark'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AGENTONTRACK_ROOT: root } }).unref();
  } catch { /* the next stop tries again */ }
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function withProject<T>(fn: (p: Project) => T | Promise<T>): Promise<T> {
  const p = new Project(root);
  try { return await fn(p); } finally { p.close(); }
}

const listApprovals = (s: ProjectState) => [...s.approvals.values()].map((a) => ({ id: a.id, state: approvalView(a, new Date()), effect: a.effect, task: a.taskId, runtime: a.runtime, reason: a.reason, requestedAt: a.requestedAt }));
const nativeRuntime = (r: string | undefined) => {
  if (r !== 'claude-code' && r !== 'codex') throw new Error('Usage: agentontrack install claude-code|codex|hermes');
  return r;
};

async function main(): Promise<void> {
  const [cmd, sub, arg] = argv;
  switch (cmd) {
    case 'hook': {
      if (isProvider(sub)) {
        const out = handleProviderHookSafely(() => new Project(root), PROVIDERS[sub!]!, await readStdin(), opt('event') ? { event: opt('event')! } : {});
        if (out.stdout) process.stdout.write(out.stdout);
        if (out.stderr) process.stderr.write(out.stderr);
        process.exitCode = out.exitCode;
        return;
      }
      const out = handleHookSafely(() => new Project(root), sub as RuntimeId, await readStdin());
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
      process.exitCode = out.exitCode;
      if (out.isStop) maybeAnchorInBackground();
      return;
    }
    case 'mcp':
      {
        // Loaded on demand: every hook starts this CLI, and a hook needs none of it.
        const { createServer, serveStdio } = await import('@agentontrack/mcp-server');
        serveStdio(() => createServer(root, sub ?? 'mcp-client'));
      }
      return;
    case 'dashboard': {
      requireTty('agentontrack dashboard');
      const { startCompanion } = await import('@agentontrack/companion');
      const allowSite = has('allow-public-site');
      const packaged = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks');
      const c = await startCompanion({ root, port: Number(opt('port') ?? (allowSite ? 47631 : 0)), selfCommand: selfCommand(), ...(existsSync(packaged) ? { benchmarksDir: packaged } : {}), ...(allowSite ? { allowedOrigins: PUBLIC_SITE_ORIGINS, onTerminalChallenge: (code: string, action: string) => print(`\nThe public site asks to: ${action}\nIf that was you, type this code there: ${code}\n`) } : {}) });
      if (allowSite) print('The public AgentOnTrack site may now connect, but only with the pairing code below. Anything it changes also needs a code shown here, so a compromised page cannot act on its own. Without --allow-public-site, the local address below works with no outside origin at all.');
      print(`AgentOnTrack dashboard: ${c.url}\nPairing code (one use, 5 minutes): ${c.newPairingCode()}\nPress Enter for a new code. Press Ctrl+C to stop.`);
      createInterface({ input: process.stdin }).on('line', () => print(`New pairing code: ${c.newPairingCode()}`));
      return;
    }
    case 'init': {
      const plan = planProjectFiles(root);
      for (const f of plan) print(`--- ${f.path} (${f.action})\n${f.preview}`);
      if (!has('apply')) { print('\nDry run: nothing was written. Re-run with --apply.'); return; }
      print(applyProjectFiles(root, plan));
      return;
    }
    case 'sync-docs':
      await withProject((p) => {
        const plan = planProjectFiles(root, p);
        print(has('dry-run') ? plan.map((f) => `${f.path}: ${f.action}`) : applyProjectFiles(root, plan));
      });
      return;
    case 'install': {
      if (isProvider(sub)) {
        const a = PROVIDERS[sub!]!;
        const stable = `${selfCommand()} --root "${root.replace(/\\/g, '/')}"`;
        const files = a.install(root, stable, { v2: has('v2'), extension: has('extension') });
        registerProject(root);
        print(`Wrote ${files.join(', ')}`);
        print({ provider: a.id, kind: a.kind, surfaces: a.surfaces, ifTheHookFails: a.failure, limitations: a.limitations });
        return;
      }
      if (sub === 'hermes') {
        print(`Add this to your Hermes config.yaml. AgentOnTrack does not edit global Hermes config.\n\n${hermesHookConfig(selfCommand())}`);
        print(coverageFor('hermes'));
        return;
      }
      if (has('sandbox') && process.platform === 'win32') throw new Error('Claude Code has no OS sandbox on native Windows, so --sandbox cannot be honoured. Use the strict profile, which holds scripts for approval, or run under WSL.');
      const r = installHooks(nativeRuntime(sub), root, selfCommand(), { sandbox: has('sandbox') });
      registerProject(root);
      print(`Wrote ${r.path}`);
      if (sub === 'codex') print('Codex fails open if its hook program is missing, so start it with `agentontrack run codex`. Codex also skips a hook until you trust it with /hooks.');
      print(coverageFor(nativeRuntime(sub)));
      return;
    }
    case 'uninstall':
      if (isProvider(sub)) { print(PROVIDERS[sub!]!.uninstall(root) ? 'Hooks removed.' : 'No hook file found.'); return; }
      print(uninstallHooks(nativeRuntime(sub), root) ? 'Hooks removed.' : 'No hook file found.');
      return;
    case 'doctor': {
      const runtimes = ['claude-code', 'codex'] as const;
      const major = Number(process.versions.node.split('.')[0]);
      await withProject((p) => {
        const report = {
          version: VERSION, node: process.version, nodeOk: major >= 24, git: toolVersion('git'), stateDir: p.stateDir, integrity: p.verifyIntegrity(), approverEnrolled: p.approverEnrolled(), policyProfile: { opaqueExec: p.state().policy.opaqueExec, onMismatch: p.state().policy.onMismatch }, anchor: p.state().anchor ?? null,
          runtimes: [
            ...runtimes.map((r) => {
              const version = toolVersion(r === 'claude-code' ? 'claude' : 'codex');
              const installed = hooksInstalled(r, root);
              return { ...coverageFor(r), version: version ?? 'NOT FOUND', hooksInstalled: installed, ...(installed ? { hookSelfTest: hookSelfTest(r, root) } : {}) };
            }),
            { ...coverageFor('hermes'), version: toolVersion('hermes') ?? 'NOT FOUND', hooksInstalled: 'not checked: hooks live in user config' },
          ],
        };
        if (has('json') || !process.stdout.isTTY) { print(report); return; }
        print(`AgentOnTrack ${VERSION}, Node ${process.version}${report.nodeOk ? '' : ' (TOO OLD: needs 24 or newer)'}, git ${report.git ?? 'NOT FOUND'}`);
        print(`Log integrity: ${report.integrity.ok ? 'ok' : `PROBLEM: ${report.integrity.problems.join('; ')}`}`);
        print(`External anchor: ${report.anchor ? report.anchor.remote : 'none, so a same-user rewrite of log and witness would go unnoticed. See `agentontrack anchor config`'}`);
        print(`Approver key: ${report.approverEnrolled ? 'enrolled' : 'none, so a same-user process driving a terminal can approve. See `agentontrack approver enroll`'}`);
        for (const r of report.runtimes) print(`\n${r.runtime}: ${r.version}\n  hooks: ${r.hooksInstalled}${'hookSelfTest' in r && r.hookSelfTest ? `, self-test ${r.hookSelfTest.ok ? 'passed' : `FAILED: ${r.hookSelfTest.detail}. ${r.hookSelfTest.fix ?? ''}`}` : ''}\n  if the hook program is missing the host: ${r.hostFailMode === 'closed' ? 'blocks the action' : 'RUNS THE ACTION (fail-open)'}\n  containment of scripts: ${r.containment}\n  evidence: ${r.evidence}`);
      });
      return;
    }
    case 'run': {
      // Everything after the runtime goes to the agent unchanged, after the checks a fail-open host cannot do for itself.
      if (isProvider(sub)) {
        const a = PROVIDERS[sub!]!;
        const test = providerSelfTest(a, root);
        if (!test.ok) { console.error(`Refusing to start ${a.name}: ${test.detail}`); process.exit(78); }
        const quoted = [...(a.runArgs ?? []), ...argv.slice(2)].map((x) => (process.platform === 'win32' ? `"${x.replace(/%/g, '%%').replace(/"/g, '\\"')}"` : x));
        const r = spawnSync(a.bin, quoted, { stdio: 'inherit', shell: process.platform === 'win32', cwd: root, env: { ...process.env, AGENTONTRACK_ROOT: root, PWD: root } });
        if (r.error) throw new Error(`Could not start ${a.name}: ${r.error.message}`);
        process.exitCode = r.status ?? 1;
        return;
      }
      if (sub !== 'codex' && sub !== 'claude-code') throw new Error(`Usage: agentontrack run codex|claude-code|${Object.keys(PROVIDERS).join('|')} [agent arguments]`);
      const check = hookSelfTest(sub, root);
      if (!check.ok) { console.error(`Refusing to start ${sub}: ${check.detail}. ${check.fix ?? ''}`); process.exit(78); }
      const passthrough = argv.slice(2).filter((a) => a !== '--allow-network');
      const pre = sub === 'codex' ? ['--sandbox', 'workspace-write', '-c', `sandbox_workspace_write.network_access=${has('allow-network')}`, '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'] : [];
      // On Windows these are .cmd shims that need a shell, and a shell would otherwise read & or | in a prompt as commands.
      const quote = (x: string) => (process.platform === 'win32' ? `"${x.replace(/%/g, '%%').replace(/"/g, '\\"')}"` : x);
      const r = spawnSync(sub === 'codex' ? 'codex' : 'claude', (sub === 'codex' && passthrough[0] === 'exec' ? ['exec', ...pre, ...passthrough.slice(1)] : [...pre, ...passthrough]).map(quote), { stdio: 'inherit', shell: process.platform === 'win32', cwd: root, env: { ...process.env, AGENTONTRACK_ROOT: root } });
      if (r.error) throw new Error(`Could not start ${sub}: ${r.error.message}`);
      process.exitCode = r.status ?? 1;
      return;
    }
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup({ root, selfCommand: selfCommand(), yes: has('yes'), human, requireTty });
      return;
    }
    case 'self':
      await runSelf(sub, { opt, has, confirm });
      return;
    case 'version': case '--version': case '-v':
      print(VERSION);
      return;
    case 'providers': {
      print(Object.values(PROVIDERS).map((a) => { const v = toolVersion(`${a.bin} ${a.versionArgs.join(' ')}`); return { id: a.id, name: a.name, kind: a.kind, version: v ?? 'NOT FOUND', hooksInstalled: providerInstalled(a, root), ...(providerInstalled(a, root) ? { hookSelfTest: providerSelfTest(a, root) } : {}), surfaces: a.surfaces, ifTheHookFails: a.failure, limitations: a.limitations }; }));
      return;
    }
    case 'mcp-config': {
      if (!sub || !MCP_CLIENTS[sub]) throw new Error(`Usage: agentontrack mcp-config ${Object.keys(MCP_CLIENTS).join('|')}. This gives goals, evidence and state. It does not enforce anything.`);
      const script = realpathSync.native(fileURLToPath(import.meta.url));
      print(`Wrote ${installMcpClient(sub, [process.execPath, script], root)}\nThis gives ${MCP_CLIENTS[sub]!.name} goals, evidence and project state. It does not stop any action.`);
      return;
    }
    case 'research': {
      print('Optional research through Perplexity, on your own key, billed by Perplexity. It enforces nothing, and an answer is never evidence that work is done. Add this to your agent\'s MCP config:\n');
      print(perplexityMcpConfig());
      return;
    }
    case 'probe': {
      if (!sub) throw new Error('Usage: agentontrack probe <baseUrl> [--model name]');
      print(await probeLocalModel(sub, opt('model')));
      return;
    }
    case 'status':
      await withProject((p) => {
        const s = p.state();
        const now = new Date();
        print(`${p.rehydrate()}\n\nIntegrity: ${JSON.stringify({ ok: p.verifyIntegrity().ok, problems: p.verifyIntegrity().problems })}\nPending approvals: ${JSON.stringify([...s.approvals.values()].filter((a) => isPendingLive(a, now)).map((a) => ({ id: a.id, effect: a.effect })))}\nOpen mismatches: ${JSON.stringify(s.mismatches.filter((m) => !m.acknowledged))}\nOpen proposals: ${s.proposals.filter((x) => x.status === 'open').length}`);
      });
      return;
    case 'approver': {
      if (sub !== 'enroll') throw new Error('Usage: agentontrack approver enroll');
      requireTty('approver enroll');
      await withProject(async (p) => {
        const current = p.approverEnrolled() ? await askSecret('Current passphrase: ') : undefined;
        const pass = await askSecret('New approver passphrase (10+ characters): ');
        if (pass !== await askSecret('Repeat it: ')) throw new Error('Passphrases differ');
        print(`Approver enrolled. Key fingerprint: ${p.enrollApprover(pass, current)}\nThere is no recovery: losing the passphrase means re-attaching the project.`);
      });
      return;
    }
    case 'goal':
      await withProject(async (p) => {
        if (sub === 'set') {
          const goal = JSON.parse(readFileSync(opt('file') ?? '', 'utf8'));
          await human(p, `Approve goal: ${goal.statement}`);
          p.human.setGoal(goal);
          print(`Goal v${p.state().goal?.version} approved. Earlier approvals no longer match.`);
        } else if (sub === 'proposals') {
          print(p.state().proposals.map((x) => ({ id: x.id, kind: x.kind, status: x.status, ts: x.ts, summary: x.payload.statement ?? x.payload.title, rationale: x.payload.rationale, proposedBy: x.actor })));
        } else if (sub === 'diff' && arg) {
          print(p.diffProposal(arg));
        } else if (sub === 'accept' && arg) {
          print(p.diffProposal(arg));
          await human(p, `Accept proposal ${arg}`);
          print(p.human.acceptProposal(arg));
        } else if (sub === 'reject' && arg) {
          await human(p, `Reject proposal ${arg}`);
          p.human.rejectProposal(arg, opt('note') ?? '');
        } else if (sub === 'close') {
          await human(p, 'Close the current goal');
          p.human.closeGoal(has('abandoned') ? 'abandoned' : 'completed');
        } else if (sub === 'reopen') {
          await human(p, 'Reopen the current goal');
          p.human.reopenGoal();
        } else if (sub === 'history') {
          print(p.state().goals);
        } else throw new Error('Usage: agentontrack goal set --file f | proposals | diff <id> | accept <id> | reject <id> [--note n] | close [--abandoned] | reopen | history');
      });
      return;
    case 'decision':
      await withProject(async (p) => {
        if (sub === 'add' && arg) {
          await human(p, `Record decision: ${arg}`);
          p.human.recordDecision(arg, opt('why') ?? '');
        } else print(p.state().decisions);
      });
      return;
    case 'policy':
      await withProject(async (p) => {
        if (sub === 'profile' && arg) {
          await human(p, `Switch policy to the ${arg} profile`);
          p.human.setProfile(arg);
          print(`Policy v${p.state().policyVersion}: earlier approvals no longer match.`);
        } else if (sub === 'set') {
          const policy = JSON.parse(readFileSync(opt('file') ?? '', 'utf8'));
          await human(p, 'Replace the policy');
          p.human.setPolicy({ ...p.state().policy, ...policy });
        } else print(p.state().policy);
      });
      return;
    case 'task':
      await withProject(async (p) => {
        if (sub === 'create') {
          const spec = JSON.parse(readFileSync(opt('file') ?? '', 'utf8'));
          await human(p, `Create task: ${spec.title}\nCriteria commands will run on your machine: ${(spec.criteria ?? []).map((c: any) => c.command).filter(Boolean).join(' | ') || 'none'}`);
          print(p.human.createTask(spec));
        } else if (sub === 'use' && arg) {
          await human(p, `Activate task ${arg}`);
          p.human.activateTask(arg);
        } else if (sub === 'close' && arg) {
          await human(p, `Close task ${arg}`);
          p.human.closeTask(arg, opt('outcome') ?? 'closed');
        } else if (sub === 'accept-weak' && arg) {
          print(p.evaluate(arg).weakCriteria ?? []);
          await human(p, `Accept these weak checks for ${arg}, so they no longer withhold VERIFIED`);
          p.human.acceptWeakChecks(arg, opt('note') ?? '');
        } else if (sub === 'accept-tests' && arg) {
          print(p.verificationFindings(arg));
          await human(p, `Accept these verification changes for ${arg}`);
          p.human.acceptVerificationChanges(arg, opt('note') ?? '');
        } else if (sub === 'accept' && arg) {
          const crit = opt('criterion') ?? '';
          await human(p, `Accept criterion ${crit} of ${arg} by human judgement`);
          p.human.acceptCriterion(arg, crit, opt('note') ?? 'accepted by human');
        } else print([...p.state().tasks.values()].map((t) => ({ id: t.id, title: t.title, closed: t.closed, status: p.evaluate(t.id).status })));
      });
      return;
    case 'suggest':
      print(routeIntent(argv.slice(1).join(' ')));
      return;
    case 'approvals':
      await withProject((p) => print(listApprovals(p.state())));
      return;
    case 'approve':
      if (!sub) throw new Error('Usage: agentontrack approve <id> [--uses n] [--ttl-minutes n] [--portable]');
      await withProject(async (p) => {
        const a = p.state().approvals.get(sub);
        if (!a) throw new Error(`No approval request ${sub}`);
        const ctx = await human(p, `Approve ${a.effect.kind} on: ${a.effect.target}\nReason: ${a.reason ?? 'n/a'}\nTask ${a.taskId}, goal v${a.goalVersion}, policy v${a.policyVersion}, runtime ${a.runtime}`);
        p.human.approve(sub, { uses: Number(opt('uses') ?? 1), ttlMs: Number(opt('ttl-minutes') ?? 60) * 60_000, portable: has('portable'), ctx });
        print(`Approved ${sub}. It is bound to that task, goal, policy and target.`);
      });
      return;
    case 'deny':
      if (!sub) throw new Error('Usage: agentontrack deny <id> [--note text]');
      await withProject(async (p) => {
        const ctx = await human(p, `Deny ${sub}`);
        p.human.deny(sub, opt('note') ?? '', ctx);
        print(`Denied ${sub}.`);
      });
      return;
    case 'revoke':
      await withProject(async (p) => {
        await human(p, `Revoke ${sub}`);
        p.human.revoke(sub!);
      });
      return;
    case 'ack':
      await withProject(async (p) => {
        await human(p, `Acknowledge mismatch record ${sub}`);
        p.human.acknowledgeMismatch(Number(sub), opt('note') ?? '');
      });
      return;
    case 'verify':
      await withProject((p) => {
        const id = sub ?? p.state().activeTaskId;
        if (!id) throw new Error('No active task');
        print(p.verifyTask(id));
      });
      return;
    case 'audit':
      if (has('recover')) {
        await confirm('Keep the valid part of the log and set the rest aside');
        print(Project.recover(root));
        return;
      }
      await withProject((p) => print(has('events') ? p.store.all() : p.verifyIntegrity()));
      return;
    case 'anchor':
      await withProject(async (p) => {
        if (sub === 'config') {
          const remote = opt('remote');
          if (!remote) throw new Error('Usage: agentontrack anchor config --remote <git url> [--every 50]');
          const every = Number(opt('every') ?? 50);
          await human(p, `Anchor this log to ${remote} every ${every} events. Use a remote that refuses force-pushes, or the anchor proves little`);
          p.human.configureAnchor(remote, every);
          print(pushAnchor(p, remote));
          return;
        }
        if (sub === 'push' || sub === 'verify') {
          const remote = opt('remote') ?? p.state().anchor?.remote;
          if (!remote) throw new Error('No anchor remote. Run: agentontrack anchor config --remote <git url>');
          if (sub === 'push') {
            const entry = pushAnchor(p, remote);
            if (has('mark')) writeFileSync(join(p.stateDir, 'anchor.last'), String(entry.seq));
            print(entry);
            return;
          }
          const r = checkAnchor(p, remote);
          print(r);
          if (!r.ok) process.exitCode = 2;
          return;
        }
        const anchor = { head: p.store.head(), instance: p.state().instance, at: new Date().toISOString() };
        const out = opt('out');
        if (out) writeFileSync(out, JSON.stringify(anchor));
        const check = opt('check');
        if (check) {
          const want = JSON.parse(readFileSync(check, 'utf8'));
          const ev = p.store.eventAt(want.head.seq);
          print({ ok: ev?.hash === want.head.hash && p.state().instance === want.instance, anchoredAt: want.at, seq: want.head.seq });
          return;
        }
        print(anchor);
      });
      return;
    default:
      print(`AgentOnTrack ${VERSION}\nStart with: agentontrack setup\nCommands: setup|doctor|providers|mcp-config|research|run|init|sync-docs|install|uninstall|status|dashboard|approver|goal|decision|policy|task|approvals|approve|deny|revoke|ack|verify|audit|anchor|probe|suggest|mcp|hook|self|version`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
