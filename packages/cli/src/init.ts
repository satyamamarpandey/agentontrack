import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalView, findDrift, isPendingLive, type Project } from '@agentontrack/core';

const BEGIN = '<!-- agentontrack:begin (generated view; the record is authoritative) -->';
const END = '<!-- agentontrack:end -->';

const TEMPLATES: Record<string, string> = {
  'AGENTS.md': 'This project uses AgentOnTrack. Goals, approvals and completion status live in its local record.\nRun `agentontrack status` to see them. Only a human can grant approvals or change the goal.',
  'GOAL.md': 'No goal approved yet. Run `agentontrack goal set --file goal.json`.',
  'DECISIONS.md': 'No decisions recorded yet.',
  'EVALS.md': 'Acceptance criteria belong to tasks. Run `agentontrack verify` to produce evidence.',
  'SAFETY.md': 'Blocked and approval-gated actions are set by policy. Run `agentontrack doctor` to see what is and is not enforced.',
};

/** Views of the record. They are regenerated on request or after meaningful events, never per tool call. */
function renderFromRecord(p: Project): Record<string, string> {
  const s = p.state();
  const now = new Date();
  const out: Record<string, string> = {};
  if (s.goal) {
    out['GOAL.md'] = [`## Goal v${s.goal.version} (${s.goal.status})`, '', s.goal.statement, '', `- In scope: ${s.goal.scope.include.join(', ')}`, `- Excluded: ${s.goal.scope.exclude.join(', ') || 'none'}`, `- Prohibited: ${s.goal.prohibit.join(', ') || 'none'}`, ...s.goal.successCriteria.map((c) => `- Success: ${c}`)].join('\n');
  }
  if (s.decisions.length) {
    const title = (id: string | null) => s.decisions.find((x) => x.id === id)?.title ?? id ?? '';
    const lines = s.decisions.map((d) => `- **${d.title}** (${d.ts.slice(0, 10)}): ${d.rationale}${d.supersededBy ? ` _(replaced by "${title(d.supersededBy)}")_` : ''}`);
    const drift = findDrift(s);
    if (drift.length) lines.push('', '### Still following a replaced decision', ...drift.map((d) => `- ${d.kind} ${d.ref}: follows "${d.stale.title}"; now "${d.current.title}"`));
    out['DECISIONS.md'] = lines.join('\n');
  }
  if (s.plan) {
    const doc = s.plan.doc;
    const approved = s.plan.approvedSha === s.plan.sha;
    const head = `## Plan v${s.plan.version} (${approved ? 'approved' : 'not approved: nothing runs until a person approves exactly this content'})`;
    const phases = (doc.phases ?? []).flatMap((ph: any, n: number) => [
      `${n + 1}. **${ph.title}** (${ph.kind}${ph.agent ? `, ${ph.agent}` : ''}${ph.state && ph.state !== 'draft' ? `, ${ph.state}` : ''})`,
      ...(ph.dependsOn?.length ? [`   - waits for: ${ph.dependsOn.join(', ')}`] : []),
      ...(ph.acceptance ?? []).map((a: any) => `   - check: ${a.description}`),
    ]);
    out['PLAN.md'] = [head, '', `Goal: ${doc.goal}`, `Mode: ${doc.mode}`, '', ...phases].join('\n');
  }
  const tasks = [...s.tasks.values()];
  if (tasks.length) {
    out['EVALS.md'] = tasks.map((t) => {
      const ev = p.evaluate(t.id);
      return [`### ${t.title} [${ev.status}]`, ...t.criteria.map((c) => `- ${c.description}: ${ev.criteria.find((x) => x.id === c.id)?.state ?? 'missing'}`)].join('\n');
    }).join('\n\n');
  }
  const pending = [...s.approvals.values()].filter((a) => isPendingLive(a, now));
  const granted = [...s.approvals.values()].filter((a) => approvalView(a, now) === 'approved');
  out['SAFETY.md'] = [
    `Policy v${s.policyVersion}: opaque code ${s.policy.opaqueExec === 'approval' ? 'requires approval' : 'runs, and is checked afterwards'}; unauthorized file changes are ${s.policy.onMismatch === 'quarantine' ? 'reversed' : 'reported'}.`,
    `- Denied: ${s.policy.denied.join(', ')}`, `- Approval required: ${s.policy.approvalRequired.join(', ')}`, `- Protected paths: ${s.policy.protectedPaths.join(', ')}`,
    `- Pending approvals: ${pending.length}. Live approvals: ${granted.length}.`,
    'Run `agentontrack doctor` to see what is and is not enforced.',
  ].join('\n');
  return out;
}

export interface PlannedFile { path: string; action: 'create' | 'append-block' | 'update-block' | 'unchanged' | 'skip-unreadable'; preview: string; next: string }

/** Existing content is never overwritten. Only the marked block is ever ours. */
export function planProjectFiles(root: string, project?: Project): PlannedFile[] {
  const views = project ? renderFromRecord(project) : {};
  const files = { ...TEMPLATES, ...views };
  if (existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md'))) files['CLAUDE.md'] = 'This project uses AgentOnTrack. See AGENTS.md.';
  return Object.entries(files).map(([path, body]) => {
    const block = `${BEGIN}\n${body}\n${END}\n`;
    const abs = join(root, path);
    if (!existsSync(abs)) return { path, action: 'create' as const, preview: `+ ${block}`, next: block };
    let cur: string;
    try { cur = readFileSync(abs, 'utf8'); } catch (err) { return { path, action: 'skip-unreadable' as const, preview: (err as Error).message, next: '' }; }
    const start = cur.indexOf(BEGIN);
    const end = cur.indexOf(END);
    if (start >= 0 && end > start) {
      const next = `${cur.slice(0, start)}${block.trimEnd()}${cur.slice(end + END.length)}`;
      return { path, action: next === cur ? ('unchanged' as const) : ('update-block' as const), preview: `~ ${block}`, next };
    }
    return { path, action: 'append-block' as const, preview: `existing content kept; appending:\n+ ${block}`, next: `${cur.trimEnd()}\n\n${block}` };
  });
}

export function applyProjectFiles(root: string, plan: PlannedFile[]): { written: string[]; failed: { path: string; error: string }[] } {
  const written: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const f of plan) {
    if (f.action === 'unchanged' || f.action === 'skip-unreadable') continue;
    try {
      writeFileSync(join(root, f.path), f.next);
      written.push(f.path);
    } catch (err) {
      failed.push({ path: f.path, error: (err as Error).message });
    }
  }
  return { written, failed };
}

export const isDirectory = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
