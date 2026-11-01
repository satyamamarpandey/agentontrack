import { matchesAny, resolveInRoot } from './paths.js';
import type { Approval, ProjectState, Task } from './state.js';
import { canonical, sha256 } from './store.js';
import type { Assurance, Coverage, Decision, Effect, EffectKind, Features } from './types.js';

export interface ActionRequest {
  runtime: string;
  tool: string;
  effects: Effect[];
  opaque: boolean;
  coverage: Coverage;
  cwd: string;
  inputFingerprint: string;
  workspaceDigest: string;
}

export interface EffectVerdict {
  effect: Effect;
  decision: Decision;
  reason: string;
  fingerprint: string;
  approvalId?: string;
}

export interface DecisionResult {
  decision: Decision;
  reasons: string[];
  verdicts: EffectVerdict[];
  assurance: Assurance;
  warnings: string[];
}

const PATH_KINDS = new Set<EffectKind>(['fs.write', 'fs.delete', 'fs.delete.recursive']);
const RANK: Record<Decision, number> = { allow: 0, unsupported: 1, request_approval: 2, deny: 3 };

export function approvalFingerprint(f: Features, b: { taskId: string | null; goalVersion: number | null; policyVersion: number; runtime: string; effect: Effect }): string {
  // Without goal binding (ablation only), an approval is effectively session-wide for that effect.
  const bound = f.goalBinding
    ? { taskId: b.taskId, goalVersion: b.goalVersion, policyVersion: b.policyVersion, runtime: b.runtime }
    : {};
  return sha256(canonical({ ...bound, kind: b.effect.kind, target: b.effect.target }));
}

export function findValidApproval(state: ProjectState, fingerprint: string, portableFingerprint: string, now: Date): Approval | undefined {
  for (const a of state.approvals.values()) {
    if (a.status !== 'granted' || a.revoked || a.usesLeft <= 0) continue;
    if (a.expiresAt && new Date(a.expiresAt) <= now) continue;
    if (a.fingerprint === fingerprint || (a.portable && a.fingerprint === portableFingerprint)) return a;
  }
  return undefined;
}

export function checkPathScope(state: ProjectState, path: string, insideRoot: boolean, goalBinding: boolean): string | null {
  if (!insideRoot) return `path outside the project root: ${path}`;
  if (matchesAny(path, state.policy.protectedPaths)) return `protected path: ${path}`;
  if (goalBinding && state.goal) {
    if (matchesAny(path, state.goal.scope.exclude)) return `excluded by goal v${state.goal.version}: ${path}`;
    if (!matchesAny(path, state.goal.scope.include)) return `outside the scope of goal v${state.goal.version}: ${path}`;
  }
  return null;
}

/** Output redirection is judged by its own fs.write effect, so it does not change which program this is. */
const allowKey = (target: string) => {
  let rest = target.replace(/\s*\d*>.*$/, '').trim();
  // A harmless variable does not change which program runs. These can, so they keep the command off the allow-list.
  const unsafe = /^(NODE_|LD_|DYLD_|PATH=|PYTHON|PERL|RUBY|BASH_ENV|ENV=|GIT_|npm_config_)/i;
  for (let m = /^([A-Za-z_]\w*=\S*)\s+/.exec(rest); m && !unsafe.test(m[1]!); m = /^([A-Za-z_]\w*=\S*)\s+/.exec(rest)) rest = rest.slice(m[0].length);
  return rest;
};

export function normalizeEffects(root: string, req: Pick<ActionRequest, 'effects' | 'cwd'>): Effect[] {
  return req.effects.map((e) => (PATH_KINDS.has(e.kind) ? { kind: e.kind, target: resolveInRoot(root, req.cwd, e.target).path } : e));
}

/** Pure decision function: same inputs, same output. It makes no model call and no I/O beyond path resolution. */
export function decide(state: ProjectState, task: Task | null, req: ActionRequest, root: string, features: Features, now: Date): DecisionResult {
  const verdicts: EffectVerdict[] = [];
  const warnings: string[] = [];
  const goal = state.goal;
  const goalVersion = goal?.version ?? null;

  for (const raw of req.effects) {
    let effect = raw;
    let scopeIssue: string | null = null;
    if (PATH_KINDS.has(raw.kind)) {
      const r = resolveInRoot(root, req.cwd, raw.target);
      effect = { kind: raw.kind, target: r.path };
      scopeIssue = checkPathScope(state, r.path, r.insideRoot, features.goalBinding);
      if (/(^|\/)\.agentontrack(\/|$)/.test(r.path)) effect = { kind: 'self.tamper', target: r.path };
    }
    const fingerprint = approvalFingerprint(features, { taskId: task?.id ?? null, goalVersion, policyVersion: state.policyVersion, runtime: req.runtime, effect });
    const portable = approvalFingerprint(features, { taskId: task?.id ?? null, goalVersion, policyVersion: state.policyVersion, runtime: '*', effect });
    const verdict = (decision: Decision, reason: string, approvalId?: string) => {
      verdicts.push({ effect, decision, reason, fingerprint, ...(approvalId ? { approvalId } : {}) });
    };

    if (state.policy.denied.includes(effect.kind)) { verdict('deny', `${effect.kind} is denied by policy v${state.policyVersion}`); continue; }
    if (features.goalBinding && goal?.prohibit.includes(effect.kind)) { verdict('deny', `${effect.kind} is prohibited by goal v${goal.version}`); continue; }

    const needs = state.policy.approvalRequired.includes(effect.kind) || scopeIssue !== null || (effect.kind === 'exec.opaque' && state.policy.opaqueExec === 'approval' && !state.policy.opaqueAllow.includes(allowKey(effect.target)) && !(task?.criteria ?? []).some((c) => c.command && allowKey(c.command) === allowKey(effect.target)));
    if (!needs) { verdict('allow', 'no rule requires approval'); continue; }
    const why = scopeIssue ?? `${effect.kind} requires human approval`;
    if (features.goalBinding && !task) { verdict('deny', `${why}; no active task, so no approval can be bound. Create and activate a task`); continue; }
    const a = findValidApproval(state, fingerprint, portable, now);
    if (a) verdict('allow', `approved by ${a.id}`, a.id);
    else verdict('request_approval', why);
  }

  if (task) {
    const mine = state.actions.filter((a) => a.taskId === task.id);
    const total = state.actionCounts.get(task.id) ?? 0;
    const stop = (reason: string) => verdicts.push({ effect: { kind: 'exec.opaque', target: req.tool }, decision: 'deny', reason, fingerprint: '' });
    if (task.limits.maxActions !== undefined && total >= task.limits.maxActions) stop(`Action budget of ${task.limits.maxActions} exhausted. A human must extend it`);
    if (task.limits.maxElapsedMs !== undefined && now.getTime() - new Date(task.createdAt).getTime() > task.limits.maxElapsedMs) stop('Time budget exhausted. A human must extend it');
    let repeats = 0;
    for (let i = mine.length - 1; i >= 0; i--) {
      const m = mine[i]!;
      if (m.fingerprint !== req.inputFingerprint) break;
      if (m.digest !== req.workspaceDigest) break;
      repeats++;
    }
    if (repeats + 1 >= state.policy.loopDenyAt) stop(`Same call repeated ${repeats + 1} times with no workspace change. Change approach or escalate`);
    else if (repeats + 1 >= state.policy.loopWarnAt) warnings.push(`Same call repeated ${repeats + 1} times with no workspace change`);
  }
  if (!task) warnings.push('No active task: this action is not bound to an approved goal');

  let decision: Decision = 'allow';
  for (const v of verdicts) if (RANK[v.decision] > RANK[decision]) decision = v.decision;
  if (req.coverage === 'unavailable' && decision === 'allow') decision = 'unsupported';

  let assurance: Assurance = req.coverage === 'enforced' ? (req.opaque ? 'partial' : 'enforced') : req.coverage === 'observed-only' ? 'observed-only' : 'none';
  if (!features.coverageAssurance) assurance = 'enforced';
  const reasons = verdicts.filter((v) => v.decision === decision && decision !== 'allow').map((v) => v.reason);
  return { decision, reasons, verdicts, assurance, warnings };
}
