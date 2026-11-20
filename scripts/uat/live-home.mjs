// The DEPLOYED site's Home against a REAL companion on this machine (built from this source), with a stand-in agent program, so no
// provider inference is spent. Real: the public site, the browser permission flow, pairing with a terminal-confirmed code, the companion
// API, project discovery, model discovery, session recording. Stand-in: the agent process (a script that answers once).
//   node scripts/uat/live-home.mjs [outDir]       needs PLAYWRIGHT_BROWSERS_PATH=.pw-browsers and a built companion
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const out = resolve(process.argv[2] ?? 'docs/uat/ux-pr3');
mkdirSync(out, { recursive: true });
const SITE = process.env.SITE_URL ?? 'https://pandeysatyam.com/agentontrack';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const dir = mkdtempSync(join(tmpdir(), 'aot-livehome-'));
const root = join(dir, 'repo');
mkdirSync(join(root, 'src'), { recursive: true });
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
git('init', '-q', '-b', 'main'); writeFileSync(join(root, 'src', 'a.txt'), 'a'); git('add', '-A'); git('commit', '-qm', 'init');
writeFileSync(join(dir, 'agent.mjs'), `console.log(JSON.stringify({type:'system',subtype:'init',model:'stand-in'}));\nconsole.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Stand-in agent: nothing was changed.'}]}}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',total_cost_usd:0,duration_ms:5,duration_api_ms:3,num_turns:1,usage:{input_tokens:1,output_tokens:1}}));\n`);
process.env.AGENTONTRACK_HOME = join(dir, 'home');
const { startCompanion } = await import(pathToFileURL(resolve('packages/companion/dist/index.js')).href);
const codes = [];
const c = await startCompanion({ root, port: 47631, allowedOrigins: [new URL(SITE).origin], onTerminalChallenge: (x) => codes.push(x), claudeCommand: [process.execPath, join(dir, 'agent.mjs')], allowPaidApi: true, detectedAuthMode: () => 'api-key' });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await ctx.grantPermissions(['local-network-access'], { origin: new URL(SITE).origin }).catch(() => undefined);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}/dashboard/?connect`);
  await page.getByTestId('retry').click();
  await page.getByTestId('probe-status').getByText('Found AgentOnTrack on this computer').waitFor({ timeout: 30_000 });
  check('deployed site finds the companion on this computer', true);
  await page.getByLabel('Pairing code').fill(await c.newPairingCode());
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByTestId('home-screen').waitFor({ timeout: 30_000 });
  check('after pairing the first screen is Home', (await page.getByRole('heading', { level: 1 }).textContent()) === 'What are you working on?');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'live-home-1-paired.png') });

  // Example prompts fill the box and send nothing.
  const box = page.getByLabel('What should your agent do?');
  const first = page.getByTestId('home-starters').getByRole('button').first();
  const text = (await first.textContent()) ?? '';
  await first.click();
  check('example prompt fills the box', (await box.inputValue()) === text && text.length > 5, text);
  await page.screenshot({ path: join(out, 'live-home-2-example-prompt.png') });

  // Before the agent is connected to the project, Home must say so plainly and must not offer to start.
  check('with no agent connected Home explains why and links to Agents', (await page.getByTestId('home-no-agent').count()) === 1 && (await page.getByTestId('home-start').isDisabled()));
  await page.screenshot({ path: join(out, 'live-home-2b-no-agent.png') });
  // Connect Claude Code to the project the way the Agents screen does (hooks written into the project), then reload.
  const { installHooks } = await import(pathToFileURL(resolve('packages/adapters/dist/index.js')).href);
  installHooks('claude-code', root);
  await page.reload();
  await page.getByTestId('home-screen').waitFor({ timeout: 30_000 });
  await box.fill(text);
  // Model dropdown: whatever discovery really returned for the chosen agent, plus Auto.
  const agent = page.getByLabel('Choose agent');
  const agentLabel = await agent.locator('option:checked').textContent();
  const options = await page.getByLabel('Choose model').locator('option').allTextContents();
  check('agent dropdown names a real, startable agent', !!agentLabel && !/None connected/.test(agentLabel), agentLabel ?? '');
  check('model dropdown starts with Auto', options[0] === 'Auto', JSON.stringify(options));
  check('every listed model says whether it was tested or is unverified', options.slice(1).every((o) => /tested|unverified/.test(o)), `${options.length - 1} discovered`);
  await page.screenshot({ path: join(out, 'live-home-3-pickers.png') });

  // Start a real session through the real API; the agent process is the stand-in.
  const start = page.getByTestId('home-start');
  check('Start is enabled with a project, an agent and a prompt', await start.isEnabled());
  await start.click();
  const dlg = page.getByTestId('terminal-code-dialog');
  await dlg.waitFor({ timeout: 15_000 });
  check('a page from outside this computer must show the request and ask for the terminal code before anything starts', (await dlg.textContent()).includes('claude-code') && codes.length > 0);
  await page.screenshot({ path: join(out, 'live-home-3b-terminal-code.png') });
  await dlg.getByLabel('Code from your terminal').fill(codes.at(-1));
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  const alertText = (await page.getByRole('alert').allTextContents()).join(' | ');
  if (alertText) console.log('PAGE ALERT:', alertText);
  await page.getByTestId('sessions-pane').waitFor({ timeout: 30_000 });
  check('Start opens the session it created', true);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, 'live-home-4-session.png') });

  // New task returns to Home; Continue last session reopens that session.
  await page.getByTestId('nav-new-task').click();
  await page.getByTestId('home-screen').waitFor();
  check('New task returns to Home with an empty box', (await box.inputValue()) === '');
  const cont = page.getByTestId('home-continue');
  await cont.waitFor({ timeout: 15_000 });
  check('Continue last session is offered after a session exists', true);
  await page.screenshot({ path: join(out, 'live-home-5-continue.png') });
  await cont.click();
  await page.getByTestId('sessions-pane').waitFor({ timeout: 15_000 });
  check('Continue last session reopens the Sessions pane', true);
  await page.screenshot({ path: join(out, 'live-home-6-continued.png') });
  check('no script errors on the page', errors.length === 0, errors.join(' | ').slice(0, 200));
} catch (e) {
  check('walkthrough finished', false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(out, 'live-home-result.json'), JSON.stringify({ site: SITE, date: new Date().toISOString(), standInAgent: true, results }, null, 1));
console.log(`${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
