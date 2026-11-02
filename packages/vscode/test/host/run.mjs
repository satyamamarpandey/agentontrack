// Opens a REAL VS Code and runs test/host/suite.cjs inside its extension host, against a real companion.
// Run on a disposable machine: `xvfb-run -a node packages/vscode/test/host/run.mjs`. It downloads VS Code, which this project does not
// put on a person's own computer.
//
// AOT_HOST_MODE:
//   dev        the source tree is loaded as the extension under development (default)
//   vsix       the packaged .vsix (AOT_VSIX) is installed with VS Code's own CLI, as a person would, and that copy is tested
//   untrusted  a workspace that is not trusted: the extension may read and must confirm nothing
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const MODE = process.env.AOT_HOST_MODE ?? 'dev';
const repo = resolve(import.meta.dirname, '..', '..', '..', '..');
const ext = resolve(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'aot-host-'));
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const root = join(dir, 'project');
mkdirSync(join(root, 'src'), { recursive: true });
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'base');

const { Project, classifyCommand } = await import(pathToFileURL(join(repo, 'packages/core/dist/index.js')).href);
const { startCompanion } = await import(pathToFileURL(join(repo, 'packages/companion/dist/index.js')).href);
const p = new Project(root);
p.human.setGoal({ statement: 'Ship it', scope: { include: ['src/**'] } });
p.human.createTask({ id: 't', title: 'The task', criteria: [{ id: 'c', description: 'x', kind: 'command', command: `node -e "process.exit(require('fs').existsSync('src/done.txt')?0:1)"` }] });
const push = classifyCommand('git push origin main');
p.preAction({ runtime: 'codex', tool: 'Bash', effects: push.effects, opaque: false, coverage: 'enforced', rawInput: 'git push origin main' });
p.close();

const codesFile = join(dir, 'codes.json');
const codes = [];
const c = await startCompanion({ root, uiDir: join(dir, 'ui'), onTerminalChallenge: (code, action) => { codes.push({ code, action }); writeFileSync(codesFile, JSON.stringify(codes)); } });
writeFileSync(codesFile, '[]');

// The companion address is a machine-scoped setting, so it goes in the user's settings, as a person would put it.
const userData = join(dir, 'user-data');
mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
  'agentontrack.companionUrl': c.url.replace(/\/$/, ''),
  'security.workspace.trust.enabled': MODE === 'untrusted',
  'security.workspace.trust.startupPrompt': 'never',
  'security.workspace.trust.banner': 'never',
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
}));

let code = 1;
try {
  const version = process.env.VSCODE_VERSION ?? 'stable';
  const exts = join(dir, 'exts');
  let developmentPath = ext;
  const launch = [root, '--disable-gpu', `--user-data-dir=${userData}`, `--extensions-dir=${exts}`];
  if (MODE === 'vsix') {
    const vsix = process.env.AOT_VSIX;
    if (!vsix) throw new Error('Set AOT_VSIX to the packaged .vsix');
    const exe = await downloadAndUnzipVSCode(version);
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
    const r = spawnSync(cli, [...cliArgs, '--install-extension', resolve(vsix), `--extensions-dir=${exts}`, `--user-data-dir=${userData}`], { encoding: 'utf8', shell: process.platform === 'win32' });
    console.log(r.stdout, r.stderr);
    if (r.status !== 0) throw new Error('Installing the VSIX failed');
    // The development path must not be the source tree, or this would not be a test of the installed package.
    developmentPath = join(dir, 'empty-dev');
    mkdirSync(developmentPath, { recursive: true });
    writeFileSync(join(developmentPath, 'package.json'), JSON.stringify({ name: 'host-test-shell', version: '0.0.0', publisher: 'test', engines: { vscode: '*' } }));
  } else {
    launch.push('--disable-extensions');
  }
  await runTests({
    version,
    extensionDevelopmentPath: developmentPath,
    extensionTestsPath: join(ext, 'test', 'host', 'suite.cjs'),
    launchArgs: launch,
    extensionTestsEnv: { AOT_PAIR_CODE: c.newPairingCode(), AOT_CODES_FILE: codesFile, AOT_COMPANION: c.url.replace(/\/$/, ''), AOT_HOST_MODE: MODE },
  });
  code = 0;
} catch (err) {
  console.error('Extension host tests failed:', err?.message ?? err);
} finally {
  await c.close();
}
process.exit(code);
