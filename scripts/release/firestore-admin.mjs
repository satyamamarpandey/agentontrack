// Owner access to the live Firestore through its REST API, for bootstrap and clean-up only: these calls carry the project owner's token and
// bypass the security rules, so nothing a browser does should ever need them. Uses the Firebase CLI's login (its refresh token in the user
// profile's configstore is exchanged for a short-lived access token that stays in memory). Prints JSON; writes nothing to disk.
//   node scripts/release/firestore-admin.mjs --project <id> get <collection/doc>
//   node scripts/release/firestore-admin.mjs --project <id> set <collection/doc> '<json object>'      (replaces the document; {"$now":true} becomes a server timestamp)
//   node scripts/release/firestore-admin.mjs --project <id> delete <collection/doc>
//   node scripts/release/firestore-admin.mjs --project <id> list <collection> [--limit 20]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const PROJECT = opt('--project');
const LIMIT = Number(opt('--limit', '20'));
const words = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--project' && argv[i - 1] !== '--limit');
const [command, path, json] = words;
if (!PROJECT || !command || !path) { console.error('Usage: firestore-admin.mjs --project <id> get|set|delete|list <path> [json]'); process.exit(2); }
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function accessToken() {
  const store = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!existsSync(store)) throw new Error('No Firebase CLI login found. Run: pnpm dlx firebase-tools@15 login');
  const refresh = JSON.parse(readFileSync(store, 'utf8')).tokens?.refresh_token;
  if (!refresh) throw new Error('The Firebase CLI is not logged in. Run: pnpm dlx firebase-tools@15 login');
  // The CLI's public OAuth client, embedded in every copy of firebase-tools; not a secret of this project.
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com', client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Could not get an access token from the CLI login (${r.status}). Run the login again.`);
  return (await r.json()).access_token;
}

// Firestore's REST value encoding, both ways.
function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') {
    if (v.$now === true) return { timestampValue: new Date().toISOString() };
    if (typeof v.$timestamp === 'string') return { timestampValue: v.$timestamp };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
  }
  throw new Error(`Cannot encode ${typeof v}`);
}
function decode(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  return v;
}
const plain = (doc) => ({ id: doc.name.split('/').slice(-1)[0], ...Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, x]) => [k, decode(x)])) });

const token = await accessToken();
const call = async (url, init = {}) => {
  const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) { console.error(JSON.stringify({ status: r.status, error: data }, null, 2)); process.exit(1); }
  return data;
};

if (command === 'get') console.log(JSON.stringify(plain(await call(`${BASE}/${path}`)), null, 2));
else if (command === 'delete') { await call(`${BASE}/${path}`, { method: 'DELETE' }); console.log(JSON.stringify({ deleted: path })); }
else if (command === 'set') {
  if (!json) { console.error('set needs a JSON object'); process.exit(2); }
  const fields = Object.fromEntries(Object.entries(JSON.parse(json)).map(([k, v]) => [k, encode(v)]));
  console.log(JSON.stringify(plain(await call(`${BASE}/${path}`, { method: 'PATCH', body: JSON.stringify({ fields }) })), null, 2));
} else if (command === 'list') {
  const data = await call(`${BASE}/${path}?pageSize=${LIMIT}`);
  console.log(JSON.stringify((data.documents ?? []).map(plain), null, 2));
} else { console.error(`Unknown command ${command}`); process.exit(2); }
