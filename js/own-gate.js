// Own model: is it switched on? Review, Practice and Play ask this before they load anything else. It reads nothing unless the Own
// database already exists (it is never created here), so for everyone who has not loaded a model file this does next to nothing:
// one quick look, remembered, and no other code is loaded.
import { openOwnDb, deleteOwnDb } from './own-db.js';

async function ownActive(idb) {
  try {
    const h = await openOwnDb({ idb, forbidCreate: true });
    if (!h) return false;
    try {
      const [settings, model] = await Promise.all([h.get('meta', 'settings'), h.get('model', 'current')]);
      return !!(settings && settings.on === true && model);
    } finally { h.close(); }
  } catch { return false; }
}

// The Own code for Review and Practice, or null when Own is off. Asked once and remembered (so a Play round does not look it up for
// every answer, and callers hear the same answer in the order they asked). Own forgets it (resetOwnGate) when the owner's switch or the
// model changes; Review forgets it at the start of every session.
let cached = null;
export const resetOwnGate = () => { cached = null; };
export const ownModule = ({ idb } = {}) => (cached ||= ownActive(idb).then(on => (on ? import('./own-shadow.js') : null)).catch(() => null));

// A review came in from another device (sync). Own's memory then no longer matches the log: it is rebuilt in the background.
// Does nothing, and loads nothing, unless Own is on.
export async function ownSynced() {
  try { const m = await ownModule(); if (m) await m.markStale(); } catch { /* Own is optional */ }
}

// ---------- other tabs ----------
// Every tab that changes Own's switch, model or scheduler pings the others (kind: 'on' | 'off' | 'load' | 'remove' | 'switch'), so they
// refresh at once. A browser without BroadcastChannel simply has no pings: the tabs catch up on their own next read.
const CHANNEL = 'study-sprint-own';
let chan;
const channel = () => {
  if (chan === undefined) { try { chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null; if (chan && chan.unref) chan.unref(); } catch { chan = null; } }
  return chan;
};
export function ownPing(kind) { try { channel()?.postMessage({ kind }); } catch { /* a ping is a courtesy */ } }
// fn(kind) runs when another tab pings. Returns a function that stops listening.
export function onOwnPing(fn) {
  const c = channel();
  if (!c) return () => {};
  const h = e => { try { fn(e && e.data && e.data.kind); } catch { /* one listener must not stop the rest */ } };
  c.addEventListener('message', h);
  return () => c.removeEventListener('message', h);
}

// "Reset all data" and "Just this device" (settings.js) call this: the Own database goes too. Throws if another tab blocks the delete.
export async function wipeOwn({ idb } = {}) {
  resetOwnGate();
  await deleteOwnDb({ idb });
  ownPing('remove');
  return true;
}
