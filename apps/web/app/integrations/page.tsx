import { readResult } from '../../lib/results';
import { Article } from '../content';
import { Catalog, type Entry } from './catalog';

export const metadata = { title: 'Integrations' };

export default function Integrations() {
  const data = readResult<{ entries: Entry[]; models: any[] }>('provider-certification.json');
  return (
    <Article title="Integrations" intro="An agent runtime and a model API are different things. A runtime has tools, hooks and sessions, and is what AgentOnTrack gates. A model API only answers. Each row says exactly what was run. All of it is self-run.">
      <h2 id="runtimes">Platforms</h2>
      <p>Only what was seen on the real program counts. A scripted model means the real program, hooks and shell, with planned tool calls, which tests the host and the gate, not how a model behaves. Blocked means it needs an account or paid plan we do not have, so it has <b>not</b> been shown to work. Connection status for your own machine is on the <a href="../dashboard/">dashboard</a>, in Agents. Names are shown as text, since these products' logos belong to their owners, and this project is not affiliated with any of them.</p>
      {data ? <Catalog entries={data.entries} /> : <p>Unavailable</p>}

      <h2 id="models">Model API connectivity</h2>
      <p>This is about what the agent talks to. It says nothing about enforcement, which comes from the runtime in front of the model.</p>
      <div className="table-wrap" tabIndex={0}><table data-testid="model-table">
        <thead><tr><th scope="col">Model source</th><th scope="col">Reached through</th><th scope="col">What was run</th></tr></thead>
        <tbody>
          <tr><th scope="row">Anthropic, Claude Haiku</th><td>Claude Code's own login</td><td>Real runs and the matched benchmark. No other Claude model was benchmarked</td></tr>
          <tr><th scope="row">OpenAI hosted models</th><td>Codex</td><td>Not tested: needs a login the owner has not provided</td></tr>
          <tr><th scope="row">Hermes hosted models</th><td>Hermes</td><td>Not tested: needs a login the owner has not provided</td></tr>
          {(data?.models ?? []).map((m: any) => <tr key={m.name}><th scope="row">{m.name}</th><td>{m.through}</td><td>{m.result}</td></tr>)}
        </tbody>
      </table></div>
      <p><code>agentontrack probe &lt;url&gt;</code> tests what an endpoint actually does.</p>

      <h2>MCP</h2>
      <p>A local stdio MCP server exposes project state, proposals and handoffs. It has no approval, policy or shell tool. MCP is not the security boundary: the hooks are.</p>
    </Article>
  );
}
