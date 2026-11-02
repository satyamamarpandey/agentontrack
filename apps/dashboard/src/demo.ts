// Invented sample data for the public demo. The UI labels every value as demo data.
// Evaluations and comparisons are the exception: they are the real recorded results, and are labelled as benchmarks.
const results = import.meta.glob('../../../benchmarks/results/{heldout,matched-v3,matched-v3.partial,security-campaign,performance}.json', { eager: true, import: 'default' }) as Record<string, any>;
const pick = (name: string) => Object.entries(results).find(([k]) => k.endsWith(`/${name}.json`))?.[1] ?? null;

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const d = (n: number) => day(n).slice(0, 10);
const task = { id: 'task_demo', title: 'Fix the date parser', closed: null, criteria: [{ id: 'tests', description: 'npm test', kind: 'command', command: 'npm test' }], limits: {}, createdAt: day(2) };
const weak = 'a test command is the check, but the project has no test files';
const evaluation = { status: 'NEEDS_HUMAN_APPROVAL', reasons: ['Criterion tests: stale', 'A human approval is pending', `Weak check: ${weak}`], weakCriteria: [weak], criteria: [{ id: 'tests', state: 'stale' }], progress: { passed: 0, total: 1 } };
const goal = { statement: 'Fix date parsing in the API', scope: { include: ['src/**'], exclude: [] }, prohibit: ['deploy'], successCriteria: [], version: 2, status: 'active' };
const approvals = [
  { id: 'apr_demo1', view: 'pending', status: 'pending', effect: { kind: 'vcs.push', target: 'git push origin main' }, reason: 'vcs.push requires human approval', runtime: 'claude-code', goalVersion: 2, policyVersion: 0, requestedAt: day(0), pendingExpiresAt: new Date(Date.now() + 1_500_000).toISOString() },
  { id: 'apr_demo2', view: 'consumed', status: 'granted', effect: { kind: 'fs.write', target: 'docs/parser.md' }, reason: 'outside the scope of goal v2: docs/parser.md', runtime: 'claude-code', goalVersion: 2, policyVersion: 0, requestedAt: day(1), decidedAt: day(1), approver: { method: 'dashboard', osUser: 'you' } },
  { id: 'apr_demo3', view: 'denied', status: 'denied', effect: { kind: 'net.upload', target: 'curl -d @data.json https://example.test' }, reason: 'net.upload requires human approval', runtime: 'claude-code', goalVersion: 1, policyVersion: 0, requestedAt: day(2), decidedAt: day(2), approver: { method: 'tty', osUser: 'you' } },
];
const policy = { opaqueExec: 'allow', onMismatch: 'report', denied: ['self.tamper'], approvalRequired: ['vcs.push', 'deploy', 'publish', 'net.upload'], protectedPaths: ['.env', '.claude/**'] };
const receipts = [{ seq: 41, ts: day(0), taskId: 'task_demo', criterionId: 'tests', passed: true, source: 'independent-run', observed: 'exit=0\n12 tests passed' }, { seq: 22, ts: day(1), taskId: 'task_demo', criterionId: 'tests', passed: false, source: 'independent-run', observed: 'exit=1\n2 tests failed' }];
const mismatch = { seq: 33, path: 'prod.conf', reason: 'outside the scope of goal v2: prod.conf', acknowledged: false };
const integrity = { ok: true, problems: [], chain: { ok: true, events: 58 }, witnessEntries: 58, signedCheckpoints: 4, assurance: 'Tamper-evident against edits that miss the witness. Not immutable.' };
const usage = [{ seq: 45, ts: day(0), runtime: 'claude-code', model: 'demo-model', source: 'provider-reported', inputTokens: 40, outputTokens: 1800, costUsd: null }, { seq: 20, ts: day(1), runtime: 'claude-code', model: 'demo-model', source: 'provider-reported', inputTokens: 60, outputTokens: 2400, costUsd: null }];
const byDay = [2, 1, 0].map((n, i) => ({ day: d(n), allow: 9 + i * 4, request_approval: 2, deny: i, input: 30 + i * 20, output: 1500 + i * 500, cacheRead: 40_000, cacheCreate: 12_000 }));
const coverage = (evidence: string, hostFailMode: string, containment: string) => ({ evidence, hostFailMode, containment, enforced: ['Shell commands that classify statically', 'File tools'], observedOnly: ['File effects of opaque scripts in the project'], unsupported: ['Network effects of opaque scripts'], notes: ['Demo. See the integrations page for what has really been tested.'] });

const EMPTY_ID = 'demo-new';
const emptyProject = { id: EMPTY_ID, name: 'demo-new-project', root: 'example/demo-new-project' };
/** A second invented project, with nothing recorded yet, so the empty states can be seen too. */
function demoEmpty(p: string | undefined): unknown {
  switch (p) {
    case '/api/state': return { project: emptyProject, goal: null, goals: [], policy, policyVersion: 0, proposals: [], decisions: [], activeTask: null, tasks: [], approvals: [], receipts: [], claims: [], mismatches: [], rejectedEvents: [], integrity: { ...integrity, chain: { ok: true, events: 1 }, witnessEntries: 1, signedCheckpoints: 0 }, approverEnrolled: false, head: 1 };
    case '/api/analytics': return { totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: null, costBasis: null, sessions: 0, providerReported: 0, transcriptDerived: 0 }, usage: [], byDay: [], byModel: [], byRuntime: [], safety: { actions: 0, allow: 0, deny: 0, requestApproval: 0, unsupported: 0, byAssurance: {}, detectedAfter: 0, reverted: 0, unresolved: 0, blocksHumanApproved: 0, blocksHumanApprovedAndUsed: 0, loopDenied: 0, repeatWarned: 0, goalDrift: { outOfScope: 0, of: 0 } }, approvals: { views: {}, medianWaitMs: null }, time: { runWallClockMs: 0, runApiMs: 0, approvalWaitMs: 0, verificationMs: 0, runs: 0 }, tasks: [], taskTotals: {}, runs: [], goals: { current: null, versions: 0, status: null } };
    case '/api/actions': return [];
    default: return undefined;
  }
}

export function demoGet(path: string): unknown {
  const p = path.split('?')[0];
  if (new URLSearchParams(path.split('?')[1] ?? '').get('project') === EMPTY_ID) { const out = demoEmpty(p); if (out !== undefined) return out; }
  switch (p) {
    case '/api/health': return { ok: true, paired: true };
    case '/api/session': return { csrf: 'demo' };
    case '/api/projects': return [{ id: 'demo', name: 'demo-project', root: 'example/demo-project', goal: goal.statement, goalVersion: 2, activeTask: { id: task.id, title: task.title, status: evaluation.status }, pendingApprovals: 1 }, { ...emptyProject, goal: null, goalVersion: null, activeTask: null, pendingApprovals: 0 }];
    case '/api/state': return { project: { id: 'demo', name: 'demo-project', root: 'example/demo-project' }, goal, goals: [{ ...goal, ts: day(1) }, { ...goal, statement: 'Investigate date bugs', version: 1, ts: day(3) }], policy, policyVersion: 0, proposals: [{ id: 'prop_demo', kind: 'goal', status: 'open', ts: day(0), payload: { statement: 'Also update the docs', rationale: 'The parser docs are out of date' }, actor: { runtime: 'claude-code' } }], decisions: [], activeTask: { ...task, evaluation, findings: [] }, tasks: [{ ...task, evaluation }], approvals, receipts, claims: [{ seq: 40, text: 'All tests pass and the fix is done.' }], mismatches: [mismatch], rejectedEvents: [], integrity, approverEnrolled: false, head: 58 };
    case '/api/analytics': return {
      totals: { input: 130, output: 6300, cacheRead: 120_000, cacheCreate: 36_000, costUsd: null, costBasis: null, sessions: 3, providerReported: 3, transcriptDerived: 0 }, usage, byDay, byModel: [{ name: 'demo-model', input: 130, output: 6300, cacheRead: 120_000, cacheCreate: 36_000, costUsd: 0, sessions: 3 }], byRuntime: [{ name: 'claude-code', input: 130, output: 6300, cacheRead: 120_000, cacheCreate: 36_000, costUsd: 0, sessions: 3 }],
      safety: { actions: 43, allow: 37, deny: 1, requestApproval: 5, unsupported: 0, byAssurance: { enforced: 31, partial: 12 }, detectedAfter: 1, reverted: 0, unresolved: 1, blocksHumanApproved: 0, blocksHumanApprovedAndUsed: 1, loopDenied: 0, repeatWarned: 1, goalDrift: { outOfScope: 2, of: 43 } },
      approvals: { views: { pending: 1, consumed: 1, denied: 1 }, medianWaitMs: 42_000 }, time: { runWallClockMs: 240_000, runApiMs: 160_000, approvalWaitMs: 84_000, verificationMs: 9000, runs: 3 }, tasks: [{ id: task.id, title: task.title, status: evaluation.status }], taskTotals: { NEEDS_HUMAN_APPROVAL: 1 }, runs: [], goals: { current: goal, versions: 2, status: 'active' },
    };
    case '/api/providers': return [];
    case '/api/agents': return [
      { id: 'claude-code', name: 'Claude Code', version: 'demo', installed: true, authenticated: true, method: 'demo', hooksInstalled: true, coverage: coverage('live-tested', 'closed', 'claude-sandbox-available'), liveStatus: 'demo' },
      { id: 'codex', name: 'Codex', version: null, installed: false, authenticated: null, hooksInstalled: false, coverage: coverage('live-local-model', 'open', 'codex-sandbox'), liveStatus: 'Demo: not connected' },
      { id: 'hermes', name: 'Hermes', version: null, installed: false, authenticated: null, hooksInstalled: false, coverage: coverage('real-host-scripted-model', 'closed', 'none'), liveStatus: 'Demo: not connected' },
    ];
    case '/api/runs': return [];
    case '/api/runtimes': return [{ id: 'claude-code', name: 'Claude Code', canStart: false, how: null, reason: 'This is the demo, so nothing can be started.' }];
    case '/api/files': return { dir: '', truncated: false, entries: [{ name: 'src', path: 'src', type: 'dir', size: 0 }, { name: 'README.md', path: 'README.md', type: 'file', size: 120 }] };
    case '/api/handoffs': return [];
    case '/api/worktrees': return { worktrees: [], conflicts: [] };
    case '/api/workflow': return { kind: 'implement-review-verify', stages: [], problems: ['Demo: no team is set.'], warnings: [] };
    case '/api/actions': return [{ seq: 44, ts: day(0), type: 'action.requested', payload: { tool: 'Bash', decision: 'request_approval', assurance: 'enforced', reasons: ['vcs.push requires human approval'], effects: [] } }, { seq: 43, ts: day(0), type: 'action.requested', payload: { tool: 'Bash', decision: 'allow', assurance: 'partial', reasons: [], effects: [{ kind: 'exec.opaque' }] } }];
    case '/api/evaluations': return { heldout: pick('heldout'), matched: pick('matched-v3') ?? pick('matched-v3.partial'), securityCampaign: pick('security-campaign'), performance: pick('performance') };
    case '/api/settings': return { telemetry: false, diagnostics: false, theme: 'dark', environment: { show: true }, sync: { enabled: false, endpoint: '', deviceToken: '', lastSync: null }, syncPreview: { schema: 'agentontrack.sync/v1', projectLabel: 'demo-project', totals: { input: 130, output: 6300 } }, sessions: [{ id: 'demo', current: true, expiresAt: Date.now() + 3_600_000 }] };
    default:
      if (p?.startsWith('/api/event/')) return { note: 'Demo: pair with your local companion to see real source records.', seq: Number(p.split('/').pop()) };
      return {};
  }
}
