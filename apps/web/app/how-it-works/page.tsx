import { Article } from '../content';

export const metadata = { title: "How it works" };

export default function HowItWorks() {
  return (
    <Article title="How it works" intro="AgentOnTrack sits at the hook points your agent already offers. It does not proxy your model traffic.">
      <pre className="term" tabIndex={0}><code>{`Agent ──hook──▶ AgentOnTrack engine ──▶ allow / deny / needs approval
  │                  │
  │ runs the tool    ├─ append-only record ─ witness file
  ▼                  │
Workspace ◀─compare──┘
  ▲
Your checks ◀─ agentontrack verify ─▶ evidence receipt ─▶ status`}</code></pre>
      <h2>Before an action</h2><p>The adapter maps the tool call to effects, such as a file write, a push or a deployment. A pure decision function checks them against the goal, task, policy and any approval. No model is involved, and no network call is made.</p>
      <h2>After an action</h2><p>AgentOnTrack diffs the workspace, and hashes a short list of sensitive files outside it. Changes the action was not authorized to make become recorded mismatches.</p>
      <h2>Preventive versus retrospective</h2><p>A blocked action never ran. A detected action already happened. AgentOnTrack reports them separately. Commands it cannot analyse are marked opaque, which lowers the recorded assurance for that action.</p>
      <h2>Across restarts and agents</h2><p>State is rebuilt from the record, not from a model's summary. A handoff carries references to approvals, and the receiving agent re-checks them instead of copying them.</p>
    </Article>
  );
}
