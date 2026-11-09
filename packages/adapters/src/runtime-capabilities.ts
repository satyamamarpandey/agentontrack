/**
 * What AgentOnTrack can do with each agent runtime, one verdict per capability.
 *   supported    - built, and exercised against the real program (evidence names the file that records it)
 *   unsupported  - AgentOnTrack does not do this for this runtime today (or the runtime offers no way to)
 *   unverified   - written from documentation, or only partly exercised, or never run on the real program
 * A verdict never rises above what its evidence shows. The test in test/runtime-capabilities.test.ts checks that.
 */
export type Verdict = 'supported' | 'unsupported' | 'unverified';

export const CAPABILITIES = [
  'runtimeDiscovery', 'authStatus', 'modelDiscovery', 'commandDiscovery', 'startSession', 'sendPrompt', 'streamOutput', 'cancel',
  'toolUseObservation', 'approvalInterception', 'usageReporting', 'sessionResume', 'contextHandoff', 'attachments', 'parallelExecution',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityClaim { verdict: Verdict; note: string; /** Repo path of the record or code behind a `supported` verdict. */ evidence?: string }
export type RuntimeCapabilities = Record<Capability, CapabilityClaim>;

const sup = (note: string, evidence: string): CapabilityClaim => ({ verdict: 'supported', note, evidence });
const uns = (note: string): CapabilityClaim => ({ verdict: 'unsupported', note });
const unv = (note: string): CapabilityClaim => ({ verdict: 'unverified', note });

const CERT = 'benchmarks/results/provider-certification.json';
const DISCOVERY = 'benchmarks/results/live-discovery.json';
const COMPANION = 'packages/companion/src/index.ts';
const NOT_STARTED = 'AgentOnTrack does not start this agent; run it yourself and its hooks report here.';

const claudeCode: RuntimeCapabilities = {
  runtimeDiscovery: sup('Detects the installed version.', COMPANION),
  authStatus: sup('Reads whether Claude Code is signed in, without reading its credentials.', COMPANION),
  modelDiscovery: sup('Models used in a run and the configured model only. No entitlement list exists, so none is shown.', DISCOVERY),
  commandDiscovery: sup('55 commands reported by one real run.', DISCOVERY),
  startSession: sup('`claude -p` in the project, with hooks in place.', COMPANION),
  sendPrompt: sup('The prompt is sent on start; a slash command only if the runtime reported it.', 'packages/core/src/commands.ts'),
  streamOutput: sup('stream-json output.', COMPANION),
  cancel: sup('The child process is killed and the run is marked stopped.', COMPANION),
  toolUseObservation: sup('Hooks report each tool call.', CERT),
  approvalInterception: sup('The pre-action hook holds an action until a person approves it. Opaque scripts are not mediated.', CERT),
  usageReporting: sup('Tokens and cache reads and writes are read from the transcript.', 'packages/adapters/src/index.ts'),
  sessionResume: sup('`--resume <session>`, with the session read from the project record. One real run recalled a value from the earlier run (resume of a real session).', 'benchmarks/results/live-resume.json'),
  contextHandoff: sup('A handoff packet is exported from the record. A second real agent resuming from it is not claimed.', 'packages/core/src/handoff.ts'),
  attachments: sup('Files stored by hash, type decided from bytes, folder granted with --add-dir. One real run read the number in an attached text file. Images and PDFs were not run against real Claude.', 'benchmarks/results/live-resume.json'),
  parallelExecution: sup('One real Claude run inside its own isolated worktree (1 trial): the project hooks reached it and refused a push, the project folder stayed unchanged, the diff held only the agent’s file, the merge preview was clean. Two agents working at the same time on separate worktrees was not exercised.', 'benchmarks/results/live-worktree.json'),
};

const terminalOnly = (extra: Partial<RuntimeCapabilities>): RuntimeCapabilities => ({
  runtimeDiscovery: sup('Detects the installed version.', COMPANION),
  authStatus: unv('Login state is not read.'),
  modelDiscovery: unv('Only a model written in its own config is read, when present. Not run against a login.'),
  commandDiscovery: unv('Not reported to AgentOnTrack by a real run.'),
  startSession: uns(NOT_STARTED),
  sendPrompt: uns(NOT_STARTED),
  streamOutput: uns(NOT_STARTED),
  cancel: uns(NOT_STARTED),
  toolUseObservation: unv('Hooks driven by a scripted model; no hosted-model run.'),
  approvalInterception: unv('Held and approved with a scripted model and a small local one; no hosted-model run.'),
  usageReporting: unv('Usage appears in the agent’s own output; AgentOnTrack does not record it.'),
  sessionResume: unv('Not exercised.'),
  contextHandoff: unv('A packet can be exported; resuming a real session from it has not been run.'),
  attachments: unv('Not exercised.'),
  parallelExecution: unv('Not exercised.'),
  ...extra,
});

/** Every platform other than Claude Code: found if installed, hooks written from its documentation. No session capability is claimed. */
const other = (id: string): RuntimeCapabilities => terminalOnly({
  toolUseObservation: unv(`See ${CERT} for "${id}": observation is not certified on a hosted model.`),
  approvalInterception: unv(`See ${CERT} for "${id}": a held action is not certified on a hosted model.`),
  modelDiscovery: unv('No model list is read.'),
});

export const RUNTIME_CAPABILITIES: Record<string, RuntimeCapabilities> = {
  'claude-code': claudeCode,
  codex: terminalOnly({
    startSession: sup('App-server handshake and thread start against a real Codex 0.167.0-alpha.3 on a ChatGPT sign-in, one trial. The exec transport is fixture-tested only.', 'benchmarks/results/live-codex-appserver.json'),
    sendPrompt: sup('A real turn completed and wrote a file (app-server), one trial. Slash commands are refused because Codex reports none.', 'benchmarks/results/live-codex-appserver.json'),
    streamOutput: sup('Real events were parsed into messages, tool steps, usage and turn status (app-server), one trial.', 'benchmarks/results/live-codex-appserver.json'),
    cancel: sup('A real running turn was interrupted (app-server), one trial.', 'benchmarks/results/live-codex-appserver.json'),
    usageReporting: sup('Real token usage was reported and recorded; Codex reports no cost, so none is shown.', 'benchmarks/results/live-codex-appserver.json'),
    sessionResume: sup('A second app-server process resumed a real thread and remembered its content, one trial. The model name default sends no model.', 'benchmarks/results/live-codex-resume.json'),
    approvalInterception: sup('Default transport is `codex app-server` with approvalPolicy `untrusted`: each action Codex asks to take waits for AgentOnTrack, answered from the same decision engine and approval records as the hooks; accept is one-time only and anything not understood is declined. Real Codex asked for approval and the decline path kept a file from being deleted, one trial (benchmarks/results/live-codex-resume.json); accept after a person approved was exercised in a real cross-review (benchmarks/results/live-handoff-run2-wrong-hooks-check.json, three approvals). Also fixture-tested (packages/adapters/test/codex-appserver.test.ts, packages/companion/test/codex-appserver-run.test.ts); method and field names are unconfirmed against a real Codex.', 'benchmarks/results/live-codex-resume.json'),
    attachments: unv('Images passed as localImage inputs (app-server) or --image (exec). Fixture-tested only.'),
  }),
  hermes: terminalOnly({ usageReporting: unv('Field names unverified.') }),
  gemini: other('gemini'), opencode: other('opencode'), cline: other('cline'), copilot: other('copilot'),
  cursor: other('cursor'), devin: other('devin'), kiro: other('kiro'),
};

export function capabilitiesFor(id: string): RuntimeCapabilities | null {
  return Object.hasOwn(RUNTIME_CAPABILITIES, id) ? RUNTIME_CAPABILITIES[id]! : null;
}

/** The matrix as rows, for docs and the interface. */
export function capabilityMatrix(): { runtime: string; capability: Capability; verdict: Verdict; note: string }[] {
  return Object.entries(RUNTIME_CAPABILITIES).flatMap(([runtime, caps]) => CAPABILITIES.map((capability) => ({ runtime, capability, verdict: caps[capability].verdict, note: caps[capability].note })));
}
