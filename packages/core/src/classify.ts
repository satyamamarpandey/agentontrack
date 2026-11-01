import type { Effect, EffectKind } from './types.js';

/**
 * Best-effort static classification of a shell command. It cannot determine every side effect:
 * anything it does not recognise becomes exec.opaque, and the observer checks effects afterwards.
 */
export interface Classification {
  effects: Effect[];
  /** True when the command contains something whose effects static analysis cannot see. */
  opaque: boolean;
}

interface Segment { text: string; tokens: string[]; redirects: string[]; pipedFrom: boolean }

/** Removes heredoc bodies: they are data for the command, not commands. Literal quoted bodies cannot run anything. */
function stripHeredocs(command: string): { text: string; dynamicBody: boolean } {
  const lines = command.split('\n');
  const out: string[] = [];
  let dynamicBody = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g, ''));
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== m[2]) {
        // An unquoted heredoc expands $(...) and backticks, so that part is still code.
        if (!m[1] && /\$\(|`/.test(lines[j]!)) dynamicBody = true;
        j++;
      }
      i = j;
    }
  }
  return { text: out.join('\n'), dynamicBody };
}

function lex(command: string): { segments: Segment[]; substitution: boolean } {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let redirects: string[] = [];
  let cur = '';
  let has = false;
  let text = '';
  let quote: string | null = null;
  let substitution = false;
  let pipedFrom = false;
  let expectRedirect = false;

  const endToken = () => {
    if (!has) return;
    if (expectRedirect) { redirects.push(cur); expectRedirect = false; } else tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endToken();
    if (tokens.length || redirects.length) segments.push({ text: text.trim(), tokens, redirects, pipedFrom });
    tokens = [];
    redirects = [];
    text = '';
    pipedFrom = nextPiped;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      text += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) { cur += command[++i]; text += command[i]; }
      else {
        if (quote === '"' && (c === '`' || (c === '$' && command[i + 1] === '('))) substitution = true;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; text += c; continue; }
    if (c === '\\' && i + 1 < command.length && command[i + 1] !== '\n') {
      cur += command[++i]; has = true; text += c + command[i];
      continue;
    }
    if (c === '`' || (c === '$' && command[i + 1] === '(') || ((c === '<' || c === '>') && command[i + 1] === '(')) substitution = true;
    if (c === ';' || c === '\n' || c === '(' || c === ')') { endSegment(false); continue; }
    if (c === '&') {
      if (command[i + 1] === '&') i++;
      else if (command[i - 1] === '>' || command[i + 1] === '>') { text += c; continue; }
      endSegment(false);
      continue;
    }
    if (c === '|') {
      if (command[i + 1] === '|') { i++; endSegment(false); } else endSegment(true);
      continue;
    }
    if (c === '>') {
      // fd duplication such as 2>&1 is not a file write.
      if (/^\d$/.test(cur) && has) { cur = ''; has = false; }
      endToken();
      if (command[i + 1] === '>') { i++; text += c; }
      text += c;
      if (command[i + 1] === '&') { while (i + 1 < command.length && !/\s/.test(command[i + 1]!)) i++; continue; }
      expectRedirect = true;
      continue;
    }
    if (/\s/.test(c)) { endToken(); text += c; continue; }
    cur += c; has = true; text += c;
  }
  endSegment(false);
  return { segments, substitution };
}

const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'wc', 'pwd', 'echo', 'printf', 'which', 'where',
  'whoami', 'date', 'stat', 'od', 'xxd', 'hexdump', 'nl', 'rev', 'tac', 'seq', 'sleep', 'read', 'uname', 'hostname', 'realpath', 'readlink', 'cmp', 'md5sum', 'sha256sum', 'shasum', 'du', 'df', 'diff', 'sort', 'uniq', 'cut', 'tr', 'awk', 'true', 'false', 'test', 'file', 'basename', 'dirname',
  'get-childitem', 'get-content', 'select-string', 'get-location', 'select-object', 'where-object', 'measure-object', 'write-output', 'test-path',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep']);
const OPAQUE_RUNNERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'make', 'npx', 'tsx', 'pwsh.exe', 'cmd', 'cmd.exe']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh', 'powershell.exe']);
const PREFIXES = new Set(['sudo', 'command', 'time', 'nohup', 'nice', 'exec', 'env', 'xargs', 'busybox']);
const STATE_REF = /(^|[\\/\s"'=])\.agentontrack([\\/\s"']|$)/;
const SELF_CMD = /\b(agentontrack|aot)(\.js|\.cmd)?\b\s+(approve|deny|revoke|goal|policy|task|ack|accept|uninstall|dashboard|approver|audit|anchor|self)\b/i;
const PAYMENT = /api\.stripe\.com|api\.paypal\.com|api\.squareup\.com|api\.adyen\.com/i;

const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '}', '!']);
const SHELL_NOOPS = new Set(['done', 'fi', 'esac', 'for', 'in', 'select', 'case']);

const flags = (t: string[]) => t.filter((x) => x.startsWith('-'));
const args = (t: string[]) => t.filter((x) => !x.startsWith('-'));

function classifySegment(seg: Segment, cwdPrefix: string, out: Effect[]): boolean {
  let opaque = false;
  const add = (kind: EffectKind, target = seg.text) => out.push({ kind, target });
  const addPath = (kind: EffectKind, p: string) => add(kind, cwdPrefix && !/^([\\/~]|[a-zA-Z]:)/.test(p) ? `${cwdPrefix}/${p}` : p);

  for (const r of seg.redirects) {
    if (!/^\/dev\/(null|stdout|stderr)$/.test(r) && r.toLowerCase() !== 'nul') addPath('fs.write', r);
  }

  if (seg.tokens.some((x) => x.toLowerCase() === 'xargs')) { add('exec.opaque'); opaque = true; }
  let t = [...seg.tokens];
  while (t[0] && SHELL_KEYWORDS.has(t[0])) t.shift();
  if (t[0] && SHELL_NOOPS.has(t[0])) return opaque;
  while (t[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || PREFIXES.has(t[0].toLowerCase()) || (t[0].startsWith('-') && t.length > 1))) t.shift();
  if (!t[0]) return opaque;
  if (/[$%]/.test(t[0])) { add('exec.dynamic'); return true; }
  const cmd = t[0].replace(/^.*[\\/]/, '').toLowerCase();
  const rest = t.slice(1);
  const a = args(rest);
  const f = flags(rest);
  const line = rest.join(' ');
  const sub = (a[0] ?? '').toLowerCase();

  if (SHELLS.has(cmd)) {
    const i = rest.findIndex((x) => /^-(\w*c|command|encodedcommand|ec)$/i.test(x));
    if (seg.pipedFrom && seg.text && i < 0) { add('install.script'); return true; }
    if (i >= 0 && /^-(encodedcommand|ec)$/i.test(rest[i]!)) { add('exec.opaque'); return true; }
    if (i >= 0 && rest[i + 1]) {
      const inner = classifyCommand(rest.slice(i + 1).join(' '));
      out.push(...inner.effects);
      return inner.opaque;
    }
    add('exec.opaque');
    return true;
  }
  if (cmd === 'eval' || cmd === 'invoke-expression' || cmd === 'iex') {
    if (seg.pipedFrom) { add('install.script'); return true; }
    const inner = classifyCommand(rest.join(' '));
    out.push(...inner.effects);
    return true;
  }
  if (OPAQUE_RUNNERS.has(cmd)) {
    add('exec.opaque');
    return true;
  }
  if (READ_ONLY.has(cmd)) return opaque;

  switch (cmd) {
    case 'cd': case 'set-location': case 'pushd': case 'popd': return opaque;
    case 'rm': case 'del': case 'erase': case 'rmdir': case 'rd': case 'remove-item': case 'unlink': {
      const recursive = f.some((x) => /^-[a-z]*r/i.test(x) || /^--recursive$/i.test(x) || /^-recurse$/i.test(x) || /^\/s$/i.test(x)) || cmd === 'rmdir' || cmd === 'rd';
      for (const p of a) addPath(recursive ? 'fs.delete.recursive' : 'fs.delete', p);
      return opaque;
    }
    case 'mv': case 'move': case 'move-item': case 'ren': case 'rename-item':
      for (const p of a) addPath('fs.write', p);
      return opaque;
    case 'cp': case 'copy': case 'copy-item': case 'ln': case 'rsync': {
      const last = a[a.length - 1];
      if (last) addPath('fs.write', last);
      return opaque;
    }
    case 'touch': case 'mkdir': case 'md': case 'chmod': case 'chown': case 'new-item':
    case 'set-content': case 'add-content': case 'out-file': case 'clear-content': {
      const start = cmd === 'chmod' || cmd === 'chown' ? 1 : 0;
      const pathFlag = rest.findIndex((x) => /^-(path|filepath|literalpath)$/i.test(x));
      if (pathFlag >= 0 && rest[pathFlag + 1]) addPath('fs.write', rest[pathFlag + 1]!);
      else for (const p of a.slice(start, cmd.endsWith('-content') || cmd === 'out-file' ? start + 1 : undefined)) addPath('fs.write', p);
      return opaque;
    }
    case 'tee': for (const p of a) addPath('fs.write', p); return opaque;
    case 'sed':
      if (f.some((x) => x.startsWith('-i') || x === '--in-place')) for (const p of a.slice(1)) addPath('fs.write', p);
      return opaque;
    case 'dd': {
      const of = rest.find((x) => x.startsWith('of='));
      if (of) addPath('fs.write', of.slice(3));
      return opaque;
    }
    case 'find':
      if (rest.includes('-delete')) { add('fs.delete.recursive', a[0] ?? '.'); return opaque; }
      if (rest.some((x) => /^-(exec|execdir|ok)$/.test(x))) { add('exec.opaque'); return true; }
      return opaque;
    case 'git': {
      // A variable can spell any subcommand, so nothing about this call can be trusted statically.
      const g = [...rest];
      while (g[0]?.startsWith('-')) g.splice(0, /^(-c|-C|--git-dir|--work-tree|--namespace)$/.test(g[0]) ? 2 : 1);
      const verb = (g[0] ?? '').toLowerCase();
      if (verb.includes('$') || verb.includes('%')) { add('exec.dynamic'); return true; }
      if (verb === 'push') { add('vcs.push'); return opaque; }
      if ((verb === 'reset' && g.includes('--hard')) || verb === 'clean' || (verb === 'checkout' && g.includes('--')) || verb === 'restore') { add('vcs.discard'); return opaque; }
      if (READ_ONLY_GIT.has(verb)) return opaque;
      add('vcs.local');
      return opaque;
    }
    case 'gh': {
      const two = `${a[0] ?? ''} ${a[1] ?? ''}`.toLowerCase();
      if (['release create', 'repo create', 'release upload'].includes(two)) add('publish');
      else if (['issue create', 'issue comment', 'pr create', 'pr comment', 'pr merge', 'pr review'].includes(two)) add('message.external');
      else if (/^(auth|secret) /.test(two)) add('credential');
      else if (a[0] === 'api') add('net.upload');
      return opaque;
    }
    case 'npm': case 'pnpm': case 'yarn': case 'cargo': case 'twine': case 'gem':
      if (sub === 'publish' || (cmd === 'twine' && sub === 'upload') || (cmd === 'gem' && sub === 'push')) { add('publish'); return opaque; }
      if (['login', 'adduser', 'token'].includes(sub)) { add('credential'); return opaque; }
      if (['test', 'ls', 'list', 'view', 'outdated', 'audit', 'why'].includes(sub)) { add('exec.opaque'); return true; }
      add('exec.opaque');
      return true;
    case 'vercel': case 'netlify': case 'fly': case 'flyctl': case 'heroku': case 'serverless': case 'sls':
      if (/\b(deploy|--prod|release)\b/.test(line) || a.length === 0) add('deploy'); else add('exec.opaque');
      return opaque;
    case 'kubectl': case 'helm': case 'terraform': case 'tofu': case 'pulumi': case 'ansible-playbook':
      if (/\b(apply|delete|destroy|up|install|upgrade|rollout|replace|patch)\b/.test(line) || cmd === 'ansible-playbook') add('deploy');
      return opaque;
    case 'aws': case 'gcloud': case 'az':
      if (/\b(configure|auth|login)\b/.test(line)) add('credential');
      else if (/\b(deploy|update-function-code|sync|cp|create|delete|put-\w+)\b/.test(line)) add('deploy');
      return opaque;
    case 'docker': case 'podman':
      if (sub === 'push') add('publish');
      else if (sub === 'login') add('credential');
      else { add('exec.opaque'); return true; }
      return opaque;
    case 'psql': case 'mysql': case 'sqlite3': case 'mongosh': case 'sqlcmd':
      if (/\b(drop|truncate|delete\s+from|alter|update)\b/i.test(line)) add('db.destructive');
      else { add('exec.opaque'); return true; }
      return opaque;
    case 'prisma': case 'alembic': case 'flyway': case 'rails':
      if (/\b(migrate|upgrade|db:|push|reset)\b/.test(line)) add('db.destructive');
      return opaque;
    case 'ssh-keygen': case 'passwd': add('credential'); return opaque;
    case 'ssh': case 'scp': case 'sftp': case 'nc': case 'ncat': case 'netcat': case 'socat': add('net.upload'); return opaque;
    case 'sendmail': case 'mail': case 'mailx': add('message.external'); return opaque;
    case 'curl': case 'wget': case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm': {
      if (PAYMENT.test(line)) { add('payment'); return opaque; }
      const upload = /(^|\s)(-d|--data\S*|-F|--form\S*|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|-Method\s+(Post|Put|Patch|Delete)|--post-\w+)(\s|=|$)/i.test(line);
      add(upload ? 'net.upload' : 'net.fetch');
      const o = rest.findIndex((x) => x === '-o' || x === '--output' || x === '-O' || x === '-OutFile');
      if (o >= 0 && rest[o + 1] && rest[o] !== '-O') addPath('fs.write', rest[o + 1]!);
      return opaque;
    }
    default:
      add('exec.opaque');
      return true;
  }
}

export function classifyCommand(command: string): Classification {
  const effects: Effect[] = [];
  let opaque = false;
  if (STATE_REF.test(command) || SELF_CMD.test(command)) effects.push({ kind: 'self.tamper', target: command });
  const { text: withoutBodies, dynamicBody } = stripHeredocs(command);
  const { segments, substitution: sub0 } = lex(withoutBodies);
  const substitution = sub0 || dynamicBody;
  if (substitution) {
    opaque = true;
    effects.push({ kind: 'exec.opaque', target: command });
    for (const m of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) effects.push(...classifyCommand(m[1] ?? m[2] ?? '').effects);
  }
  let cwdPrefix = '';
  for (const seg of segments) {
    const head = seg.tokens[0]?.toLowerCase();
    if ((head === 'cd' || head === 'set-location') && seg.tokens[1]) {
      cwdPrefix = cwdPrefix && !/^([\\/~]|[a-zA-Z]:)/.test(seg.tokens[1]) ? `${cwdPrefix}/${seg.tokens[1]}` : seg.tokens[1];
      continue;
    }
    if (classifySegment(seg, cwdPrefix, effects)) opaque = true;
  }
  return { effects, opaque };
}
