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
/** Git settings that rename a command or change where a push goes. Setting one hides what a later git command does. */
const GIT_INDIRECT = /^(alias\.|url\.|remote\.|push\.|branch\.[^=]*\.(remote|pushremote)|include\.|includeif\.)/i;
/** Git settings that name a program git will run. */
const GIT_RUNS_PROGRAM = /^(core\.(sshcommand|fsmonitor|pager|editor|gitproxy|hookspath|askpass)|credential\.|protocol\.|diff\.[^=]*\.(command|textconv)|difftool\.|mergetool\.|merge\.[^=]*\.driver|filter\.|sequence\.editor|gpg\.|pager\.|sendemail\.|uploadpack\.|receive\.|init\.templatedir)/i;
/** Git's own commands. A verb outside this list is an alias or an extension, so what it does cannot be read from the command. */
const KNOWN_GIT = new Set(['', 'add', 'am', 'apply', 'archive', 'bisect', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fast-export', 'fast-import', 'fetch', 'filter-branch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'hash-object', 'help', 'init', 'interpret-trailers', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-tree', 'mergetool', 'mktag', 'mktree', 'mv', 'name-rev', 'notes', 'pack-objects', 'pack-refs', 'prune', 'pull', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'revert', 'rm', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-objects', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree']);
/** Programs whose effects are read from their arguments. Seen after an unknown wrapper (timeout 5 git push), they are still read. */
const KNOWN_HEADS = new Set(['git', 'hub', 'gh', 'npm', 'pnpm', 'yarn', 'cargo', 'twine', 'gem', 'docker', 'podman', 'curl', 'wget', 'scp', 'sftp', 'ssh', 'rsync', 'rclone', 'gsutil', 's3cmd', 'azcopy', 'ftp', 'tftp', 'nc', 'ncat', 'netcat', 'socat', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'aws', 'gcloud', 'az', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'serverless', 'sls', 'bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd', 'sendmail', 'mail', 'mailx', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'bitsadmin', 'psql', 'mysql', 'agentontrack', 'aot']);
/** The program a token names: no folder, lower case, and no Windows suffix, so that git.exe is git. */
const headOf = (tok: string) => tok.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
/** PowerShell's -EncodedCommand is base64 of UTF-16LE text. Returns the text, or null if it is not readable text. */
function decodePowerShell(b64: string | undefined): string | null {
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  const text = Buffer.from(b64, 'base64').toString('utf16le');
  return text.length > 0 && [...text].every((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && c !== 0xfffd); }) ? text : null;
}
const OPAQUE_RUNNERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'make', 'npx', 'tsx']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh']);
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
  const cmd = headOf(t[0]);
  const rest = t.slice(1);
  const a = args(rest);
  const f = flags(rest);
  const line = rest.join(' ');
  const sub = (a[0] ?? '').toLowerCase();
  // xargs hands a program arguments nobody can read here: "echo push | xargs git" is a push.
  if (opaque && KNOWN_HEADS.has(cmd) && seg.tokens.some((x) => x.toLowerCase() === 'xargs')) { add('exec.dynamic'); return true; }

  if (SHELLS.has(cmd)) {
    const enc = cmd === 'powershell' || cmd === 'pwsh' ? rest.findIndex((x) => /^-(e|ec|en[a-z]*)$/i.test(x)) : -1;
    if (enc >= 0) {
      // Encoded text is decoded and read. Text that cannot be read is held: it exists to hide what runs.
      const text = decodePowerShell(rest[enc + 1]);
      if (!text) { add('exec.dynamic'); return true; }
      out.push(...classifyCommand(text).effects);
      add('exec.opaque');
      return true;
    }
    const i = rest.findIndex((x) => /^-(\w*c|command|co[a-z]*)$/i.test(x));
    if (seg.pipedFrom && seg.text && i < 0) { add('install.script'); return true; }
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
  if (cmd === 'cmd') {
    // cmd /c "git push" is git push.
    const i = rest.findIndex((x) => /^\/[ck]$/i.test(x));
    if (i >= 0 && rest[i + 1]) out.push(...classifyCommand(rest.slice(i + 1).join(' ')).effects);
    add('exec.opaque');
    return true;
  }
  if (cmd === 'start-process' || cmd === 'saps' || cmd === 'start') {
    // Start-Process git -ArgumentList push is git push.
    const inner = rest.filter((x) => !/^-(filepath|argumentlist|args|wait|nonewwindow|verb|windowstyle|passthru|workingdirectory)$/i.test(x) && !/^\/(b|wait|min|max)$/i.test(x)).map((x) => x.replace(/,/g, ' ')).join(' ');
    if (inner) out.push(...classifyCommand(inner).effects);
    add('exec.opaque');
    return true;
  }
  if (OPAQUE_RUNNERS.has(cmd)) {
    add('exec.opaque');
    // npx npm publish runs npm publish.
    const k = cmd === 'npx' ? rest.findIndex((x) => KNOWN_HEADS.has(headOf(x))) : -1;
    if (k >= 0) classifySegment({ ...seg, tokens: rest.slice(k), redirects: [] }, cwdPrefix, out);
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
      // rsync to another computer (user@host:path, host:path or rsync://) sends files away. A single letter before the colon is a Windows drive.
      if (cmd === 'rsync' && last && (/^rsync:\/\//i.test(last) || /^[^\\/:]{2,}:/.test(last))) { add('net.upload'); return opaque; }
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
    case 'hub': case 'git': {
      // A variable can spell any subcommand, so nothing about this call can be trusted statically.
      const g = [...rest];
      let indirect = false;
      while (g[0]?.startsWith('-')) {
        if (g[0] === '-c' && GIT_INDIRECT.test(g[1] ?? '')) indirect = true;
        if ((g[0] === '-c' && GIT_RUNS_PROGRAM.test(g[1] ?? '')) || /^--(exec-path=|config-env)/.test(g[0])) { add('exec.opaque'); opaque = true; }
        g.splice(0, /^(-c|-C|--git-dir|--work-tree|--namespace|--config-env)$/.test(g[0]) ? 2 : 1);
      }
      const verb = (g[0] ?? '').toLowerCase();
      const ga = g.slice(1).filter((x) => !x.startsWith('-')).map((x) => x.toLowerCase());
      if (verb.includes('$') || verb.includes('%')) { add('exec.dynamic'); return true; }
      // An alias or a rewritten remote given on this command line can turn any verb into a push.
      if (indirect) { add('exec.dynamic'); return true; }
      // git push, and everything else that sends commits somewhere.
      if (verb === 'push' || verb === 'send-pack' || verb === 'http-push' || (['subtree', 'lfs', 'annex', 'flow'].includes(verb) && ga.includes('push'))
        || (verb === 'svn' && ga[0] === 'dcommit') || (verb === 'p4' && ga[0] === 'submit') || (verb === 'annex' && ['sync', 'copy', 'move', 'export'].includes(ga[0] ?? ''))) { add('vcs.push'); return opaque; }
      if (cmd === 'hub') {
        if (['pull-request', 'pr', 'issue'].includes(verb)) { add('message.external'); return opaque; }
        if (['release', 'fork', 'create', 'delete', 'gist'].includes(verb)) { add('publish'); return opaque; }
        if (['api', 'sync', 'ci-status'].includes(verb)) { add('net.upload'); return opaque; }
      }
      if (verb === 'send-email' || verb === 'imap-send') { add('message.external'); return opaque; }
      if (verb === 'config') {
        const reading = g.slice(1).some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--unset|--unset-all|get|list|unset)$/.test(x));
        const keys = g.slice(1).filter((x) => !x.startsWith('-') && !['set', 'add'].includes(x));
        // "git config alias.p push" defines a command; "git config remote.origin.url X" moves a push.
        if (!reading && keys.length > 1 && GIT_INDIRECT.test(keys[0]!)) { add('exec.dynamic'); return true; }
        if (!reading && keys.length > 1 && GIT_RUNS_PROGRAM.test(keys[0]!)) { add('exec.opaque'); add('vcs.local'); return true; }
      }
      // Pointing a remote somewhere else changes where an approved "git push origin" would go.
      if (verb === 'remote' && ['add', 'set-url', 'rename', 'set-branches'].includes(ga[0] ?? '')) { add('exec.dynamic'); return true; }
      // These run a command line of their own, which is read here as far as it can be.
      if ((verb === 'submodule' && ga[0] === 'foreach') || verb === 'filter-branch' || (verb === 'bisect' && ga[0] === 'run') || (verb === 'rebase' && g.some((x) => x === '-x' || x.startsWith('--exec'))) || verb === 'difftool' || verb === 'mergetool') {
        const inner = g.slice(1).filter((x) => !/^(foreach|run|-x|--exec|--recursive|-i|--interactive|--quiet|-q)$/.test(x)).map((x) => x.replace(/^--exec=/, '')).join(' ');
        if (inner) out.push(...classifyCommand(inner).effects.filter((e) => e.kind !== 'exec.opaque'));
        add('exec.opaque'); add('vcs.local');
        return true;
      }
      // Fetching through a program named on the command line runs that program.
      if (g.some((x) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(x))) { add('exec.dynamic'); return true; }
      // Not one of git's own commands: an alias from the person's configuration, or an extension. It may push.
      if (!KNOWN_GIT.has(verb) && !READ_ONLY_GIT.has(verb)) { add('exec.dynamic'); return true; }
      if ((verb === 'reset' && g.includes('--hard')) || verb === 'clean' || (verb === 'checkout' && g.includes('--')) || verb === 'restore') { add('vcs.discard'); return opaque; }
      if (READ_ONLY_GIT.has(verb)) return opaque;
      add('vcs.local');
      return opaque;
    }
    case 'gh': {
      const group = (a[0] ?? '').toLowerCase();
      const act = (a[1] ?? '').toLowerCase();
      const reads = ['view', 'list', 'status', 'diff', 'checks', 'watch', 'download', 'clone', 'checkout', 'ls', 'logs'].includes(act);
      if (['', 'help', 'version', 'status', 'search', 'browse', 'completion'].includes(group)) return opaque;
      if (group === 'api') { add('net.upload'); return opaque; }
      if (group === 'auth' || group === 'secret') { add('credential'); return opaque; }
      if (['variable', 'ssh-key', 'gpg-key'].includes(group)) { if (!reads) add('credential'); return opaque; }
      if (reads) return opaque;
      if (group === 'repo' && act === 'sync') { add('vcs.push'); return opaque; }
      if (group === 'release' || group === 'gist' || group === 'repo') { add('publish'); return opaque; }
      if (['workflow', 'run', 'cache', 'codespace'].includes(group)) { add('deploy'); return opaque; }
      if (['issue', 'pr', 'label', 'project'].includes(group)) { add('message.external'); return opaque; }
      // gh alias and gh extension define new commands. Anything else not recognised here writes to GitHub.
      if (group === 'alias' || group === 'extension') { add('exec.dynamic'); return true; }
      add('net.upload');
      return opaque;
    }
    case 'npm': case 'pnpm': case 'yarn': case 'cargo': case 'twine': case 'gem':
      if (sub === 'publish' || (cmd === 'yarn' && sub === 'npm' && (a[1] ?? '').toLowerCase() === 'publish') || (cmd === 'twine' && sub === 'upload') || (cmd === 'gem' && sub === 'push')) { add('publish'); return opaque; }
      if (['login', 'adduser', 'token'].includes(sub) || (cmd === 'yarn' && sub === 'npm' && ['login', 'logout'].includes((a[1] ?? '').toLowerCase()))) { add('credential'); return opaque; }
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
      else if (/\b(deploy|update-function-code|sync|cp|mv|create|delete|upload|upload-batch|publish|push|put-\w+)\b/.test(line)) add('deploy');
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
    case 'ssh': case 'scp': case 'sftp': case 'ftp': case 'tftp': case 'nc': case 'ncat': case 'netcat': case 'socat': add('net.upload'); return opaque;
    case 'rclone': case 'gsutil': case 's3cmd': case 'azcopy':
      if (/\b(cp|copy|copyto|sync|mv|move|moveto|put|rsync|rm|delete|deletefile|purge)\b/.test(line)) add('net.upload'); else { add('exec.opaque'); return true; }
      return opaque;
    case 'bitsadmin': add(/\/upload/i.test(line) ? 'net.upload' : 'net.fetch'); return opaque;
    case 'certutil': if (/-urlcache/i.test(line)) add('net.fetch'); else { add('exec.opaque'); return true; } return opaque;
    case 'sendmail': case 'mail': case 'mailx': add('message.external'); return opaque;
    case 'curl': case 'wget': case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm': {
      if (PAYMENT.test(line)) { add('payment'); return opaque; }
      const upload = /(^|\s)(-d|--data\S*|-F|--form\S*|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|-Method\s+(Post|Put|Patch|Delete)|--post-\w+)(\s|=|$)/i.test(line);
      add(upload ? 'net.upload' : 'net.fetch');
      const o = rest.findIndex((x) => x === '-o' || x === '--output' || x === '-O' || x === '-OutFile');
      if (o >= 0 && rest[o + 1] && rest[o] !== '-O') addPath('fs.write', rest[o + 1]!);
      return opaque;
    }
    default: {
      add('exec.opaque');
      // An unknown wrapper in front of a known program (timeout 5 git push, sudo -u x npm publish): the program is still read.
      const k = t.findIndex((x, n) => n > 0 && KNOWN_HEADS.has(headOf(x)));
      if (k > 0) classifySegment({ ...seg, tokens: t.slice(k), redirects: [] }, cwdPrefix, out);
      return true;
    }
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
