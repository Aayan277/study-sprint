// Study Sprint: starts the app and switches between screens. (The Settings screen is in js/settings.js.)
//
// Navigation uses the part of the address after "#", e.g. ".../#/decks" or ".../#/deck/abc123".
// That way the phone's back gesture and the browser's back button work as expected.

import * as db from './db.js';
import { applyTheme, syncBrowserBar, skinButtonsHTML, applyCardAlign, accentTitle } from './themes.js';
import { renderToday } from './today.js';
import { addSampleDeck } from './sample.js';
import { initInstall } from './install.js';
import { initPanelResize } from './panel-resize.js';
import { takeDraft } from './import-draft.js';
import { $, esc, toast, openSheet, closeSheet, stashDraft, initSheet, initTapGuard, setFocusMode, sheetDirty } from './ui.js';
import * as sync from './sync.js';
import { initWhatsNew } from './whats-new.js';
import { takeLaunch } from './study-data.js';
import { configureShortcuts } from './shortcuts.js';
import * as fx from './fx.js';
import { initBadge } from './badge.js';
import { initSidebar, drawSidebar, drawSync as drawSideSync, markCurrent } from './sidebar.js';
import { watchMath } from './math-watch.js';
import { go as navGo, replace as navReplace, initNav, rewrite, releaseBack, whenIdle } from './nav.js';
import { initUpdates, showUpdateRequired } from './update.js';
import { fetchMinClient, rememberMinClient, cachedMinClient, isTooOld, holdSync, syncHeld, setSyncGate } from './app-config.js';

// Shown in Settings → About, so you can tell whether your phone has the newest version.
const APP_VERSION = '4.49';

let settings = { ...db.DEFAULT_SETTINGS };
let updates = null;       // the update watcher (js/update.js), set up with the service worker at the bottom of this file
initInstall();       // listens for the browser saying the app can be installed (see install.js)

// Stats is slow to draw, so changes from other devices redraw it once after things settle (not once per sync),
// and only while it's showing: if the page is hidden, it redraws when you come back.
let statsTimer = null, statsStale = false;
function redrawStatsSoon() {
  clearTimeout(statsTimer);
  if (document.hidden) { statsStale = true; return; }
  statsTimer = setTimeout(async () => {
    if (currentRoute !== 'stats') return;
    // While Stats is being edited the same box is drawn again (edit mode, the scroll and a held card survive); otherwise a fresh screen.
    try { if ((await lazy('./stats.js')).softRefresh()) return; } catch { /* fall back to a fresh draw */ }
    if (currentRoute === 'stats') route();
  }, 1500);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && statsStale) { statsStale = false; if (currentRoute === 'stats') redrawStatsSoon(); }
});

// The Settings screen and its sheets live in js/settings.js, loaded the first time they are needed. They share the loaded
// settings object, the current screen and a few helpers with this file through this object.
const settingsHost = {
  get settings() { return settings; },
  set settings(v) { settings = v; },
  get currentRoute() { return currentRoute; },
  version: APP_VERSION,
  markOnboarded: () => markOnboarded(),
  seedSampleDeck: again => seedSampleDeck(again)
};
async function loadSettings() {
  const m = await lazy('./settings.js');
  m.init(settingsHost);
  return m;
}

let warnedStale = false;
// After each sync: keep Settings up to date, and redraw the screen if changes came in from another device.
addEventListener('sync', async e => {
  const { state, applied } = e.detail;
  drawSideSync();          // the sidebar's sync line (a draw of the whole sidebar follows below when changes came in)
  if (currentRoute === 'settings') {
    const s = await loadSettings();          // (already loaded: Settings is showing)
    if (state === 'signed-out') s.drawSync(); else { s.showSyncStatus(); if (state === 'done') { s.drawUsage(); s.drawDamaged(); } }
  }
  if (state === 'signed-out' && e.detail.error) toast(e.detail.error);
  if (state === 'error' && !warnedStale) {
    // Failing for days (e.g. the free Supabase project paused): say so once per visit.
    const acct = await sync.account();
    const days = acct?.lastSync ? Math.floor((Date.now() - acct.lastSync) / 86400000) : 0;
    if (days >= 3) { warnedStale = true; toast(`Sync hasn't worked for ${days} days. See Settings → Sync.`); }
  }
  if (state !== 'done' || !applied) return;
  settings = { ...(await db.getSettings()), theme: settings.theme };     // study settings may have changed
  const busy = document.getElementById('sheet')?.open || document.activeElement?.matches?.('input, textarea, select');
  if (currentRoute !== 'today' || busy) drawSidebar();          // (Today hands its own fresh data over when it redraws, unless a sheet or field keeps it from)
  if (busy) return;
  if (currentRoute === 'stats') redrawStatsSoon();
  else if (['today', 'decks', 'deck', 'browse'].includes(currentRoute)) route();
  else if (currentRoute === 'settings') {
    // Redraw Settings in place (keeping your scroll position) so synced study settings show.
    const s = await loadSettings(), view = s.settingsView(), y = scrollY;
    if (view) { await s.renderSettings(view); scrollTo(0, y); }
  }
});

// ---------- first run ----------
// A brand-new install (no decks, cards or reviews, and never opened before) starts with the short
// first-run start in js/onboarding.js instead of a filled-in sample. Anyone with data never sees it.
// To skip it (the browser tests do): set localStorage 'study-sprint-skip-onboarding' to '1', or open the app
// with ?skipOnboarding in the address. Skipping this way adds the sample deck, like the app always used to.
function skipFlag() {
  try { if (localStorage.getItem('study-sprint-skip-onboarding') === '1') return true; } catch { /* no storage: fine */ }
  // The address flag is for local testing only, so a stray link can't switch the first run off on the live site.
  return ['localhost', '127.0.0.1'].includes(location.hostname) && /[?&]skipOnboarding\b/.test(location.search);
}

// Settle what a start-up looks like. Returns true if the first-run start should show.
async function checkFirstRun() {
  if (settings.onboarded) return false;
  // Upgrades: anyone who opened the app before has `seeded` set (the old first-run flag) or has data.
  const hasData = settings.seeded || (await db.getDecks()).length || (await db.getAll('cards')).length || (await db.getAll('reviewLog')).length;
  if (hasData) { await pinOldTheme(true); settings.theme = applyTheme(settings.theme); await markOnboarded(); return false; }
  // A new install saves its theme now (auto: it follows the device), so what it looks like never depends on a default that may change.
  if (skipFlag()) { await db.setSetting('theme', settings.theme); await seedSampleDeck(); await markOnboarded(); await markWhatsNewSeen(); return false; }
  await db.setSetting('theme', settings.theme);
  await markWhatsNewSeen();            // a brand-new install has no "what's new": everything is new to it
  return true;
}
// New installs follow the device's light or dark setting (auto), but an install from before that change was dark without ever saving a choice:
// it stays dark. (getSettings fills in defaults, so the raw store is asked whether a theme was ever saved.)
async function pinOldTheme(known = false) {
  if (await db.get('settings', 'theme') !== undefined) return;
  if (!known && !(settings.onboarded || settings.seeded)) return;
  settings.theme = { ...settings.theme, mode: 'dark' };
  await db.setSetting('theme', settings.theme);
}
async function markWhatsNewSeen() {
  settings.whatsNewSeen = APP_VERSION;
  await db.setSetting('whatsNewSeen', APP_VERSION);
}
async function markOnboarded() {
  if (settings.onboarded) return;
  settings.onboarded = true;
  await db.setSetting('onboarded', true);
}

// Add the sample deck once. A saved flag stops it coming back after you delete it
// (`again`: the person asked for it, e.g. "Try the sample deck" in the first-run start).
async function seedSampleDeck(again = false) {
  if (settings.seeded && !again) return;
  await addSampleDeck();
  settings.seeded = true;
  await db.setSetting('seeded', true);
}

// ---------- navigation ----------
// Loads a screen's file. A failed import() is remembered by the browser until the page reloads (even once you are back online), so after a
// failure the file is asked for again under a new address (?r=...) the next time: the screen can load without pressing Reload.
const busted = new Map();
const lazy = path => import(busted.has(path) ? `${path}?r=${busted.get(path)}` : path).catch(err => { busted.set(path, Date.now()); throw err; });
const ROUTES = {
  // Today is the home screen, so it loads with the app. Every other screen is loaded the first time it is
  // opened (the service worker has them saved, so that is quick), which keeps the first load small.
  // Review also needs the FSRS library from the internet (saved for offline after the first time).
  today: el => renderToday(el),
  welcome: async (el, arg) => (await lazy('./onboarding.js')).renderWelcome(el, arg, { seedSample: () => seedSampleDeck(true), finish: markOnboarded }),
  review: async (el, deckId) => (await lazy('./review.js')).renderReview(el, deckId),
  play: async el => (await lazy('./play.js')).renderPlay(el),
  test: async (el, deckId) => (await lazy('./mock-exam.js')).renderTest(el, deckId),
  decks: async (el, arg) => (await lazy('./decks.js')).renderLibrary(el, arg === 'starters'),
  deck: async (el, id) => (await lazy('./decks.js')).renderDeck(el, id),
  browse: async (el, arg) => (await lazy('./browse.js')).renderBrowseAll(el, arg),
  import: async (el, deckId) => (await lazy('./import-screen.js')).renderImport(el, deckId),
  stats: async el => (await lazy('./stats.js')).renderStats(el),
  settings: async el => (await loadSettings()).renderSettings(el),
  help: async (el, arg) => (await lazy('./help.js')).renderHelp(el, arg)
};

// Remembered so the gear can take you back to where you were.
let currentRoute = null;     // name of the screen showing now, e.g. 'decks'
let beforeSettings = null;   // address of the screen you were on before opening Settings

async function route() {
  const resetLink = takeResetLink();      // opened from a password reset email? (see below)
  const [, name = 'today', arg] = location.hash.match(/^#\/([a-z]+)(?:\/(.+))?/) || [];
  if (name === 'settings' && currentRoute && currentRoute !== 'settings') beforeSettings = beforeSettings || lastHash;
  if (name !== 'settings') beforeSettings = null;
  // Once the start is done, #/welcome goes to Today. Still allowed: the guided review that follows it, and
  // #/welcome/again (the "How it works" link on an empty Today screen), which shows the pitch again.
  if (name === 'welcome' && settings.onboarded && !/^(review\/|again$)/.test(arg || '')) { navReplace('#/today'); return; }
  // Walking out of the first-run start any other way (a link, the back button) counts as skipping it.
  if (currentRoute === 'welcome' && name !== 'welcome') markOnboarded();
  if (name !== 'review') takeLaunch();     // a session handed over to Review that never got there (e.g. it failed to load) must not start later
  const prevRoute = currentRoute;
  currentRoute = name;
  lastHash = location.hash;
  document.body.classList.toggle('welcome', name === 'welcome');       // the first-run start hides the tabs
  // The gear (phones) and the sidebar's Settings link (desktop) double as a close button while Settings is open.
  document.querySelectorAll('a[data-tab="settings"]').forEach(a => a.setAttribute('aria-label', name === 'settings' ? 'Close settings' : 'Settings'));
  const render = ROUTES[name] || ROUTES.today;
  // Highlight the right tab. A deck's page and the import screen count as the Decks tab.
  // (A running Review session counts as Today.)
  const tab = name === 'deck' || name === 'import' || name === 'browse' || name === 'test' ? 'decks' : name === 'review' ? 'today' : name === 'help' ? 'settings' : name;
  document.querySelectorAll('[data-tab]').forEach(t => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  markCurrent();                // the deck page open now, in the sidebar's list
  // After a Review or Play round, or an import, the sidebar's counts are out of date (Today hands over its own fresh data).
  // (A round that finished has already redrawn it; one left half-way, or an import, has not.)
  const sidebarStale = name !== prevRoute && name !== 'today'
    && (prevRoute === 'import' || (['review', 'play', 'test'].includes(prevRoute) && document.body.classList.contains('focus')));
  releaseBack();                // a session's hold on the back gesture ends when you leave it (a running one asks again as it redraws)
  stashDraft();             // unsaved edits in a card panel are kept for when it is opened again
  closeSheet();
  setFocusMode(false);          // a running Review or Play round turns it back on (see ui.js)
  if (sidebarStale) drawSidebar();
  // Each visit to a screen draws into a fresh box. If you switch screens while one is still loading,
  // the old one finishes into its own box, which is no longer on the page, so it can't draw over the new one.
  const el = document.createElement('div');
  el.className = 'view' + fx.enterClass();      // a short fade-up where View Transitions are missing
  $('screen').replaceChildren(el);
  // Which screen this is, for the desktop layout (some screens use the full width: see styles.css).
  $('screen').dataset.route = ROUTES[name] ? name : 'today';
  scrollTo(0, 0);
  try {
    await render(el, arg && decodeURIComponent(arg));
  } catch (err) {
    if (!el.isConnected) return;          // a screen you already left: ignore
    console.error(err);
    setFocusMode(false);                  // a round that failed to draw must not leave the header and tabs hidden
    // A screen's file that couldn't be loaded (offline, or a half-finished update) gets a plain message and a way out.
    if (/dynamically imported module|importing a module script/i.test(err.message)) {
      el.innerHTML = `<div class="empty"><b>Couldn't load this screen.</b><br>Check your connection and reload.<br><button class="btn" type="button" data-reload>Reload</button></div>`;
      el.querySelector('[data-reload]').onclick = () => location.reload();
      // Back online while this message is still showing: load the screen again by itself.
      addEventListener('online', () => { if (el.isConnected) route(); }, { once: true });
      return;
    }
    el.innerHTML = `<div class="empty"><b>Something went wrong.</b><br>${esc(err.message || err)}</div>`;
  }
  if (el.isConnected) { scrollTo(0, 0); announceScreen(el, name); updates?.routed(name); }
  // #/settings/sync (the welcome page's "Sign in" link, the sidebar, the email-confirmed sheet): land on the Sync section, after the
  // scroll to the top above. Focus goes to its heading, not the email box, so a phone doesn't open its keyboard.
  if (el.isConnected && name === 'settings' && arg === 'sync' && $('syncTitle')) {
    const t = $('syncTitle');
    t.tabIndex = -1;
    t.scrollIntoView({ block: 'start' });
    t.focus({ preventScroll: true });
  }      // (an update waiting for a quiet moment restarts the app on Today or Decks)
  if (resetLink) showResetLink(resetLink);
}

// Tell screen readers the screen changed: the page title follows the screen (a deck shows its own name) and
// focus moves to the screen's main heading.
const SCREEN_NAMES = { today: 'Today', decks: 'Decks', deck: 'Deck', browse: 'All cards', import: 'Add cards', review: 'Review', play: 'Play', test: 'Practice test', stats: 'Stats', settings: 'Settings', help: 'Help', welcome: 'Welcome' };
let firstScreen = true;
function announceScreen(el, name) {
  const h1 = el.querySelector('h1');
  const title = name === 'welcome' ? SCREEN_NAMES.welcome : h1?.textContent.trim() || SCREEN_NAMES[name] || 'Today';
  document.title = `${title} · Study Sprint`;
  const first = firstScreen;
  firstScreen = false;
  // Not on the very first load, and not during a Review or Play round (they manage focus themselves).
  if (first || !h1 || document.body.classList.contains('focus')) return;
  h1.tabIndex = -1;
  // Next frame, not now: focusing makes the browser work out the whole new screen's layout on the spot (50-130 ms on a phone);
  // a frame later it has done that for the paint anyway. (Skipped if the screen was already replaced.)
  // Only if nothing has taken focus in the meantime (the person tapped or typed, a sheet opened) and Review/Play haven't started.
  const before = document.activeElement;
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (h1.isConnected && (now === before || now === document.body) && !document.body.classList.contains('focus')) h1.focus({ preventScroll: true });
  });
}

let lastHash = '#/today';

// Tapping the gear while Settings is open closes it and returns to the previous screen.
// (The gear in the phone header and the Settings link in the desktop sidebar both count.)
function wireGear() {
  // Tapping the Play tab on a Play screen that is already showing (e.g. the results) starts a fresh setup:
  // the address does not change, so there is no hashchange to do it.
  document.addEventListener('click', e => {
    if (!e.target.closest('a[data-tab="play"]') || e.defaultPrevented) return;
    if (currentRoute === 'play' && location.hash === '#/play') { e.preventDefault(); route(); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('a[data-tab="settings"]') || e.defaultPrevented) return;
    if (currentRoute !== 'settings') return;           // not open: the link opens Settings as normal
    e.preventDefault();
    navGo(beforeSettings || '#/today');                    // back to the screen you opened Settings from (or home)
  });
}

// ---------- password reset links ----------
// A "reset your password" email opens the app with a sign-in after the # (see parseAuthLink in sync-merge.js).
// Take it out of the address straight away (and keep it for this tab, in case the app reloads to update).
function takeResetLink() {
  const link = sync.recoveryFromLink();
  if (!link) return null;
  rewrite('#/settings');
  if (link.session) { try { sessionStorage.setItem('resetLink', JSON.stringify(link)); } catch { /* fine without */ } }
  return link;
}
function keptResetLink() {
  try { return JSON.parse(sessionStorage.getItem('resetLink') || 'null'); } catch { return null; }
}
let resetShown = false;
async function showResetLink(link) {
  resetShown = true;
  const forget = () => { try { sessionStorage.removeItem('resetLink'); } catch { /* ignore */ } };
  if (link.error) { forget(); toast(link.error); return; }
  if (link.confirmed) {
    forget();
    // The address is confirmed: keep it for the Sync form's email box, but it is no longer "waiting".
    const wait = (await db.getSettings()).pendingSignup;
    if (wait) await db.setSetting('pendingSignup', { ...wait, confirmed: true });
    openSheet(`
      <h2 id="sheetTitle">Email confirmed</h2>
      <p>Your account is ready. Sign in with your email and password to start syncing.</p>
      <p class="note">Made the account in the Study Sprint app on your home screen? Open it there and sign in. This link may have opened in a different browser.</p>
      <div class="sheet-actions"><button class="btn ghost" type="button" id="cfLater">Not now</button><button class="btn primary" type="button" id="cfSignIn">Sign in</button></div>`);
    $('cfSignIn').focus();
    $('cfLater').addEventListener('click', closeSheet);
    $('cfSignIn').addEventListener('click', () => { closeSheet(); navGo('#/settings/sync'); });
    return;
  }
  // Show whose account the link is for, and refuse a link for a different account than this device's.
  let user;
  try { user = await sync.lookUpResetLink(link.session); } catch (err) {
    if (err.code !== 'offline') forget();   // offline: keep the link for this tab, so reopening the app tries again
    toast(err.message);
    return;
  }
  let result;
  (await loadSettings()).openPasswordSheet({
    title: 'Set a new password',
    intro: `<p class="note" style="margin-top:0">Set a new password for <b>${esc(user.email)}</b>. Then use it to sign in on your other devices.</p>`,
    save: async pw => { result = await sync.finishPasswordReset(link.session, pw); forget(); },
    done: () => result.signedIn ? 'Password saved. You\'re signed in.'
      : `Password saved for ${result.email}. To sync this device with that account, sign in from Settings → Sync.`
  });
  // Cancelling just closes it; the link can't be used again after that.
  $('pwCancel')?.addEventListener('click', forget);
}

// ---------- start up ----------
// Pictures and sounds no card uses any more are removed once a day, when the browser has nothing else to do, after the first screen is up.
// (Signed in, syncing does this, and removes them from the account too.) Nothing to do with no pictures or sounds on the device. The
// one-hour wait for new files (db.cleanMedia) is unchanged. The time of the last tidy is kept on this device only (db.LOCAL_ONLY).
const MEDIA_TIDY_EVERY = 24 * 3600 * 1000;
async function tidyMedia(now = Date.now()) {
  if (Number.isFinite(settings.mediaCleanedAt) && now - settings.mediaCleanedAt < MEDIA_TIDY_EVERY && now >= settings.mediaCleanedAt) return false;
  if (await sync.account()) return false;
  if (!(await db.count('media'))) return false;       // (not noted: the first picture added is looked at on the next start)
  await db.cleanMedia(now);
  settings.mediaCleanedAt = now;
  await db.setSetting('mediaCleanedAt', now);
  return true;
}
function tidyMediaWhenIdle() {
  const run = () => tidyMedia().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 15000 });
  else setTimeout(run, 3000);
}

// The server can name the oldest version allowed to sync (js/app-config.js). Asked once, after the first screen, only when signed in (a device that
// never syncs has nothing to protect and sends nothing). Any problem with the question means "no minimum".
async function checkMinClient() {
  if (syncHeld(APP_VERSION)) return;                      // "Keep using offline" was chosen for this version: sync stays off until the app updates
  if (!(await sync.account())) { setSyncGate(false); return; }
  const min = await fetchMinClient();
  if (min) rememberMinClient(min);
  if (!min || !isTooOld(APP_VERSION, min)) { setSyncGate(false); return; }
  setSyncGate(true);                                      // no syncing while this version is too old
  if (await updates?.tryUpdate()) await new Promise(r => setTimeout(r, 2500));      // a new version is on its way: it restarts the app by itself
  showUpdateRequired({
    onUpdate: async () => { await updates?.tryUpdate(); updates?.updater.tap(); },
    onOffline: () => { holdSync(APP_VERSION); setSyncGate(true); toast('Sync is off until Study Sprint updates. Studying works as usual.', { ms: 6000 }); }
  });
}

async function start() {
  initSheet();
  initPanelResize();
  initTapGuard();
  wireGear();
  initSidebar({ version: APP_VERSION });
  initWhatsNew({ version: APP_VERSION });
  watchMath();       // draws the maths on cards (js/math.js, loaded when the first formula appears) wherever it appears
  // "Skip to page" moves focus to the page without touching the address (a #screen hash would be read as a route).
  document.querySelector('.skip')?.addEventListener('click', e => { e.preventDefault(); $('screen').focus({ preventScroll: true }); });
  // Theme changes from the sidebar's toggle (or anywhere else): keep the settings copy and the open Settings screen in step.
  addEventListener('themechange', e => {
    settings.theme = e.detail;
    const r = document.querySelector(`input[name="mode"][value="${e.detail.mode}"]`);
    if (r) r.checked = true;
    const u = document.querySelector(`input[name="ui"][value="${e.detail.ui}"]`);
    if (u) u.checked = true;
    const h = $('thTitle'); if (h) h.textContent = accentTitle(e.detail.ui);          // "Theme" in Original, "Accent colour" in Clinical
    const s = $('skins'); if (s) s.innerHTML = skinButtonsHTML(e.detail.skin);      // Settings' previews follow the new style and light/dark
  });
  try {
    settings = await db.getSettings();
  } catch (err) {
    $('screen').innerHTML = `<div class="empty"><b>Couldn't open storage.</b><br>${esc(err.message)}<br>Private browsing can block it. Try a normal tab.</div>`;
    return;
  }
  await pinOldTheme();
  settings.theme = applyTheme(settings.theme);
  applyCardAlign(settings.cardAlign);
  fx.configure(settings); configureShortcuts(settings);
  const firstRun = await checkFirstRun();
  setSyncGate(syncHeld(APP_VERSION) || isTooOld(APP_VERSION, cachedMinClient()));      // closed before sync starts if this version is known to be too old (checkMinClient, below, asks the server)
  sync.startAutoSync();      // does nothing until you sign in (Settings → Sync)
  // Opening the app with no "#/..." in the address shows Today.
  if (!location.hash) history.replaceState(null, '', '#/today');      // (initNav, below, tags the entry)
  // A brand-new install opens on the first-run start (but a link to somewhere else is respected).
  if (firstRun && /^#\/today\/?$/.test(location.hash)) history.replaceState(null, '', '#/welcome');
  // Changing tab slides (View Transitions) unless Smooth transitions is off, motion is reduced or a round is running.
  initNav();         // tabs replace history, sheets and sessions hold the back gesture (js/nav.js)
  addEventListener('hashchange', () => fx.transition(route, currentRoute, (location.hash.match(/^#\/([a-z]+)/) || [, 'today'])[1]));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBrowserBar);
  await route();
  initBadge();          // the due count on the app icon, when the person turned it on (badge.js)
  if (currentRoute !== 'today') drawSidebar();      // Today does it with the data it has just loaded
  tidyMediaWhenIdle();
  checkMinClient().catch(err => console.error(err));
  // Reloaded (e.g. to update) while a reset link was waiting for a new password: show it again.
  if (!resetShown) { const kept = keptResetLink(); if (kept) showResetLink(kept); }

  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
}

// Is there something a reload would lose? Then an update waits (js/update.js): an edited card, a Review or Play round or Practice test (they hide
// the header and tabs: body.focus), or Add cards holding text or cards that aren't saved.
function updateBusy() {
  if (sheetDirty()) return true;
  if ($('sheet')?.open) return true;          // any sheet that is open (a form, a question) would be closed by a reload
  if (document.body.classList.contains('focus')) return true;
  if (/^#\/test(\/|$)/.test(location.hash) || currentRoute === 'test') return true;      // a Practice test (it keeps its own state; a reload must not cut it off)
  if (currentRoute === 'import') {
    return !!($('pasteBox')?.value || '').trim() || !!$('preview') && !$('preview').hidden || !!$('docBox') && !$('docBox').hidden || !!$('sugStatus') && !$('sugStatus').hidden || !!takeDraft();
  }
  return false;
}

// Offline support and "Add to Home Screen" need the service worker.
if ('serviceWorker' in navigator) {
  // When a new version has installed and nothing would be lost, reload once so it shows straight away (instead of only after closing and
  // reopening the app a second time). With unsaved work open it waits for a tap or a quiet moment: see js/update.js.
  let reloaded = false;
  // Not while nav is stepping through history (a reload then can be cancelled); and once more if the page is still here a second later.
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    const again = () => whenIdle().then(() => location.reload());
    again();
    setTimeout(again, 1000);
  };
  updates = initUpdates({ busy: updateBusy, reload, getRoute: () => currentRoute });
  addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => updates.watch(reg)).catch(() => {}));
}

start();
