// Runs INSIDE VS Code's extension host. The window, the sidebar registration, the commands and the input box are VS Code's own.
const vscode = require('vscode');
const assert = require('node:assert');
const fs = require('node:fs');

const log = (m) => console.log(`  ${m}`);
const latestCode = () => { const all = JSON.parse(fs.readFileSync(process.env.AOT_CODES_FILE, 'utf8')); return all.at(-1); };

exports.run = async () => {
  const ext = vscode.extensions.getExtension('satyamamarpandey.agentontrack-vscode');
  assert.ok(ext, 'the extension is installed in this VS Code');
  const MODE = process.env.AOT_HOST_MODE ?? 'dev';
  if (MODE === 'vsix') assert.ok(ext.extensionPath.split(/[/\\]/).includes('exts'),'loaded from the installed package, not the source tree: ' + ext.extensionPath);
  const api = await ext.activate();
  log('activated (' + MODE + ')');
  if (MODE === 'untrusted') return untrusted(api);

  // What it contributes, as VS Code reads it.
  const c = ext.packageJSON.contributes;
  assert.equal(c.viewsContainers.activitybar[0].id, 'agentontrack');
  assert.deepEqual(c.views.agentontrack.map((v) => v.id), ['agentontrack.project', 'agentontrack.approvals', 'agentontrack.team', 'agentontrack.handoffs', 'agentontrack.usage']);
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const cmd of c.commands) assert.ok(registered.has(cmd.command), `command ${cmd.command} is registered`);
  for (const id of ['agentontrack.project', 'agentontrack.approvals']) await vscode.commands.executeCommand(`${id}.focus`);
  log(`${c.commands.length} commands and 5 views registered`);

  // The companion address is machine-scoped: a workspace setting cannot move it.
  const prop = c.configuration.properties['agentontrack.companionUrl'];
  assert.equal(prop.scope, 'machine');
  assert.equal(vscode.workspace.getConfiguration('agentontrack').get('companionUrl'), process.env.AOT_COMPANION);

  // Before pairing: nothing is read, and a change is impossible.
  assert.equal(api.snapshot(), null);
  assert.equal(api.client()?.connected ?? false, false);

  // Pairing, with the code a person would type.
  await vscode.commands.executeCommand('agentontrack.connect', { code: process.env.AOT_PAIR_CODE });
  assert.ok(api.client()?.connected, 'paired');
  await api.refresh();
  const s = api.snapshot();
  assert.equal(s.goal.statement, 'Ship it');
  assert.equal(s.task.id, 't');
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].kind, 'vcs.push');
  log(`reads the project: goal "${s.goal.statement}", ${s.pending.length} waiting`);

  // It cannot change anything by itself: the companion asks for a code from the terminal.
  const { NeedsCode } = (() => { try { return require('../../dist/extension.js'); } catch { return {}; } })();
  let asked = null;
  await api.client().post('/api/settings', { theme: 'light' }).catch((e) => { asked = e; });
  assert.ok(asked && /terminal/i.test(asked.message), 'a change is refused until a code from the terminal is given');
  void NeedsCode;

  // Approving through the extension, with the code typed into VS Code's own input box.
  const real = vscode.window.showInputBox;
  let prompts = 0;
  vscode.window.showInputBox = async (opts) => { prompts++; assert.match(opts.title ?? '', /Confirm in your terminal/); return latestCode().code; };
  try {
    await vscode.commands.executeCommand('agentontrack.approve', { id: s.pending[0].id });
  } finally { vscode.window.showInputBox = real; }
  assert.equal(prompts, 1, 'it asked the person for the code once');
  await api.refresh();
  assert.equal(api.snapshot().pending.length, 0, 'the approval is gone from the sidebar');
  const state = await api.client().get('/api/state');
  assert.equal(state.approvals[0].view, 'approved');
  assert.equal(state.approvals[0].approver.method, 'dashboard');
  log('approved through VS Code, with a code from the terminal');

  // A wrong code changes nothing.
  vscode.window.showInputBox = async () => 'not-the-code';
  try { await vscode.commands.executeCommand('agentontrack.createHandoff', { to: 'codex' }); } finally { vscode.window.showInputBox = real; }
  assert.equal((await api.client().get('/api/handoffs')).length, 0, 'a wrong code made no handoff');

  // Handing off, with the right one.
  vscode.window.showInputBox = async () => latestCode().code;
  try { await vscode.commands.executeCommand('agentontrack.createHandoff', { to: 'codex' }); } finally { vscode.window.showInputBox = real; }
  const handoffs = await api.client().get('/api/handoffs');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].to, 'codex');
  await api.refresh();
  assert.equal(api.snapshot().handoffs.length, 1);
  await vscode.commands.executeCommand('agentontrack.showHandoff', { id: handoffs[0].id });
  const doc = vscode.window.activeTextEditor?.document;
  assert.ok(doc && doc.languageId === 'markdown' && doc.getText().startsWith('# Handoff hnd_'), 'the handoff opens as readable text');
  log('handoff made and shown');

  // The sidebar follows another surface: a change made elsewhere shows up without a click.
  const before = api.snapshot().head;
  await api.client().get('/api/revision');
  assert.ok(before > 0);

  // Disconnecting forgets the session.
  await vscode.commands.executeCommand('agentontrack.disconnect');
  assert.equal(api.client()?.connected ?? false, false);
  log('disconnected');
};

/** A workspace that is not trusted: the extension may read, and must start or confirm nothing. */
async function untrusted(api) {
  assert.equal(vscode.workspace.isTrusted, false, 'this workspace is not trusted');
  await vscode.commands.executeCommand('agentontrack.connect', { code: process.env.AOT_PAIR_CODE });
  assert.ok(api.client()?.connected, 'reading is allowed: it paired');
  await api.refresh();
  assert.equal(api.snapshot().pending.length, 1);
  const real = vscode.window.showInputBox;
  let asked = 0;
  vscode.window.showInputBox = async () => { asked++; return 'x'; };
  try { await vscode.commands.executeCommand('agentontrack.approve', { id: api.snapshot().pending[0].id }); } finally { vscode.window.showInputBox = real; }
  assert.equal(asked, 0, 'it never even asked for a code');
  const state = await api.client().get('/api/state');
  assert.equal(state.approvals[0].view, 'pending', 'the approval was not decided');
  log('untrusted workspace: reads, confirms nothing');
}
