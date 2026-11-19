// Arguments given to an agent's program must arrive exactly as written and must never be read as shell syntax. On Windows many agent
// programs are .cmd files that only cmd.exe can start, which is where a prompt containing `" & something & "` used to be run as a command
// (found by static analysis on 2026-11-19). The Windows cases need Windows; the quoting function itself is tested everywhere.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdQuote, npmShimTarget, resolveOnWindows, spawnAgent } from '../src/spawn-agent.js';

const HOSTILE = [
  'plain words',
  'a" & echo INJECTED> "%MARK%" & "b',
  'ends with a backslash\\',
  'a "quoted" word',
  '100% & more | less > out < in ^ caret (paren) !bang!',
  '%PATH% and %MARK%',
  'back\\slash\\"quote',
  '',
  "single 'quotes' stay",
  'unicode: naïve café',
];

let dir: string; let mark: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aot-spawn-')); mark = join(dir, 'injected.txt'); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp */ } });

/** A script that writes the arguments it received to a file, as JSON. */
const echoScript = () => { const f = join(dir, 'echo.js'); writeFileSync(f, `require('fs').writeFileSync(process.env.AOT_ARGS_OUT, JSON.stringify(process.argv.slice(2)));`); return f; };
const received = () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
const env = () => ({ ...process.env, AOT_ARGS_OUT: join(dir, 'args.json'), MARK: mark, PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` });

describe('the quoting for cmd.exe', () => {
  it('puts a caret before every character cmd.exe treats specially, the quotes included, once per time the line is read', () => {
    expect(cmdQuote('a&b', 1)).toBe('^"a^&b^"');
    expect(cmdQuote('a&b', 2)).toBe('^^^"a^^^&b^^^"');
    expect(cmdQuote('say "hi"', 1)).toBe('^"say \\^"hi\\^"^"');
    expect(cmdQuote('trailing\\', 1)).toBe('^"trailing\\\\^"');
    for (const a of HOSTILE) expect(cmdQuote(a, 1).replace(/\^./g, ''), a).not.toMatch(/[&|<>"%!()]/);
  });
});

describe.runIf(process.platform === 'win32')('on Windows, no argument is read as a command', () => {
  it('a plain .cmd file that passes its arguments on receives each one intact, and nothing is injected', () => {
    const script = echoScript();
    writeFileSync(join(dir, 'fakeagent.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    for (const arg of HOSTILE.filter((a) => a !== '')) {
      const r = spawnAgent('fakeagent', ['-p', arg, '--flag'], { env: env(), cwd: dir, encoding: 'utf8' });
      expect(r.status, `${arg}: ${r.stderr}`).toBe(0);
      expect(received(), arg).toEqual(['-p', arg, '--flag']);
      expect(existsSync(mark), `injected by: ${arg}`).toBe(false);
    }
  });
  it('an npm launcher is not run through a shell at all: its script is started with Node directly', () => {
    const script = echoScript();
    mkdirSync(join(dir, 'node_modules', 'pkg', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'bin', 'cli.js'), readFileSync(script, 'utf8'));
    writeFileSync(join(dir, 'npmagent.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n');
    expect(npmShimTarget(join(dir, 'npmagent.cmd'))?.script).toBe(join(dir, 'node_modules', 'pkg', 'bin', 'cli.js'));
    for (const arg of [...HOSTILE, 'two\nlines']) {
      const r = spawnAgent('npmagent', ['exec', arg], { env: env(), cwd: dir, encoding: 'utf8' });
      expect(r.status, `${arg}: ${r.stderr}`).toBe(0);
      expect(received(), arg).toEqual(['exec', arg]);
      expect(existsSync(mark)).toBe(false);
    }
  });
  it('a real program is started directly', () => {
    expect(resolveOnWindows('node', process.env)?.toLowerCase().endsWith('node.exe')).toBe(true);
    const script = echoScript();
    for (const arg of HOSTILE) {
      const r = spawnAgent('node', [script, arg], { env: env(), cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(received()).toEqual([arg]);
      expect(existsSync(mark)).toBe(false);
    }
  });
  it('a line break for a plain .cmd file is refused with a reason, not passed on broken', () => {
    writeFileSync(join(dir, 'fakeagent.cmd'), `@echo off\r\n"${process.execPath}" "${echoScript()}" %*\r\n`);
    const r = spawnAgent('fakeagent', ['two\nlines & echo INJECTED> "%MARK%"'], { env: env(), cwd: dir, encoding: 'utf8' });
    expect(r.error?.message).toMatch(/line break/);
    expect(existsSync(mark)).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('elsewhere, arguments go straight to the program', () => {
  it('passes every argument intact', () => {
    const script = echoScript();
    for (const arg of HOSTILE) {
      const r = spawnAgent(process.execPath, [script, arg], { env: env(), cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(received()).toEqual([arg]);
    }
  });
});
