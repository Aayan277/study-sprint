// The pure part of the app-icon badge (no page, no database): tested by tests/badge.test.js. The rest is in badge.js.

export const supported = (nav = globalThis.navigator) => typeof nav?.setAppBadge === 'function';

// Set the badge to n, or clear it at 0. Returns 'set', 'clear' or 'unsupported'. Never throws.
export function applyBadge(nav, n) {
  if (!supported(nav)) return 'unsupported';
  const count = Math.max(0, Math.floor(Number(n)) || 0);
  const quiet = p => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
  try {
    if (count > 0) { quiet(nav.setAppBadge(count)); return 'set'; }
    quiet(typeof nav.clearAppBadge === 'function' ? nav.clearAppBadge() : nav.setAppBadge(0));
    return 'clear';
  } catch { return 'unsupported'; }
}

// Debounced "work out the count and show it". Everything is passed in so it can be tested without a page:
//   compute() the number   apply(n) show it   enabled() is the setting on?
//   held() true while a round is running (nothing is worked out then, whatever asked)
//   key() a string that changes when the answer could have changed (the data, the day, a 10-minute slot).
//         While it is the same as last time the last number is shown again without reading anything.
// request() waits `delay` ms and joins several asks into one; now() runs at once. now({ fresh: true }) ignores the key
// (the setting was just switched on).
export function makeRefresher({ compute, apply, enabled, held = () => false, key = () => '', delay = 2000, timer = setTimeout, untimer = clearTimeout }) {
  let t = null, running = false, again = false, freshAsked = false, lastKey = null, lastN = 0;
  async function run(fresh) {
    if (running) { again = true; freshAsked ||= !!fresh; return; }
    running = true;
    try {
      if (!(await enabled())) { apply(0); lastKey = null; return; }
      if (held()) return;
      const k = key();
      if (fresh || k !== lastKey) { lastN = await compute(); lastKey = k; }
      apply(lastN);
    } catch { /* the badge is a nicety: never break the app */ }
    finally { running = false; if (again) { again = false; const f = freshAsked; freshAsked = false; if (f) run(true); else request(); } }
  }
  function request() { if (t !== null) untimer(t); t = timer(() => { t = null; run(false); }, delay); }
  function now({ fresh = false } = {}) { if (t !== null) { untimer(t); t = null; } return run(fresh); }
  return { request, now };
}
