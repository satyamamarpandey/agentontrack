// Runs one program in a real terminal for clean-install-test.mjs, in a process of its own. On Windows, node-pty's cleanup can
// end other processes on the same console, and on CI runners that silently ended the test. stdout carries the screen; stdin is typed.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { command, args, cwd, env } = JSON.parse(process.argv[2]);
const pty = createRequire(join(process.cwd(), 'x.js'))('@lydell/node-pty');
const term = pty.spawn(command, args, { cwd, env, cols: 200, rows: 40 });
term.onData((d) => process.stdout.write(d));
term.onExit(({ exitCode }) => { process.stdout.write(`\n__PTY_EXIT__ ${exitCode}\n`); });
process.stdin.setEncoding('utf8').on('data', (d) => term.write(d));
