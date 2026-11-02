// The phone page's service worker is run here with a stand-in browser, to check what it will and will not keep.
// It must never keep another site's response (such as Firebase's), a write, or anything that is not the page shell or its built assets.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('apps/dashboard/public/sw.js'), 'utf8');

function boot() {
  const handlers: Record<string, (e: any) => void> = {};
  const stored: string[] = [];
  const cache = { addAll: async () => undefined, put: async (req: { url: string }) => { stored.push(req.url); } };
  const fetches: string[] = [];
  const ctx: any = {
    self: { addEventListener: (n: string, f: any) => { handlers[n] = f; }, skipWaiting: () => undefined, clients: { claim: async () => undefined } },
    location: { origin: 'https://example.test' },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => undefined },
    fetch: async (req: { url: string }) => { fetches.push(req.url); return { ok: true, clone() { return this; } }; },
    URL, Response: { error: () => ({ error: true }) }, Promise,
  };
  vm.runInNewContext(source, ctx);
  const request = async (url: string, method = 'GET') => {
    let answer: Promise<unknown> | null = null;
    handlers.fetch!({ request: { url, method }, respondWith: (p: Promise<unknown>) => { answer = p; } });
    if (answer) await answer;
    await new Promise((ok) => setTimeout(ok, 5));
    return answer !== null;
  };
  return { request, stored, fetches };
}

describe('the phone page service worker', () => {
  it('keeps same-site built assets and the phone page shell', async () => {
    const sw = boot();
    await sw.request('https://example.test/agentontrack/dashboard/assets/mobile-abc.js');
    await sw.request('https://example.test/agentontrack/dashboard/?m=1');
    expect(sw.stored).toEqual(['https://example.test/agentontrack/dashboard/assets/mobile-abc.js', 'https://example.test/agentontrack/dashboard/?m=1']);
  });
  it('never keeps, or even handles, another site (Firebase, Google), a write, or any other path', async () => {
    const sw = boot();
    const handled = [
      await sw.request('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel'),
      await sw.request('https://identitytoolkit.googleapis.com/v1/accounts:lookup'),
      await sw.request('https://example.test/agentontrack/dashboard/assets/x.js', 'POST'),
      await sw.request('https://example.test/agentontrack/account/'),
      await sw.request('https://example.test/api/anything'),
    ];
    expect(handled).toEqual([false, false, false, true, true]);
    expect(sw.stored).toEqual([]);
  });
  it('has no mention of any account or data host in its source', () => {
    expect(source).not.toMatch(/firebase|googleapis|indexedDB|localStorage|token/i);
  });
});
