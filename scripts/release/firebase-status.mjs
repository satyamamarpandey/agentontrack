// Read-only status of the live Firebase project, for the release record: whether App Check is enforced on Firestore and on Auth, which
// sign-in methods are on, which domains may sign in, and whether the deployed Firestore rules are the ones in this repository. It changes
// nothing. Uses the Firebase CLI's login the same way scripts/release/firestore-admin.mjs does (the token stays in memory and is never printed).
//   node scripts/release/firebase-status.mjs --project <id>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const PROJECT = argv[argv.indexOf('--project') + 1];
if (!PROJECT || PROJECT.startsWith('--')) { console.error('Usage: firebase-status.mjs --project <id>'); process.exit(2); }

async function accessToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(store)) throw new Error('No Firebase CLI login found. Run: pnpm dlx firebase-tools@15 login');
  const refresh = JSON.parse(readFileSync(store, 'utf8')).tokens?.refresh_token;
  if (!refresh) throw new Error('The Firebase CLI is not logged in.');
  // The CLI's public OAuth client, embedded in every copy of firebase-tools; not a secret of this project.
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Could not get an access token from the CLI login (${r.status}).`);
  return (await r.json()).access_token;
}

const token = await accessToken();
const get = async (url) => { const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': PROJECT } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const out = { project: PROJECT, at: new Date().toISOString() };

// App Check: UNENFORCED means requests without an App Check token are accepted.
for (const [name, service] of [['firestore', 'firestore.googleapis.com'], ['auth', 'identitytoolkit.googleapis.com']]) {
  const r = await get(`https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT}/services/${service}`);
  out[`appCheck.${name}`] = r.status === 200 ? (r.body.enforcementMode ?? 'UNENFORCED (not set)') : `could not read (${r.status})`;
}
const apps = await get(`https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT}/apps/-/recaptchaV3Config`).catch(() => ({ status: 0 }));
out['appCheck.providers'] = apps.status === 200 ? 'a reCAPTCHA provider is configured' : `none readable (${apps.status})`;

// Auth configuration.
const cfg = await get(`https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`);
if (cfg.status === 200) {
  out['auth.emailPassword'] = !!cfg.body.signIn?.email?.enabled;
  out['auth.emailPasswordRequired'] = !!cfg.body.signIn?.email?.passwordRequired;
  out['auth.anonymous'] = !!cfg.body.signIn?.anonymous?.enabled;
  out['auth.authorizedDomains'] = cfg.body.authorizedDomains ?? [];
  out['auth.emailEnumerationProtection'] = cfg.body.emailPrivacyConfig?.enableImprovedEmailPrivacy ?? false;
  out['auth.passwordPolicy'] = cfg.body.passwordPolicyConfig?.passwordPolicyEnforcementState ?? 'default';
} else out.auth = `could not read (${cfg.status})`;

// Deployed Firestore rules against this repository's file.
const rel = await get(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
if (rel.status === 200 && rel.body.rulesetName) {
  const rs = await get(`https://firebaserules.googleapis.com/v1/${rel.body.rulesetName}`);
  const deployed = rs.body.source?.files?.[0]?.content ?? '';
  const local = readFileSync('firestore.rules', 'utf8');
  const sha = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
  out['rules.deployedAt'] = rel.body.updateTime ?? rel.body.createTime;
  out['rules.deployedSha'] = sha(deployed);
  out['rules.localSha'] = sha(local);
  out['rules.sameAsRepository'] = sha(deployed) === sha(local);
} else out.rules = `could not read (${rel.status})`;

console.log(JSON.stringify(out, null, 1));
