// Runs the Firebase-emulator end-to-end specs on THIS machine the way the `accounts` job in .github/workflows/ci.yml does.
//   node scripts/e2e-emulator-local.mjs [spec names...]     (default: the six specs the `accounts` job in ci.yml runs)
// Java is needed by the emulators. If a portable JDK exists at .local\jdk inside the repo (gitignored; override: AOT_JDK_DIR), JAVA_HOME and PATH are set for THIS process tree only; nothing
// machine-wide is changed. firebase-tools is the pinned one CI uses, run through `pnpm dlx` (no global install); it downloads its emulator JARs to ~/.cache/firebase itself.
// Build first, with the demo config (a demo- project id never reaches a real Firebase project):
//   NEXT_PUBLIC_FIREBASE_CONFIG='{"apiKey":"demo-key","authDomain":"demo-agentontrack.firebaseapp.com","projectId":"demo-agentontrack","appId":"demo-app"}' AOT_FIREBASE_EMULATORS=1 AOT_CONFIGURED_BUILD=1 pnpm build && pnpm build:pages
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const jdk = resolve(process.env.AOT_JDK_DIR ?? '.local\\jdk');
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '.pw-browsers', // same as CI
  AOT_FIREBASE_EMULATORS: '1',
  AOT_CONFIGURED_BUILD: '1',
};
if (existsSync(join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
  env.JAVA_HOME = jdk;
  env.PATH = `${join(jdk, 'bin')}${delimiter}${env.PATH ?? env.Path ?? ''}`;
  console.log(`Using portable JDK at ${jdk}`);
} else {
  console.log('No portable JDK found; using whatever java is on PATH.');
}
// No API keys or real project: the emulators need none.
for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN']) delete env[k];

// --trace-off: see docs/product/TEST_MATRIX.md. On Windows, Playwright's retain-on-failure tracing of contexts made in beforeAll loses its own trace files during the one-minute
// last test of phone.spec and fails the run in afterAll, although every assertion passed. Off is for local diagnosis only; CI does not use it.
const args = process.argv.slice(2);
const traceOff = args.includes('--trace-off');
const specs = args.filter((a) => !a.startsWith('--'));
const list = specs.length ? specs.join(' ') : 'accounts.spec accounts-configured.spec early-access-emulator.spec rules.spec phone.spec phone-new-session.spec';
const inner = `pnpm exec playwright test ${list} --project=chromium --workers=1${traceOff ? ' --trace=off' : ''}`;
const r = spawnSync('pnpm', ['dlx', 'firebase-tools@15', 'emulators:exec', '--only', 'auth,firestore', '--project', 'demo-agentontrack', process.platform === 'win32' ? `"${inner}"` : inner], { stdio: 'inherit', shell: process.platform === 'win32', env });

try {
  const s = JSON.parse(readFileSync('test-results/e2e.json', 'utf8')).stats;
  console.log(`\nResult: ${JSON.stringify(s)}`);
  if (s.skipped > 0) console.error('Some tests were skipped: nothing was proved for them.');
} catch { console.error('No test-results/e2e.json was written.'); }
process.exit(r.status ?? 1);
