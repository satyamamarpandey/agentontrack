// What AgentOnTrack knows about each platform that is not a live measurement: who makes it, where to get it, how it is reached.
// Every URL is the maker's own page or documentation. What has actually been run is NOT here: it is read from the recorded
// certification file, so this list cannot drift from the test record.

export type Group = 'Coding agents' | 'Editors' | 'Local models' | 'Research';
export type Kind = 'core' | 'adapter' | 'editor' | 'model' | 'research' | 'unsupported';

export interface Meta {
  id: string;
  /** The id in the certification record, when it has one. */
  cert?: string;
  name: string;
  maker: string;
  group: Group;
  kind: Kind;
  install: { url: string; label: string };
  /** How it is reached from here. */
  interfaces: string[];
  /** What a person does to connect it, in plain steps. */
  steps: string[];
  /** A command for a terminal step, when there is one. */
  command?: string;
  /** Only for model servers: the address they listen on by default. */
  baseUrl?: string;
  note?: string;
}

const hooks = (id: string) => `agentontrack install ${id}`;

export const CATALOG: Meta[] = [
  { id: 'claude-code', cert: 'claude-code', name: 'Claude Code', maker: 'Anthropic', group: 'Coding agents', kind: 'core', install: { url: 'https://docs.claude.com/en/docs/claude-code/overview', label: 'Install Claude Code' }, interfaces: ['Terminal', 'VS Code', 'Hooks', 'MCP'], steps: ['Install Claude Code and sign in with your own account.', 'Press Connect, to add AgentOnTrack\'s hook to this project.'] },
  { id: 'codex', cert: 'codex', name: 'Codex', maker: 'OpenAI', group: 'Coding agents', kind: 'core', install: { url: 'https://github.com/openai/codex', label: 'Install Codex' }, interfaces: ['Terminal', 'Hooks', 'MCP'], steps: ['Install Codex and sign in with your own account.', 'Press Connect, then start it with agentontrack run codex so the hook is checked first.'], command: 'agentontrack run codex' },
  { id: 'hermes', cert: 'hermes', name: 'Hermes', maker: 'Nous Research', group: 'Coding agents', kind: 'core', install: { url: 'https://github.com/NousResearch/hermes-agent', label: 'Install Hermes' }, interfaces: ['Terminal', 'Hooks', 'MCP (optional package)'], steps: ['Install Hermes.', 'Run the command below and add what it prints to Hermes\' own config. Keep fail_closed: true.'], command: hooks('hermes') },
  { id: 'cursor', cert: 'cursor', name: 'Cursor', maker: 'Anysphere', group: 'Editors', kind: 'adapter', install: { url: 'https://cursor.com/download', label: 'Download Cursor' }, interfaces: ['Editor', 'Terminal agent', 'Hooks'], steps: ['Install Cursor and sign in.', 'Run the command below in your project.'], command: hooks('cursor') },
  { id: 'copilot', cert: 'copilot', name: 'GitHub Copilot CLI', maker: 'GitHub', group: 'Coding agents', kind: 'adapter', install: { url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli', label: 'Install Copilot CLI' }, interfaces: ['Terminal', 'Hooks'], steps: ['Install Copilot CLI and sign in with GitHub.', 'Run the command below in your project.'], command: hooks('copilot') },
  { id: 'gemini', cert: 'gemini', name: 'Gemini CLI', maker: 'Google', group: 'Coding agents', kind: 'adapter', install: { url: 'https://geminicli.com/docs/get-started/installation/', label: 'Install Gemini CLI' }, interfaces: ['Terminal', 'Hooks', 'MCP'], steps: ['Install Gemini CLI and sign in.', 'Run the command below in your project.'], command: hooks('gemini') },
  { id: 'antigravity', name: 'Antigravity', maker: 'Google', group: 'Editors', kind: 'unsupported', install: { url: 'https://antigravity.google/docs/install/', label: 'Install Antigravity' }, interfaces: ['Editor'], steps: ['Antigravity documents hooks, but AgentOnTrack has no adapter for it yet, so it cannot be connected.'], note: 'No adapter has been built, so nothing has been run.' },
  { id: 'opencode', cert: 'opencode', name: 'OpenCode', maker: 'OpenCode', group: 'Coding agents', kind: 'adapter', install: { url: 'https://opencode.ai/', label: 'Install OpenCode' }, interfaces: ['Terminal', 'Plugins'], steps: ['Install OpenCode.', 'Run the command below in your project.'], command: hooks('opencode') },
  { id: 'cline', cert: 'cline', name: 'Cline', maker: 'Cline', group: 'Coding agents', kind: 'adapter', install: { url: 'https://docs.cline.bot/', label: 'Install Cline' }, interfaces: ['Terminal', 'VS Code', 'Hooks', 'MCP'], steps: ['Install the Cline CLI.', 'Run the command below in your project.'], command: hooks('cline') },
  { id: 'kiro', cert: 'kiro', name: 'Kiro', maker: 'Amazon', group: 'Editors', kind: 'adapter', install: { url: 'https://kiro.dev/', label: 'Get Kiro' }, interfaces: ['Editor', 'Terminal agent', 'Hooks'], steps: ['Install Kiro and sign in.', 'Run the command below in your project.'], command: hooks('kiro') },
  { id: 'continue', cert: 'continue', name: 'Continue', maker: 'Continue', group: 'Coding agents', kind: 'adapter', install: { url: 'https://docs.continue.dev/cli/quickstart', label: 'Install Continue' }, interfaces: ['Terminal', 'MCP'], steps: ['Install Continue.', 'Run the command below. It adds the project state over MCP only, with no enforcement.'], command: 'agentontrack mcp-config continue' },
  { id: 'devin', cert: 'devin', name: 'Devin for Terminal', maker: 'Cognition', group: 'Coding agents', kind: 'adapter', install: { url: 'https://docs.devin.ai/cli', label: 'Install Devin CLI' }, interfaces: ['Terminal', 'Hooks'], steps: ['Install the Devin CLI and sign in.', 'Run the command below in your project.'], command: hooks('devin') },
  { id: 'vscode', name: 'VS Code and compatible editors', maker: 'AgentOnTrack', group: 'Editors', kind: 'editor', install: { url: 'https://github.com/satyamamarpandey/agentontrack/releases/latest', label: 'Get the extension' }, interfaces: ['VS Code extension (.vsix)'], steps: ['Download agentontrack-vscode.vsix from the release page.', 'Run the command below, then Connect to the companion from the command palette.'], command: 'code --install-extension agentontrack-vscode.vsix', note: 'Tested in real VS Code. Cursor, Antigravity and other editors that install VS Code extensions are not tested.' },
  { id: 'ollama', name: 'Ollama', maker: 'Ollama', group: 'Local models', kind: 'model', install: { url: 'https://ollama.com/download', label: 'Download Ollama' }, interfaces: ['Local API'], baseUrl: 'http://127.0.0.1:11434', steps: ['Install Ollama and pull a model.', 'Check that it answers: Configure tests the address.'], note: 'A model server is not an agent. It has no tools, approvals or session state on its own.' },
  { id: 'lmstudio', name: 'LM Studio', maker: 'LM Studio', group: 'Local models', kind: 'model', install: { url: 'https://lmstudio.ai/', label: 'Download LM Studio' }, interfaces: ['Local API'], baseUrl: 'http://127.0.0.1:1234', steps: ['Install LM Studio, load a model and start its local server.', 'Check that it answers: Configure tests the address.'], note: 'A model server is not an agent. It has no tools, approvals or session state on its own.' },
  { id: 'llamacpp', name: 'llama.cpp', maker: 'ggml', group: 'Local models', kind: 'model', install: { url: 'https://github.com/ggml-org/llama.cpp', label: 'Get llama.cpp' }, interfaces: ['Local API'], baseUrl: 'http://127.0.0.1:8080', steps: ['Build or install llama.cpp and start llama-server with a model.', 'Check that it answers: Configure tests the address.'], note: 'A model server is not an agent. It has no tools, approvals or session state on its own.' },
  { id: 'vllm', name: 'vLLM', maker: 'vLLM project', group: 'Local models', kind: 'model', install: { url: 'https://docs.vllm.ai/en/latest/getting_started/installation/', label: 'Install vLLM' }, interfaces: ['Local API'], baseUrl: 'http://127.0.0.1:8000', steps: ['Install vLLM and serve a model.', 'Check that it answers: Configure tests the address.'], note: 'A model server is not an agent. It has no tools, approvals or session state on its own.' },
  { id: 'perplexity', cert: 'perplexity', name: 'Perplexity', maker: 'Perplexity', group: 'Research', kind: 'research', install: { url: 'https://docs.perplexity.ai/', label: 'Get a Perplexity API key' }, interfaces: ['API', 'MCP'], steps: ['Make an API key with Perplexity, on your own account.', 'Run the command below. The key stays in your own environment, and is never sent to AgentOnTrack\'s website.'], command: 'agentontrack research', note: 'Research answers are information. They count as no evidence that work is done.' },
];

export type Support = 'model' | 'verified-hooks' | 'observation' | 'mcp' | 'research' | 'partial' | 'untested' | 'unsupported';

/** The words a person sees for each recorded status. Nothing is upgraded on the way. */
export const SUPPORT: Record<Support, { label: string; help: string }> = {
  model: { label: 'Tested through agents', help: 'Used as the model behind an agent that AgentOnTrack governs. The server itself has no tools, approvals or session state.' },
  'verified-hooks': { label: 'Native hooks, verified', help: 'AgentOnTrack\'s gate runs before each action, tested on the real program.' },
  observation: { label: 'Observation only', help: 'Actions are recorded afterwards. Nothing is blocked before it runs.' },
  mcp: { label: 'MCP only', help: 'It can read project state and send proposals. Nothing it does is blocked or approved.' },
  research: { label: 'Research only', help: 'It answers questions. It cannot change your project through AgentOnTrack.' },
  partial: { label: 'Partly verified', help: 'Some of it ran on the real program. Read what is missing.' },
  untested: { label: 'Not tested', help: 'Written from the maker\'s documentation. Never run on the real program, so do not rely on it.' },
  unsupported: { label: 'Not supported', help: 'AgentOnTrack has no adapter for it.' },
};

export function supportOf(status: string | undefined, kind: Kind): Support {
  if (kind === 'unsupported') return 'unsupported';
  switch (status) {
    case 'NATIVE_ENFORCEMENT_VERIFIED': return 'verified-hooks';
    case 'OBSERVATION_VERIFIED': return 'observation';
    case 'MCP_VERIFIED': return 'mcp';
    case 'RESEARCH_API_VERIFIED': return 'research';
    case 'PARTIAL': return kind === 'research' ? 'research' : 'partial';
    default: return 'untested';
  }
}
