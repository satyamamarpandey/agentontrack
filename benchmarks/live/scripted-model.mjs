// A model API that returns planned tool calls, so a REAL agent host, its REAL hooks and REAL OS sandbox can be tested
// reproducibly with no credentials. The agent program is real. The model is not, and every result says so:
// "real host, scripted model" is never reported as a live model test.
import { createServer } from 'node:http';

/** plan: list of { tool: RegExp, args: (toolName) => object }. After the plan, the model just answers in text. */
export async function startScriptedModel() {
  let plan = [];
  const seen = { requests: 0, toolResults: [], toolNames: new Set(), systemText: '' };
  const pick = (names) => {
    while (plan.length) {
      const step = plan[0];
      const name = names.find((n) => step.tool.test(n));
      plan.shift();
      if (name) return { name, args: step.args(name), id: `call_${Math.random().toString(36).slice(2, 10)}` };
      seen.toolResults.push(`PLANNED TOOL NOT OFFERED: ${step.tool} among ${names.join(',')}`);
    }
    return null;
  };
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? x.output ?? (typeof x.content === 'string' ? x.content : textOf(x.content ?? ''))).join(' ') : JSON.stringify(c ?? ''));
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [name, data] of events) res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    res.end();
  };
  const usage = { input_tokens: 10, output_tokens: 5 };

  const anthropic = (b, res) => {
    for (const m of b.messages ?? []) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'tool_result') seen.toolResults.push(textOf(c.content));
    const names = (b.tools ?? []).map((t) => t.name).filter(Boolean);
    names.forEach((n) => seen.toolNames.add(n));
    // Hosts make side requests with no tools, such as for titles. Those must not use up the plan.
    const call = names.length ? pick(names) : null;
    const id = `msg_${seen.requests}`;
    const content = call ? { type: 'tool_use', id: call.id, name: call.name, input: call.args } : { type: 'text', text: 'Finished.' };
    if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: b.model, content: [content], stop_reason: call ? 'tool_use' : 'end_turn', usage })); return; }
    sse(res, [
      ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, usage } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } : { type: 'text_delta', text: 'Finished.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  };

  const chat = (b, res) => {
    for (const m of b.messages ?? []) if (m.role === 'tool') seen.toolResults.push(textOf(m.content));
    const names = (b.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    names.forEach((n) => seen.toolNames.add(n));
    const call = names.length ? pick(names) : null;
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'Finished.' };
    const u = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: `c${seen.requests}`, object: 'chat.completion', model: b.model, choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: u })); return; }
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'Finished.' };
    sse(res, [
      ['', { id: `c${seen.requests}`, object: 'chat.completion.chunk', model: b.model, choices: [{ index: 0, delta, finish_reason: null }] }],
      ['', { id: `c${seen.requests}`, object: 'chat.completion.chunk', model: b.model, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: u }],
      ['', '[DONE]'],
    ]);
  };

  const responses = (b, res) => {
    for (const i of b.input ?? []) if (i.type === 'function_call_output' || i.type === 'custom_tool_call_output') seen.toolResults.push(textOf(i.output));
    // Codex groups MCP tools in a namespace, and a call names the namespace and the tool separately.
    const spaces = new Map();
    const names = (b.tools ?? []).flatMap((t) => (t.type === 'namespace' ? (t.tools ?? []).map((n) => { const full = `${t.name}/${n.name}`; spaces.set(full, { namespace: t.name, name: n.name }); return full; }) : [t.name ?? t.function?.name])).filter(Boolean);
    names.forEach((n) => seen.toolNames.add(n));
    const call = names.length ? pick(names) : null;
    const id = `resp_${seen.requests}`;
    const item = call ? { type: 'function_call', id: `fc_${call.id}`, call_id: call.id, ...(spaces.get(call.name) ?? { name: call.name }), arguments: JSON.stringify(call.args), status: 'completed' } : { type: 'message', id: `m_${seen.requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Finished.', annotations: [] }] };
    sse(res, [
      ['response.created', { type: 'response.created', response: { id, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } }],
    ]);
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.requests++;
      const url = req.url.split('?')[0];
      let b = {};
      try { b = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
      const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.endsWith('/models')) return ok({ object: 'list', data: [{ id: 'scripted', object: 'model', context_length: 200000 }] });
      if (url.endsWith('/count_tokens')) return ok({ input_tokens: 10 });
      if (url.endsWith('/messages')) return anthropic(b, res);
      if (url.endsWith('/chat/completions')) return chat(b, res);
      if (url.endsWith('/responses')) return responses(b, res);
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    setPlan: (p) => { plan = [...p]; seen.toolResults.length = 0; },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}

/** The shell tool's arguments differ by host. */
export const shellArgs = (command) => (name) => {
  if (name === 'exec_command') return { cmd: command };
  if (name === 'shell') return { command: ['bash', '-lc', command] };
  return { command };
};
export const SHELL = /^(Bash|terminal|shell|shell_command|exec_command)$/;
