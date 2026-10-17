// The account's space limit, applied while syncing pictures (and sounds). The numbers come from the server
// (supabase/limits.sql my_usage()); the decisions and the words are in quota.js.
//
// Only pictures and sounds wait when the account is full. Cards, reviews and settings keep syncing.

import * as db from './db.js';
import * as supa from './supa.js';
import { planUploads, level, fullMessage } from './quota.js';

let lastUsage = null;                 // the newest numbers we saw
export const knownUsage = () => lastUsage;

// What this account uses now, or null if the server can't say (limits.sql not run yet, offline).
export async function fetchUsage(token) {
  try {
    lastUsage = await supa.myUsage(token);
  } catch (err) {
    if (supa.isSignedOutError(err)) throw err;
    console.warn('Usage check failed', err);
    return null;
  }
  return lastUsage;
}

// Send the pictures and sounds waiting on this device, as many as fit. Returns a note to show when some
// are kept back ("Your account is full…"), else null. progress(i, n) says how far it got.
export async function sendPending(auth, pending, progress = () => {}) {
  if (!pending.length) return null;
  const token = auth.access_token, uid = auth.user.id;
  const plan = planUploads(pending, await fetchUsage(token));
  let full = plan.held.length ? plan.usage : null;
  for (const [i, m] of plan.send.entries()) {
    progress(i, plan.send.length);
    try {
      await supa.uploadMedia(token, uid, m.id, m.type, m.data);
    } catch (err) {
      // The server's own rule said no. If that is because the account is full (another device filled it
      // meanwhile), keep the rest on this device; any other refusal is a real problem.
      const usage = err.code === 'media_policy' ? await fetchUsage(token) : null;
      if (!usage || level(usage) !== 'full') throw err;
      full = usage;
      break;
    }
    await db.markUploaded([m.id]);
  }
  return full ? fullMessage(full) : null;
}
