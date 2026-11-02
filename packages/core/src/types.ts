import * as z from 'zod/v4';

export const EFFECT_KINDS = [
  'fs.read', 'fs.write', 'fs.delete', 'fs.delete.recursive', 'vcs.local', 'vcs.discard', 'vcs.push',
  'exec.opaque', 'exec.dynamic', 'net.fetch', 'net.upload', 'install.script', 'deploy', 'publish', 'db.destructive',
  'credential', 'payment', 'message.external', 'policy.modify', 'self.tamper', 'mcp.call',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** `target` is a path for fs.* effects, otherwise the matched command or URL. */
export interface Effect {
  kind: EffectKind;
  target: string;
}

export const CriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['command', 'artifact', 'human']),
  command: z.string().optional(),
  path: z.string().optional(),
  sha256: z.string().optional(),
  expectExit: z.number().int().default(0),
  timeoutMs: z.number().int().positive().default(300_000),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const GoalContractSchema = z.object({
  statement: z.string().min(1),
  scope: z.object({
    include: z.array(z.string()).default(['**']),
    exclude: z.array(z.string()).default([]),
  }).prefault({}),
  prohibit: z.array(z.enum(EFFECT_KINDS)).default([]),
  successCriteria: z.array(z.string()).default([]),
});
export type GoalContract = z.infer<typeof GoalContractSchema>;

export const PolicySchema = z.object({
  approvalRequired: z.array(z.enum(EFFECT_KINDS)).default([
    'fs.delete.recursive', 'vcs.discard', 'vcs.push', 'net.upload', 'install.script', 'deploy', 'publish',
    'db.destructive', 'credential', 'payment', 'message.external', 'policy.modify', 'exec.dynamic',
  ]),
  denied: z.array(z.enum(EFFECT_KINDS)).default(['self.tamper']),
  protectedPaths: z.array(z.string()).default([
    '.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/id_rsa', '.claude/**', '.codex/**', '.hermes/**', '.cursor/**', '.github/hooks/**', '.github/copilot/**', '.gemini/**', '.devin/**', '.opencode/**', '.kiro/**', '.cline/**', '.clinerules/**', '.continue/**', '.roo/**', 'SAFETY.md', 'GOAL.md',
  ]),
  /** approval is the only preventive control for opaque code where no OS sandbox exists. */
  opaqueExec: z.enum(['allow', 'approval']).default('allow'),
  /** Exact commands a human trusts to run under opaqueExec=approval. They still run code the agent may have edited. */
  opaqueAllow: z.array(z.string()).default([]),
  /** quarantine undoes unauthorized file changes after the fact. That is reversal, not prevention. */
  onMismatch: z.enum(['report', 'quarantine']).default('report'),
  /** report tells the human and costs no model turn. block makes the agent correct a premature claim, at the price of an extra turn. */
  stopCheck: z.enum(['report', 'block']).default('report'),
  observerIgnore: z.array(z.string()).default([
    '.git/**', 'node_modules/**', '**/node_modules/**', 'dist/**', '**/dist/**', '.next/**', 'coverage/**', '**/*.tsbuildinfo',
  ]),
  verificationPaths: z.array(z.string()).default([
    '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go', 'test/**', 'tests/**', '**/__tests__/**',
    'package.json', '**/package.json', 'vitest.config.*', 'jest.config.*', 'pytest.ini', 'pyproject.toml', '.github/workflows/**', 'playwright.config.*',
  ]),
  /** Sensitive files outside the project, hashed before and after each non-read action. */
  sentinelPaths: z.array(z.string()).default([
    '~/.bashrc', '~/.zshrc', '~/.profile', '~/.gitconfig', '~/.ssh/config', '~/.ssh/authorized_keys', '~/.npmrc',
    '~/.claude/settings.json', '~/.codex/config.toml', '~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1', '~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
  ]),
  pendingTtlMs: z.number().int().positive().default(30 * 60_000),
  maxObservedFiles: z.number().int().positive().default(20_000),
  loopWarnAt: z.number().int().positive().default(3),
  loopDenyAt: z.number().int().positive().default(6),
  efficiency: z.object({
    dedupeReads: z.boolean().default(false),
    failureMemory: z.boolean().default(true),
    failureTtlMs: z.number().int().positive().default(60 * 60_000),
  }).prefault({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const POLICY_PROFILES: Record<string, Partial<Policy>> = {
  standard: {},
  /** Prevents all opaque code unless a human approved it or allow-listed the exact command. */
  strict: { opaqueExec: 'approval', onMismatch: 'quarantine' },
};

export const TaskLimitsSchema = z.object({
  maxActions: z.number().int().positive().optional(),
  maxElapsedMs: z.number().int().positive().optional(),
});

export type Decision = 'allow' | 'deny' | 'request_approval' | 'unsupported';

/** How much of the action the runtime and adapter could actually control. */
export type Coverage = 'enforced' | 'observed-only' | 'unavailable';

/**
 * enforced: a pre-action gate fired and static classification was complete.
 * partial: gate fired, but the action is opaque (effects can only be observed afterwards).
 * observed-only: no gate, only after-the-fact observation.
 * none: neither.
 */
export type Assurance = 'enforced' | 'partial' | 'observed-only' | 'none';

export type TaskStatus =
  | 'PLANNED' | 'IN_PROGRESS' | 'BLOCKED' | 'IMPLEMENTED_UNVERIFIED' | 'VERIFIED'
  | 'FAILED' | 'NEEDS_HUMAN_APPROVAL' | 'UNSUPPORTED' | 'UNKNOWN';

export type ActorKind = 'human' | 'agent' | 'system';
export interface Actor {
  kind: ActorKind;
  runtime?: string;
  sessionId?: string;
}

export const HUMAN_ONLY_EVENTS = new Set([
  'goal.approved', 'goal.rejected', 'goal.closed', 'goal.reopened', 'policy.set', 'approval.granted', 'approval.denied', 'approval.revoked',
  'task.created', 'task.activated', 'task.accepted', 'task.closed', 'mismatch.acknowledged', 'verification.accepted', 'team.set', 'weak.accepted', 'anchor.configured', 'approver.enrolled', 'decision.approved', 'decision.rejected',
]);

export interface StoredEvent {
  seq: number;
  ts: string;
  type: string;
  actor: Actor;
  taskId: string | null;
  goalVersion: number | null;
  policyVersion: number | null;
  payload: any;
  prevHash: string;
  hash: string;
}

/** Mechanisms that can be disabled for ablation experiments. All on in the product. */
export interface Features {
  goalBinding: boolean;
  effectObserver: boolean;
  staleEvidence: boolean;
  coverageAssurance: boolean;
  commandClassifier: boolean;
}
export const ALL_FEATURES: Features = {
  goalBinding: true, effectObserver: true, staleEvidence: true, coverageAssurance: true, commandClassifier: true,
};
