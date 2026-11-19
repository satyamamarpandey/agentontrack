import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

/*
 * Starting an agent's own program with the person's arguments, a prompt among them. On Windows many of these programs are `.cmd` files, which
 * only cmd.exe can run, and cmd.exe reads `&`, `|`, `<`, `>`, `^`, `%` and `"` in an argument as its own syntax: a prompt containing
 * `" & calc & "` would run calc. So a shell is avoided wherever it can be, and where it cannot, every such character is escaped.
 *
 *   1. A real program (.exe, .com): started directly. No shell reads the arguments.
 *   2. An npm launcher (.cmd written by npm): the script it launches is found in it and started with Node directly. No shell.
 *   3. Any other .cmd or .bat: started through cmd.exe with each argument quoted and every special character escaped with a caret, twice,
 *      because a batch file that passes its arguments on has them read a second time.
 */

/** Where Windows would find this program: each PATH folder, with each extension PATHEXT lists. Null if it is nowhere. */
export function resolveOnWindows(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = isAbsolute(bin) || /[\\/]/.test(bin) ? [''] : pathVar.split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const base = d ? join(d, bin) : bin;
    if (extname(base) && existsSync(base)) return base;
    for (const e of exts) for (const ext of [e, e.toLowerCase()]) if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

/** The script an npm launcher starts, and the Node it would use, or null if this file is not one. */
export function npmShimTarget(shim: string): { node: string; script: string } | null {
  let text: string;
  try { text = readFileSync(shim, 'utf8'); } catch { return null; }
  // npm writes: "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
  const m = /"%_prog%"\s+"%dp0%\\([^"\r\n]+?)"\s+%\*/i.exec(text) ?? /"%~dp0\\?([^"\r\n]+?\.(?:c|m)?js)"\s+%\*/i.exec(text);
  if (!m) return null;
  const dir = dirname(shim);
  const script = join(dir, m[1]!);
  if (!existsSync(script)) return null;
  const beside = join(dir, 'node.exe');
  return { node: existsSync(beside) ? beside : process.execPath, script };
}

const META = /[()%!^"<>&|]/g;
/**
 * One argument as cmd.exe must be given it. First the rules of the program that finally receives it (backslashes before a quote doubled, the
 * quote escaped, trailing backslashes doubled, the whole in quotes), then a caret before every character cmd.exe treats specially, the quotes
 * included, so that cmd.exe never thinks it is inside or outside a quoted run. `passes` is how many times cmd.exe will read the line.
 */
export function cmdQuote(arg: string, passes = 2): string {
  let a = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  for (let i = 0; i < passes; i++) a = a.replace(META, '^$&');
  return a;
}

/** Starts the program and waits. Arguments are passed as given: nothing in them is read as shell syntax, on any system. */
export function spawnAgent(bin: string, args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<Buffer | string> {
  if (process.platform !== 'win32') return spawnSync(bin, args, opts);
  const env = (opts.env ?? process.env) as NodeJS.ProcessEnv;
  const found = resolveOnWindows(bin, env);
  if (!found) return spawnSync(bin, args, opts); // not found: let the system say so
  if (/\.(exe|com)$/i.test(found)) return spawnSync(found, args, opts);
  const shim = npmShimTarget(found);
  if (shim) return spawnSync(shim.node, [shim.script, ...args], opts);
  // A newline cannot be carried through cmd.exe at all: it ends the command.
  if (args.some((a) => /[\r\n]/.test(a))) return { pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null, error: new Error(`${bin} is started through a .cmd file on this computer, and an argument with a line break cannot be passed to one safely. Put the text on one line, or pass it in a file.`) } as unknown as SpawnSyncReturns<string>;
  const line = [found.replace(META, '^$&'), ...args.map((a) => cmdQuote(a, 2))].join(' ');
  return spawnSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}
