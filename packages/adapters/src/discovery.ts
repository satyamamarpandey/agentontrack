import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a model name came from. None of these says the person may USE the model: a name seen in a config file or a past run is a fact about
 * this computer, and a plan or entitlement can change without it. `entitlement` is therefore always 'unknown' unless a run actually used it.
 */
export type ModelSource = 'used-in-a-run' | 'runtime-default' | 'configured' | 'listed-by-local-server' | 'entered-by-user';

export interface ModelEntry {
  id: string;
  agent: string;
  source: ModelSource;
  /** What is known about whether it works: only "worked" when a recorded run used it. */
  entitlement: 'worked' | 'unknown';
  note: string;
}

export interface AgentEntry {
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean | null;
  canStart: boolean;
  /** One word for the picker: ready, needs-setup, terminal-only, missing. */
  status: 'ready' | 'needs-setup' | 'terminal-only' | 'missing';
  reason: string | null;
  /** Commands this runtime reported itself (for example in its session init). Never guessed. */
  commands: string[];
  commandsSource: 'reported-by-runtime' | 'not-reported';
}

export interface Seen { agent: string; model: string; worked: boolean }
export interface InitReport { agent: string; model: string | null; commands: string[]; at: number }

const clean = (s: unknown): string | null => (typeof s === 'string' && /^[\w][\w.:/@+-]{0,99}$/.test(s) ? s : null);

/** The model line of Codex's config, read as text. Nothing else in that file is read. */
export function codexConfiguredModel(home = homedir()): string | null {
  const f = join(home, '.codex', 'config.toml');
  if (!existsSync(f)) return null;
  const m = /^\s*model\s*=\s*"([^"\n]+)"/m.exec(readFileSync(f, 'utf8'));
  return clean(m?.[1]);
}

/** The model named in Claude Code's own settings file, if any. Credentials in that folder are never opened. */
export function claudeConfiguredModel(home = homedir()): string | null {
  const f = join(home, '.claude', 'settings.json');
  if (!existsSync(f)) return null;
  try { return clean(JSON.parse(readFileSync(f, 'utf8')).model); } catch { return null; }
}

/** Asks a local model server what it has loaded. Loopback only, so no prompt or code could leave this computer. */
export async function localServerModels(fetchImpl: typeof fetch = fetch, bases = ['http://127.0.0.1:11434', 'http://127.0.0.1:1234']): Promise<{ base: string; models: string[] }[]> {
  const out: { base: string; models: string[] }[] = [];
  for (const base of bases) {
    try {
      const ollama = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (ollama.ok) { out.push({ base, models: ((await ollama.json() as any).models ?? []).map((m: any) => clean(m.name)).filter(Boolean) }); continue; }
    } catch { /* not Ollama, or not running */ }
    try {
      const r = await fetchImpl(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) out.push({ base, models: ((await r.json() as any).data ?? []).map((m: any) => clean(m.id)).filter(Boolean) });
    } catch { /* nothing listening */ }
  }
  return out;
}

export interface DiscoverInput {
  seen: Seen[];
  inits: InitReport[];
  home?: string;
  fetchImpl?: typeof fetch;
  localBases?: string[];
  /** Skip the network probe (tests, or a person who turned it off). */
  probeLocal?: boolean;
}

export async function discoverModels(i: DiscoverInput): Promise<ModelEntry[]> {
  const out = new Map<string, ModelEntry>();
  const add = (e: ModelEntry) => {
    const k = `${e.agent}\u0000${e.id}`;
    const have = out.get(k);
    // A model a run actually used outranks every other source for the same name.
    if (!have || (e.entitlement === 'worked' && have.entitlement !== 'worked')) out.set(k, e);
  };
  for (const s of i.seen) { const id = clean(s.model); if (id && s.worked) add({ id, agent: s.agent, source: 'used-in-a-run', entitlement: 'worked', note: 'A run on this computer used it successfully.' }); }
  for (const r of i.inits) { const id = clean(r.model); if (id) add({ id, agent: r.agent, source: 'runtime-default', entitlement: 'unknown', note: 'The runtime reported this as the model it started with. That does not show your plan allows others.' }); }
  const claude = claudeConfiguredModel(i.home); if (claude) add({ id: claude, agent: 'claude-code', source: 'configured', entitlement: 'unknown', note: 'Named in Claude Code’s settings on this computer.' });
  const codex = codexConfiguredModel(i.home); if (codex) add({ id: codex, agent: 'codex', source: 'configured', entitlement: 'unknown', note: 'Named in Codex’s config on this computer.' });
  if (i.probeLocal !== false) {
    for (const s of await localServerModels(i.fetchImpl, i.localBases)) for (const id of s.models) add({ id, agent: 'local-model', source: 'listed-by-local-server', entitlement: 'unknown', note: `Loaded in the server at ${s.base}. It is a model, not an agent: an agent program must be pointed at it.` });
  }
  return [...out.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id));
}

export interface RuntimeFact { id: string; name: string; installed: boolean; authenticated: boolean | null; canStart: boolean; reason: string | null }

export function describeAgents(runtimes: RuntimeFact[], inits: InitReport[]): AgentEntry[] {
  return runtimes.map((r) => {
    const init = inits.filter((x) => x.agent === r.id).sort((a, b) => b.at - a.at)[0];
    const status: AgentEntry['status'] = r.canStart ? 'ready' : !r.installed ? 'missing' : r.authenticated === false ? 'needs-setup' : /terminal/i.test(r.reason ?? '') ? 'terminal-only' : 'needs-setup';
    return { id: r.id, name: r.name, installed: r.installed, authenticated: r.authenticated, canStart: r.canStart, status, reason: r.reason, commands: init?.commands ?? [], commandsSource: init ? 'reported-by-runtime' : 'not-reported' };
  });
}
