// Keeping the app up to date without throwing away work.
//
// How an update arrives: sw.js installs the new version's files in the background. Where this page can look after the switch
// itself (it answers the worker's "can you handle it?" question), the new worker waits, and the page tells it to take over
// ("skip-waiting") at a good moment; the page then reloads on its own. A page that can't answer (an older copy of the app still open on
// a phone) is handled the old way: the worker takes over at once, and this page reloads when it notices.
//
// A good moment is when nothing would be lost by reloading:
//   not while a card is being edited (sheetDirty), not in a Review or Play round or a Practice test (the round has the header and tabs
//   hidden: body.focus), and not while Add cards holds something typed or read that isn't saved yet.
// Then "Update ready — tap to restart" waits at the bottom of the screen. Tapping it restarts. Without a tap the app restarts by itself the
// next time you land on Today or Decks with nothing open.
//
// It also asks the browser whether there is a new version when the app is opened again after an hour or more, and every 6 hours it stays open
// (a phone app can be left open for days, and the browser only checks when the page loads).
// The logic is in createUpdater (no browser needed: tests/update.test.js); initUpdates joins it to the service worker and the page.

export const CHECK_GAP = 60 * 60 * 1000;          // asking again when the app comes back to the front: at most this often
export const CHECK_EVERY = 6 * 60 * 60 * 1000;    // and while it stays open
export const UPDATE_READY_TEXT = 'Update ready — tap to restart';
export const SETTLE_MS = 1500;                 // after landing on Today or Decks, wait this long before asking the worker to switch (the screen is still loading files)
export const ACCEPT_WINDOW = 10 * 1000;         // a switch that follows the person's (or a good moment's) go within this long may reload without asking again
export const WATCHDOG_MS = 5000;               // no controller change this long after asking: the switch is stuck, so show the bar again
export const isRestSpot = name => name === 'today' || name === 'decks';      // routes where an update waiting may restart the app by itself

export function createUpdater({ busy, reload, skipWaiting = () => false, show = () => {}, hide = () => {}, update = () => {}, now = () => Date.now(), settleMs = SETTLE_MS, watchdogMs = WATCHDOG_MS }) {
  let pending = false;       // an update is ready and was held back
  let accepted = false;      // the person (or a good moment) said go: the next controller change reloads whatever is open
  let acceptedAt = 0;
  let lastRoute = '', settle = null, watchdog = null;
  let lastCheck = now();
  const defer = () => { if (!pending) { pending = true; show(); } };
  // Take the update: tell the waiting worker to take over (the reload follows when the controller changes), or reload now if none is waiting.
  const go = () => {
    pending = false; accepted = true; acceptedAt = now(); hide(); clearTimeout(settle); clearTimeout(watchdog);
    if (!skipWaiting()) { reload(); return; }
    // (If the worker never takes over, e.g. it is held up by files still loading, the bar comes back and a tap asks again.)
    watchdog = setTimeout(() => { if (accepted) { accepted = false; defer(); } }, watchdogMs);
    watchdog?.unref?.();
  };
  const check = () => { lastCheck = now(); try { return Promise.resolve(update()).catch(() => {}); } catch { return Promise.resolve(); } };
  return {
    // Another page was refused when it asked the new version to take over (this page, or another, has work open): show the bar, don't ask again.
    held() { clearTimeout(watchdog); accepted = false; defer(); },
    // A new version is installed and waiting.
    waiting() { if (busy()) defer(); else go(); },
    // A new version has taken over (this page is still the old one).
    changed() {
      clearTimeout(watchdog);
      // Reload if nothing is open, or if this page itself asked a moment ago. A switch that happens long after (another page's, or a stalled one
      // that finally went through) must not cut off work that began since.
      if (!busy() || (accepted && now() - acceptedAt <= ACCEPT_WINDOW)) { pending = false; accepted = true; hide(); reload(); }
      else { accepted = false; defer(); }
    },
    // The screen changed. `name` is the route ('today', 'decks'...). Call it once the screen is drawn.
    routed(name) {
      lastRoute = name; clearTimeout(settle);
      if (pending && isRestSpot(name) && !busy()) settle = setTimeout(() => { if (pending && isRestSpot(lastRoute) && !busy()) go(); }, settleMs);
      settle?.unref?.();
    },
    tap: go,
    // The app came back to the front: look for a new version, at most once an hour.
    visible() { if (now() - lastCheck >= CHECK_GAP) return check(); return Promise.resolve(); },
    check,
    get pending() { return pending; }
  };
}

// A modal sheet (the card editor) makes the rest of the page unreachable, so while one is open the bar lives inside it, and goes back to the
// page when it closes. (openSheet rebuilds the sheet's contents, which would drop the bar, so it is put back on every change.)
function place(el) {
  const sheet = document.getElementById('sheet');
  const host = sheet && sheet.open ? sheet : document.body;
  if (el.parentNode !== host) host.append(el);
}

// The bottom bar. One element, made when first needed.
function bar(onTap) {
  let el = document.getElementById('updateBar');
  if (!el) {
    el = document.createElement('button');
    el.type = 'button'; el.id = 'updateBar'; el.className = 'update-bar'; el.hidden = true;
    el.textContent = UPDATE_READY_TEXT;
    el.addEventListener('click', () => onTap());
    document.body.append(el);
    const sheet = document.getElementById('sheet');
    if (sheet) new MutationObserver(() => place(el)).observe(sheet, { attributes: true, attributeFilter: ['open'], childList: true });
  }
  return el;
}

export function initUpdates({ busy, reload, getRoute = () => '' }) {
  const sw = navigator.serviceWorker;
  let reg = null;
  const updater = createUpdater({
    busy, reload,
    skipWaiting: () => { if (!reg?.waiting) return false; reg.waiting.postMessage({ type: 'skip-waiting' }); return true; },
    show: () => { const b = bar(() => updater.tap()); b.hidden = false; place(b); announce(UPDATE_READY_TEXT); },
    hide: () => { const b = document.getElementById('updateBar'); if (b) b.hidden = true; },
    update: () => reg?.update()
  });
  // The worker asks every open page before it decides whether to take over at once. This page can wait for a good moment.
  // Before the new version takes over (because any page asked) every page is asked whether now is all right. Busy pages say no, and then every page is told to wait.
  sw.addEventListener('message', e => {
    const type = e.data?.type;
    if (type === 'update-handled-by-page?') e.ports?.[0]?.postMessage({ handled: true });
    else if (type === 'ok-to-switch?') e.ports?.[0]?.postMessage({ ok: !busy() });
    else if (type === 'update-held') updater.held();
  });
  // (The first time a worker takes over a page that had none, on the very first visit, there is nothing old to replace.)
  let controlled = !!sw.controller;
  sw.addEventListener('controllerchange', () => { if (!controlled) { controlled = true; return; } updater.changed(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updater.visible(); });
  setInterval(() => updater.check(), CHECK_EVERY);
  addEventListener('hashchange', () => setTimeout(() => updater.routed(getRoute()), 400));
  return {
    updater,
    // Called with the worker's registration once it exists: finds an update already waiting, and notices the next one.
    watch(registration) {
      reg = registration;
      const note = () => { if (reg.waiting && sw.controller) updater.waiting(); };
      note();
      const track = w => w.addEventListener('statechange', () => { if (w.state === 'installed') note(); });
      if (reg.installing) track(reg.installing);        // (one that started installing before this page looked)
      reg.addEventListener('updatefound', () => { if (reg.installing) track(reg.installing); });
    },
    routed: name => updater.routed(name),
    // Ask the browser for a new version now and wait (up to `wait` ms) for it to finish installing. true when one is on its way: the page then
    // restarts by itself unless work is open (updater.waiting). Used when the server says this version is too old (js/app-config.js).
    async tryUpdate(wait = 15000) {
      if (!reg) return false;
      try { await reg.update(); } catch { return false; }
      if (reg.waiting) { updater.waiting(); return true; }
      const w = reg.installing;
      if (!w) return false;
      return new Promise(done => {
        const timer = setTimeout(() => done(false), wait);
        w.addEventListener('statechange', () => { if (w.state === 'installed' || w.state === 'activated') { clearTimeout(timer); done(true); } else if (w.state === 'redundant') { clearTimeout(timer); done(false); } });
      });
    }
  };
}

// The blocking screen for a version the server no longer accepts. It covers the app (which is made inert behind it) until one of its two buttons
// is pressed. onUpdate() should look for the update and restart; onOffline() should turn sync off for this version. Returns a function that
// takes the screen away.
export function showUpdateRequired({ onUpdate, onOffline }) {
  document.getElementById('updateRequired')?.remove();
  const el = document.createElement('div');
  el.id = 'updateRequired'; el.className = 'update-required';
  el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'urTitle'); el.setAttribute('aria-describedby', 'urText');
  el.innerHTML = `<div class="ur-card">
    <h2 id="urTitle">Study Sprint needs an update to keep syncing safely.</h2>
    <p id="urText">Your cards and progress are safe on this device. Update now to carry on syncing, or keep studying offline and sync again once the app has updated.</p>
    <div class="ur-actions"><button class="btn primary" type="button" id="urUpdate">Update now</button><button class="btn ghost" type="button" id="urOffline">Keep using offline</button></div>
  </div>`;
  const behind = [...document.body.children].filter(c => c !== el && c.tagName !== 'SCRIPT');
  behind.forEach(c => c.setAttribute('inert', ''));
  document.body.append(el);
  const close = () => { el.remove(); behind.forEach(c => c.removeAttribute('inert')); };
  el.querySelector('#urUpdate').addEventListener('click', async e => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Updating…';
    try { await onUpdate(); } finally { const b = el.querySelector('#urUpdate'); if (b) { b.disabled = false; b.textContent = 'Update now'; } }
  });
  el.querySelector('#urOffline').addEventListener('click', () => { close(); onOffline(); });
  el.querySelector('#urUpdate').focus({ preventScroll: true });
  return close;
}

function announce(text) {
  const live = document.getElementById('toastLive');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 60); }
}
