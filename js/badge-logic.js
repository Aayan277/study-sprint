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
//   compute() the number   apply(n) show it   enabled() is the setting on and the badge available?
//   held() true while a round is running (nothing is worked out then)
export function makeRefresher({ compute, apply, enabled, held = () => false, delay = 2000, timer = setTimeout, untimer = clearTimeout }) {
  let t = null, running = false, again = false, shown = false;
  async function run(force) {
    if (running) { again = true; return; }
    running = true;
    try {
      if (!(await enabled())) { if (shown) { apply(0); shown = false; } return; }
      if (!force && held()) return;
      const n = await compute();
      apply(n); shown = true;
    } catch { /* the badge is a nicety: never break the app */ }
    finally { running = false; if (again) { again = false; request(); } }
  }
  function request() { if (t !== null) untimer(t); t = timer(() => { t = null; run(false); }, delay); }
  function now(force = false) { if (t !== null) { untimer(t); t = null; } return run(force); }
  return { request, now };
}
