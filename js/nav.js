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
let seq = Date.now();                                     // overlay ids: they start from a per-load value, so an entry left by an earlier load is never mistaken for a live one
const overlays = new Map();                               // id -> { id, guard, key, dismiss, onBack, pushed, closed, href, depth }
const liveIds = () => new Set(overlays.keys());
let late = null;                                          // a traverse gave up waiting: { from, delta, until }. Its popstate may still come.
let chain = Promise.resolve();                            // history changes happen one after another
let busy = 0;                                             // >0 while we move through history ourselves: hashchange is ignored
let waiter = null;                                        // resolves on the next popstate (after history.back / go)
let swallowed = false;                                    // a hashchange arrived while busy: reconcile() must look at the address afterwards
let fresh = null;                                         // an address the app did not make arrived while busy (our own go() may have popped its entry): reconcile() restores it
let glen = 0;                                             // history.length when we last called history.go(): a new entry the app did not make shows as a longer history
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

// Resolves when no history change is in flight or waiting (for a caller that must not act in the middle of one, e.g. a reload).
export function whenIdle() {
  return pending ? chain.then(whenIdle) : Promise.resolve();
}

// history.go / back, resolving when the browser has arrived (or after a short wait if it never does: e.g. nothing to go back to).
const TRAVERSE_WAIT = 1500;
function traverse(delta) {
  return new Promise(resolve => {
    late = null;
    const from = cur;
    const t = setTimeout(() => { waiter = null; late = { from, delta, until: Date.now() + 5000 }; resolve(false); }, TRAVERSE_WAIT);
    waiter = () => { clearTimeout(t); setTimeout(() => resolve(true), 0); };       // after the browser's own hashchange, which follows popstate
    glen = history.length;
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
function tabNow(hash) {
  if (hash === location.hash && cur.depth === 0) return;
  return becomeRoot(hash, popsFor(cur.depth));
}
function goNow(hash) {
  if (isTabRoot(hash)) return tabNow(hash);
  if (hash !== location.hash) location.hash = hash;
}
export function toTab(hash) {
  if (!synthetic) fresh = null;        // the app's own navigation, made after the user's stray address, wins (a redirect made while a route renders, inside announce(), is not: it must not erase an address that arrived meanwhile)
  return queue(() => tabNow(hash));
}
// Go to an address: a tab destination replaces, anything else is one new entry.
// When nothing is in flight this changes the address synchronously, like `location.hash = ...` did.
export function go(hash) {
  if (!synthetic) fresh = null;
  return queue(() => goNow(hash));
}
// Like go(), for a "back" button that has a known parent: if the entry underneath is that parent, really go back to it.
export function up(hash) {
  fresh = null;
  return queue(() => {
    if (cur.depth > 0 && cur.kind === 'page' && cur.from === hash && !isTabRoot(hash)) return traverse(-1);
    return goNow(hash);
  });
}
// A "back" button for a screen that can be opened from several places: step back if there is somewhere in the app, else go to `fallback`.
export function back(fallback) {
  fresh = null;
  return queue(() => (cur.depth > 0 && cur.kind === 'page' ? traverse(-1) : goNow(fallback)));
}
// Swap the address of the screen showing (a redirect: the entry is replaced, not added to).
export function replace(hash) {
  if (!synthetic) fresh = null;
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
  const ov = { id: ++seq, guard: false, dismiss, pushed: false, closed: false, href: '', depth: -1 };
  overlays.set(ov.id, ov);
  pushEntry(ov);
  return ov.id;
}
// Push the overlay's entry. A hold that is put back after Back reuses the address it was made on.
function pushEntry(ov) {
  queue(() => {
    if (ov.closed) return;
    if (!ov.href) ov.href = location.href;
    history.pushState(makeEntry(cur.depth + 1, 'ov', ov.id, cur.from), '', ov.href);
    cur = readEntry(history.state);
    ov.pushed = true;
    ov.depth = cur.depth;
  });
}
export function closeOverlay(id) {
  const ov = overlays.get(id);
  if (!ov) return;
  overlays.delete(id);
  ov.closed = true;
  popIfTop(ov);
}
// Take the overlay's entry off, if it is the entry we are on (ask the browser, not our own record: the two can differ for a moment).
// Entries nobody owns any more that were under it (a hold released while a sheet was over it) are taken off too, so no Back press is wasted.
function popIfTop(ov) {
  queue(async () => {
    if (!ov.pushed || readEntry(history.state)?.id !== ov.id) return;
    busy++;
    try { if (await traverse(-1)) await unwind(); } finally { busy--; }
  });
}
// Keep going back over entries nobody owns (callers hold `busy`).
async function unwind() {
  for (let n = 0; n < 12 && isStale(cur, liveIds()); n++) if (!(await traverse(-1))) break;
}

// Hold the back gesture while a session runs: back calls onBack() (which asks "End session?") and the session stays.
// Calling it again with the same key only swaps onBack.
export function holdBack(key, onBack) {
  for (const ov of overlays.values()) if (ov.guard && ov.key === key) { ov.onBack = onBack; return; }
  const ov = { id: ++seq, guard: true, key, onBack, pushed: false, closed: false, href: '', depth: -1 };
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
  if (!isStale(cur, liveIds())) return;
  queue(async () => { busy++; try { await unwind(); } finally { busy--; } });
}

function onPop() {
  const left = cur;
  const arrived = track(history.state);
  // A longer history and an untagged entry while we traverse: a new address (location.hash = ..., the address bar) committed before our
  // history.go() did. It is not that go()'s arrival (a traversal never adds an entry), so keep waiting for it, or we would write over the wrong entry.
  const stray = busy && !arrived && history.length > glen;
  if (stray) fresh = location.hash;
  else { const w = waiter; waiter = null; w?.(); }
  if (late) {
    // A history move of ours whose popstate came after we stopped waiting: it is still ours, not a press of Back.
    const l = late; late = null;
    if (arrived && Date.now() < l.until && arrived.depth === l.from.depth + l.delta) { settle(); return; }
  }
  if (!arrived || busy) return;                       // an entry the app did not tag yet: hashchange handles it
  if (arrived.depth < left.depth) {
    // Back went below some overlays' entries. The one we left, if it is a session, stays when Back moved exactly one entry
    // and the address is the one it was made on (its entry is put back, and its owner asks). Anything else (the long-press
    // Back menu, history.go(-2), an entry the browser skipped) is leaving: a session is let go, a sheet is closed.
    const gone = [...overlays.values()].filter(o => o.pushed && o.depth > arrived.depth && o.depth <= left.depth).sort((x, y) => y.depth - x.depth);
    for (const ov of gone) {
      if (ov.guard && ov.id === left.id && arrived.depth === left.depth - 1 && location.href === ov.href) {
        ov.pushed = false;
        pushEntry(ov);                                // the session stays: put its entry back (the only re-push from a popstate)
        try { ov.onBack?.(); } catch (err) { console.error(err); }
      } else {
        overlays.delete(ov.id); ov.closed = true;
        if (!ov.guard) try { ov.dismiss?.(); } catch (err) { console.error(err); }
      }
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
  const old = lastHash, want = fresh;
  fresh = null;
  if (location.hash !== old) {
    if (!readEntry(history.state)) { freshEntry(old); lastHash = location.hash; announce(old); }
    else { track(history.state); announce(old); }
  }
  if (want != null && want !== location.hash) go(want);    // the user's new address was swallowed and its entry popped by our traversal: go there now
}

// Every in-app link goes through go(): links to tabs replace instead of pushing (the tab bar, the sidebar, the logo, "Back to Today" and so on).
function onClick(e) {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href^="#/"]');
  if (!a || a.target) return;
  e.preventDefault();
  go(a.getAttribute('href'));          // through the queue, so a link clicked right after a sheet closes waits for the sheet's entry to go
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
