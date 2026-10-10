// Study Sprint offline support.
// - The app's own files load from the network first, so updates show up right away when you're online,
//   and fall back to the saved copy when you're offline.
// - Fonts and CDN libraries are saved the first time they load and then always come from the saved copy
//   (their addresses include a pinned version number, so they never change).
//
// When you change the list of files below, bump the version in CACHE so phones throw the old copy away.
const CACHE = 'study-sprint-v22';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/autograde.js', 'js/browse.js', 'js/browse-logic.js', 'js/anki.js', 'js/anki-read.js', 'js/sync-data.js', 'js/sync-merge.js', 'js/sync.js', 'js/sync-config.js', 'js/supa.js', 'js/password.js', 'js/days.js', 'js/db.js', 'js/decks.js', 'js/game.js', 'js/import.js', 'js/import-screen.js', 'js/jlpt.js', 'js/match.js',
  'js/play.js', 'js/queue.js', 'js/review.js', 'js/sample.js', 'js/sched-settings.js', 'js/srs.js', 'js/stats.js', 'js/stats-calc.js', 'js/themes.js', 'js/ui.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
// The scheduling library, saved at install so reviews work offline from the first launch.
// Saved separately so a slow CDN can't stop the rest from installing.
const PRELOAD = ['https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs'];
const CACHE_FIRST_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cdn.sheetjs.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(CORE);
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
    // cache: 'no-cache' makes the browser check GitHub for a newer file every time instead of reusing
    // its own copy (GitHub lets browsers keep copies for 10 minutes, which delayed updates).
    const fresh = new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    e.respondWith(
      fetch(fresh).then(save).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    );
  } else if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(save)));
  }
});
