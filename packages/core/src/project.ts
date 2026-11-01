import { spawnSync } from 'node:child_process';
import { randomBytes, type KeyObject } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { approvalFingerprint, checkPathScope, decide, normalizeEffects, type ActionRequest, type DecisionResult } from './decide.js';
import { createApprover, keyFingerprint, signBody, unlockApprover, verifyIntegrity, Witness, type ApproverFile, type IntegrityReport } from './integrity.js';
import { changedPaths, diffSnapshots, hashSentinels, snapshotDigest, takeSnapshot, type Snapshot } from './observe.js';
import { matchesAny, resolveInRoot } from './paths.js';
import { applyEvent, approvalView, deserializeState, emptyState, evaluateTask, isPendingLive, serializeState, type ProjectState, type Task, type TaskEvaluation } from './state.js';
import { EventStore, canonical, sha256, type NewEvent } from './store.js';
import { ALL_FEATURES, CriterionSchema, GoalContractSchema, POLICY_PROFILES, PolicySchema, TaskLimitsSchema, type Actor, type Coverage, type Criterion, type Effect, type Features, type GoalContract, type StoredEvent } from './types.js';
import { checkRemote } from './anchor.js';
import { assessCriteria, compareManifests, inspectVerificationFile, type VerificationManifest } from './verification.js';

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;
const HUMAN: Actor = { kind: 'human' };
const SECRET = /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)\S+|\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,})\b/gi;
export const redact = (text: string) => text.replace(SECRET, (_m, key) => `${key ?? ''}[REDACTED]`);
const MAX_BLOB = 1024 * 1024;
const PROJECTION_EVERY = 100;

export function agentontrackHome(): string {
  return process.env.AGENTONTRACK_HOME ?? join(homedir(), '.agentontrack');
}

const projectKey = (root: string) => sha256(realpathSync.native(resolve(root))).slice(0, 24);

export interface Registered { id: string; root: string; name: string; attachedAt: string }
const registryPath = () => join(agentontrackHome(), 'registry.json');
export const loadRegistry = (): Registered[] => { try { return JSON.parse(readFileSync(registryPath(), 'utf8')); } catch { return []; } };
export const saveRegistry = (r: Registered[]) => { mkdirSync(dirname(registryPath()), { recursive: true }); writeFileSync(registryPath(), JSON.stringify(r, null, 2)); };
export function registerProject(root: string): Registered {
  const real = realpathSync.native(resolve(root));
  const id = basename(stateDirFor(real));
  const reg = loadRegistry();
  let entry = reg.find((r) => r.id === id);
  if (!entry) {
    entry = { id, root: real, name: basename(real) || real, attachedAt: new Date().toISOString() };
    reg.push(entry);
    saveRegistry(reg);
  }
  return entry;
}

/** State lives outside the workspace, so the observer, repo and ordinary agent edits do not touch it. */
export function stateDirFor(root: string): string {
  return join(agentontrackHome(), 'projects', projectKey(root));
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch {
    // Windows refuses a rename over a file another hook has open. That hook's snapshot is just as recent.
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

export interface PreActionInput {
  runtime: string;
  sessionId?: string;
  tool: string;
  effects: Effect[];
  opaque: boolean;
  coverage: Coverage;
  cwd?: string;
  rawInput?: unknown;
  /** A dedicated read tool cannot change files, so it skips the workspace scan. Shell commands never set this. */
  skipObservation?: boolean;
}

export interface PreActionResult extends DecisionResult {
  seq: number;
  taskId: string | null;
  approvalIds: string[];
}

export interface PostActionResult {
  mismatches: { path: string; reason: string }[];
  undeclared: string[];
  truncated: boolean;
  reverted: { path: string; how: string }[];
}

export interface HumanContext { method: string }

export class Project {
  readonly store: EventStore;
  readonly stateDir: string;
  readonly witness: Witness;
  private snapshotPath: string;
  private approverPath: string;
  private blobDir: string;
  private cache: ProjectState | undefined;
  private signer: KeyObject | undefined;

  constructor(readonly root: string, readonly features: Features = ALL_FEATURES) {
    this.root = realpathSync.native(resolve(root));
    this.stateDir = stateDirFor(this.root);
    mkdirSync(this.stateDir, { recursive: true });
    this.snapshotPath = join(this.stateDir, 'snapshot.json');
    this.approverPath = join(this.stateDir, 'approver.json');
    this.blobDir = join(this.stateDir, 'blobs');
    this.witness = new Witness(join(agentontrackHome(), 'witness', `${projectKey(this.root)}.jsonl`));
    this.store = new EventStore(join(this.stateDir, 'events.sqlite'));
    this.store.onCommit = (e) => this.witnessEvent(e);
    if (!this.store.head()) this.store.append({ type: 'project.attached', actor: { kind: 'system' }, payload: { root: this.root, instance: randomBytes(16).toString('hex') } });
  }

  private witnessEvent(e: StoredEvent): void {
    const entry: Parameters<Witness['add']>[0] = { seq: e.seq, hash: e.hash };
    if (e.type === 'project.attached') entry.instance = e.payload.instance;
    if (e.type === 'approver.enrolled') entry.approverKey = e.payload.publicKey;
    if (this.signer && e.actor.kind === 'human') entry.sig = signBody(this.signer, { seq: e.seq, hash: e.hash, instance: this.cache?.instance ?? this.state().instance });
    this.witness.add(entry);
  }

  /** Incremental: resumes from the last projection, and only replays what is new. */
  state(): ProjectState {
    const head = this.store.head();
    if (!this.cache) {
      const saved = this.store.loadProjection();
      const at = saved && this.store.eventAt(saved.seq);
      if (saved && at && at.hash === saved.hash) {
        try { this.cache = deserializeState(saved.state); } catch { /* rebuilt below */ }
      }
      this.cache ??= emptyState();
    }
    if (head && head.seq !== this.cache.lastSeq) {
      if (head.seq < this.cache.lastSeq) this.cache = emptyState();
      const before = this.cache.lastSeq;
      for (const e of this.store.since(this.cache.lastSeq)) applyEvent(this.cache, e);
      if (this.cache.lastSeq - before >= PROJECTION_EVERY || (before === 0 && this.cache.lastSeq >= PROJECTION_EVERY)) {
        this.store.saveProjection(head.seq, head.hash, serializeState(this.cache));
      }
    }
    return this.cache;
  }

  /** Forces a projection save; recovery tests and long-lived processes use this. */
  checkpoint(): void {
    const s = this.state();
    const head = this.store.head();
    if (head) this.store.saveProjection(head.seq, head.hash, serializeState(s));
  }

  close(): void {
    this.store.close();
  }

  private stamp(s: ProjectState, taskId: string | null) {
    return { taskId, goalVersion: s.goal?.version ?? null, policyVersion: s.policyVersion };
  }

  // Approver key ---------------------------------------------------------------------------------

  approverEnrolled(): boolean { return !!this.state().approverKey; }

  enrollApprover(passphrase: string, currentPassphrase?: string): string {
    const had = this.approverEnrolled();
    if (had) {
      if (!currentPassphrase) throw new Error('An approver is already enrolled; rotation needs the current passphrase');
      this.unlock(currentPassphrase);
    }
    const file = createApprover(passphrase);
    this.humanAppend({ type: 'approver.enrolled', payload: { publicKey: file.publicKey } });
    writeAtomic(this.approverPath, JSON.stringify(file));
    this.signer = unlockApprover(file, passphrase);
    return keyFingerprint(file.publicKey);
  }

  unlock(passphrase: string): void {
    if (!existsSync(this.approverPath)) throw new Error('No approver key file');
    const file: ApproverFile = JSON.parse(readFileSync(this.approverPath, 'utf8'));
    if (file.publicKey !== this.state().approverKey) throw new Error('Approver key file does not match the enrolled key');
    this.signer = unlockApprover(file, passphrase);
  }

  lock(): void { this.signer = undefined; }

  private humanAppend(e: Omit<NewEvent, 'actor'>): StoredEvent {
    const s = this.state();
    const payload: Record<string, unknown> = { ...(e.payload as object), nonce: randomBytes(12).toString('hex') };
    if (s.approverKey) {
      if (!this.signer) throw new Error('This project has an enrolled approver: unlock with the passphrase first');
      payload.sig = signBody(this.signer, { type: e.type, taskId: e.taskId ?? null, payload, instance: s.instance });
    }
    return this.store.append({ ...e, actor: HUMAN, payload });
  }

  private approverInfo(ctx?: HumanContext) {
    const key = this.state().approverKey;
    let user = 'unknown';
    try { user = userInfo().username; } catch { /* some containers have no passwd entry */ }
    return { method: ctx?.method ?? 'api', osUser: user, keyFingerprint: key ? keyFingerprint(key) : null };
  }

  /** The human-only operations. Only the CLI and the paired dashboard reach these; the MCP server does not. */
  readonly human = {
    setGoal: (goal: unknown, fromProposal?: string) => {
      const parsed: GoalContract = GoalContractSchema.parse(goal);
      return this.humanAppend({ type: 'goal.approved', payload: { goal: parsed, ...(fromProposal ? { fromProposal } : {}) } });
    },
    closeGoal: (outcome: 'completed' | 'abandoned') => this.humanAppend({ type: 'goal.closed', payload: { outcome } }),
    reopenGoal: () => this.humanAppend({ type: 'goal.reopened', payload: {} }),
    setPolicy: (policy: unknown) => this.humanAppend({ type: 'policy.set', payload: { policy: PolicySchema.parse(policy) } }),
    setProfile: (profile: string) => {
      const p = POLICY_PROFILES[profile];
      if (!p) throw new Error(`Unknown profile ${profile}`);
      return this.human.setPolicy({ ...this.state().policy, ...p });
    },
    createTask: (input: { title: string; criteria?: unknown[]; limits?: unknown; activate?: boolean; id?: string }): string => {
      const s = this.state();
      const id = input.id ?? newId('task');
      const criteria: Criterion[] = (input.criteria ?? []).map((c) => CriterionSchema.parse(c));
      // Without a baseline, a run whose hooks never fired would leave nothing to compare against.
      if (!this.loadSnapshot()) writeAtomic(this.snapshotPath, JSON.stringify(this.takeSnap(s)));
      this.humanAppend({ type: 'task.created', ...this.stamp(s, id), payload: { id, title: input.title, criteria, limits: TaskLimitsSchema.parse(input.limits ?? {}), verificationBaseline: this.currentManifest() } });
      if (input.activate !== false) this.human.activateTask(id);
      return id;
    },
    activateTask: (id: string) => {
      if (!this.state().tasks.has(id)) throw new Error(`No task ${id}`);
      this.humanAppend({ type: 'task.activated', taskId: id, payload: { id } });
    },
    closeTask: (id: string, outcome: string) => this.humanAppend({ type: 'task.closed', taskId: id, payload: { id, outcome } }),
    approve: (id: string, opts: { uses?: number; ttlMs?: number; portable?: boolean; ctx?: HumanContext } = {}) => {
      this.store.tx(() => {
        const s = this.state();
        const a = s.approvals.get(id);
        if (!a) throw new Error(`No approval request ${id}`);
        const view = approvalView(a, new Date());
        if (view !== 'pending') throw new Error(`Approval ${id} cannot be granted: it is ${view}`);
        const expiresAt = new Date(Date.now() + (opts.ttlMs ?? 3_600_000)).toISOString();
        const portable = !!opts.portable;
        const approver = this.approverInfo(opts.ctx);
        // A portable grant moves the uses to the re-keyed record below, so the total never doubles.
        this.humanAppend({ type: 'approval.granted', ...this.stamp(s, a.taskId), payload: { id, fingerprint: a.fingerprint, uses: portable ? 0 : opts.uses ?? 1, expiresAt, portable, approver } });
        if (portable) {
          // Re-keys the fingerprint to any runtime, but task, goal, policy and target stay bound.
          const fp = approvalFingerprint(this.features, { taskId: a.taskId, goalVersion: a.goalVersion, policyVersion: a.policyVersion, runtime: '*', effect: a.effect as Effect });
          this.store.append({ type: 'approval.requested', actor: { kind: 'system' }, taskId: a.taskId, goalVersion: a.goalVersion, policyVersion: a.policyVersion, payload: { id: `${id}_portable`, fingerprint: fp, effect: a.effect, runtime: '*' } });
          this.humanAppend({ type: 'approval.granted', taskId: a.taskId, payload: { id: `${id}_portable`, fingerprint: fp, uses: opts.uses ?? 1, expiresAt, portable: true, approver } });
        }
      });
    },
    deny: (id: string, note = '', ctx?: HumanContext) => {
      this.store.tx(() => {
        const a = this.state().approvals.get(id);
        if (!a) throw new Error(`No approval request ${id}`);
        const view = approvalView(a, new Date());
        if (view !== 'pending') throw new Error(`Approval ${id} cannot be denied: it is ${view}`);
        this.humanAppend({ type: 'approval.denied', taskId: a.taskId, payload: { id, note, approver: this.approverInfo(ctx) } });
      });
    },
    revoke: (id: string) => {
      if (!this.state().approvals.has(id)) throw new Error(`No approval request ${id}`);
      return this.humanAppend({ type: 'approval.revoked', payload: { id } });
    },
    acceptWeakChecks: (taskId: string, note: string) => {
      if (!this.state().tasks.has(taskId)) throw new Error(`No task ${taskId}`);
      const warnings = this.evaluate(taskId).weakCriteria ?? [];
      this.humanAppend({ type: 'weak.accepted', taskId, payload: { id: taskId, note, warnings } });
      return warnings;
    },
    configureAnchor: (remote: string, every: number) => checkRemote(remote) && this.humanAppend({ type: 'anchor.configured', payload: { remote, every } }),
    acknowledgeMismatch: (seq: number, note: string) => this.humanAppend({ type: 'mismatch.acknowledged', payload: { seq, note } }),
    acceptVerificationChanges: (taskId: string, note: string) => this.humanAppend({ type: 'verification.accepted', taskId, payload: { id: taskId, note, verificationBaseline: this.currentManifest() } }),
    acceptCriterion: (taskId: string, criterionId: string, note: string) => {
      const s = this.state();
      this.humanAppend({ type: 'evidence.recorded', ...this.stamp(s, taskId), payload: { criterionId, passed: true, observed: note, source: 'human', workspaceDigest: this.currentDigest() } });
    },
    acceptProposal: (id: string, overrides: Partial<GoalContract> = {}) => {
      const s = this.state();
      const prop = s.proposals.find((x) => x.id === id);
      if (!prop || prop.status !== 'open') throw new Error(`No open proposal ${id}`);
      if (prop.kind === 'decision') {
        this.humanAppend({ type: 'decision.approved', ...this.stamp(s, null), payload: { id, title: prop.payload.title, rationale: prop.payload.rationale, fromProposal: id } });
        return { invalidatedApprovals: 0, staleReceipts: 0 };
      }
      const { statement, scope, prohibit, successCriteria } = prop.payload;
      const goal = { statement, scope: scope ?? s.goal?.scope, prohibit: prohibit ?? s.goal?.prohibit, successCriteria: successCriteria ?? s.goal?.successCriteria, ...overrides };
      const now = new Date();
      const invalidatedApprovals = [...s.approvals.values()].filter((a) => approvalView(a, now) === 'approved').length;
      const staleReceipts = s.receipts.filter((r) => r.goalVersion === s.goal?.version).length;
      this.human.setGoal(goal, id);
      return { invalidatedApprovals, staleReceipts };
    },
    rejectProposal: (id: string, note: string) => {
      const prop = this.state().proposals.find((x) => x.id === id);
      if (!prop || prop.status !== 'open') throw new Error(`No open proposal ${id}`);
      this.humanAppend({ type: prop.kind === 'goal' ? 'goal.rejected' : 'decision.rejected', payload: { id, note } });
    },
    recordDecision: (title: string, rationale: string) => {
      const s = this.state();
      this.humanAppend({ type: 'decision.approved', ...this.stamp(s, null), payload: { id: newId('dec'), title, rationale } });
    },
  };

  propose(kind: 'goal' | 'decision', payload: Record<string, unknown>, actor: Actor): string {
    const id = newId('prop');
    if (kind === 'goal') GoalContractSchema.partial().parse({ statement: payload.statement });
    this.store.append({ type: kind === 'goal' ? 'goal.proposed' : 'decision.proposed', actor, payload: { ...payload, id } });
    return id;
  }

  diffProposal(id: string): { field: string; current: unknown; proposed: unknown }[] {
    const s = this.state();
    const prop = s.proposals.find((x) => x.id === id);
    if (!prop) throw new Error(`No proposal ${id}`);
    if (prop.kind !== 'goal') return [{ field: 'decision', current: null, proposed: { title: prop.payload.title, rationale: prop.payload.rationale } }];
    return (['statement', 'scope', 'prohibit', 'successCriteria'] as const).flatMap((field) => {
      const proposed = prop.payload[field];
      if (proposed === undefined) return [];
      const current = s.goal?.[field] ?? null;
      return canonical(current) === canonical(proposed) ? [] : [{ field, current, proposed }];
    });
  }

  taskForSession(s: ProjectState, sessionId?: string): Task | null {
    const id = (sessionId && s.sessions.get(sessionId)) || s.activeTaskId;
    return id ? s.tasks.get(id) ?? null : null;
  }

  /** A session stays on the task it first saw, so a later activation elsewhere does not move its approvals. */
  bindSession(sessionId: string): string | null {
    const s = this.state();
    const existing = s.sessions.get(sessionId);
    if (existing) return existing;
    if (!s.activeTaskId) return null;
    this.store.append({ type: 'session.bound', actor: { kind: 'system', sessionId }, taskId: s.activeTaskId, payload: { sessionId, taskId: s.activeTaskId } });
    return s.activeTaskId;
  }

  private loadSnapshot(): Snapshot | undefined {
    if (!existsSync(this.snapshotPath)) return undefined;
    try { return JSON.parse(readFileSync(this.snapshotPath, 'utf8')); } catch { return undefined; }
  }

  private takeSnap(s: ProjectState, prev?: Snapshot): Snapshot {
    const snap = takeSnapshot(this.root, s.policy.observerIgnore, s.policy.maxObservedFiles, prev);
    snap.sentinels = hashSentinels(s.policy.sentinelPaths);
    if (s.policy.onMismatch === 'quarantine') this.saveBlobs(snap, prev);
    return snap;
  }

  /** Content-addressed copies let quarantine restore a file. Local only, and only in quarantine mode. */
  private saveBlobs(snap: Snapshot, prev?: Snapshot): void {
    mkdirSync(this.blobDir, { recursive: true });
    for (const [rel, e] of Object.entries(snap.files)) {
      if (prev?.files[rel]?.hash === e.hash || e.size > MAX_BLOB) continue;
      const target = join(this.blobDir, e.hash);
      if (!existsSync(target)) { try { copyFileSync(join(this.root, rel), target); } catch { /* vanished mid-scan */ } }
    }
  }

  currentDigest(): string {
    return snapshotDigest(this.takeSnap(this.state(), this.loadSnapshot()));
  }

  currentManifest(): VerificationManifest {
    const s = this.state();
    const snap = takeSnapshot(this.root, s.policy.observerIgnore, s.policy.maxObservedFiles, this.loadSnapshot());
    const out: VerificationManifest = {};
    for (const rel of Object.keys(snap.files)) {
      if (!matchesAny(rel, s.policy.verificationPaths)) continue;
      const entry = inspectVerificationFile(join(this.root, rel), rel);
      if (entry) out[rel] = entry;
    }
    return out;
  }

  quickIntegrity(): { ok: boolean; reason?: string } {
    const head = this.store.head();
    const w = this.witness.last();
    if (!head) return { ok: false, reason: 'Event log is empty' };
    if (!w) return { ok: false, reason: 'Witness file is missing' };
    if (w.seq > head.seq) return { ok: false, reason: `Log head ${head.seq} is behind witnessed event ${w.seq}: truncation or rollback` };
    const ev = this.store.eventAt(w.seq);
    if (!ev || ev.hash !== w.hash) return { ok: false, reason: `Event ${w.seq} differs from its witnessed hash` };
    return { ok: true };
  }

  verifyIntegrity(): IntegrityReport {
    const s = this.state();
    return verifyIntegrity(this.store, this.witness, s.approverKey, s.instance);
  }

  /**
   * Keeps the valid prefix, sets the damaged log aside and records the incident. Evidence and approvals after the
   * break are gone from the active log, which is the correct result: they can no longer be trusted.
   */
  static recover(root: string): { quarantined: string; keptEvents: number; problems: string[] } {
    const p = new Project(root);
    const report = p.verifyIntegrity();
    const dbPath = p.store.path;
    const incidentDir = join(p.stateDir, 'incidents', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(incidentDir, { recursive: true });
    const firstBad = report.firstBadSeq ?? ((p.store.head()?.seq ?? 0) + 1);
    const tmp = `${dbPath}.recovered`;
    rmSync(tmp, { force: true });
    p.store.exportPrefix(tmp, firstBad);
    const witnessEntries = p.witness.all();
    p.store.close();
    for (const ext of ['', '-wal', '-shm']) if (existsSync(dbPath + ext)) renameSync(dbPath + ext, join(incidentDir, `events.sqlite${ext}`));
    if (existsSync(p.witness.path)) copyFileSync(p.witness.path, join(incidentDir, 'witness.jsonl'));
    renameSync(tmp, dbPath);
    p.witness.replace(witnessEntries.filter((w) => w.seq < firstBad));
    const fresh = new Project(root);
    const kept = fresh.store.head()?.seq ?? 0;
    fresh.store.append({ type: 'integrity.incident', actor: { kind: 'system' }, payload: { problems: report.problems, firstBadSeq: firstBad, quarantined: incidentDir } });
    fresh.close();
    return { quarantined: incidentDir, keptEvents: kept, problems: report.problems };
  }

  preAction(input: PreActionInput): PreActionResult {
    if (input.sessionId) this.bindSession(input.sessionId);
    const initial = this.state();
    const actor: Actor = { kind: 'agent', runtime: input.runtime, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };

    let digest = initial.lastDigest;
    if (!input.skipObservation || !digest) {
      const prev = this.loadSnapshot();
      const snap = this.takeSnap(initial, prev);
      if (prev) {
        const drift = diffSnapshots(prev, snap);
        // Changes between actions came from outside any gate (a human, or a background process).
        if (changedPaths(drift).length) this.store.append({ type: 'workspace.drift', actor: { kind: 'system' }, ...this.stamp(initial, this.taskForSession(initial, input.sessionId)?.id ?? null), payload: drift });
      }
      writeAtomic(this.snapshotPath, JSON.stringify(snap));
      digest = snapshotDigest(snap);
    }
    const integrity = this.quickIntegrity();

    // One write transaction, so two parallel hooks cannot both spend a single-use approval.
    return this.store.tx(() => {
      const s = this.state();
      const task = this.taskForSession(s, input.sessionId);
      const req: ActionRequest = {
        runtime: input.runtime, tool: input.tool, effects: input.effects, opaque: input.opaque, coverage: input.coverage,
        cwd: input.cwd ?? this.root, inputFingerprint: sha256(canonical({ tool: input.tool, input: input.rawInput ?? null })), workspaceDigest: digest,
      };
      const now = new Date();
      const result = decide(s, task, req, this.root, this.features, now);
      if (!integrity.ok) {
        result.warnings.push(`Log integrity problem: ${integrity.reason}`);
        const gated = result.decision === 'request_approval' || result.verdicts.some((v) => v.approvalId);
        // A record that cannot be trusted cannot back an approval, so approval-gated actions fail closed.
        if (gated) {
          result.decision = 'deny';
          result.reasons = [`Approvals are suspended: ${integrity.reason}. A human must run \`agentontrack audit --recover\``];
          for (const v of result.verdicts) { if (v.approvalId) delete v.approvalId; }
        }
      }
      if (s.policy.efficiency.failureMemory) {
        const failed = s.failures.filter((f) => f.fingerprint === req.inputFingerprint && f.digest === digest && now.getTime() - new Date(f.ts).getTime() < s.policy.efficiency.failureTtlMs).at(-1);
        if (failed) result.warnings.push(`This exact call failed earlier with no file changes since: ${failed.summary}`);
      }

      const ev = this.store.append({
        type: 'action.requested', actor, ...this.stamp(s, task?.id ?? null),
        payload: {
          tool: input.tool, effects: normalizeEffects(this.root, req), decision: result.decision, reasons: result.reasons, verdicts: result.verdicts,
          assurance: result.assurance, coverage: input.coverage, opaque: input.opaque, inputFingerprint: req.inputFingerprint, workspaceDigest: digest, warnings: result.warnings,
        },
      });

      const approvalIds: string[] = [];
      if (result.decision === 'request_approval') {
        const seen = new Set<string>();
        for (const v of result.verdicts.filter((x) => x.decision === 'request_approval' && !seen.has(x.fingerprint))) {
          seen.add(v.fingerprint);
          // Duplicate requests reuse the live one, so retries do not pile up prompts.
          const pending = [...s.approvals.values()].find((a) => a.fingerprint === v.fingerprint && isPendingLive(a, now));
          const id = pending?.id ?? newId('apr');
          approvalIds.push(id);
          if (!pending) {
            this.store.append({
              type: 'approval.requested', actor, ...this.stamp(s, task?.id ?? null),
              payload: { id, fingerprint: v.fingerprint, effect: v.effect, reason: v.reason, runtime: input.runtime, requestSeq: ev.seq, pendingExpiresAt: new Date(now.getTime() + s.policy.pendingTtlMs).toISOString() },
            });
          }
        }
      } else if (result.decision === 'allow') {
        for (const id of new Set(result.verdicts.map((v) => v.approvalId).filter((x): x is string => !!x))) {
          this.store.append({ type: 'approval.consumed', actor: { kind: 'system' }, ...this.stamp(s, task?.id ?? null), payload: { id, requestSeq: ev.seq } });
        }
      }
      return { ...result, seq: ev.seq, taskId: task?.id ?? null, approvalIds };
    });
  }

  /** Compares what changed on disk with what the action was authorized to do. */
  postAction(input: { runtime: string; sessionId?: string; tool: string; effects: Effect[]; cwd?: string; result?: unknown; skipObservation?: boolean }): PostActionResult {
    if (input.skipObservation) return { mismatches: [], undeclared: [], truncated: false, reverted: [] };
    const s = this.state();
    const task = this.taskForSession(s, input.sessionId);
    const actor: Actor = { kind: 'agent', runtime: input.runtime, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    const prev = this.loadSnapshot() ?? { files: {}, truncated: false };
    const snap = this.takeSnap(s, prev);
    writeAtomic(this.snapshotPath, JSON.stringify(snap));
    const diff = diffSnapshots(prev, snap);
    const declared = new Set(input.effects.filter((e) => e.kind.startsWith('fs.')).map((e) => resolveInRoot(this.root, input.cwd ?? this.root, e.target).path));
    const declaredDirs = [...declared].map((d) => `${d}/**`);
    const undeclared: string[] = [];
    const mismatches: { path: string; reason: string }[] = [];
    if (this.features.effectObserver) {
      for (const path of changedPaths(diff)) {
        const isDeclared = declared.has(path) || matchesAny(path, declaredDirs);
        if (!isDeclared) undeclared.push(path);
        const issue = checkPathScope(s, path, true, this.features.goalBinding);
        // A declared out-of-scope write is fine only if a human approved that exact target.
        if (issue && !(isDeclared && this.approvedTarget(s, path))) mismatches.push({ path, reason: issue });
      }
      for (const [path, hash] of Object.entries(snap.sentinels ?? {})) {
        const before = prev.sentinels?.[path];
        if (before !== undefined && before !== hash && !declared.has(path)) mismatches.push({ path, reason: `sensitive file outside the project changed: ${path}` });
      }
    }
    const obs = this.store.append({
      type: 'action.observed', actor, ...this.stamp(s, task?.id ?? null),
      payload: { tool: input.tool, diff, undeclared, truncated: snap.truncated, attribution: 'interval', resultSha256: input.result === undefined ? null : sha256(canonical(input.result)) },
    });
    const reverted: { path: string; how: string }[] = [];
    if (mismatches.length) {
      const ev = this.store.append({ type: 'effect.mismatch', actor: { kind: 'system' }, ...this.stamp(s, task?.id ?? null), payload: { tool: input.tool, mismatches, observedSeq: obs.seq } });
      if (s.policy.onMismatch === 'quarantine') {
        reverted.push(...this.revert(mismatches.map((m) => m.path), prev, diff, ev.seq));
        if (reverted.length) {
          this.store.append({ type: 'effect.reverted', actor: { kind: 'system' }, ...this.stamp(s, task?.id ?? null), payload: { mismatchSeq: ev.seq, reverted } });
          writeAtomic(this.snapshotPath, JSON.stringify(this.takeSnap(this.state(), this.loadSnapshot())));
        }
      }
    }
    return { mismatches, undeclared, truncated: snap.truncated, reverted };
  }

  /** Undoes project-file changes, keeping any removed copy. Sentinel files outside the root are reported only. */
  private revert(paths: string[], prev: Snapshot, diff: ReturnType<typeof diffSnapshots>, seq: number) {
    const out: { path: string; how: string }[] = [];
    const quarantineDir = join(this.stateDir, 'quarantine', String(seq));
    const moveAside = (rel: string) => {
      const dest = join(quarantineDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(this.root, rel), dest);
    };
    for (const rel of paths) {
      try {
        if (diff.added.includes(rel)) {
          moveAside(rel);
          unlinkSync(join(this.root, rel));
          out.push({ path: rel, how: 'new file moved to quarantine' });
        } else if (diff.modified.includes(rel) || diff.deleted.includes(rel)) {
          const blob = prev.files[rel] && join(this.blobDir, prev.files[rel]!.hash);
          if (!blob || !existsSync(blob)) { out.push({ path: rel, how: 'NOT reverted: no saved copy' }); continue; }
          if (diff.modified.includes(rel)) moveAside(rel);
          mkdirSync(dirname(join(this.root, rel)), { recursive: true });
          copyFileSync(blob, join(this.root, rel));
          out.push({ path: rel, how: 'restored previous content' });
        }
      } catch (err) {
        out.push({ path: rel, how: `NOT reverted: ${(err as Error).message}` });
      }
    }
    return out;
  }

  private approvedTarget(s: ProjectState, path: string): boolean {
    return [...s.approvals.values()].some((a) => a.status === 'granted' && !a.revoked && a.effect.target === path && a.goalVersion === (s.goal?.version ?? 0));
  }

  /**
   * Catches changes that no gate saw, which is what a host that fails open leaves behind: a missing hook program runs
   * the action with no event at all. It can only see files, so a push made that way stays invisible here.
   */
  private reconcile(s: ProjectState, taskId: string): void {
    const prev = this.loadSnapshot();
    if (!prev) return;
    const snap = this.takeSnap(s, prev);
    const diff = diffSnapshots(prev, snap);
    const paths = changedPaths(diff);
    if (!paths.length) return;
    this.store.append({ type: 'workspace.drift', actor: { kind: 'system' }, ...this.stamp(s, taskId), payload: { ...diff, foundAt: 'verify' } });
    const mismatches = paths.flatMap((path) => {
      const issue = checkPathScope(s, path, true, this.features.goalBinding);
      return issue ? [{ path, reason: `changed with no gate firing: ${issue}. The agent's hooks may be missing or untrusted` }] : [];
    });
    if (mismatches.length) this.store.append({ type: 'effect.mismatch', actor: { kind: 'system' }, ...this.stamp(s, taskId), payload: { tool: 'unobserved', mismatches } });
    writeAtomic(this.snapshotPath, JSON.stringify(snap));
  }

  /** Runs a criterion itself. An agent's own statement goes to evidence.claimed and never satisfies anything. */
  verifyTask(taskId: string): TaskEvaluation {
    const s = this.state();
    const task = s.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    this.reconcile(s, taskId);
    for (const c of task.criteria) {
      if (c.kind === 'human') continue;
      let passed = false;
      let observed = '';
      let outputSha256: string | undefined;
      const started = Date.now();
      if (c.kind === 'command') {
        const r = spawnSync(c.command ?? '', { cwd: this.root, shell: true, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        outputSha256 = sha256(out);
        passed = !r.error && r.status === c.expectExit;
        observed = redact(`exit=${r.status ?? 'none'}${r.error ? ` error=${r.error.message}` : ''}\n${out.slice(-2000)}`);
      } else if (c.kind === 'artifact') {
        const p = resolve(this.root, c.path ?? '');
        if (existsSync(p)) {
          const h = sha256(readFileSync(p));
          passed = !c.sha256 || c.sha256 === h;
          observed = `exists sha256=${h}`;
        } else observed = 'missing';
      }
      // Digest comes after the run, so files the check itself generated do not make its own receipt stale.
      this.store.append({
        type: 'evidence.recorded', actor: { kind: 'system' }, ...this.stamp(s, taskId),
        payload: { criterionId: c.id, passed, observed, source: 'independent-run', workspaceDigest: this.currentDigest(), durationMs: Date.now() - started, ...(c.command ? { command: c.command } : {}), ...(outputSha256 ? { outputSha256 } : {}) },
      });
    }
    // Files a check generated are not drift on the next verify.
    writeAtomic(this.snapshotPath, JSON.stringify(this.takeSnap(s, this.loadSnapshot())));
    return this.evaluate(taskId);
  }

  verificationFindings(taskId: string) {
    const task = this.state().tasks.get(taskId);
    return task ? compareManifests(task.verificationBaseline ?? {}, this.currentManifest()) : [];
  }

  evaluate(taskId: string): TaskEvaluation {
    const s = this.state();
    const ev = evaluateTask(s, taskId, this.currentDigest(), { ...this.features, findings: this.verificationFindings(taskId) });
    const task = s.tasks.get(taskId);
    const weak = task ? assessCriteria(task.criteria, this.root, s.policy.verificationPaths, Object.keys(takeSnapshot(this.root, s.policy.observerIgnore, s.policy.maxObservedFiles, this.loadSnapshot()).files)) : [];
    if (weak.length) {
      ev.weakCriteria = weak;
      const open = weak.filter((w) => !task?.weakAccepted?.includes(w));
      ev.reasons.push(...weak.map((w) => `Weak check${open.includes(w) ? '' : ' (accepted by a human)'}: ${w}`));
      if (open.length && ev.status === 'VERIFIED') {
        ev.status = 'IMPLEMENTED_UNVERIFIED';
        ev.reasons.push('VERIFIED is withheld until these checks are strengthened, or a human accepts them');
      }
    }
    return ev;
  }

  recordClaim(text: string, actor: Actor, taskId: string | null) {
    return this.store.append({ type: 'evidence.claimed', actor, taskId, payload: { text } });
  }

  recordFailure(input: { runtime: string; sessionId?: string; tool: string; rawInput?: unknown; summary: string }) {
    const s = this.state();
    this.store.append({
      type: 'action.failed', actor: { kind: 'agent', runtime: input.runtime }, ...this.stamp(s, this.taskForSession(s, input.sessionId)?.id ?? null),
      payload: { tool: input.tool, inputFingerprint: sha256(canonical({ tool: input.tool, input: input.rawInput ?? null })), summary: redact(input.summary).slice(0, 300), workspaceDigest: s.lastDigest },
    });
  }

  recordUsage(u: { runtime: string; model: string; source: 'provider-reported' | 'transcript-derived'; taskId?: string | null; sessionId?: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; costUsd?: number; costBasis?: string; durationMs?: number; runId?: string }) {
    const s = this.state();
    const taskId = u.taskId ?? this.taskForSession(s, u.sessionId)?.id ?? null;
    return this.store.append({ type: 'usage.recorded', actor: { kind: 'system', runtime: u.runtime }, ...this.stamp(s, taskId), payload: u });
  }

  /** Duplicate-read avoidance. Off by default: it saves tokens only if the earlier read is still in context. */
  checkRead(path: string): { duplicate: boolean; hash?: string } {
    const s = this.state();
    if (!s.policy.efficiency.dedupeReads) return { duplicate: false };
    const r = resolveInRoot(this.root, this.root, path);
    let hash: string;
    try { hash = sha256(readFileSync(resolve(this.root, r.path))); } catch { return { duplicate: false }; }
    const seen = s.reads.get(r.path);
    if (seen?.hash === hash) return { duplicate: true, hash };
    this.store.append({ type: 'context.read', actor: { kind: 'system' }, payload: { path: r.path, hash } });
    return { duplicate: false, hash };
  }

  resetContext() { this.store.append({ type: 'context.reset', actor: { kind: 'system' }, payload: {} }); }

  /** Compact state for a fresh or compacted context. It is built from the record, not from a model summary. */
  rehydrate(sessionId?: string): string {
    const s = this.state();
    const now = new Date();
    const lines = ['[AgentOnTrack state]'];
    if (!s.goal) lines.push('Goal: none approved.');
    else {
      lines.push(`Goal v${s.goal.version} (${s.goal.status}): ${s.goal.statement}`);
      const parts = [`Scope: ${s.goal.scope.include.join(', ')}`, ...(s.goal.scope.exclude.length ? [`excluded ${s.goal.scope.exclude.join(', ')}`] : []), ...(s.goal.prohibit.length ? [`prohibited ${s.goal.prohibit.join(', ')}`] : [])];
      lines.push(parts.join('; '));
    }
    const task = this.taskForSession(s, sessionId);
    if (task) {
      const ev = this.evaluate(task.id);
      lines.push(`Task ${task.id}: ${task.title} [${ev.status}]`);
      for (const c of ev.criteria) lines.push(`  - ${c.id}: ${c.state}`);
      for (const r of ev.reasons.filter((x) => !x.startsWith('Criterion'))) lines.push(`  ! ${r}`);
      for (const a of [...s.approvals.values()].filter((x) => x.taskId === task.id && isPendingLive(x, now))) lines.push(`  pending approval ${a.id}: ${a.effect.kind} ${a.effect.target}`);
    } else lines.push('Task: none active.');
    const words = new Set(`${s.goal?.statement ?? ''} ${task?.title ?? ''}`.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const relevant = s.decisions
      .map((d) => ({ d, score: `${d.title} ${d.rationale}`.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
      .sort((a, b) => b.score - a.score || b.d.ts.localeCompare(a.d.ts)).slice(0, 5);
    for (const { d } of relevant) lines.push(`Decision: ${d.title}: ${d.rationale}`);
    lines.push('Only a human can grant approvals or change the goal. Evidence, not your statement, decides completion.');
    return lines.join('\n');
  }

  prepareHandoff(fromRuntime: string, taskId?: string) {
    const s = this.state();
    const task = taskId ? s.tasks.get(taskId) : this.taskForSession(s);
    if (!task) throw new Error('No task to hand off');
    const ev = this.evaluate(task.id);
    const now = new Date();
    const handoff = {
      schema: 'agentontrack.handoff/v1', fromRuntime, createdAt: now.toISOString(), taskId: task.id, title: task.title,
      goal: s.goal, policyVersion: s.policyVersion, workspaceDigest: this.currentDigest(), status: ev.status, criteria: ev.criteria,
      outstanding: ev.reasons,
      approvalRefs: [...s.approvals.values()].filter((a) => a.taskId === task.id && approvalView(a, now) === 'approved').map((a) => a.id),
      requiredApprovals: [...s.approvals.values()].filter((a) => a.taskId === task.id && isPendingLive(a, now)).map((a) => ({ id: a.id, effect: a.effect })),
      decisions: s.decisions.slice(-5).map((d) => d.title),
      uncertainty: ['Approvals are references. The receiving runtime re-evaluates them; nothing is copied.', 'Evidence currency is rechecked against the receiving workspace.'],
    };
    this.store.append({ type: 'handoff.prepared', actor: { kind: 'agent', runtime: fromRuntime }, taskId: task.id, payload: { handoffSha256: sha256(canonical(handoff)) } });
    return handoff;
  }

  acceptHandoff(handoff: ReturnType<Project['prepareHandoff']>, toRuntime: string) {
    const s = this.state();
    const now = new Date();
    const approvals = handoff.approvalRefs.map((id) => {
      const a = s.approvals.get(id);
      if (!a) return { id, valid: false, reason: 'unknown approval' };
      const view = approvalView(a, now);
      if (view !== 'approved') return { id, valid: false, reason: view === 'consumed' ? 'no uses left' : view };
      if (a.goalVersion !== (s.goal?.version ?? 0)) return { id, valid: false, reason: `issued for goal v${a.goalVersion}, current is v${s.goal?.version}` };
      if (a.policyVersion !== s.policyVersion) return { id, valid: false, reason: 'policy changed' };
      if (a.runtime !== toRuntime && !a.portable) return { id, valid: false, reason: `bound to runtime ${a.runtime}` };
      return { id, valid: true, reason: 'still valid' };
    });
    const evaluation = this.evaluate(handoff.taskId);
    const result = { toRuntime, approvals, evaluation, goalChanged: handoff.goal?.version !== s.goal?.version, workspaceChanged: handoff.workspaceDigest !== this.currentDigest() };
    this.store.append({ type: 'handoff.accepted', actor: { kind: 'agent', runtime: toRuntime }, taskId: handoff.taskId, payload: result });
    return result;
  }
}
