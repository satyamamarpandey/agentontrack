import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

/**
 * Optional settings and keys from a file named e.env. It is separate from the sign-in each agent keeps for itself: nothing here is needed to
 * use a Claude Code or Codex subscription, and a missing file or an empty value never stops anything from working.
 *
 * Safety rules, enforced by this module and its tests:
 *  - values are read into a private object and are never copied into process.env, so no child process inherits them by accident;
 *  - values never appear in JSON, in logs, in `inspect` output or in error messages, only the names and whether each is set;
 *  - a key is used only for the purpose written next to it in KEYS, and the paid-API keys reach an agent only when AOT_ALLOW_PAID_API is on;
 *  - a name that is not listed is ignored, so a stray line cannot set an arbitrary variable.
 */
export const KEYS = {
  AOT_ALLOW_PAID_API: { secret: false, purpose: 'Set to 1 to let agents use the API keys below and bill by use. Off unless set to 1.' },
  ANTHROPIC_API_KEY: { secret: true, purpose: 'Given to Claude Code only when AOT_ALLOW_PAID_API=1.' },
  OPENAI_API_KEY: { secret: true, purpose: 'Given to Codex only when AOT_ALLOW_PAID_API=1.' },
  GEMINI_API_KEY: { secret: true, purpose: 'Given to Gemini CLI only when AOT_ALLOW_PAID_API=1.' },
  OLLAMA_HOST: { secret: false, purpose: 'Address of a local Ollama server, if you use one. Default http://127.0.0.1:11434.' },
} as const;
export type EnvKey = keyof typeof KEYS;
const NAMES = new Set<string>(Object.keys(KEYS));

export class EnvConfig {
  readonly #values = new Map<string, string>();
  readonly unknown: string[] = [];
  readonly file: string | null;
  readonly loosePermissions: boolean;

  constructor(entries: Record<string, string>, file: string | null, loosePermissions = false) {
    for (const [k, v] of Object.entries(entries)) { if (NAMES.has(k)) { if (v !== '') this.#values.set(k, v); } else this.unknown.push(k); }
    this.file = file;
    this.loosePermissions = loosePermissions;
  }

  get(key: EnvKey): string | undefined { return this.#values.get(key); }
  isSet(key: EnvKey): boolean { return this.#values.has(key); }
  get allowPaidApi(): boolean { return this.#values.get('AOT_ALLOW_PAID_API') === '1'; }
  get ollamaHost(): string { return this.#values.get('OLLAMA_HOST') ?? 'http://127.0.0.1:11434'; }

  /** Extra environment for one agent. Only with paid API mode on, and only that agent's own key. */
  keysFor(agent: 'claude-code' | 'codex' | 'gemini'): NodeJS.ProcessEnv {
    if (!this.allowPaidApi) return {};
    const key = agent === 'claude-code' ? 'ANTHROPIC_API_KEY' : agent === 'codex' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
    const v = this.#values.get(key);
    return v ? { [key]: v } : {};
  }

  /** Names and whether each is set. Never a value. */
  describe(): { file: string | null; keys: { name: string; set: boolean; secret: boolean }[]; ignoredNames: string[]; loosePermissions: boolean } {
    return { file: this.file, keys: Object.entries(KEYS).map(([name, m]) => ({ name, set: this.#values.has(name), secret: m.secret })), ignoredNames: this.unknown, loosePermissions: this.loosePermissions };
  }

  toJSON() { return this.describe(); }
  toString() { return `EnvConfig(${[...this.#values.keys()].join(', ') || 'empty'})`; }
  [inspect.custom]() { return this.toString(); }
}

/** KEY=value lines. `#` starts a comment, a value may be quoted, `export ` is allowed. Anything else is skipped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

/** e.env in the working folder, else in the AgentOnTrack home. A path in AGENTONTRACK_ENV_FILE wins, and the value `none` turns the file off (tests use it). */
export function findEnvFile(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AGENTONTRACK_ENV_FILE === 'none') return null;
  const candidates = [env.AGENTONTRACK_ENV_FILE, join(cwd, 'e.env'), join(env.AGENTONTRACK_HOME ?? join(homedir(), '.agentontrack'), 'e.env')].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

export function loadEnvFile(file: string | null = findEnvFile()): EnvConfig {
  if (!file || !existsSync(file)) return new EnvConfig({}, null);
  let loose = false;
  // On POSIX, a file readable by others is worth a warning. Windows permissions are set when the file is created and cannot be judged from the mode bits.
  if (process.platform !== 'win32') { try { loose = (statSync(file).mode & 0o077) !== 0; } catch { /* unreadable: treated as empty below */ } }
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return new EnvConfig({}, file, loose); }
  return new EnvConfig(parseEnv(text), file, loose);
}
