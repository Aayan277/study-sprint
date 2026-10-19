// The server can name the oldest version of the app that may sync ("min_client", from the app_config() function in supabase/). A phone
// that stayed on an old version would otherwise go on writing data the new version reads differently. When this copy is older, the app
// looks for an update, and if none arrives shows a blocking but friendly screen (showUpdateRequired in js/update.js) with two choices:
// Update now, or Keep using offline (study carries on, nothing syncs until the app has updated).
//
// Everything here fails open: no answer, an error, or a server that has no app_config() yet all mean "no minimum".
// Only the pure parts and the small browser parts are here; app.js decides when to ask (once, after the first screen, when signed in).

import { SUPABASE_URL, SUPABASE_KEY } from './sync-config.js';

export const CONFIG_TIMEOUT = 8000;
const CACHE_KEY = 'study-sprint-min-client';        // the last min_client the server named (this device only)
const HOLD_KEY = 'study-sprint-sync-hold';          // the app version for which the person chose "Keep using offline"
export const SYNC_PAUSED_MESSAGE = 'Update Study Sprint to keep syncing.';

// "4.36" / "v4.36" / "4.36.1" → [4, 36] / [4, 36] / [4, 36, 1]; anything else → null.
export function parseVersion(v) {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(String(v ?? '').trim());
  return m ? m[1].split('.').map(Number) : null;
}
// -1, 0 or 1; null when either is not a version. Missing parts count as 0 ("4.36" equals "4.36.0").
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
export const isTooOld = (appVersion, min) => compareVersions(appVersion, min) === -1;

// The version named in what the server returned: { min_client: '4.40' }, a one-row list of that, or the bare value. Otherwise null.
export function minClientOf(data) {
  const row = Array.isArray(data) ? data[0] : data;
  const v = row && typeof row === 'object' ? row.min_client : row;
  return parseVersion(v) ? String(v).trim() : null;
}

// Ask the server. Returns the min_client string, or null for any problem (no network, no such function, a bad answer, slower than `timeout`).
export async function fetchMinClient({ fetchFn = (...a) => fetch(...a), base = SUPABASE_URL, key = SUPABASE_KEY, timeout = CONFIG_TIMEOUT } = {}) {
  if (!base || !key) return null;
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeout);
  try {
    const res = await fetchFn(base + '/rest/v1/rpc/app_config', {
      method: 'POST', signal: c.signal,
      headers: { apikey: key, 'Content-Type': 'application/json' }, body: '{}'
    });
    if (!res.ok) return null;
    return minClientOf(await res.json());
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------- remembered on this device ----------
const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };
export function cachedMinClient() { try { return minClientOf(store()?.getItem(CACHE_KEY)); } catch { return null; } }
export function rememberMinClient(min) { try { store()?.setItem(CACHE_KEY, String(min)); } catch { /* fine */ } }
// "Keep using offline" is remembered for one app version: when the app updates, the hold is over by itself.
export function holdSync(appVersion) { try { store()?.setItem(HOLD_KEY, String(appVersion)); } catch { /* fine */ } }
export function syncHeld(appVersion) { try { return store()?.getItem(HOLD_KEY) === String(appVersion); } catch { return false; } }

// ---------- turning sync off ----------
// Every request to the sync server goes through fetch (js/supa.js). While the gate is closed, those get a "426 Upgrade Required" answer with a
// plain message, which sync shows as its status instead of reaching the server. Study never uses the server, so it carries on. The
// app_config question itself is let through.
let gateClosed = false, gateBase = '';
export function setSyncGate(closed, base = SUPABASE_URL) {
  gateClosed = !!closed; gateBase = base;
  if (!gateClosed || globalThis.fetch?.__syncGate) return;
  const real = globalThis.fetch.bind(globalThis);
  const gated = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (gateClosed && gateBase && url.startsWith(gateBase) && !url.includes('/rpc/app_config')) {
      return Promise.resolve(new Response(JSON.stringify({ message: SYNC_PAUSED_MESSAGE }), { status: 426, headers: { 'content-type': 'application/json' } }));
    }
    return real(input, init);
  };
  gated.__syncGate = true;
  globalThis.fetch = gated;
}
export const syncGateClosed = () => gateClosed;
