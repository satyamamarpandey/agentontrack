// Keeps the app shell available when the network is slow. It never caches Firebase, the account page, or anything with a person's data.
const SHELL = 'aot-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./?m=1', './manifest.webmanifest', './icon-192.png']).catch(() => undefined))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && (u.pathname.includes('/assets/') || u.search === '?m=1')) { const copy = r.clone(); void caches.open(SHELL).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request).then((m) => m ?? Response.error())));
});
