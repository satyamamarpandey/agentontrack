import { Article } from '../content';

export const metadata = { title: "Features" };

export default function Features() {
  return (
    <Article title="Features" intro="What AgentOnTrack does today. Planned work is on the roadmap, not here.">
      <h2>Goals and tasks</h2><p>A versioned goal contract with scope, exclusions and prohibited effects. Agents can propose changes; only you can accept them.</p>
      <h2>Task-bound approvals</h2><p>Each approval covers one effect, for one task, goal version, policy version and runtime. They are single-use by default and expire. Unanswered requests lapse.</p>
      <h2>Effect checks</h2><p>After each action the workspace is compared with what was authorized. Strict mode requires approval for opaque programs and reverses unauthorized file changes.</p>
      <h2>Evidence receipts</h2><p>AgentOnTrack runs your acceptance checks itself. A task reaches VERIFIED only with current passing evidence, no unresolved unauthorized change and no unreviewed sign that tests were weakened.</p>
      <h2>A record you can check</h2><p>An append-only local log with a separate witness file and an optional passphrase-protected approver key. It is tamper-evident under stated assumptions. It is not immutable.</p>
      <h2>Efficiency aids</h2><p>Loop and budget limits, memory of failed commands, optional duplicate-read skipping, and compact restart context built from the record.</p>
      <h2>Local dashboard</h2><p>Goals, approvals, evidence, usage and safety for your projects, paired to your browser with a one-time code.</p>
    </Article>
  );
}
