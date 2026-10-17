// The account's space limit, applied while syncing pictures (and sounds). The numbers come from the server
// (supabase/limits.sql my_usage()); the decisions and the words are in quota.js.
//
// Only pictures and sounds wait when the account is full. Cards, reviews and settings keep syncing.

import * as supa from './supa.js';
import { planUploads, level } from './quota.js';
import { isSoundRow } from './sync-merge.js';


// What this account uses now, or null if the server can't say (limits.sql not run yet, offline).
export async function fetchUsage(token) {
  try {
    return await supa.myUsage(token);
  } catch (err) {
    if (supa.isSignedOutError(err)) throw err;
    console.warn('Usage check failed', err);
    return null;
  }
}

// Which of the pictures and sounds waiting on this device to send now (pictures first, like uploadMediaFiles does),
// given how much room the account has. Returns { send, full }: full is the usage numbers when some are kept back
// (the account is full), else null. The ones kept back stay on the device and go when there's room.
export async function planMedia(auth, pending) {
  if (!pending.length) return { send: [], full: null };
  const ordered = [...pending.filter(m => !isSoundRow(m)), ...pending.filter(isSoundRow)];
  const plan = planUploads(ordered, await fetchUsage(auth.access_token));
  return { send: plan.send, full: plan.held.length ? plan.usage : null };
}

// An upload the server refused with its own "row-level security" answer: if that is because the account is full
// (another device filled it meanwhile), the usage numbers; anything else null (a real problem, to be thrown).
export async function refusedAsFull(auth, err) {
  if (err?.code !== 'media_policy') return null;
  const usage = await fetchUsage(auth.access_token);
  return usage && level(usage) === 'full' ? usage : null;
}
