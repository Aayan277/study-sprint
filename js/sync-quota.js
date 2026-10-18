// The account's space limit, applied while syncing pictures (and sounds). The numbers come from the server
// (supabase/limits.sql my_usage()); the decisions and the words are in quota.js.
//
// Only pictures and sounds wait when the account is full. Cards, reviews and settings keep syncing.

import * as supa from './supa.js';
import { planUploads, level, fullMessage, SERVER_FULL_MESSAGE } from './quota.js';
import { isSoundRow, runPool } from './sync-merge.js';


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
// size, onProgress: how many are asked at once, and a callback (done, total).
// cap: how many kept-back files to ask the account about (default 25; sync.js asks about every one right after a re-upload).
// done: the kept-back ones the account turned out to hold already (an earlier try got there but the answer was lost, and the
// account's usage already counts them): the caller marks them uploaded.
export async function planMedia(auth, pending, checked = new Set(), { cap, size, onProgress } = {}) {
  if (!pending.length) return { send: [], full: null, done: [] };
  const ordered = [...pending.filter(m => !isSoundRow(m)), ...pending.filter(isSoundRow)];
  const plan = planUploads(ordered, await fetchUsage(auth.access_token));
  const done = await alreadyOnServer(plan.held, id => supa.mediaExists(auth.access_token, auth.user.id, id), checked, cap, { size, onProgress });
  const stillHeld = plan.held.length - done.length;
  return { send: plan.send, full: stillHeld ? plan.usage : null, done };
}

// Of the files kept back for lack of room, the ids the account already has. Looks at no more than `cap` files per call,
// and remembers (in `checked`, for as long as the app is open) the ones it found missing, so the next sync looks at the next few
// instead of asking about thousands of files every time. A check that fails is skipped, not remembered.
export async function alreadyOnServer(held, exists, checked = new Set(), cap = 25, { size, onProgress } = {}) {
  const todo = held.filter(m => !checked.has(m.id)).slice(0, cap);
  const found = [];
  await runPool(todo, async m => {
    if (await exists(m.id)) found.push(m.id); else checked.add(m.id);
  }, { size, onProgress }).catch(err => { if (supa.isSignedOutError(err)) throw err; });
  return found;
}

// An upload the server refused with its own "row-level security" answer (supabase/limits.sql): say why, in words.
// The account is full (another device filled it meanwhile), the whole server is full, or we can't tell. null when
// it was some other kind of error (to be thrown as before).
export async function explainRefusal(auth, err) {
  if (err?.code !== 'media_policy') return null;
  const usage = await fetchUsage(auth.access_token);
  if (usage && level(usage) === 'full') return fullMessage(usage);
  if (usage) return SERVER_FULL_MESSAGE;           // room in the account, so it's the project-wide ceiling
  return 'Some pictures and sounds couldn’t be sent just now. They are kept on this device and will be tried again.';
}
