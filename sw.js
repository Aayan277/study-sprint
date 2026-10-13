// Study Sprint offline support.
// - The app's own files come from the saved copy straight away (so the app opens fast even on a slow connection),
//   and are checked against the network in the background, so the next visit has any update.
//   A new version of this file (bump CACHE) also installs a fresh copy of everything and reloads the app once:
//   see the "controllerchange" part of js/app.js.
// - Fonts and CDN libraries are saved the first time they load and then always come from the saved copy
//   (their addresses include a pinned version number, so they never change).
//
// Bump CACHE on every release that changes any app file, so phones throw the old copy away (not only when the
// list of files below changes: old and new modules would mix). tests/sw.test.js fails until you do, and
// `node tests/update-sw-hash.mjs` then saves the new fingerprint of the app files here.
const CACHE = 'study-sprint-v60';
// files-hash: b52a5f7e98be07be
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/autograde.js', 'js/browse.js', 'js/browse-logic.js', 'js/anki.js', 'js/anki-read.js', 'js/sync-data.js', 'js/sync-merge.js', 'js/sync.js', 'js/sync-config.js', 'js/sidebar.js', 'js/supa.js', 'js/password.js', 'js/export.js', 'js/exam.js', 'js/exam-sheet.js', 'js/format.js', 'js/cloze.js', 'js/occlusion.js', 'js/occlusion-view.js', 'js/occlusion-editor.js', 'js/card-editor.js', 'js/media.js', 'js/speech.js', 'js/balance.js', 'js/deck-tree.js', 'js/deck-picker.js', 'js/days.js', 'js/db.js', 'js/decks.js', 'js/game.js', 'js/import.js', 'js/import-screen.js', 'js/jlpt.js', 'js/match.js',
  'js/fx.js', 'js/play.js', 'js/queue.js', 'js/review.js', 'js/today.js', 'js/study-data.js', 'js/onboarding.js', 'js/install.js', 'js/sample.js', 'js/sched-settings.js', 'js/srs.js', 'js/stats.js', 'js/stats-calc.js', 'js/themes.js', 'js/ui.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/icon-monochrome-512.png', 'icons/icon.svg', 'icons/favicon.svg', 'icons/apple-touch-icon.png'
];
// The scheduling library, saved at install so reviews work offline from the first launch.
// Saved separately so a slow CDN can't stop the rest from installing.
const PRELOAD = ['https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs'];
const CACHE_FIRST_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cdn.sheetjs.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    // cache: 'reload' skips the browser's own saved copies (GitHub lets those live for 10 minutes), so a new
    // version never installs half old files.
    await Promise.all(CORE.map(file => c.add(new Request(file, { cache: 'reload' }))));
    await Promise.all(PRELOAD.map(url => c.add(url).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const save = res => {
    // Only keep good responses (status 200, or "opaque" ones from other sites that we can't inspect).
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  };

  if (url.origin === location.origin) {
    e.respondWith(savedThenUpdate(e, req));
  } else if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(save)));
  }
});

// Our own files: answer from the saved copy at once, and fetch a fresh copy in the background for next time.
// cache: 'no-cache' makes the browser ask GitHub whether the file changed instead of reusing its own copy.
// With nothing saved yet (or no saved copy of a page), wait for the network, and when offline show the app.
async function savedThenUpdate(e, req) {
  const saved = await caches.match(req, { ignoreSearch: true });
  const fresh = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(async res => {
    if (res.ok) await (await caches.open(CACHE)).put(req, res.clone());
    return res;
  });
  if (saved) {
    e.waitUntil(fresh.catch(() => {}));      // keep the worker alive until the background copy is saved
    return saved;
  }
  try { return await fresh; } catch (err) {
    if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
    throw err;
  }
}
