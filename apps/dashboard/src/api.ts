import { demoGet } from './demo';

let csrf = '';
let project = '';
let token = '';
let demo = false;

/** Served by the local companion, API is same-origin. Served from the public site, it is the companion on this machine. */
const isPublicSite = () => import.meta.env.BASE_URL !== '/';
let base = '';
if (isPublicSite()) base = `http://127.0.0.1:${sessionStorage.getItem('aot-port') ?? '47631'}`;

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data?: any) { super(message); }
}

export const setProject = (id: string) => { project = id; };
export const currentProject = () => project;
export const isDemo = () => demo;
export const onPublicSite = isPublicSite;
export const enterDemo = () => { demo = true; project = 'demo'; };
export const leaveDemo = () => { demo = false; project = ''; };
export const setPort = (port: string) => {
  if (!/^\d{2,5}$/.test(port)) throw new ApiError(400, 'Enter a valid port number');
  sessionStorage.setItem('aot-port', port);
  base = `http://127.0.0.1:${port}`;
};
export const currentPort = () => sessionStorage.getItem('aot-port') ?? '47631';

/** A path that already names its project keeps it: the project grid reads several at once. */
const withProject = (path: string) => (project && !/[?&]project=/.test(path) ? `${path}${path.includes('?') ? '&' : '?'}project=${project}` : path);
const auth = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** The address that needs no permission from the browser, because the page and the companion are then the same origin. */
export const localAddress = () => `http://127.0.0.1:${currentPort()}/`;

/** Chromium's permission for a public page reaching a local address. Other browsers do not know the name, and throw. */
async function localNetworkPermission(): Promise<string> {
  try { return (await navigator.permissions.query({ name: 'local-network-access' as PermissionName })).state; } catch { return 'unknown'; }
}

async function unreachableMessage(): Promise<string> {
  const fallback = `Or use the local address the companion prints, such as ${localAddress()}, which needs no browser permission.`;
  if (await localNetworkPermission() === 'denied') return `Your browser denied this page access to your local network, so it cannot reach the companion. Allow local network access for this site in the browser's site settings, then try again. ${fallback}`;
  return `Could not reach the companion on this machine. Is \`agentontrack dashboard --allow-public-site\` running on this port? If your browser asked about local network access, it must be allowed. Your browser may also block this connection outright, as Safari does from a secure page. ${fallback}`;
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${base}${path}`, init);
  } catch {
    throw new ApiError(0, isPublicSite() ? await unreachableMessage() : 'Lost the connection to the companion.');
  }
}

export async function get<T = any>(path: string): Promise<T> {
  if (demo) return demoGet(path) as T;
  const r = await send(withProject(path), { headers: auth() });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body.error ?? `Request failed (${r.status})`, body);
  return body;
}

/** The public site can change nothing without a code that only the terminal shows. Set by the app. */
let askTerminalCode: (action: string) => Promise<string> = () => Promise.reject(new ApiError(428, 'Enter the code shown in your terminal'));
export const setTerminalPrompt = (fn: typeof askTerminalCode) => { askTerminalCode = fn; };

export async function post<T = any>(path: string, body: Record<string, unknown> | object = {}): Promise<T> {
  if (demo) throw new ApiError(403, 'This is the demo, so nothing was changed. Pair with your local companion to do this for real.');
  const r = await send(withProject(path), { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentontrack-csrf': csrf, ...auth() }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (r.status === 428) return post<T>(path, { ...body, challengeId: out.challengeId, confirm: await askTerminalCode(out.action ?? path) });
  if (!r.ok) throw new ApiError(r.status, out.error ?? out.issues?.join('; ') ?? `Request failed (${r.status})`, out);
  return out;
}

export async function resumeSession(): Promise<boolean> {
  if (new URLSearchParams(location.search).has('demo')) { enterDemo(); return true; }
  if (isPublicSite()) {
    // A token in sessionStorage lasts for this tab only, and is never sent anywhere but the companion.
    token = sessionStorage.getItem('aot-token') ?? '';
    if (!token) return false;
  }
  try {
    const h = await get<{ paired: boolean }>('/api/health');
    if (!h.paired) { token = ''; sessionStorage.removeItem('aot-token'); return false; }
    const s = await get<{ csrf: string }>('/api/session');
    csrf = s.csrf;
    return true;
  } catch {
    return false;
  }
}

export async function pair(code: string): Promise<void> {
  const r = await send('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, out.error ?? 'Pairing failed');
  csrf = out.csrf;
  if (out.token) { token = out.token; sessionStorage.setItem('aot-token', token); }
}

export function forgetSession() {
  token = '';
  csrf = '';
  sessionStorage.removeItem('aot-token');
}

/** Fetch, not EventSource, so it can carry the bearer token. It reconnects from the last id it saw. */
export function subscribe(onEvent: () => void, onLive: (live: boolean) => void, onSessionGone: () => void = () => {}): () => void {
  if (demo) { onLive(false); return () => {}; }
  const ctl = new AbortController();
  let last = '';
  const run = async () => {
    while (!ctl.signal.aborted) {
      try {
        const q = withProject(`/api/events/stream${last ? `?since=${last}` : ''}`);
        const r = await fetch(`${base}${q}`, { headers: auth(), signal: ctl.signal });
        // Sessions live in the companion's memory, so a restarted companion answers but no longer knows this browser.
        if (r.status === 401) { onLive(false); onSessionGone(); return; }
        if (!r.ok || !r.body) throw new Error('stream');
        onLive(true);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const ids = [...value.matchAll(/^id: (\d+)$/gm)];
          if (ids.length) { last = ids.at(-1)![1]!; onEvent(); }
        }
      } catch { /* retried below */ }
      if (ctl.signal.aborted) return;
      onLive(false);
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  };
  run();
  return () => ctl.abort();
}

export async function downloadExport(): Promise<void> {
  if (demo) throw new ApiError(403, 'This is the demo, so there is no record to export.');
  const r = await send(withProject('/api/data/export'), { headers: auth() });
  if (!r.ok) throw new ApiError(r.status, 'Export failed');
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `agentontrack-${project}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
