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
// The cache name the worker under test uses, read from sw.js so the test does not break on every bump.
const CACHE_NAME = SW.match(/const CACHE = '([^']+)'/)[1];
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
    delete: async name => stores.delete(name),
    match: async (req, opts) => find(req, opts),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      const key = req => String(req.url ?? req);
      return { keys: async () => [...m.keys()].map(url => ({ url })), match: async req => m.get(key(req)), put: async (req, res) => { m.set(key(req), res); }, delete: async req => m.delete(key(req)) };
    }
  };
  const ctx = vm.createContext({
    self: { addEventListener: (t, f) => { on[t] = f; }, skipWaiting() {}, clients: { claim() {} }, registration: { scope: 'https://app.test/' } },
    caches, location: { origin: 'https://app.test' }, URL, Request, Response,
    fetch: async req => { fetched.push(req.url ?? req); return { ok: true, type: 'cors', clone() { return this; }, from: 'network' }; }
  });
  vm.runInContext(SW, ctx);
  const request = (url, mode = 'cors') => {
    let out;
    on.fetch({ request: { method: 'GET', url, mode }, respondWith: p => { out = p; } });
    return out;
  };
  // A form POSTed to share-target (what Android's Share menu sends): `form` is { files: [File], title, text, url }.
  const share = (form, site, origin) => {
    let out;
    on.fetch({ request: { method: 'POST', url: 'https://app.test/share-target', mode: 'navigate', headers: { get: k => (k.toLowerCase() === 'sec-fetch-site' ? site ?? null : k.toLowerCase() === 'origin' ? origin ?? null : null) }, formData: async () => { if (form === 'broken') throw new Error('no body'); return { getAll: k => (k === 'files' ? form.files || [] : []), get: k => form[k] ?? null }; } }, respondWith: p => { out = p; } });
    return out;
  };
  const activate = () => { let p; on.activate({ waitUntil: x => { p = x; } }); return p; };
  return { ctx, caches, fetched, request, share, activate, current: vm.runInContext('CACHE', ctx) };
}
const good = tag => ({ ok: true, type: 'cors', tag });

test('keepLibraries copies pinned libraries from the newest old cache only', async () => {
  const stores = new Map([
    ['study-sprint-v10', new Map([[KATEX + 'katex.mjs', good('ancient')], [KATEX + 'only-in-ancient.js', good('x')]])],
    ['study-sprint-v66', new Map([[KATEX + 'katex.mjs', good('v66')]])]
  ]);
  const { ctx, caches } = boot(stores);
  const into = await caches.open(CACHE_NAME);
  await ctx.keepLibraries(into);
  assert.equal((await into.match(KATEX + 'katex.mjs')).tag, 'v66');
  assert.equal(await into.match(KATEX + 'only-in-ancient.js'), undefined, 'older caches are not read');
});

test('keepLibraries skips opaque and failed responses, and URLs this release no longer pins', async () => {
  const keep = [KATEX + 'katex.min.css', KATEX + 'fonts/KaTeX_Main-Regular.woff2', JS + 'ts-fsrs@5.4.2/dist/index.mjs',
    JS + 'fflate@0.8.2/esm/browser.js'];
  const drop = [
    [KATEX + 'katex.mjs', { ok: false, type: 'cors', status: 404 }],
    [KATEX + 'fonts/KaTeX_Math-Italic.woff2', { ok: false, type: 'opaque' }],
    [JS + 'katex@0.16.0/dist/katex.mjs', good('older katex version')],
    [JS + 'ts-fsrs@5.0.0/dist/index.mjs', good('older ts-fsrs')],
    [JS + 'some-other-package@1.0.0/index.js', good('never pinned')],
    ['https://fonts.gstatic.com/s/geist/v1/a.woff2', good('Google Fonts is not used any more')],
    ['https://unpkg.com/anything@1/x.js', good('other host')]
  ];
  const opaque = KATEX + 'fonts/KaTeX_Size1-Regular.woff2';
  const stores = new Map([['study-sprint-v66', new Map([...keep.map(u => [u, good(u)]), ...drop, [opaque, { ok: false, type: 'opaque' }]])]]);
  const { ctx, caches } = boot(stores);
  const into = await caches.open(CACHE_NAME);
  await ctx.keepLibraries(into);
  for (const u of keep) assert.equal((await into.match(u))?.tag, u, 'kept ' + u);
  for (const [u] of drop) assert.equal(await into.match(u), undefined, 'left behind ' + u);
  assert.equal(await into.match(opaque), undefined);
});

test('keepLibraries does not overwrite what is already saved, and survives a broken cache', async () => {
  const stores = new Map([['study-sprint-v66', new Map([[KATEX + 'katex.min.css', good('old')]])], [CACHE_NAME, new Map([[KATEX + 'katex.min.css', good('new')]])]]);
  const { ctx, caches } = boot(stores);
  const into = await caches.open(CACHE_NAME);
  await ctx.keepLibraries(into);
  assert.equal((await into.match(KATEX + 'katex.min.css')).tag, 'new');
  ctx.caches.keys = async () => { throw new Error('storage gone'); };
  await ctx.keepLibraries(into);          // does not throw
});

test('jsdelivr is matched ignoring ?search (an old ?again=2 address is still the saved file)', async () => {
  const stores = new Map([[CACHE_NAME, new Map([[KATEX + 'katex.mjs', good('saved')]])]]);
  const { request, fetched } = boot(stores);
  assert.equal((await request(KATEX + 'katex.mjs?again=2')).tag, 'saved');
  assert.equal((await request(KATEX + 'katex.mjs')).tag, 'saved');
  assert.equal(fetched.length, 0);
  // other hosts are matched exactly
  stores.get(CACHE_NAME).set('https://unpkg.com/x@1/a.js', good('unpkg'));
  assert.equal((await request('https://unpkg.com/x@1/a.js?v=2')).from, 'network');
  assert.equal(fetched.length, 1);
});

test('a saved opaque copy does not answer a cors request (module and stylesheet loads)', async () => {
  const url = KATEX + 'katex.min.css';
  const stores = new Map([[CACHE_NAME, new Map([[url, { ok: false, type: 'opaque', tag: 'opaque' }]])]]);
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

// ---------- a branch that changes app files must not reuse the CACHE name that main already shipped ----------
import { execFileSync } from 'node:child_process';
test("CACHE differs from origin/main's when the app files differ from it", t => {
  let main;
  try { main = execFileSync('git', ['show', 'origin/main:sw.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { t.skip('git or origin/main is not available'); return; }
  const mainCache = main.match(/const CACHE = '([^']+)'/)?.[1], mainHash = main.match(/files-hash: (\w+)/)?.[1];
  if (!mainCache || !mainHash) { t.skip("could not read origin/main's sw.js"); return; }
  if (computeHash() === mainHash) return;                       // the app files are the same as main's: nothing to bump
  assert.notEqual(CACHE_NAME, mainCache, `app files differ from origin/main but CACHE is still ${mainCache}: bump it in sw.js`);
});

// ---------- Share → Study Sprint (Android Web Share Target) ----------
const SHARED = 'study-sprint-share';
const kept = async (stores, name) => { const r = stores.get(SHARED)?.get('https://app.test/share-target/' + name); return r && { r, json: name === 'text' ? await r.clone().json() : null }; };

test('a shared file is kept (with its name and time) and the person is sent on to the Add cards screen', async () => {
  const stores = new Map();
  const { share } = boot(stores);
  const file = new File(['%PDF-1.4'], 'notes lecture.pdf', { type: 'application/pdf' });
  const res = await share({ files: [file] });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://app.test/#/import/share');
  const f = await kept(stores, 'file');
  assert.equal(decodeURIComponent(f.r.headers.get('x-name')), 'notes lecture.pdf');
  assert.ok(Date.now() - Number(f.r.headers.get('x-at')) < 5000);
  assert.equal(await kept(stores, 'text'), undefined);
});

test('shared text is kept as a note, and a new share replaces the old one', async () => {
  const stores = new Map();
  const { share } = boot(stores);
  await share({ files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] });
  await share({ title: 'T', text: 'Cell - unit of life', url: '' });
  assert.equal(await kept(stores, 'file'), undefined, 'the older file is gone');
  const t = await kept(stores, 'text');
  assert.equal(t.json.text, 'Cell - unit of life');
  assert.ok(t.json.at > 0);
});

test('a shared file over 50 MB is not kept: a "too big" note instead', async () => {
  const stores = new Map();
  const { share } = boot(stores);
  const big = { name: 'huge.pdf', type: 'application/pdf', size: 51 * 1024 * 1024 };
  const res = await share({ files: [big] });
  assert.equal(res.status, 303);
  assert.equal(await kept(stores, 'file'), undefined);
  assert.equal((await kept(stores, 'text')).json.tooBig, 'huge.pdf');
});

test('a share the worker cannot read still ends on the screen, with a "failed" note', async () => {
  const stores = new Map();
  const { share } = boot(stores);
  const res = await share('broken');
  assert.equal(res.status, 303);
  assert.equal((await kept(stores, 'text')).json.failed, true);
});

test('an app update keeps a share that is waiting (the share cache is not an app cache)', async () => {
  const stores = new Map([[SHARED, new Map([['https://app.test/share-target/text', good('waiting')]])], ['study-sprint-v1', new Map()]]);
  const { activate } = boot(stores);
  await activate();
  assert.ok(stores.has(SHARED), 'the share is kept');
  assert.ok(!stores.has('study-sprint-v1'), 'old app caches are still thrown away');
});

test('a share POSTed from another site is not taken: it goes to the app with nothing kept', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const stores = new Map();
    const { share } = boot(stores);
    const res = await share({ files: [], title: 'Evil', text: 'cards from a stranger' }, site);
    assert.equal(res.status, 303, site);
    assert.equal(res.headers.get('location'), 'https://app.test/', site + ': to the app, not the share screen');
    assert.equal(await kept(stores, 'text'), undefined, site + ': nothing is kept');
    assert.equal(await kept(stores, 'file'), undefined);
  }
});

test('a share from the phone itself (none), from the app (same-origin) or from a browser without the header is taken', async () => {
  for (const site of ['none', 'same-origin', undefined]) {
    const stores = new Map();
    const { share } = boot(stores);
    const res = await share({ files: [], title: 'Cells', text: 'Cell - unit of life' }, site);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /#\/import\/share$/);
    assert.equal((await kept(stores, 'text')).json.text, 'Cell - unit of life', String(site));
  }
});

test('when the browser does not show Sec-Fetch-Site to the worker (Chromium), the Origin of the post decides', async () => {
  const cases = [['https://evil.example', false], ['http://app.test', false], ['https://app.test', true], [null, true], ['null', true]];
  for (const [origin, taken] of cases) {
    const stores = new Map();
    const { share } = boot(stores);
    const res = await share({ files: [], title: 'T', text: 'from ' + origin }, undefined, origin);
    assert.equal(res.status, 303);
    assert.equal(!!(await kept(stores, 'text')), taken, String(origin));
    assert.equal(/#\/import\/share$/.test(res.headers.get('location')), taken, String(origin));
  }
});
