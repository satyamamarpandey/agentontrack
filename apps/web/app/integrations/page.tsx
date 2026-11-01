import { Article } from '../content';

export const metadata = { title: 'Integrations' };

export default function Integrations() {
  return (
    <Article title="Integrations" intro="An agent runtime and a model API are different things. A runtime has tools, hooks and sessions, and is what AgentOnTrack gates. A model API only answers. Each row says exactly what was run. All of it is self-run.">
      <h2 id="runtimes">Agent runtimes</h2>
      <div className="table-wrap" tabIndex={0}><table data-testid="runtime-table">
        <thead><tr><th scope="col">Runtime</th><th scope="col">Where and with what</th><th scope="col">Gate held a real action</th><th scope="col">Approval path</th><th scope="col">If the hook cannot run</th><th scope="col">From this website</th><th scope="col">Result</th></tr></thead>
        <tbody>
          <tr><th scope="row">Claude Code 2.1.316</th><td>A Windows machine, Haiku, normal login, a real task</td><td>Yes</td><td>Yes, approve and deny</td><td>Fails closed with <code>onFailure: block</code>. Observed</td><td>Deployed site to a real run: passed</td><td>End to end verified</td></tr>
          <tr><th scope="row">Codex 0.166.0</th><td>A cloud runner, no login: a scripted model through every path, and small local models</td><td>Yes: the push was held</td><td>Yes: denied, then allowed once after approval</td><td><b>Fails open.</b> Observed. <code>agentontrack run codex</code> refuses to start if the hook is broken</td><td>Not connected. Starting Codex from the dashboard is not built</td><td>Gate verified on the real program. Not tested with OpenAI models</td></tr>
          <tr><th scope="row">Hermes 0.22.5</th><td>A cloud runner, no login: a scripted model through every path</td><td>Yes: with a scripted model. A small local model has not reached the gate</td><td>Yes: denied, then allowed once after approval, with a scripted model</td><td>Blocks, with <code>fail_closed: true</code>. Observed. Its default fails open</td><td>Not connected</td><td>Gate verified on the real program, with a scripted model only</td></tr>
        </tbody>
      </table></div>
      <p className="muted small">A scripted model means the real program, hooks, shell and sandbox, with planned tool calls. It tests the host and the gate, not how a model behaves. Forced compaction and resume: Claude Code only. MCP in the real host: Claude Code and Codex. On Hermes the server did not load in the test, so it is not observed. With a real small local model on a CPU-only runner, Claude Code and Codex each had a real push held. On Hermes the model never reached a push. An approval on one agent did not carry over to another, between real Codex and Hermes with a scripted model.</p>

      <h2 id="models">Model API connectivity</h2>
      <p>This is about what the agent talks to. It says nothing about enforcement, which comes from the runtime in front of the model.</p>
      <div className="table-wrap" tabIndex={0}><table data-testid="model-table">
        <thead><tr><th scope="col">Model source</th><th scope="col">Reached through</th><th scope="col">What was run</th></tr></thead>
        <tbody>
          <tr><th scope="row">Anthropic, Claude Haiku</th><td>Claude Code's own login</td><td>Real runs and the matched benchmark. No other Claude model was benchmarked</td></tr>
          <tr><th scope="row">OpenAI hosted models</th><td>Codex</td><td>Not tested: needs a login the owner has not provided</td></tr>
          <tr><th scope="row">Hermes hosted models</th><td>Hermes</td><td>Not tested: needs a login the owner has not provided</td></tr>
          <tr><th scope="row">Ollama, qwen2.5:3b</th><td>Claude Code, Codex and Hermes, and a direct probe</td><td>Probe passed: chat, usage and a tool call in one trial. Claude Code and Codex reached the gate with a push. Hermes did not</td></tr>
          <tr><th scope="row">LM Studio, vLLM, llama.cpp</th><td>Unavailable</td><td>Not tested</td></tr>
        </tbody>
      </table></div>
      <p><code>agentontrack probe &lt;url&gt;</code> tests what an endpoint actually does.</p>

      <h2>MCP</h2>
      <p>A local stdio MCP server exposes project state, proposals and handoffs. It has no approval, policy or shell tool. MCP is not the security boundary: the hooks are.</p>
    </Article>
  );
}
