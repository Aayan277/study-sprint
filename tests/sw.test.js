// The service worker keeps old app files until CACHE changes, so a release that changes any app file
// without a CACHE bump would mix old and new modules on phones. Run with: node tests/sw.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHash, savedHash } from './sw-hash.mjs';

test('app files changed only together with a CACHE bump', () => {
  assert.equal(savedHash(), computeHash(),
    'App files changed: bump CACHE in sw.js and update the hash with `node tests/update-sw-hash.mjs`');
});

// ---------- v4.2.2: keepLibraries and the cache-first branch (docs/design/katex-review.md, should-fix 5 and 6) ----------
import fs from 'node:fs';
import vm from 'node:vm';

const SW = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const JS = 'https://cdn.jsdelivr.net/npm/';
const KATEX = JS + 'katex@0.16.47/dist/';

// The worker's code run against a fake `caches` (name → Map of url → response) and a fake `fetch`.
function boot(stores) {
  const on = {}, fetched = [];
  const find = (req, opts = {}) => {
    const strip = u => (opts.ignoreSearch ? u.split('?')[0] : u);
    for (const m of stores.values()) for (const [u, r] of m) if (strip(u) === strip(req.url ?? req)) return r;
    return undefined;
  };
  const caches = {
    keys: async () => [...stores.keys()],
    match: async (req, opts) => find(req, opts),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return { keys: async () => [...m.keys()].map(url => ({ url })), match: async req => m.get(req.url ?? req), put: async (req, res) => { m.set(req.url ?? req, res); } };
    }
  };
  const ctx = vm.createContext({
    self: { addEventListener: (t, f) => { on[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
    caches, location: { origin: 'https://app.test' }, URL, Request, Response,
    fetch: async req => { fetched.push(req.url ?? req); return { ok: true, type: 'cors', clone() { return this; }, from: 'network' }; }
  });
  vm.runInContext(SW, ctx);
  const request = (url, mode = 'cors') => {
    let out;
    on.fetch({ request: { method: 'GET', url, mode }, respondWith: p => { out = p; } });
    return out;
  };
  return { ctx, caches, fetched, request, current: vm.runInContext('CACHE', ctx) };
}
const good = tag => ({ ok: true, type: 'cors', tag });

test('keepLibraries copies pinned libraries from the newest old cache only', async () => {
  const stores = new Map([
    ['study-sprint-v10', new Map([[KATEX + 'katex.mjs', good('ancient')], [KATEX + 'only-in-ancient.js', good('x')]])],
    ['study-sprint-v66', new Map([[KATEX + 'katex.mjs', good('v66')]])]
  ]);
  const { ctx, caches } = boot(stores);
  const into = await caches.open('study-sprint-v67');
  await ctx.keepLibraries(into);
  assert.equal((await into.match(KATEX + 'katex.mjs')).tag, 'v66');
  assert.equal(await into.match(KATEX + 'only-in-ancient.js'), undefined, 'older caches are not read');
});

test('keepLibraries skips opaque and failed responses, and URLs this release no longer pins', async () => {
  const keep = [KATEX + 'katex.min.css', KATEX + 'fonts/KaTeX_Main-Regular.woff2', JS + 'ts-fsrs@5.4.2/dist/index.mjs',
    JS + 'fflate@0.8.2/esm/browser.js', 'https://fonts.gstatic.com/s/geist/v1/a.woff2', 'https://fonts.googleapis.com/css2?family=Geist'];
  const drop = [
    [KATEX + 'katex.mjs', { ok: false, type: 'cors', status: 404 }],
    [KATEX + 'fonts/KaTeX_Math-Italic.woff2', { ok: false, type: 'opaque' }],
    [JS + 'katex@0.16.0/dist/katex.mjs', good('older katex version')],
    [JS + 'ts-fsrs@5.0.0/dist/index.mjs', good('older ts-fsrs')],
    [JS + 'some-other-package@1.0.0/index.js', good('never pinned')],
    ['https://unpkg.com/anything@1/x.js', good('other host')]
  ];
  const opaque = KATEX + 'fonts/KaTeX_Size1-Regular.woff2';
  const stores = new Map([['study-sprint-v66', new Map([...keep.map(u => [u, good(u)]), ...drop, [opaque, { ok: false, type: 'opaque' }]])]]);
  const { ctx, caches } = boot(stores);
  const into = await caches.open('study-sprint-v67');
  await ctx.keepLibraries(into);
  for (const u of keep) assert.equal((await into.match(u))?.tag, u, 'kept ' + u);
  for (const [u] of drop) assert.equal(await into.match(u), undefined, 'left behind ' + u);
  assert.equal(await into.match(opaque), undefined);
});

test('keepLibraries does not overwrite what is already saved, and survives a broken cache', async () => {
  const stores = new Map([['study-sprint-v66', new Map([[KATEX + 'katex.min.css', good('old')]])], ['study-sprint-v67', new Map([[KATEX + 'katex.min.css', good('new')]])]]);
  const { ctx, caches } = boot(stores);
  const into = await caches.open('study-sprint-v67');
  await ctx.keepLibraries(into);
  assert.equal((await into.match(KATEX + 'katex.min.css')).tag, 'new');
  ctx.caches.keys = async () => { throw new Error('storage gone'); };
  await ctx.keepLibraries(into);          // does not throw
});

test('jsdelivr is matched ignoring ?search (an old ?again=2 address is still the saved file)', async () => {
  const stores = new Map([['study-sprint-v67', new Map([[KATEX + 'katex.mjs', good('saved')]])]]);
  const { request, fetched } = boot(stores);
  assert.equal((await request(KATEX + 'katex.mjs?again=2')).tag, 'saved');
  assert.equal((await request(KATEX + 'katex.mjs')).tag, 'saved');
  assert.equal(fetched.length, 0);
  // other hosts are matched exactly
  stores.get('study-sprint-v67').set('https://unpkg.com/x@1/a.js', good('unpkg'));
  assert.equal((await request('https://unpkg.com/x@1/a.js?v=2')).from, 'network');
  assert.equal(fetched.length, 1);
});

test('a saved opaque copy does not answer a cors request (module and stylesheet loads)', async () => {
  const url = KATEX + 'katex.min.css';
  const stores = new Map([['study-sprint-v67', new Map([[url, { ok: false, type: 'opaque', tag: 'opaque' }]])]]);
  const { request, fetched } = boot(stores);
  assert.equal((await request(url, 'no-cors')).tag, 'opaque');
  assert.equal(fetched.length, 0);
  assert.equal((await request(url, 'cors')).from, 'network');
  assert.equal(fetched.length, 1);
});

test('every versioned CDN address the app loads is one the worker keeps (PINNED)', async () => {
  const { ctx } = boot(new Map());
  const pinned = vm.runInContext('PINNED', ctx);
  const base = vm.runInContext('KATEX_BASE', ctx);
  assert.equal(base, (await import('../js/math.js')).KATEX_BASE, 'the worker and js/math.js name the same KaTeX version');
  const root = new URL('../js/', import.meta.url);
  for (const f of fs.readdirSync(root)) {
    for (const m of fs.readFileSync(new URL(f, root), 'utf8').matchAll(/https:\/\/(?:cdn\.jsdelivr\.net|cdn\.sheetjs\.com|unpkg\.com|cdnjs\.cloudflare\.com)\/[^'"`\s)]+/g)) {
      assert.ok(pinned.some(p => m[0].startsWith(p)), `${f}: ${m[0]} is not in PINNED in sw.js`);
    }
  }
});
