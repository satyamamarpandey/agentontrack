// Provisions the free Firebase project the public site's accounts and early access use, from a Firebase CLI login the OWNER made in their own browser.
// It is idempotent: run it again and it reports what already exists. Nothing here costs money: Spark plan, no Cloud Functions, no billing account.
//
//   pnpm dlx firebase-tools@15 login          (the owner, once; opens a browser)
//   node scripts/release/firebase-provision.mjs --project <id> [--region nam5] [--display "AgentOnTrack"]
//
// What it does, in order, printing each step:
//   1. creates the project if it does not exist (Firebase Management API, through the CLI)
//   2. registers a web app and prints its public config (apiKey, authDomain, projectId, appId: identifiers, not secrets)
//   3. creates the default Firestore database in the region given, production mode
//   4. deploys firestore.rules from this repository
//   5. enables email-and-password sign-in through the Identity Toolkit API, using the CLI's own OAuth token (Google sign-in needs two clicks in the
//      console, because its OAuth consent screen cannot be created by an API; the script says so)
//   6. adds the public site's domain to the authorized domains
//   7. writes the web config to .local/firebase-web-config.json (gitignored) and prints the `gh variable set` command for the public repository
// It never prints or stores the CLI's token.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]] : null)).filter(Boolean));
const PROJECT = args.project;
const REGION = args.region ?? 'nam5';
const DISPLAY = args.display ?? 'AgentOnTrack';
const SITE_DOMAIN = args.domain ?? 'pandeysatyam.com';
if (!PROJECT) { console.error('Usage: node scripts/release/firebase-provision.mjs --project <id> [--region nam5] [--display AgentOnTrack] [--domain pandeysatyam.com]'); process.exit(2); }

const shell = process.platform === 'win32';
const fb = (cmdArgs, { json = true, allowFail = false } = {}) => {
  const full = ['dlx', 'firebase-tools@15', ...cmdArgs, ...(json ? ['--json'] : []), '--non-interactive'];
  const r = spawnSync('pnpm', full, { encoding: 'utf8', shell, maxBuffer: 1 << 26 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.status !== 0 && !allowFail) { console.error(out.slice(-4000)); throw new Error(`firebase ${cmdArgs.join(' ')} failed (${r.status})`); }
  if (!json) return { status: r.status, out };
  // The JSON is on stdout; warnings on stderr may follow it, so parse the balanced object only.
  const so = r.stdout ?? '';
  const start = so.indexOf('{'); const end = so.lastIndexOf('}');
  try { return { status: r.status, out, data: start >= 0 && end > start ? JSON.parse(so.slice(start, end + 1)) : null }; } catch { return { status: r.status, out, data: null }; }
};
const step = (n, text) => console.log(`\n[${n}] ${text}`);

/** The CLI's own OAuth refresh token, exchanged for a short-lived access token, for the two calls the CLI has no command for. The token stays in memory. */
async function accessToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(store)) throw new Error('No Firebase CLI login found. Run: pnpm dlx firebase-tools@15 login');
  const cfg = JSON.parse(readFileSync(store, 'utf8'));
  const refresh = cfg.tokens?.refresh_token;
  if (!refresh) throw new Error('The Firebase CLI is not logged in. Run: pnpm dlx firebase-tools@15 login');
  // The CLI's public OAuth client (it is embedded in every copy of firebase-tools; it is not a secret in any meaningful sense).
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Could not get an access token from the CLI login (${r.status}). Run the login again.`);
  return (await r.json()).access_token;
}
const api = async (token, url, init = {}) => {
  const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};

step(1, `Project ${PROJECT}`);
const list = fb(['projects:list']);
const projects = Array.isArray(list.data?.result) ? list.data.result : [];
if (projects.some((p) => p.projectId === PROJECT)) console.log('  exists already');
else {
  const made = fb(['projects:create', PROJECT, '--display-name', DISPLAY], { allowFail: true });
  if (made.status === 0) console.log('  created');
  else {
    // The Google Cloud project may exist from an earlier attempt without Firebase on it yet (for example when the Firebase terms had not been accepted).
    const added = fb(['projects:addfirebase', PROJECT], { allowFail: true });
    if (added.status !== 0) { console.error(made.out.slice(-1500)); console.error(added.out.slice(-1500)); throw new Error('Could not create the project or add Firebase to it. Either the id is taken (try another --project), or the account has not accepted the Firebase terms yet: open https://console.firebase.google.com/, start "Create a project", accept the terms, and run this again.'); }
    console.log('  Firebase added to the existing Google Cloud project');
  }
}

step(2, 'Web app and its public config');
const apps = fb(['apps:list', 'WEB', '--project', PROJECT]);
let app = (Array.isArray(apps.data?.result) ? apps.data.result : []).find((a) => a.displayName === DISPLAY) ?? (Array.isArray(apps.data?.result) ? apps.data.result[0] : undefined);
if (!app) {
  const made = fb(['apps:create', 'WEB', DISPLAY, '--project', PROJECT]);
  app = made.data?.result ?? made.data;
  console.log('  created');
} else console.log('  exists already');
const appId = app.appId ?? app.result?.appId;
const sdk = fb(['apps:sdkconfig', 'WEB', appId, '--project', PROJECT]);
const cfgAll = sdk.data?.result?.sdkConfig ?? sdk.data?.sdkConfig ?? sdk.data?.result ?? sdk.data;
const webConfig = { apiKey: cfgAll.apiKey, authDomain: cfgAll.authDomain, projectId: cfgAll.projectId, appId: cfgAll.appId };
for (const k of Object.keys(webConfig)) if (!webConfig[k]) throw new Error(`The SDK config has no ${k}: ${JSON.stringify(cfgAll).slice(0, 300)}`);
console.log('  config:', JSON.stringify(webConfig));

step(3, `Firestore database in ${REGION}`);
// A new project has its APIs off. Service Usage switches them on with the same login; an operation name comes back and finishes within seconds.
const token = await accessToken();
for (const svc of ['firestore.googleapis.com', 'firebaserules.googleapis.com', 'identitytoolkit.googleapis.com']) {
  const r = await api(token, `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${svc}:enable`, { method: 'POST', body: '{}' });
  if (r.status !== 200) console.log(`  could not enable ${svc} (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
  else if (r.data?.done === false && r.data?.name) {
    for (let i = 0; i < 30; i++) { await new Promise((ok) => setTimeout(ok, 2000)); const op = await api(token, `https://serviceusage.googleapis.com/v1/${r.data.name}`); if (op.data?.done) break; }
    console.log(`  enabled ${svc}`);
  } else console.log(`  ${svc}: ${r.data?.response?.service?.state ?? 'enabled'}`);
}
await new Promise((ok) => setTimeout(ok, 5000));
const dbs = fb(['firestore:databases:list', '--project', PROJECT], { allowFail: true });
const haveDefault = JSON.stringify(dbs.data ?? dbs.out).includes('(default)');
if (haveDefault) console.log('  exists already');
else {
  const made = fb(['firestore:databases:create', '(default)', '--location', REGION, '--project', PROJECT], { json: false, allowFail: true });
  if (made.status !== 0) { console.error(made.out.slice(-3000)); throw new Error('Could not create the Firestore database. If the message says the API is not enabled, open the Firebase console once (Build → Firestore) and run this again.'); }
  console.log('  created');
}

step(4, 'Deploy firestore.rules');
const dep = fb(['deploy', '--only', 'firestore:rules', '--project', PROJECT], { json: false });
console.log('  ' + (dep.out.split('\n').filter((l) => /rules|Deploy complete/i.test(l)).slice(-3).join(' | ') || 'done'));

step(5, 'Sign-in methods');
const cfgUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;
let authCfg = await api(token, cfgUrl);
if (authCfg.status === 404 || authCfg.status === 403) {
  console.log(`  Authentication is not initialised yet (HTTP ${authCfg.status}). Owner: Firebase console → Build → Authentication → Get started. Then run this script again. Skipping the rest of this step.`);
} else if (authCfg.status !== 200) {
  console.log(`  Could not read the Authentication config (HTTP ${authCfg.status}): ${JSON.stringify(authCfg.data).slice(0, 300)}`);
} else {
  const email = authCfg.data.signIn?.email;
  if (email?.enabled && email?.passwordRequired) console.log('  email and password: already enabled');
  else {
    const r = await api(token, `${cfgUrl}?updateMask=signIn.email.enabled,signIn.email.passwordRequired`, { method: 'PATCH', body: JSON.stringify({ signIn: { email: { enabled: true, passwordRequired: true } } }) });
    console.log(r.status === 200 ? '  email and password: enabled' : `  email and password: could not enable (HTTP ${r.status}) ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  const prot = await api(token, `${cfgUrl}?updateMask=emailPrivacyConfig.enableImprovedEmailPrivacy`, { method: 'PATCH', body: JSON.stringify({ emailPrivacyConfig: { enableImprovedEmailPrivacy: true } }) });
  console.log(prot.status === 200 ? '  email enumeration protection: on' : `  email enumeration protection: could not set (HTTP ${prot.status})`);
  const idps = await api(token, `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs`);
  const google = (idps.data?.defaultSupportedIdpConfigs ?? []).find((c) => c.name?.endsWith('/google.com'));
  console.log(google?.enabled ? '  Google: enabled' : '  Google: NOT enabled. Owner: Firebase console → Authentication → Sign-in method → Google → Enable (two clicks; the console creates the OAuth client). Optional: email-and-password works without it.');

  step(6, 'Authorized domains');
  const domains = new Set(authCfg.data.authorizedDomains ?? []);
  const want = [SITE_DOMAIN, 'satyamamarpandey.github.io'];
  const missing = want.filter((d) => !domains.has(d));
  if (!missing.length) console.log('  already listed: ' + want.join(', '));
  else {
    const r = await api(token, `${cfgUrl}?updateMask=authorizedDomains`, { method: 'PATCH', body: JSON.stringify({ authorizedDomains: [...domains, ...missing] }) });
    console.log(r.status === 200 ? `  added: ${missing.join(', ')}` : `  could not add (HTTP ${r.status}) ${JSON.stringify(r.data).slice(0, 300)}`);
  }
}

step(7, 'Write the config for the build');
mkdirSync('.local', { recursive: true });
const outPath = join('.local', 'firebase-web-config.json');
writeFileSync(outPath, JSON.stringify(webConfig));
console.log(`  wrote ${outPath}`);
console.log('\nNext, for the public repository (the config is public identifiers, so a repository VARIABLE, not a secret):');
console.log(`  gh variable set FIREBASE_WEB_CONFIG -R satyamamarpandey/agentontrack --body '${JSON.stringify(webConfig)}'`);
console.log('Then export, push main, and the pages workflow builds the site with accounts on and installs gated.');
