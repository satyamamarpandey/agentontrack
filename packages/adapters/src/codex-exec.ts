/**
 * Codex through its documented non-interactive mode: `codex exec --json` prints one JSON event per line.
 * Written from the public docs (learn.chatgpt.com/docs/non-interactive-mode). Field names beyond thread.started, turn.completed usage
 * and item.{started,completed} were not confirmed verbatim, so the parser reads defensively and never invents a value.
 * Not yet run against a real Codex login: the capability contract keeps these as `unverified`.
 */
export interface CodexExecOptions { prompt: string; model?: string; resumeSessionId?: string; sandbox?: 'read-only' | 'workspace-write'; cwd?: string; /** Image files, passed with the documented --image flag. */ images?: string[] }

export type CodexEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; tool: 'shell' | 'file' | 'mcp' | 'web' | 'other'; summary: string; phase: 'started' | 'completed' }
  | { kind: 'usage'; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
  | { kind: 'error'; message: string }
  | { kind: 'turn'; status: 'started' | 'completed' | 'failed' };

const MODEL = /^\w[\w.:-]{0,79}$/;
const SESSION = /^[\w-]{8,80}$/;

/** Arguments after the program name. Never includes a bypass flag; the sandbox is workspace-write unless the caller narrows it. */
export function buildCodexExecArgs(o: CodexExecOptions): string[] {
  if (!o.prompt || o.prompt.startsWith('-')) throw new Error('A prompt cannot be empty or start with a hyphen');
  if (o.model !== undefined && !MODEL.test(o.model)) throw new Error('Not a model name');
  if (o.resumeSessionId !== undefined && !SESSION.test(o.resumeSessionId)) throw new Error('Not a session id');
  const args = ['exec'];
  if (o.resumeSessionId) args.push('resume');
  args.push('--json');
  if (o.model && o.model !== 'default') args.push('--model', o.model); // 'default' means Codex's own default: a ChatGPT sign-in rejects the literal name
  // `resume` is not documented to take the sandbox or working-directory flags, so they are set only on a fresh session.
  if (!o.resumeSessionId) args.push('--sandbox', o.sandbox ?? 'workspace-write');
  if (o.resumeSessionId) args.push(o.resumeSessionId);
  for (const img of o.images ?? []) { if (img.startsWith('-')) throw new Error('Not an image path'); args.push('--image', img); }
  args.push('--', o.prompt);
  return args;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toolOf(item: any): { tool: 'shell' | 'file' | 'mcp' | 'web' | 'other'; summary: string } {
  const t = str(item?.type);
  if (t === 'command_execution') return { tool: 'shell', summary: str(item.command).slice(0, 300) };
  if (t === 'file_change') return { tool: 'file', summary: Array.isArray(item.changes) ? item.changes.map((c: any) => str(c?.path)).filter(Boolean).join(', ').slice(0, 300) : 'file change' };
  if (t === 'mcp_tool_call') return { tool: 'mcp', summary: `${str(item.server)}/${str(item.tool)}`.slice(0, 300) };
  if (t === 'web_search') return { tool: 'web', summary: str(item.query).slice(0, 300) };
  return { tool: 'other', summary: t || 'item' };
}

/** One line of output to zero or one event. A line that is not JSON, or not an object, is not an event. */
export function parseCodexLine(line: string): CodexEvent | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  switch (o.type) {
    case 'thread.started': return SESSION.test(str(o.thread_id)) ? { kind: 'session', sessionId: o.thread_id } : null;
    case 'turn.started': return { kind: 'turn', status: 'started' };
    case 'turn.failed': return { kind: 'turn', status: 'failed' };
    case 'turn.completed': return o.usage && typeof o.usage === 'object'
      ? { kind: 'usage', inputTokens: num(o.usage.input_tokens), cachedInputTokens: num(o.usage.cached_input_tokens), outputTokens: num(o.usage.output_tokens), reasoningOutputTokens: num(o.usage.reasoning_output_tokens) }
      : { kind: 'turn', status: 'completed' };
    case 'error': return { kind: 'error', message: (str(o.message) || str(o.error?.message) || 'Codex reported an error').slice(0, 500) };
    case 'item.started': case 'item.completed': {
      const phase = o.type === 'item.started' ? 'started' : 'completed';
      if (o.item?.type === 'agent_message') return phase === 'completed' ? { kind: 'message', text: str(o.item.text).slice(0, 4000) } : null;
      if (o.item?.type === 'reasoning') return null;
      return { kind: 'tool', ...toolOf(o.item), phase };
    }
    default: return null;
  }
}

/** Splits a stream into lines across chunk boundaries. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines.filter((l) => l.trim());
  }
  flush(): string[] { const r = this.buf.trim() ? [this.buf] : []; this.buf = ''; return r; }
}

/** Reported usage for the record. The docs example shows cached_input_tokens as a part of input_tokens, so it is subtracted to match how Claude usage is recorded (input excludes cache). Cached input is kept apart from ordinary input, and nothing is priced: Codex reports no cost here. */
export function codexUsageRecord(u: Extract<CodexEvent, { kind: 'usage' }>, model: string) {
  const fresh = Math.max(0, u.inputTokens - u.cachedInputTokens);
  return { runtime: 'codex', model, source: 'provider-reported' as const, inputTokens: fresh, outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens, cacheCreationTokens: 0 };
}
