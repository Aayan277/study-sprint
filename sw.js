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
const CACHE = 'study-sprint-v108';
// files-hash: f4093062bb27e231
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css', 'css/clinical.css',
  'js/app.js', 'js/note-fields.js', 'js/reverse.js', 'js/autograde.js', 'js/browse.js', 'js/browse-logic.js', 'js/anki.js', 'js/anki-read.js', 'js/sync-data.js', 'js/sync-merge.js', 'js/sync.js', 'js/sync-config.js', 'js/sidebar.js', 'js/supa.js', 'js/password.js', 'js/export.js', 'js/exam.js', 'js/exam-sheet.js', 'js/fsrs-data.js', 'js/fsrs-fit.js', 'js/fit-health.js', 'js/health-sheet.js', 'js/retention-sim.js', 'js/retention-sheet.js', 'js/worker-job.js', 'js/fsrs7-model.js', 'js/fsrs7-sched.js', 'js/srs7.js', 'js/fsrs-optimize-worker.js', 'js/optimize-sheet.js', 'js/format.js', 'js/cloze.js', 'js/occlusion.js', 'js/occlusion-view.js', 'js/occlusion-editor.js', 'js/card-editor.js', 'js/media.js', 'js/panel-resize.js', 'js/audio.js', 'js/audio-type.js', 'js/backup-nudge.js', 'js/speech.js', 'js/balance.js', 'js/deck-tree.js', 'js/deck-picker.js', 'js/days.js', 'js/db.js', 'js/decks.js', 'js/game.js', 'js/import.js', 'js/import-screen.js', 'js/jlpt.js', 'js/match.js', 'js/steps.js', 'js/confusion.js', 'js/scratchpad.js', 'js/answer-diff.js', 'js/math.js', 'js/tag-tree.js', 'js/tag-study-sheet.js', 'js/postpone.js', 'js/postpone-sheet.js', 'js/accept.js', 'js/glossary.js', 'js/glossary-view.js', 'js/glossary-sheet.js', 'js/glossary-list.js',
  'js/fx.js', 'js/captcha.js', 'js/captcha-frame.html', 'js/quota.js', 'js/sync-push.js', 'js/sync-quota.js', 'js/media-sweep.js', 'js/lazy-media.js', 'js/play.js', 'js/queue.js', 'js/review.js', 'js/today.js', 'js/study-data.js', 'js/onboarding.js', 'js/install.js', 'js/sample.js', 'js/sched-settings.js', 'js/srs.js', 'js/stats.js', 'js/stats-calc.js', 'js/streak-sheet.js', 'js/rescue-sheet.js', 'js/empty-state.js', 'js/finish-extras.js', 'js/themes.js', 'js/ui.js', 'js/nav.js', 'js/compare-sheet.js', 'js/leech-coach.js', 'js/leech-logic.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/icon-monochrome-512.png', 'icons/icon.svg', 'icons/favicon.svg', 'icons/apple-touch-icon.png'
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
  'https://cdn.jsdelivr.net/npm/fflate@0.8.2/', 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/', 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/',
  'https://cdn.sheetjs.com/xlsx-0.20.3/'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const CACHE_FIRST_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'cdn.sheetjs.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    // cache: 'reload' skips the browser's own saved copies (GitHub lets those live for 10 minutes), so a new
    // version never installs half old files.
    await Promise.all(CORE.map(file => c.add(new Request(file, { cache: 'reload' }))));
    await Promise.all(PRELOAD.map(url => c.add(url).catch(() => {})));
    await keepLibraries(c);
  }).then(() => self.skipWaiting()));
});

// A new CACHE name starts empty, but the libraries (maths, fonts...) were saved the first time they were used and may be
// needed offline: copy them over from the newest old copy before the old ones are thrown away. Only what this release
// still uses is copied (PINNED and the fonts), and only good responses: an "opaque" one (saved from a no-cors request, so it
// can't be checked and can't answer a cors request) or a failed one is left behind.
const stillUsed = url => {
  const u = new URL(url);
  return FONT_HOSTS.includes(u.hostname) || PINNED.some(p => url.startsWith(p));
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
