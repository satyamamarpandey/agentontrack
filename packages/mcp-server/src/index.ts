import { approvalView, computeAnalytics, isPendingLive, Project, routeIntent } from '@agentontrack/core';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export { serveStdio } from '@modelcontextprotocol/server/stdio';

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Deliberately has no approve, policy or task-creation tool: a model must not be able to create its own
 * approval. It is not a security boundary by itself; the hooks are the gate. Project state is opened per
 * call, so startup has no side effects, which matters because auto-negotiating clients spawn it twice.
 */
export function createServer(root: string, runtime = 'mcp-client'): McpServer {
  const server = new McpServer({ name: 'agentontrack', version: '0.1.0' });
  const withProject = <T>(fn: (p: Project) => T): T => {
    const p = new Project(root);
    try { return fn(p); } finally { p.close(); }
  };
  const agent = { kind: 'agent' as const, runtime };

  server.registerTool('project.status', { description: 'Current goal, task, verified status and pending approvals', inputSchema: z.object({}) },
    async () => text(withProject((p) => {
      const s = p.state();
      const task = p.taskForSession(s);
      return {
        goal: s.goal, task: task ? { id: task.id, title: task.title, ...p.evaluate(task.id) } : null,
        pendingApprovals: [...s.approvals.values()].filter((a) => isPendingLive(a, new Date())).map((a) => ({ id: a.id, effect: a.effect })),
        openMismatches: s.mismatches.filter((m) => !m.acknowledged),
      };
    })));

  server.registerTool('goal.history', { description: 'All approved goal versions', inputSchema: z.object({}) },
    async () => text(withProject((p) => p.state().goals)));

  server.registerTool('evidence.list', { description: 'Evidence receipts and their currency for a task', inputSchema: z.object({ taskId: z.string().min(1) }) },
    async ({ taskId }) => text(withProject((p) => ({
      evaluation: p.evaluate(taskId),
      receipts: p.state().receipts.filter((r) => r.taskId === taskId).map(({ observed: _o, ...r }) => r),
    }))));

  server.registerTool('safety.coverage', { description: 'Assurance recorded for recent actions, including what was not enforced', inputSchema: z.object({}) },
    async () => text(withProject((p) => p.store.all().filter((e) => e.type === 'action.requested').slice(-50).map((e) => ({ seq: e.seq, tool: e.payload.tool, decision: e.payload.decision, assurance: e.payload.assurance })))));

  server.registerTool('goal.propose', { description: 'Propose a goal change. This has no effect until a human approves it with the CLI', inputSchema: z.object({ statement: z.string().min(1), rationale: z.string().optional() }) },
    async (input) => text(withProject((p) => ({ proposed: p.propose('goal', input, agent), effective: false }))));

  server.registerTool('decision.propose', { description: 'Propose an architecture or design decision for human review', inputSchema: z.object({ title: z.string().min(1), rationale: z.string().min(1) }) },
    async (input) => text(withProject((p) => ({ proposed: p.propose('decision', input, agent), effective: false }))));

  server.registerTool('evidence.claim', { description: 'Record a statement about progress. Claims never satisfy an acceptance criterion', inputSchema: z.object({ taskId: z.string().min(1), text: z.string().min(1) }) },
    async ({ taskId, text: claim }) => text(withProject((p) => ({ recorded: p.recordClaim(claim, agent, taskId).seq, countsAsEvidence: false }))));

  server.registerTool('handoff.prepare', { description: 'Prepare a portable handoff. Approvals are references, revalidated by the receiver', inputSchema: z.object({ taskId: z.string().optional() }) },
    async ({ taskId }) => text(withProject((p) => p.prepareHandoff(runtime, taskId))));

  server.registerTool('decisions.list', { description: 'Approved decisions, and proposals still open', inputSchema: z.object({}) },
    async () => text(withProject((p) => ({ approved: p.state().decisions, open: p.state().proposals.filter((x) => x.status === 'open').map((x) => ({ id: x.id, kind: x.kind, summary: x.payload.statement ?? x.payload.title })) }))));

  server.registerTool('approvals.list', { description: 'Approval requests and their state. Read only: approving needs a human outside this interface', inputSchema: z.object({}) },
    async () => text(withProject((p) => [...p.state().approvals.values()].filter((a) => !a.id.endsWith('_portable')).map((a) => ({ id: a.id, state: approvalView(a, new Date()), effect: a.effect, taskId: a.taskId })))));

  server.registerTool('usage.summary', { description: 'Token totals as recorded, with their source', inputSchema: z.object({}) },
    async () => text(withProject((p) => computeAnalytics(p).totals)));

  server.registerTool('runtime.diagnostics', { description: 'Record integrity and policy mode', inputSchema: z.object({}) },
    async () => text(withProject((p) => {
      const r = p.verifyIntegrity();
      return { integrityOk: r.ok, problems: r.problems, opaqueExec: p.state().policy.opaqueExec, onMismatch: p.state().policy.onMismatch, approverEnrolled: p.approverEnrolled() };
    })));

  server.registerTool('workflow.suggest', { description: 'Map a plain-language intention to a workflow. Suggests only', inputSchema: z.object({ intent: z.string().min(1).max(500) }) },
    async ({ intent }) => text(routeIntent(intent, runtime)));

  server.registerResource('current-state', 'agentontrack://state', { title: 'Project state', description: 'Goal, task and evidence summary', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: withProject((p) => p.rehydrate()) }] }));

  server.registerPrompt('safe-continuation', { description: 'Resume work from the recorded state', argsSchema: z.object({}) },
    async () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${withProject((p) => p.rehydrate())}\n\nContinue the task from this state. Do not treat stale criteria as passing. Ask the user for any approval you need.` } }] }));

  return server;
}
