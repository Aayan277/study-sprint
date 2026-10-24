// Study Sprint offline support.
// - The app's own files come from the saved copy straight away (so the app opens fast even on a slow connection),
//   and are checked against the network in the background, so the next visit has any update.
//   A new version of this file (bump CACHE) also installs a fresh copy of everything and the app reloads once to use it,
//   waiting for unsaved work first: see js/update.js.
// - CDN libraries are saved the first time they load and then always come from the saved copy
//   (their addresses include a pinned version number, so they never change).
//
// Bump CACHE on every release that changes any app file, so phones throw the old copy away (not only when the
// list of files below changes: old and new modules would mix). tests/sw.test.js fails until you do, and
// `node tests/update-sw-hash.mjs` then saves the new fingerprint of the app files here.
const CACHE = 'study-sprint-v130';
// files-hash: 74764f69d55097bf
const CORE = [
  './', 'index.html', 'privacy.html', 'terms.html', 'manifest.webmanifest', 'css/styles.css', 'css/clinical.css',
  'js/app.js', 'js/sync-state.js', 'js/settings.js', 'js/math-watch.js', 'js/card-checks.js', 'js/help.js', 'js/whats-new.js', 'js/note-fields.js', 'js/reverse.js', 'js/autograde.js', 'js/browse.js', 'js/browse-logic.js', 'js/anki.js', 'js/anki-template.js', 'js/anki-read.js', 'js/anki-match.js', 'js/sync-data.js', 'js/sync-merge.js', 'js/sync.js', 'js/sync-config.js', 'js/sidebar.js', 'js/supa.js', 'js/password.js', 'js/export.js', 'js/share-deck.js', 'js/share-logic.js', 'js/exam.js', 'js/exam-sheet.js', 'js/fsrs-data.js', 'js/fsrs-fit.js', 'js/fit-health.js', 'js/health-sheet.js', 'js/retention-sim.js', 'js/retention-sheet.js', 'js/worker-job.js', 'js/fsrs7-model.js', 'js/fsrs7-sched.js', 'js/srs7.js', 'js/fsrs-optimize-worker.js', 'js/optimize-sheet.js', 'js/format.js', 'js/cloze.js', 'js/occlusion.js', 'js/occlusion-view.js', 'js/occlusion-editor.js', 'js/card-editor.js', 'js/media.js', 'js/panel-resize.js', 'js/audio.js', 'js/audio-type.js', 'js/backup-nudge.js', 'js/speech.js', 'js/balance.js', 'js/deck-tree.js', 'js/deck-picker.js', 'js/days.js', 'js/db.js', 'js/decks.js', 'js/game.js', 'js/import.js', 'js/import-screen.js', 'js/doc-import.js', 'js/match.js', 'js/type-in.js', 'js/steps.js', 'js/confusion.js', 'js/scratchpad.js', 'js/answer-diff.js', 'js/math.js', 'js/tag-tree.js', 'js/tag-study-sheet.js', 'js/postpone.js', 'js/postpone-sheet.js', 'js/accept.js', 'js/glossary.js', 'js/glossary-view.js', 'js/glossary-sheet.js', 'js/glossary-list.js', 'js/update.js', 'js/app-config.js', 'js/keywords.js', 'js/reading-cards.js', 'js/reading-suggest.js', 'js/keywords-job.js', 'js/keywords-worker.js', 'js/autotag.js', 'js/autotag-sheet.js',
  'js/fx.js', 'js/captcha.js', 'js/captcha-frame.html', 'js/quota.js', 'js/sync-push.js', 'js/sync-quota.js', 'js/media-sweep.js', 'js/recorder.js', 'js/recorder-logic.js', 'js/lazy-media.js', 'js/play.js', 'js/practice-save.js', 'js/mock-exam.js', 'js/mock-exam-logic.js', 'js/mock-exam-sheet.js', 'js/mock-exam-store.js', 'js/queue.js', 'js/review.js', 'js/today.js', 'js/study-data.js', 'js/onboarding.js', 'js/install.js', 'js/reminders.js', 'js/badge.js', 'js/badge-logic.js', 'js/ics.js', 'js/sample.js', 'js/sched-settings.js', 'js/srs.js', 'js/stats.js', 'js/stats-calc.js', 'js/streak-sheet.js', 'js/rescue-sheet.js', 'js/empty-state.js', 'js/finish-extras.js', 'js/themes.js', 'js/ui.js', 'js/stats-layout-sheet.js', 'js/stats-edit.js', 'js/stats-layout.js', 'js/import-draft.js', 'js/a11y.js', 'js/shortcuts.js', 'js/nav.js', 'js/compare-sheet.js', 'js/leech-coach.js', 'js/leech-logic.js', 'js/legal.js', 'js/legal-theme.js', 'js/legal-page.js',
  'fonts/geist-latin.woff2', 'fonts/geist-latin-ext.woff2', 'fonts/geist-cyrillic.woff2', 'fonts/geist-cyrillic-ext.woff2', 'fonts/geist-vietnamese.woff2',
  'icons/icon-192.png', 'icons/icon-monochrome-512.png', 'icons/icon.svg', 'icons/favicon.svg', 'icons/apple-touch-icon.png'
];
// The scheduling library, saved at install so reviews work offline from the first launch.
// Saved separately so a slow CDN can't stop the rest from installing.
const PRELOAD = ['https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs'];
// Everything else the app loads from a CDN, at the pinned versions of this release (js/math.js, js/anki-read.js,
// js/import-screen.js). Only these are carried over from an old cache (see keepLibraries). tests/sw.test.js checks that
// every versioned CDN address in js/ starts with one of them.
const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/';
const PINNED = [
  ...PRELOAD, KATEX_BASE,
  'https://cdn.jsdelivr.net/npm/fflate@0.8.2/', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/', 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/', 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/',
  'https://cdn.sheetjs.com/xlsx-0.20.3/'
];
// What was shared to the app (Android's Share menu) waits here for a moment, between the worker and the Add cards screen. Not a copy of
// any app file, so it is kept when the app updates (see activate) and emptied when the cards are saved, or replaced by the next share.
const SHARE_CACHE = 'study-sprint-share';
const MAX_SHARE_BYTES = 50 * 1024 * 1024;      // as the Add cards screen's limit for a file
const CACHE_FIRST_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cdn.sheetjs.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    // cache: 'no-cache' makes the browser ask the server about every file before using its own saved copy (GitHub lets those
    // live for 10 minutes), so a new version never installs half old files. Unlike 'reload' it only downloads the file again
    // when it changed: files the page has just fetched come back as a tiny "304 Not Modified".
    await Promise.all(CORE.map(file => c.add(new Request(file, { cache: 'no-cache' }))));
    await Promise.all(PRELOAD.map(url => c.add(url).catch(() => {})));
    await keepLibraries(c);
  }).then(takeOverUnlessPagesWait));
});

// A new version used to take over the moment it was installed, and the open page reloaded itself. That could throw away a card being edited
// or a round in progress. Now each open page is asked (a message on its own channel) whether it will look after the switch itself: the
// new version waits, and the page sends 'skip-waiting' at a good moment (js/update.js). If no page is open, or one doesn't answer in
// time (an older copy of the app, still open on a phone), the new version takes over at once, as before.
async function takeOverUnlessPagesWait() {
  let handled = false;
  try {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    handled = pages.length > 0 && (await Promise.all(pages.map(page => new Promise(done => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => done(false), 500);
      ch.port1.onmessage = e => { clearTimeout(timer); done(e.data?.handled === true); };
      try { page.postMessage({ type: 'update-handled-by-page?' }, [ch.port2]); } catch { clearTimeout(timer); done(false); }
    })))).every(Boolean);
  } catch { handled = false; }
  if (!handled) await self.skipWaiting();
}
// A page asks the waiting version to take over. Taking over throws away the old files, so every OTHER open page is asked first
// ('ok-to-switch?' on its own channel): a page in the middle of a round or an edit says no, and then the new version keeps waiting and
// every page is told ('update-held') so each shows "Update ready". A page that doesn't answer in time (an older copy of the app, still open
// on a phone: it has no such question) counts as agreeing, as before.
async function everyoneAgrees(except) {
  try {
    const pages = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(page => page.id !== except);      // (the page that asked has decided: it may be busy and have been tapped)
    const said = await Promise.all(pages.map(page => new Promise(done => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => done(true), 500);
      ch.port1.onmessage = e => { clearTimeout(timer); done(e.data?.ok !== false); };
      try { page.postMessage({ type: 'ok-to-switch?' }, [ch.port2]); } catch { clearTimeout(timer); done(true); }
    })));
    return said.every(Boolean);
  } catch { return true; }
}
async function switchIfAgreed(asker) {
  if (await everyoneAgrees(asker)) { self.skipWaiting(); return; }      // (not awaited: skipWaiting() resolves only once the switch is complete)
  try { for (const page of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) page.postMessage({ type: 'update-held' }); } catch { /* the pages ask again at their next quiet moment */ }
}
self.addEventListener('message', e => { if (e.data && e.data.type === 'skip-waiting') e.waitUntil(switchIfAgreed(e.source && e.source.id)); });

// A new CACHE name starts empty, but the libraries (maths...) were saved the first time they were used and may be
// needed offline: copy them over from the newest old copy before the old ones are thrown away. Only what this release
// still uses is copied (PINNED), and only good responses: an "opaque" one (saved from a no-cors request, so it
// can't be checked and can't answer a cors request) or a failed one is left behind.
const stillUsed = url => {
  const u = new URL(url);
  return PINNED.some(p => url.startsWith(p));
};
async function keepLibraries(into) {
  try {
    const version = key => +(/^study-sprint-v(\d+)$/.exec(key)?.[1] ?? -1);
    const old = (await caches.keys()).filter(k => k !== CACHE && version(k) >= 0).sort((a, b) => version(b) - version(a))[0];
    if (!old) return;
    const from = await caches.open(old);
    for (const req of await from.keys()) {
      if (!stillUsed(req.url) || await into.match(req)) continue;
      const res = await from.match(req);
      if (res && res.type !== 'opaque' && res.ok) await into.put(req, res);
    }
  } catch { /* the libraries just download again when they are next used */ }
}

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Share → Study Sprint: Android sends the shared file or text as a form (POST). It is kept in SHARE_CACHE (the first file, and the
// text/link as a small JSON note) and the person is sent on to the Add cards screen (a 303 turns the POST into a GET), which reads it.
// Anything unexpected still ends on that screen, just without the shared content, so a share never lands on an error page.
// A share comes from the phone's own Share menu, which the browser marks Sec-Fetch-Site: none (or same-origin from the app). A form on
// another website can POST here too (cross-site, or same-site from a sibling page): that must not fill the Add cards screen with
// text of the site's choosing, so it is sent to the app with nothing taken. Chromium does not show Sec-Fetch-Site to a service worker
// for a navigation (checked: the header is missing here even for a cross-site form), so when it is absent the Origin header, which a
// form post does carry, is used: an address that is not ours is refused. THIS IS NOT CSRF PROTECTION: a post with no Origin, or the opaque
// "null" origin (the phone's own share may send either, and a sandboxed page can send "null" on purpose), is let through, so a hostile
// page that can produce one of those still gets its text into the Add cards screen. What limits the harm is that screen: it only shows what
// it received as a preview and saves nothing until the person says so.
const shareIsOurs = req => {
  const h = name => (req.headers && req.headers.get && req.headers.get(name)) || '';
  const site = h('Sec-Fetch-Site');
  if (site) return site === 'none' || site === 'same-origin';
  const origin = h('Origin');
  return !origin || origin === 'null' || origin === location.origin;
};
async function takeShare(req) {
  if (!shareIsOurs(req)) return Response.redirect(new URL('./', self.registration.scope).href, 303);
  try {
    const form = await req.formData();
    const c = await caches.open(SHARE_CACHE);
    for (const k of await c.keys()) await c.delete(k);
    const at = Date.now();                    // the screen ignores a share older than 10 minutes
    const file = form.getAll('files').find(f => typeof f === 'object' && f && typeof f.name === 'string' && f.size > 0);
    const note = body => c.put(new URL('share-target/text', self.registration.scope), new Response(JSON.stringify({ at, ...body }), { headers: { 'content-type': 'application/json' } }));
    if (file && file.size > MAX_SHARE_BYTES) await note({ tooBig: file.name });                   // not kept: the screen says it is too big
    else if (file) await c.put(new URL('share-target/file', self.registration.scope), new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name), 'x-at': String(at) } }));
    else await note({ title: String(form.get('title') || ''), text: String(form.get('text') || ''), url: String(form.get('url') || '') });
  } catch {
    // The form couldn't be read or kept (storage full…): the screen says so instead of showing nothing.
    try { await (await caches.open(SHARE_CACHE)).put(new URL('share-target/text', self.registration.scope), new Response(JSON.stringify({ at: Date.now(), failed: true }), { headers: { 'content-type': 'application/json' } })); } catch { /* the screen opens without it */ }
  }
  return Response.redirect(new URL('./#/import/share', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).href === new URL('share-target', self.registration.scope).href) { e.respondWith(takeShare(req)); return; }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const save = res => {
    // Only keep good responses (status 200, or "opaque" ones from other sites that we can't inspect).
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  };

  if (url.origin === location.origin) {
    e.respondWith(savedFirst(req));
  } else if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    // jsdelivr addresses carry the version, so a query string (an old "?again=2" retry) never means a different file.
    // A saved "opaque" copy can't answer a cors request (the module and stylesheet loads ask with cors), so that one is fetched again.
    const find = caches.match(req, { ignoreSearch: url.hostname === 'cdn.jsdelivr.net' });
    e.respondWith(find.then(r => (r && !(r.type === 'opaque' && req.mode === 'cors') ? r : fetch(req).then(save))));
  }
});

// Our own files: answer from the saved copy of THIS version only. Every file of a release is saved together when the
// worker installs (a new CACHE name for each release), so the files in use always belong to the same version. An
// earlier version refreshed each file on its own in the background, which could mix a new file with an old one
// after a big update ("Importing binding name ... is not found"). Updates now arrive only as a whole new worker.
// A file that isn't saved yet (or a page with nothing saved) comes from the network; offline, the app shell is shown.
async function savedFirst(req) {
  const saved = await caches.match(req, { ignoreSearch: true });
  if (saved) return saved;
  try {
    const res = await fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  } catch (err) {
    if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
    throw err;
  }
}
