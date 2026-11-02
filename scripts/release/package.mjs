// Builds the release archives: one bundled program, the dashboard, licence notices and an official Node runtime per platform.
// The runtime means users need nothing installed first. Its download is checked against Node's published checksums.
// Usage: node scripts/release/package.mjs [--targets linux-x64,windows-x64] [--out dist-release]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const VERSION = /VERSION = '([^']+)'/.exec(readFileSync('packages/cli/src/self.ts', 'utf8'))[1];
const NODE_VERSION = process.env.AOT_NODE_VERSION ?? process.version;
const OUT = resolve(arg('out', 'dist-release'));
const ALL = {
  'linux-x64': { node: 'linux-x64', ext: 'tar.gz' },
  'linux-arm64': { node: 'linux-arm64', ext: 'tar.gz' },
  'macos-x64': { node: 'darwin-x64', ext: 'tar.gz' },
  'macos-arm64': { node: 'darwin-arm64', ext: 'tar.gz' },
  'windows-x64': { node: 'win-x64', ext: 'zip' },
};
const targets = arg('targets', Object.keys(ALL).join(',')).split(',');
// On Windows the system tar reads zip. A tar from Git Bash, which may come first on PATH, does not.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.error?.message}`);
  return r.stdout;
};

async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'aot-pack-'));

// One bundle, split so a hook never loads the dashboard or MCP code.
const lib = join(work, 'lib');
const bundled = await build({
  entryPoints: { cli: 'packages/cli/dist/index.js' }, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', outdir: lib, outExtension: { '.js': '.mjs' }, chunkNames: 'chunk-[hash]', minify: false, legalComments: 'linked', metafile: true, logLevel: 'warning',
  banner: { js: "import { createRequire as __aotCreateRequire } from 'node:module'; const require = __aotCreateRequire(import.meta.url);" },
});

// Notices for everything that went into the bundle, read from each package's own files.
const seen = new Map();
for (const input of Object.keys(bundled.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+))\//.exec(input);
  if (m && !seen.has(m[2])) seen.set(m[2], m[1]);
}
const notices = ['Third-party software bundled in AgentOnTrack. Generated at build time from the packages themselves.\n'];
for (const [name, dir] of [...seen].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  notices.push(`\n=== ${name} ${pkg.version} (${pkg.license ?? 'licence not stated'}) ===\n${file ? readFileSync(join(dir, file), 'utf8') : 'No licence file in the package.'}\n`);
}
const thirdParty = notices.join('');

const sums = [];
for (const t of targets) {
  const spec = ALL[t];
  if (!spec) throw new Error(`Unknown target ${t}`);
  const name = `agentontrack-${VERSION}-${t}`;
  const root = join(work, name);
  mkdirSync(root);
  cpSync(lib, join(root, 'lib'), { recursive: true });
  cpSync('packages/companion/ui', join(root, 'ui'), { recursive: true });
  mkdirSync(join(root, 'benchmarks'));
  for (const f of ['matched-v3.json', 'security-campaign.json', 'performance.json', 'matched-v4.json', 'provider-certification.json']) if (existsSync(`benchmarks/results/${f}`)) cpSync(`benchmarks/results/${f}`, join(root, 'benchmarks', f));
  cpSync('LICENSE', join(root, 'LICENSE'));
  cpSync('NOTICE', join(root, 'NOTICE'));
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), thirdParty);
  writeFileSync(join(root, 'VERSION'), `${VERSION}\n`);

  // Official Node, checked against the checksums Node publishes, and cut down to the runtime itself.
  const archive = `node-${NODE_VERSION}-${spec.node}.${spec.ext}`;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const want = (await fetchOk(`${base}/SHASUMS256.txt`)).toString().split('\n').find((l) => l.endsWith(`  ${archive}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`${archive} is not in Node's checksums`);
  const data = await fetchOk(`${base}/${archive}`);
  if (sha256(data) !== want) throw new Error(`Checksum mismatch for ${archive}`);
  const unpack = join(work, `node-${t}`);
  mkdirSync(unpack);
  const file = join(unpack, archive);
  writeFileSync(file, data);
  if (spec.ext === 'zip' && process.platform !== 'win32') run('unzip', ['-q', archive], unpack);
  else run(TAR, ['-xf', archive], unpack);
  const inner = join(unpack, readdirSync(unpack).find((f) => f.startsWith('node-') && statSync(join(unpack, f)).isDirectory()));
  const nodeDir = join(root, 'node');
  mkdirSync(join(nodeDir, 'bin'), { recursive: true });
  if (t.startsWith('windows')) {
    rmSync(join(nodeDir, 'bin'), { recursive: true });
    renameSync(join(inner, 'node.exe'), join(nodeDir, 'node.exe'));
  } else {
    renameSync(join(inner, 'bin', 'node'), join(nodeDir, 'bin', 'node'));
    chmodSync(join(nodeDir, 'bin', 'node'), 0o755);
  }
  renameSync(join(inner, 'LICENSE'), join(nodeDir, 'LICENSE'));
  rmSync(unpack, { recursive: true, force: true });

  const outFile = join(OUT, `${name}.${spec.ext}`);
  if (spec.ext === 'zip' && process.platform !== 'win32') run('zip', ['-qr', outFile, name], work);
  else run(TAR, spec.ext === 'zip' ? ['-a', '-cf', outFile, name] : ['-czf', outFile, name], work);
  rmSync(root, { recursive: true, force: true });
  sums.push(`${sha256(readFileSync(outFile))}  ${name}.${spec.ext}`);
  console.log(`${name}.${spec.ext}: ${(statSync(outFile).size / 1e6).toFixed(1)} MB`);
}
for (const s of ['install.sh', 'install.ps1']) {
  cpSync(join('scripts', 'release', s), join(OUT, s));
  sums.push(`${sha256(readFileSync(join(OUT, s)))}  ${s}`);
}
// The VS Code extension, built from the same tree, so its checksum is in the same list.
const vsix = spawnSync('pnpm', ['--dir', 'packages/vscode', 'run', 'package'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (vsix.status !== 0) throw new Error('Could not build the VS Code extension');
const vsixSrc = resolve('dist-release', 'agentontrack-vscode.vsix');
if (vsixSrc !== join(OUT, 'agentontrack-vscode.vsix')) cpSync(vsixSrc, join(OUT, 'agentontrack-vscode.vsix'));
sums.push(`${sha256(readFileSync(join(OUT, 'agentontrack-vscode.vsix')))}  agentontrack-vscode.vsix`);
writeFileSync(join(OUT, 'SHA256SUMS'), `${sums.join('\n')}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`Packaged ${VERSION} with Node ${NODE_VERSION} in ${OUT}`);
