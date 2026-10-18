// Navigation: how the app uses the browser's history, so it feels like an app and not a website.
// (docs/design/navigation.md explains the design; this file is the code.)
//
//   Tabs (Today, Decks, Play, Stats, Settings)   replace the history entry. Swiping back never steps through tabs.
//   Drill-downs (a deck page, Browse, Import)    push one entry, so back returns to where you came from.
//   Sheets and dialogs                           push an entry while open, so back closes them.
//   A running Review or Play round               holds an entry, so back asks "End session?" instead of leaving.
//
// Every history entry the app makes carries a small state: { ss: depth, k: 'page' | 'ov', id, from }.
// `depth` counts the entries above the app's first one, so going to a tab can jump back to the bottom with one history.go().
// Reload keeps the state, so a reloaded page still knows where it is.

const TAB_ROOT = /^#\/(today|decks|play|stats|settings)\/?$/;

// ---------- pure helpers (tests/nav.test.js) ----------
// The screen name in an address: '#/deck/abc' is 'deck'; no hash means Today.
export const routeName = hash => (String(hash || '').match(/^#\/([a-z]+)/) || [, 'today'])[1];
// Is this address a bottom-tab destination? '#/decks' is; '#/decks/starters' is a sub-view (a drill-down), and so is '#/deck/x'.
export const isTabRoot = hash => hash === '' || hash == null || TAB_ROOT.test(hash);
// What history.state means to us: null for an entry the app did not make (or has not tagged yet).
export function readEntry(state) {
  if (!state || typeof state.ss !== 'number') return null;
  return { depth: state.ss, kind: state.k === 'ov' ? 'ov' : 'page', id: state.id || 0, from: state.from || '' };
}
export const makeEntry = (depth, kind = 'page', id = 0, from = '') => ({ ss: depth, k: kind, id, from });
// An overlay entry (a sheet or a held session) whose owner is gone is a dead end: going back onto it should keep going.
export const isStale = (entry, liveIds) => !!entry && entry.kind === 'ov' && !liveIds.has(entry.id);
// How many history.go() steps take a tab switch (or any "become the root") down to the bottom entry.
export const popsFor = depth => Math.max(0, depth);

// ---------- the browser side ----------
let cur = { depth: 0, kind: 'page', id: 0, from: '' };    // the entry we are on
let seq = 0;                                              // overlay ids
const overlays = new Map();                               // id -> { id, guard, key, dismiss, onBack, pushed, closed }
let chain = Promise.resolve();                            // history changes happen one after another
let busy = 0;                                             // >0 while we move through history ourselves: hashchange is ignored
let waiter = null;                                        // resolves on the next popstate (after history.back / go)
let swallowed = false;                                    // a hashchange arrived while busy: reconcile() must look at the address afterwards
let synthetic = false;                                    // true while we dispatch a hashchange ourselves
let lastHash = '';

// Runs fn now when nothing is in flight (so `go()` still changes the address at once, as `location.hash = ...` did), else after the rest.
let pending = 0;
function queue(fn) {
  const exec = () => { try { return Promise.resolve(fn()); } catch (err) { console.error(err); return Promise.resolve(); } };
  const first = pending++ === 0;
  const p = first ? exec() : chain.then(exec);
  return (chain = p.catch(err => console.error(err)).then(() => { if (--pending === 0) reconcile(); }));
}

// history.go / back, resolving when the browser has arrived (or after a short wait if it never does: e.g. nothing to go back to).
function traverse(delta) {
  return new Promise(resolve => {
    const t = setTimeout(() => { waiter = null; resolve(false); }, 400);
    waiter = () => { clearTimeout(t); setTimeout(() => resolve(true), 0); };       // after the browser's own hashchange, which follows popstate
    history.go(delta);
  });
}
const track = state => { const e = readEntry(state); if (e) cur = e; return e; };

// Tell the rest of the app the address changed (its screens listen for 'hashchange'), after a change that fires no such event.
function announce(oldHash) {
  synthetic = true;
  try { dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href.replace(/#.*$/, '') + oldHash, newURL: location.href })); }
  finally { synthetic = false; }
  lastHash = location.hash;
}

// Make `hash` the bottom entry of the history: go down to the first entry and replace it. (Tabs do this.)
async function becomeRoot(hash, pops) {
  const old = lastHash;
  busy++;
  try {
    if (pops > 0) await traverse(-pops);
    history.replaceState(makeEntry(0), '', hash);
    cur = readEntry(history.state);
  } finally { busy--; }
  announce(old);
}

// Show an address as a tab: it replaces the entry you are on. From a drill-down it also drops the entries above the first one.
export function toTab(hash) {
  return queue(() => {
    if (hash === location.hash && cur.depth === 0) return;
    return becomeRoot(hash, popsFor(cur.depth));
  });
}
// Go to an address: a tab destination replaces, anything else is one new entry.
export function go(hash) {
  if (isTabRoot(hash)) return toTab(hash);
  return queue(() => { if (hash !== location.hash) location.hash = hash; });
}
// Like go(), for a "back" button that has a known parent: if the entry underneath is that parent, really go back to it.
export function up(hash) {
  if (cur.depth > 0 && cur.from === hash && !isTabRoot(hash)) { history.back(); return; }
  go(hash);
}
// A "back" button for a screen that can be opened from several places: step back if there is somewhere in the app, else go to `fallback`.
export function back(fallback) {
  if (cur.depth > 0) history.back(); else go(fallback);
}
// Swap the address of the screen showing (a redirect: the entry is replaced, not added to).
export function replace(hash) {
  if (isTabRoot(hash)) return toTab(hash);
  return queue(() => {
    const old = lastHash;
    history.replaceState(makeEntry(cur.depth, 'page', 0, cur.from), '', hash);
    cur = readEntry(history.state);
    announce(old);
  });
}
// Change the address text without touching the entry's meaning or showing a new screen (reset links, first start).
export function rewrite(hash) {
  history.replaceState(history.state, '', location.pathname + location.search + hash);
}

// ---------- overlays: sheets, dialogs and held sessions ----------
// openOverlay pushes an entry; back then calls dismiss() (the owner closes itself). closeOverlay is for the owner closing
// itself some other way: it takes the entry off again.
export function openOverlay(dismiss) {
  const ov = { id: ++seq, guard: false, dismiss, pushed: false, closed: false };
  overlays.set(ov.id, ov);
  pushEntry(ov);
  return ov.id;
}
function pushEntry(ov) {
  queue(() => {
    if (ov.closed) return;
    history.pushState(makeEntry(cur.depth + 1, 'ov', ov.id, cur.from), '', location.href);
    cur = readEntry(history.state);
    ov.pushed = true;
  });
}
export function closeOverlay(id) {
  const ov = overlays.get(id);
  if (!ov) return;
  overlays.delete(id);
  ov.closed = true;
  popIfTop(ov);
}
function popIfTop(ov) {
  queue(async () => {
    if (ov.pushed && cur.kind === 'ov' && cur.id === ov.id) { busy++; try { await traverse(-1); } finally { busy--; } }
  });
}

// Hold the back gesture while a session runs: back calls onBack() (which asks "End session?") and the session stays.
// Calling it again with the same key only swaps onBack.
export function holdBack(key, onBack) {
  for (const ov of overlays.values()) if (ov.guard && ov.key === key) { ov.onBack = onBack; return; }
  const ov = { id: ++seq, guard: true, key, onBack, pushed: false, closed: false };
  overlays.set(ov.id, ov);
  pushEntry(ov);
}
export function releaseBack(key) {
  for (const ov of [...overlays.values()]) {
    if (!ov.guard || (key && ov.key !== key)) continue;
    overlays.delete(ov.id);
    ov.closed = true;
    popIfTop(ov);
  }
}
export const isHolding = key => [...overlays.values()].some(o => o.guard && (!key || o.key === key));

// Keep going back over entries nobody owns any more (a closed sheet's, a finished session's), which are the same screen.
function settle() {
  if (isStale(cur, new Set(overlays.keys()))) queue(async () => {
    if (isStale(cur, new Set(overlays.keys()))) { busy++; try { await traverse(-1); } finally { busy--; } }
  });
}

function onPop() {
  const left = cur;
  const arrived = track(history.state);
  const w = waiter; waiter = null; w?.();
  if (!arrived || busy) return;                       // an entry the app did not tag yet: hashchange handles it
  // Back off an overlay: its owner closes it (a session asks first and keeps its entry).
  if (left.kind === 'ov' && arrived.depth < left.depth) {
    const ov = overlays.get(left.id);
    if (ov?.guard) {
      pushEntry(ov);                                  // the session stays: put its entry back
      try { ov.onBack?.(); } catch (err) { console.error(err); }
    } else if (ov) {
      overlays.delete(ov.id); ov.closed = true;
      try { ov.dismiss?.(); } catch (err) { console.error(err); }
    }
  }
  settle();
}

function onHash(e) {
  if (synthetic) return;                              // our own announcement: the app's listeners handle it
  if (busy) { swallowed = true; e.stopImmediatePropagation(); return; } // passing through history on the way to a tab: reconcile() catches up afterwards
  const old = lastHash;
  lastHash = location.hash;
  if (readEntry(history.state)) { track(history.state); return; }       // back or forward onto an entry we know
  freshEntry(old);
}

// A new entry that did not come through go() or a link click: the address bar, another app opening a link, or a stray
// `location.hash = ...`. It is kept as the browser made it (one more entry, tagged one level deeper), so a reload right after
// it behaves; everything the app does itself goes through go() or onClick below, which replace for tabs.
// Returns false: the app draws the address as usual.
function freshEntry(old) {
  history.replaceState(makeEntry(cur.depth + 1, 'page', 0, old), '');
  cur = readEntry(history.state);
  return false;
}

// After our own history moves, the address may have changed under events we held back (or a link was followed meanwhile):
// make the app show what the address says.
function reconcile() {
  if (busy || pending || !swallowed) return;
  swallowed = false;
  const old = lastHash;
  if (location.hash === old) return;
  if (!readEntry(history.state)) { freshEntry(old); lastHash = location.hash; announce(old); return; }
  track(history.state);
  announce(old);
}

// Links to tabs replace instead of pushing (the tab bar, the sidebar, the logo, "Back to Today" and so on).
function onClick(e) {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href^="#/"]');
  if (!a || a.target) return;
  const hash = a.getAttribute('href');
  if (!isTabRoot(hash)) return;
  e.preventDefault();
  toTab(hash);
}

// Start listening. Call once, when the app starts, after the address has been settled (an empty address becomes #/today first).
// A reload on an overlay entry (a sheet that was open) steps back off it.
export function initNav() {
  lastHash = location.hash;
  const e = readEntry(history.state);
  if (e) cur = e;
  else { history.replaceState(makeEntry(0), ''); cur = readEntry(history.state); }
  addEventListener('popstate', onPop);
  addEventListener('hashchange', onHash, true);        // capture: runs before the app's own listeners, which it may stop
  document.addEventListener('click', onClick);
  settle();
}
