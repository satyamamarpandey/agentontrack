// Builds the inventory behind docs/uat/MASTER_MATRIX.md: every surface a person, an agent or an attacker can reach, read from the code
// itself, each linked to the tests that exercise it. Nothing is typed by hand here, so an item added to the product without a test shows
// up as NO PROOF on the next run instead of being silently absent.
//
//   node scripts/uat/build-inventory.mjs [--routes test-results/routes-hit.txt]
//
// Writes docs/uat/evidence/inventory.json and docs/uat/evidence/INVENTORY.md. "Proof" means a test file names the item (a route path, a
// command, a test id) or, for companion routes, that a browser test actually requested it (the optional --routes log, written by the
// e2e fixture when AOT_ROUTE_LOG is set). It does NOT by itself mean the test passed: the pass counts are in the matrix.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir, keep, out = []) => {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === 'dist' || name === '.next' || name === 'out') continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, keep, out); else if (keep(rel)) out.push(rel);
  }
  return out;
};
const argv = process.argv.slice(2);
const routesLog = argv.includes('--routes') ? argv[argv.indexOf('--routes') + 1] : null;

// ---------- The test corpus ----------
const testFiles = [
  ...['packages/core/test', 'packages/adapters/test', 'packages/companion/test', 'packages/cli/test', 'packages/mcp-server/test', 'packages/remote/test', 'packages/vscode/test', 'apps/dashboard/test', 'apps/web/test'].flatMap((d) => walk(d, (f) => /\.(ts|tsx|mjs)$/.test(f))),
  ...walk('e2e', (f) => f.endsWith('.spec.ts')),
  ...walk('scripts/release', (f) => /(live-|install-test|upgrade-rollback|clean-install)/.test(f) && f.endsWith('.mjs')),
  ...walk('benchmarks/live', (f) => f.endsWith('.mjs')),
];
const corpus = testFiles.map((f) => ({ f, text: read(f) }));
const kindOf = (f) => (f.startsWith('e2e/') ? (/(emulator|rules|accounts|phone)\b/.test(f) && !/phone-shell/.test(f) ? 'emulator' : /live-/.test(f) ? 'live' : 'browser') : f.startsWith('scripts/release') || f.startsWith('benchmarks/live') ? 'live' : 'unit');
/** Test files whose text contains any of the needles. A needle is a literal string or a RegExp. */
const proofFor = (needles) => {
  const hits = corpus.filter(({ text }) => needles.some((n) => (n instanceof RegExp ? n.test(text) : text.includes(n))));
  return { files: hits.map((h) => h.f), kinds: [...new Set(hits.map((h) => kindOf(h.f)))].sort() };
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hit = new Set();
if (routesLog && existsSync(routesLog)) for (const line of readFileSync(routesLog, 'utf8').split('\n')) if (line.trim()) hit.add(line.trim());
const items = [];
const add = (area, id, what, expected, proof, extra = {}) => items.push({ area, id, what, expected, proofFiles: proof.files.slice(0, 6), proofCount: proof.files.length, proofKinds: proof.kinds, ...extra });

// ---------- 1. Companion HTTP routes ----------
const companion = read('packages/companion/src/index.ts');
const routes = new Map();
for (const m of companion.matchAll(/path === '(\/[^']+)' && method === '([A-Z]+)'/g)) routes.set(`${m[2]} ${m[1]}`, { method: m[2], path: m[1], human: false });
for (const m of companion.matchAll(/^\s+'(\/api\/[^']+)': \{ schema:/gm)) routes.set(`POST ${m[1]}`, { method: 'POST', path: m[1], human: true });
for (const m of companion.matchAll(/= \/\^((?:\\\/|[^/\n])+)\$\/\.exec\(path\)/g)) {
  const pattern = m[1].replace(/\\\//g, '/');
  if (!pattern.startsWith('/api/')) continue;
  routes.set(`* ${pattern}`, { method: 'POST', path: pattern, regex: true, human: false });
}
const routeHit = (r) => {
  if (!hit.size) return false;
  if (!r.regex) return hit.has(`${r.method} ${r.path}`);
  const re = new RegExp(`^${r.path.replace(/\(\?:/g, '(').replace(/\\w/g, '\\w')}$`);
  return [...hit].some((h) => re.test(h.split(' ')[1] ?? ''));
};
for (const [key, r] of [...routes].sort()) {
  // A regex route is searched by its fixed prefix (up to the first group).
  const literal = r.regex ? r.path.split('(')[0] : r.path;
  const needles = r.regex ? [literal] : [new RegExp(`['"\`]${esc(r.path)}['"\`?]|${esc(r.path)}\\?|[}]${esc(r.path)}['"\`?]`)];
  const proof = proofFor(needles);
  const requested = routeHit(r);
  if (requested && !proof.kinds.includes('browser')) proof.kinds.push('browser-request');
  add('companion-api', key, r.human ? 'human action (needs a confirmation code)' : r.method === 'GET' ? 'read' : 'action', r.human ? 'refused without a fresh code; with it, changes exactly what it says' : r.method === 'GET' ? 'paired session only; returns this project only' : 'paired session and CSRF value; outside page needs a terminal code', proof, { requestedByBrowserTest: requested });
}

// ---------- 2. Phone actions ----------
const actions = read('packages/companion/src/remote-actions.ts');
for (const m of new Set([...actions.matchAll(/case '([a-z]+\.[a-z.]+)':/g)].map((x) => x[1]))) add('phone-action', m, 'action a trusted phone may ask for', 'signed, bound to the device, bounded; refused when not allowed', proofFor([new RegExp(`['"\`]${esc(m)}['"\`]`)]));

// ---------- 3. CLI commands ----------
const cli = read('packages/cli/src/index.ts');
const cliCmds = new Set([...cli.matchAll(/^\s{4}case '([a-z][a-z-]*)':/gm)].map((x) => x[1]));
for (const c of [...cliCmds].sort()) add('cli', `agentontrack ${c}`, 'command', 'does what --help says; human-only commands need a real terminal', proofFor([new RegExp(`['"\`\\s]${esc(c)}['"\`\\s,\\]]`), `agentontrack ${c}`]));

// ---------- 4. MCP tools ----------
const mcp = read('packages/mcp-server/src/index.ts');
for (const m of mcp.matchAll(/registerTool\('([^']+)'/g)) add('mcp-tool', m[1], 'tool an agent can call', 'reads, or proposes; never approves, changes policy or creates a task', proofFor([`'${m[1]}'`, `"${m[1]}"`]));

// ---------- 5. Editor commands ----------
const vs = JSON.parse(read('packages/vscode/package.json'));
const vsTests = [...walk('packages/vscode', (f) => /\.(ts|mjs|js|cjs)$/.test(f) && /test/.test(f)), ...testFiles].filter((f, i, a) => a.indexOf(f) === i).map((f) => ({ f, text: read(f) }));
// The real-host suite checks that EVERY contributed command is registered in a real VS Code. That proves a command exists and is wired,
// not what it does: a command that is also run by name in a test is marked "exercised".
const HOST_SUITE = 'packages/vscode/test/host/suite.cjs';
const allRegistered = existsSync(join(ROOT, HOST_SUITE)) && /for \(const cmd of c\.commands\) assert\.ok\(registered\.has\(cmd\.command\)/.test(read(HOST_SUITE));
for (const c of vs.contributes?.commands ?? []) {
  const short = c.command.replace('agentontrack.', '');
  const hits = vsTests.filter(({ text }) => text.includes(c.command) || new RegExp(`['"\`]${esc(short)}['"\`]`).test(text));
  const files = [...new Set([...hits.map((h) => h.f), ...(allRegistered ? [HOST_SUITE] : [])])];
  add('vscode-command', c.command, c.title, 'works in a trusted folder; cannot confirm its own requests (terminal code)', { files, kinds: [...(hits.length ? ['exercised-in-real-host'] : []), ...(allRegistered ? ['registered-in-real-host'] : [])] });
}

// ---------- 6. Website pages ----------
for (const f of walk('apps/web/app', (p) => p.endsWith('/page.tsx')).sort()) {
  const route = `/${f.replace('apps/web/app/', '').replace(/\/?page\.tsx$/, '')}`.replace(/\/$/, '') || '/';
  const needle = route === '/' ? [/PAGES = \['\/'/, "'/'"] : [`'${route}/'`, `${route}/\``, `${route}/'`, `"${route}/"`, `${route}/?`];
  add('site-page', route === '/' ? '/' : `${route}/`, 'public page', 'loads at 320 to 1920 in both themes, no script error, axe clean, links resolve', proofFor(needle));
}

// ---------- 7. Dashboard screens ----------
const app = read('apps/dashboard/src/App.tsx');
const screens = /const SCREENS = \[([^\]]+)\]/.exec(app)?.[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
for (const s of screens) add('dashboard-screen', s, 'dashboard screen', 'renders with real data and in demo mode; states for empty, offline and denied', proofFor([`'${s}'`, `#${s.toLowerCase()}`, `'${s.toLowerCase()}'`]));

// ---------- 8. Firestore rule blocks ----------
const rules = read('firestore.rules');
for (const m of rules.matchAll(/^\s*match \/([^ {]+(?:\{[^}]+\})?[^ ]*) \{/gm)) {
  const path = m[1];
  if (path.startsWith('databases')) continue;
  const coll = path.split('/')[0];
  const sub = path.split('/').filter((x) => !x.startsWith('{')).pop();
  add('firestore-rule', `/${path}`, 'collection rule', 'own data only; forged, replayed and cross-account writes refused', proofFor([`${sub}/`, `/${sub}\``, `'${sub}'`, `${coll}/`]).kinds.includes('emulator') ? proofFor([`${sub}/`, `/${sub}\``, `'${sub}'`]) : proofFor([`${sub}/`]));
}

// ---------- 9. Controls with a test id ----------
const ui = [...walk('apps/dashboard/src', (f) => f.endsWith('.tsx')), ...walk('apps/web/app', (f) => f.endsWith('.tsx'))];
const controls = new Map();
for (const f of ui) {
  const text = read(f);
  for (const m of text.matchAll(/data-testid=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\})/g)) {
    const raw = m[1] ?? m[2] ?? m[3];
    const id = raw.replace(/\$\{[^}]+\}.*$/, '');   // a templated id is matched by its fixed prefix
    const dyn = raw.includes('${');
    if (!id) continue;
    if (!controls.has(id)) controls.set(id, { files: new Set(), dyn });
    controls.get(id).files.add(f);
  }
}
const e2eText = corpus.filter((c) => c.f.startsWith('e2e/') || c.f.startsWith('scripts/release')).map((c) => c.text).join('\n');
let controlsProved = 0; const controlsUnproved = [];
for (const [id, c] of [...controls].sort()) {
  const re = c.dyn ? new RegExp(`['"\`=]${esc(id)}`) : new RegExp(`(getByTestId\\(|data-testid=|testid=|Id\\()\\s*['"\`\\\\"]*${esc(id)}['"\`\\\\$]|['"\`]${esc(id)}['"\`]`);
  if (re.test(e2eText)) controlsProved++; else controlsUnproved.push({ id, in: [...c.files][0] });
}

// ---------- 10. Agents and integrations ----------
let cert = { entries: [] };
try { cert = JSON.parse(read('benchmarks/results/provider-certification.json')); } catch { /* not present */ }
for (const e of cert.entries ?? []) add('agent', e.id ?? e.name, e.name ?? e.id, 'real-host proof, or UNSUPPORTED', { files: e.proof ? [String(e.proof)] : [], kinds: [String(e.status ?? 'unknown')] }, { status: e.status, version: e.version, evidence: e.evidence });

// ---------- Output ----------
const byArea = {};
for (const it of items) (byArea[it.area] ??= []).push(it);
const summary = Object.fromEntries(Object.entries(byArea).map(([a, list]) => [a, { total: list.length, withProof: list.filter((x) => x.proofCount > 0 || x.requestedByBrowserTest).length, noProof: list.filter((x) => x.proofCount === 0 && !x.requestedByBrowserTest).map((x) => x.id) }]));
summary.controls = { total: controls.size, referencedInBrowserTests: controlsProved, notReferenced: controlsUnproved };
mkdirSync(join(ROOT, 'docs/uat/evidence'), { recursive: true });
writeFileSync(join(ROOT, 'docs/uat/evidence/inventory.json'), `${JSON.stringify({ generatedBy: 'scripts/uat/build-inventory.mjs', testFiles: testFiles.length, routesLog: routesLog && hit.size ? { file: routesLog, distinctRequests: hit.size } : null, summary, items }, null, 1)}\n`);

const short = (f) => f.replace(/^packages\//, '').replace(/^e2e\//, 'e2e:').replace(/\.test\.ts$|\.spec\.ts$/, '');
const lines = ['# Inventory', '', 'Generated by `node scripts/uat/build-inventory.mjs`. Do not edit by hand. Every item is read from the code; "proof" lists the test files that name it. An item with no proof is listed at the top of its section.', ''];
for (const [area, list] of Object.entries(byArea)) {
  const s = summary[area];
  lines.push(`## ${area} (${s.total}; with proof ${s.withProof}; no proof ${s.noProof.length})`, '');
  if (s.noProof.length) lines.push(`**No proof:** ${s.noProof.map((x) => `\`${x}\``).join(', ')}`, '');
  lines.push('| Item | What | Proof (test files) | Kinds |', '|---|---|---|---|');
  for (const it of list) lines.push(`| \`${it.id.replace(/\|/g, '\\|')}\` | ${it.what} | ${it.proofFiles.map(short).join(', ') || (it.requestedByBrowserTest ? '(requested by a browser test)' : '**none**')}${it.proofCount > 6 ? `, +${it.proofCount - 6}` : ''} | ${it.proofKinds.join(', ')} |`);
  lines.push('');
}
lines.push(`## controls (${controls.size} test ids; ${controlsProved} named in browser tests; ${controlsUnproved.length} not)`, '', 'A control without a test id is covered by the button sweep in `e2e/uat-sweep.spec.ts`, which clicks every enabled button on every page and screen.', '');
if (controlsUnproved.length) { lines.push('| Test id not named in any browser test | Defined in |', '|---|---|'); for (const c of controlsUnproved) lines.push(`| \`${c.id}\` | ${c.in.split(sep).join('/')} |`); lines.push(''); }
writeFileSync(join(ROOT, 'docs/uat/evidence/INVENTORY.md'), `${lines.join('\n')}\n`);
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, k === 'controls' ? { total: v.total, referenced: v.referencedInBrowserTests, not: v.notReferenced.length } : { total: v.total, withProof: v.withProof, noProof: v.noProof.length }])), null, 1));
void relative;
