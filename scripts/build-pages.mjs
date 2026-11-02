// Builds the public static site: marketing pages, the dashboard (demo mode, or paired to the visitor's own companion), and the install scripts.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.PAGES_BASE ?? '/agentontrack';
const OUT = resolve(process.env.PAGES_OUT ?? 'dist-pages');
const web = resolve('apps/web');
const shell = process.platform === 'win32';
if (process.env.NEXT_PUBLIC_RELEASE_PUBLISHED === '1' && !process.env.NEXT_PUBLIC_RELEASE_VERSION?.trim()) {
  console.error('NEXT_PUBLIC_RELEASE_PUBLISHED=1 needs NEXT_PUBLIC_RELEASE_VERSION, or the download links would be wrong.');
  process.exit(1);
}
// Optional accounts. Unset means no sign-in UI and no Firebase code in the build. Any value is a project's public identifiers, never a secret.
const FIREBASE = (process.env.NEXT_PUBLIC_FIREBASE_CONFIG ?? '').trim();
if (FIREBASE) {
  let parsed = {};
  try { parsed = JSON.parse(FIREBASE); } catch { /* reported below */ }
  const absent = ['apiKey', 'authDomain', 'projectId', 'appId'].filter((k) => !parsed[k]);
  if (absent.length) { console.error(`NEXT_PUBLIC_FIREBASE_CONFIG must be JSON with ${absent.join(', ')}.`); process.exit(1); }
}
const EMULATORS = process.env.AOT_FIREBASE_EMULATORS === '1' ? '1' : '';
const env = { ...process.env, NEXT_PUBLIC_BASE_PATH: BASE, NEXT_PUBLIC_FIREBASE_CONFIG: FIREBASE, NEXT_PUBLIC_FIREBASE_EMULATORS: EMULATORS };

rmSync(OUT, { recursive: true, force: true });
rmSync(join(web, '.next'), { recursive: true, force: true });
const status = spawnSync('pnpm', ['--dir', 'apps/web', 'exec', 'next', 'build'], { stdio: 'inherit', env, shell }).status ?? 1;
if (status !== 0) process.exit(status);
cpSync(join(web, 'out'), OUT, { recursive: true });
rmSync(join(web, 'out'), { recursive: true, force: true });
rmSync(join(web, '.next'), { recursive: true, force: true });

const dash = spawnSync('pnpm', ['--dir', 'apps/dashboard', 'exec', 'vite', 'build'], { stdio: 'inherit', shell, env: { ...process.env, VITE_BASE: `${BASE}/dashboard/`, VITE_OUT: join(OUT, 'dashboard'), VITE_FIREBASE_CONFIG: FIREBASE, VITE_FIREBASE_EMULATORS: EMULATORS, VITE_APPCHECK_KEY: process.env.NEXT_PUBLIC_APPCHECK_SITE_KEY ?? '' } });
if (dash.status !== 0) process.exit(dash.status ?? 1);
writeFileSync(join(OUT, '.nojekyll'), '');

// Served at the site root, so `curl ... | sh` and `irm ... | iex` work. A Windows checkout must not turn install.sh into CRLF, which sh cannot run.
writeFileSync(join(OUT, 'install.sh'), readFileSync('scripts/release/install.sh', 'utf8').replace(/\r\n/g, '\n'));
writeFileSync(join(OUT, 'install.ps1'), readFileSync('scripts/release/install.ps1'));

// Refuse to publish anything that looks private.
const FORBIDDEN = [/[A-Z]:[\\/]Users[\\/]/, /\/Users\/\w+/, /\/home\/\w+\//, /Temp[\\/]bl-/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /sk-ant-/, /aot-site/];
// Names and addresses to keep out stay out of this source too. One regular expression per line, from an untracked file.
if (existsSync('.private-denylist')) for (const l of readFileSync('.private-denylist', 'utf8').split('\n').filter(Boolean)) FORBIDDEN.push(new RegExp(l, 'i'));
const problems = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (name.endsWith('.map')) { problems.push(`source map present: ${p}`); continue; }
    if (!/\.(html|js|css|txt|json|svg|rsc|sh|ps1)$/.test(name)) continue;
    const text = readFileSync(p, 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${p}: ${re}`);
  }
};
walk(OUT);
if (problems.length) { console.error(`Refusing to publish:\n${problems.join('\n')}`); process.exit(1); }
for (const need of ['index.html', 'install/index.html', 'dashboard/index.html', 'install.sh', 'install.ps1']) {
  if (!existsSync(join(OUT, need))) { console.error(`Missing ${need}`); process.exit(1); }
}
console.log('pages build ok:', OUT);
