// Syncing this device with Supabase, so every device has the same decks, cards, progress and study settings.
//
// One sync does two things:
//   1. Pull: ask the server for every change since the last one this device saw (by its change number, seq),
//      and save each one unless this device has a newer version (db.applyRemote). The request starts a couple of
//      minutes behind that bookmark, because a change numbered earlier can become visible later (pullStart).
//   2. Push: send everything changed here since the last push (db.localChangesSince). The server keeps
//      whichever version is newest, so sending something old can't overwrite something new.
// It runs when the app opens, a few seconds after you change something, when you come back online or back
// to the app, every few minutes while it's open, and with Sync now. Offline, everything still works:
// changes simply wait for the next sync.
//
// Progress is announced with a 'sync' event on window: { state: 'syncing' | 'done' | 'error' | 'signed-out',
// at, applied (changes received), sent, error }.

import * as db from './db.js';
import * as supa from './supa.js';
import { planSweep, markKey, GONE, droppedRefs } from './media-sweep.js';
import { planMedia, explainRefusal, fetchUsage } from './sync-quota.js';
import { fullMessage, splitOversized, capTimes, rowLabel, rowBytes, bigRowsNote, dataFullMessage, SERVER_FULL_MESSAGE } from './quota.js';
import { pushSafely } from './sync-push.js';
import { storedType } from './audio-type.js';
import { planPrefetch, wantedMedia, canTry, failedAgain, PREFETCH_BYTES, NEW_AHEAD } from './lazy-media.js';
import { rowFromRecord, rowFromTombstone, rowFromSetting, pullStart, startPull, logPull, newestOnly, chunks, parseAuthLink, uploadMediaFiles, runPool, getPageSafely, withSyncLock, SKIPPED, trimForPush, overLimitDayFlags, isSoundRow, isWholeStorageError, SOUNDS_BLOCKED_NOTE, PICTURES_BLOCKED_NOTE } from './sync-merge.js';

const AFTER_CHANGE = 4000;            // wait this long after a change, so a burst of changes goes in one sync
const EVERY = 5 * 60 * 1000;          // and check for other devices' changes every 5 minutes while open
const PAGE = 1000;                    // rows per request when pulling
const BATCH = 500;                    // rows per request when pushing
const RESEND_TRIES = 3;               // a re-upload whose start-over keeps failing is given up after this many syncs
const RESEND_FAILED_NOTE = 'The re-upload couldn’t finish, maybe because this device is short of space. Syncing carries on as normal; you can try Re-upload everything again later.';

let running = null, again = false, againSkip = false, timer = 0, started = false;
let resendTries = 0, resendGaveUp = false, resendFailed = false, justResent = false;   // the start-over failing (see run), and a re-upload that has just run
let retrySounds = true;       // sounds the server turned away are tried again once each time the app opens, and on Sync now
// Routine syncs that find another tab holding the lock try again a little later (nothing tells this tab what the other one saw);
// a long run of those is said out loud, since the other window may be frozen. (timing: changed by the tests.)
export const timing = { skipRetry: 45000, busyNoteAfter: 120000, lockWait: 60000 };
const BUSY_NOTE = 'Waiting for another window of the app, which is syncing or paused. Close other windows if this stays.';
let skips = 0, firstSkip = 0, skipTimer = 0;
let last = { state: 'idle', at: 0, applied: 0, sent: 0, error: null };

function emit(detail) {
  last = { ...last, ...detail };
  globalThis.dispatchEvent?.(new CustomEvent('sync', { detail: last }));
}
export const lastStatus = () => last;

// ---------- account ----------
// Who's signed in on this device, or null.
export async function account() {
  const { syncAuth, syncState } = await db.getSettings();
  return syncAuth ? { email: syncAuth.user.email, id: syncAuth.user.id, lastSync: syncState?.lastSync || 0 } : null;
}

// Make an account. With email confirmation turned on (the normal setup, docs/sync-setup.md) nobody is signed in
// yet: Supabase emails a link first. Returns { pending: true } then, { pending: false } once signed in.
// captcha: the token from captcha.js, when the project uses one.
export async function createAccount(email, password, captcha) {
  const made = await supa.signUp(email.trim(), password, { captcha, redirectTo: appUrl() });
  if (made.pending) return { pending: true };
  await signedIn(made.session);
  return { pending: false };
}
export async function signIn(email, password, captcha) { return signedIn(await supa.signIn(email.trim(), password, { captcha })); }

async function signedIn(session) {
  const { syncState } = await db.getSettings();
  await db.setSetting('syncAuth', session);
  // A different account than last time on this device (or the first): start from the beginning, so
  // everything here is sent and everything on the server is merged in.
  if (!syncState || syncState.userId !== session.user.id) {
    await db.forgetSyncedMarks();   // records that came from other devices count as unsent too
    await db.setSetting('syncState', { userId: session.user.id, lastSeq: 0, pushedUntil: 0, lastSync: 0 });
  }
  return syncNow();
}

// ---------- starting over from this device ----------
// For a lost or restored server: this device thinks the server already has its data, so it never sends it again.
// This makes it send everything: every deck, card, review, setting and deleted marker, and every picture and sound.
// It only re-sends, never deletes or overwrites newer data on the server: every row goes with its own change time,
// and the server keeps whichever copy is newer (supabase/setup.sql, the "new.updated_at <= old.updated_at" check), so a
// newer copy from another device stays. The same goes the other way: pulled rows only replace things here when they are newer (db.applyRemote).
// Pulling starts over too (lastSeq 0), because a restored server numbers its changes from an earlier point.
// This only asks: a flag is saved and a sync is started. The reset itself happens at the start of the next sync run
// (startOverFromHere), so a sync that is running or waiting right now can't write its old bookmarks over it.
// Progress and problems show in the normal sync status.
export async function resendEverything() {
  if (!(await session())) throw new supa.SupaError('Sign in first.');
  forgetResendFailures();          // a new ask starts the counting (and the telling) again
  await db.setSettings([['resendPending', true], ['resendTries', 0], ['resendFailed', false]]);
  syncNow({ retry: true });
}
// The start-over, run because resendPending is set. If it keeps failing (storage full, say), every sync would fail with it:
// after RESEND_TRIES failures in a row (counted on this device only) the flag is cleared, the person is told once, and syncing
// carries on as normal. Until then the error ends this sync as before, and the next one tries again.
export async function tryStartOver(userId, start = startOverFromHere) {
  try {
    await start(userId);
    resendTries = 0; justResent = true;
    await db.setSetting('resendTries', 0).catch(() => {});
    return null;
  } catch (err) {
    resendTries = Math.max(resendTries, Number((await db.getSettings().catch(() => ({}))).resendTries) || 0) + 1;
    console.error('Re-upload could not start over', resendTries, err);
    if (resendTries < RESEND_TRIES) { await db.setSetting('resendTries', resendTries).catch(() => {}); throw err; }
    resendGaveUp = resendFailed = true;                       // (also when clearing the flag fails too: no more tries until the app is opened again)
    resendTries = 0;
    await db.setSettings([['resendPending', false], ['resendTries', 0], ['resendFailed', true]]).catch(() => {});
    return RESEND_FAILED_NOTE;
  }
}
export function forgetResendFailures() { resendGaveUp = false; resendTries = 0; resendFailed = false; }
export const resendGivenUp = () => resendGaveUp;
// The give-up is told in the next 'done' note (and in an error that comes first), and then forgotten. Kept in a local-only setting
// meanwhile, so a sync that fails right after it doesn't lose it.
const failedNote = () => (resendFailed ? RESEND_FAILED_NOTE : null);
async function startOverFromHere(userId) {
  const { syncState } = await db.getSettings();
  await db.forgetSyncedMarks();
  await db.forgetUploadedMedia();
  await db.setSetting('mediaRefs', null);
  await db.setSetting('syncState', { userId, lastSeq: 0, pushedUntil: 0, lastSync: syncState?.lastSync || 0 });
  await db.setSetting('resendPending', false);       // only now: if this is cut short, the next sync does it again
}

// ---------- passwords ----------
// The app's own address, which the reset email links back to.
const appUrl = () => location.origin + location.pathname;

export const sendPasswordReset = (email, captcha) => supa.sendPasswordReset(email.trim(), appUrl(), { captcha });

// Opened from a password-reset email? The link's address holds a sign-in (see parseAuthLink).
// Returns { session } to set a new password with, { error } if the link didn't work, or null.
export function recoveryFromLink(hash = location.hash) {
  return parseAuthLink(hash);
}
// Whose account a reset link is for: { id, email }. Anyone can make a link for their own account, so this
// refuses (with a message to show) if the link is for someone else than the account signed in on this device.
export async function lookUpResetLink(linkSession) {
  let user;
  try { user = await supa.getUser(linkSession.access_token); } catch (err) {
    // Only a refused token means the link is spent. Offline or a server hiccup: keep the link and try again later.
    if (err.status === 401 || err.status === 403) throw new supa.SupaError('That reset link has expired or was already used. Ask for a new one.', { code: 'expired' });
    throw new supa.SupaError('Couldn’t check that reset link. Check your connection and open it again.', { code: 'offline' });
  }
  const current = await account();
  if (current && current.id !== user.id) {
    throw new supa.SupaError(`That link is for ${user.email}, but this device is signed in as ${current.email}. Sign out here first, then ask for a new reset email.`);
  }
  // Signed out, but this device last synced with a different account: setting the password would sign in and
  // copy everything here into the link's account, so refuse.
  const { syncState } = await db.getSettings();
  if (!current && syncState?.userId && syncState.userId !== user.id) {
    throw new supa.SupaError(`That link is for ${user.email}, but this device's cards belong to a different account. Sign in to that account first, or clear this device (Settings → Your data → Reset all data).`);
  }
  return user;
}
// Set the new password from a reset link. Normally that signs in too. Not on a device that has cards
// but never signed in: a link for someone else's account would copy everything here into it.
// Returns { signedIn, email } so the screen can say which happened.
export async function finishPasswordReset(linkSession, password) {
  const user = await lookUpResetLink(linkSession);   // checked again here, right before anything changes
  await supa.setPassword(linkSession.access_token, password);
  const { syncAuth, syncState } = await db.getSettings();
  const known = syncAuth?.user?.id === user.id || syncState?.userId === user.id;
  if (!known && !syncState && await hasLocalData()) return { signedIn: false, email: user.email };
  await signedIn({ ...linkSession, user });
  return { signedIn: true, email: user.email };
}
async function hasLocalData() {
  for (const name of ['decks', 'cards', 'reviewLog']) if ((await db.getAll(name)).length) return true;
  return false;
}
// Change the password while signed in.
export async function changePassword(password) {
  const auth = await session();
  if (!auth) throw new supa.SupaError('Sign in first.');
  await supa.setPassword(auth.access_token, password);
}

// ---------- leaving ----------
// How many changes made here haven't reached the server yet.
export async function pendingChanges() {
  const { syncState } = await db.getSettings();
  const c = await db.localChangesSince(syncState?.pushedUntil || 0);
  return Object.values(c.records).reduce((n, list) => n + list.length, 0) + c.tombstones.length + c.settings.length;
}

// Delete everything in this account on the server, and sign this device out. Devices keep their own data.
// (Signing in again later sends this device's data back up, starting from scratch.)
export async function deleteServerData(opts = {}) {
  if (!(await session())) throw new supa.SupaError('Sign in first.');
  await keepDeviceWhole(opts);
  const auth = await session();                      // (again: a long download can outlast the sign-in)
  if (!auth) throw new supa.SupaError('Sign in first.');
  if (opts.signal?.aborted) throw cancelled();
  await supa.deleteAllRows(auth.access_token, auth.user.id);
  try { await supa.deleteMedia(auth.access_token, auth.user.id, await supa.listMedia(auth.access_token, auth.user.id)); } catch (err) { console.error(err); }
  await signOut({ forget: true });
}

// Delete the account itself: its files, its synced data, and the sign-in. This device keeps its own data and is
// signed out. (Needs supabase/limits.sql on the project.)
export async function deleteAccount(opts = {}) {
  if (!(await session())) throw new supa.SupaError('Sign in first.');
  await keepDeviceWhole(opts);
  const auth = await session();                      // (again: a long download can outlast the sign-in)
  if (!auth) throw new supa.SupaError('Sign in first.');
  if (opts.signal?.aborted) throw cancelled();
  // Files first, through the Storage API (that also frees the space); the server function removes any left.
  try { await supa.deleteMedia(auth.access_token, auth.user.id, await supa.listMedia(auth.access_token, auth.user.id)); } catch (err) { console.error(err); }
  await supa.deleteAccount(auth.access_token);
  await signOut({ forget: true });
}
// What this account uses and may use: { data, media, limit } in bytes, or null (limits.sql not run, or offline).
export async function usage() {
  const auth = await session().catch(() => null);
  return auth ? fetchUsage(auth.access_token) : null;
}

// Sign out on this device. Its data stays here. (Signing back in to the same account carries on where it
// left off; changes made meanwhile are sent then.)
//   forget: also forget this device's sync bookmarks, so signing in again starts from scratch
//           (used when this device's data is removed, or the server's is)
export async function signOut({ forget = false } = {}) {
  const { syncAuth } = await db.getSettings();
  if (syncAuth) await supa.signOut(syncAuth.access_token);
  resetSkips();
  await db.setSetting('syncAuth', null);
  if (forget) { await db.setSetting('syncState', null); await db.setSetting('mediaRefs', null); }
  emit({ state: 'signed-out', error: null });
}

// A sign-in that's still valid, refreshed if it's about to expire. null when signed out.
async function session() {
  const { syncAuth } = await db.getSettings();
  if (!syncAuth) return null;
  if (syncAuth.expires_at - 60 > Date.now() / 1000) return syncAuth;
  try {
    const fresh = await supa.refresh(syncAuth.refresh_token);
    await db.setSetting('syncAuth', fresh);
    return fresh;
  } catch (err) {
    if (supa.isSignedOutError(err)) await db.setSetting('syncAuth', null);
    throw err;
  }
}

// Siblings of a cloze note edited on two devices can end up with different texts (the newest of each card wins
// while syncing). The newest sibling's text wins for all of them; this saves the others again, so every
// device agrees. cloze.js is only loaded when a pulled card belongs to a note. Image-occlusion notes (their boxes
// and picture) are healed the same way, by occlusion.js, and so are a card and its reverse card (reverse.js).
export async function healNotes() {
  const [{ healNotes: heal }, { healOcclusion }, { healPairs }] = await Promise.all([import('./cloze.js'), import('./occlusion.js'), import('./reverse.js')]);
  const all = await db.getAll('cards');
  const fixed = [...heal(all), ...healOcclusion(all), ...healPairs(all)];
  if (fixed.length) await db.saveCards(fixed);
  return fixed.length;
}

// ---------- syncing ----------
// Sync now. If a sync is already running, one more runs straight after it (so nothing is missed).
// skipIfBusy: for the syncs that start by themselves; if another tab is syncing, that tab does the work (withSyncLock).
// The others (the buttons, sign-in, "catch up first" in app.js) wait for the other tab, for a while.
// Returns { ok: true }, or { ok: false, reason } when it didn't happen: 'skipped' (a routine sync, another window is syncing), 'busy'
// (waited a minute for another window, in vain) or 'error' (anything else, already announced in the status). Callers that must not
// go on without a sync (app.js: Replace everywhere, Delete everywhere) stop on 'busy'.
export function syncNow({ retry = false, skipIfBusy = false } = {}) {
  if (retry) retrySounds = true;
  if (running) { againSkip = again ? againSkip && skipIfBusy : skipIfBusy; again = true; return running; }
  // (Two tabs of the app take turns, where the browser has Web Locks, so they can't mix up the bookmarks.)
  const onWait = () => emit({ state: 'syncing', progress: 'Waiting for another window to finish syncing…' });
  running = Promise.resolve(withSyncLock(run, { skipIfBusy, onWait, waitMs: timing.lockWait }))
    .then(r => (r === SKIPPED ? skipped() : (resetSkips(), { ok: true })), err => {
      console.error('Sync failed', err);
      resetSkips();
      const extra = failedNote();
      if (err?.code === 'lock-timeout') { emit({ state: 'error', error: err.message }); return { ok: false, reason: 'busy' }; }
      emit(supa.isSignedOutError(err) ? { state: 'signed-out', error: err.message } : { state: 'error', error: extra ? `${err.message} ${extra}` : err.message });
      return { ok: false, reason: 'error', error: err };
    })
    .finally(() => {
      running = null;
      if (again) { again = false; syncNow({ skipIfBusy: againSkip }); }
    });
  return running;
}
const resetSkips = () => { skips = 0; clearTimeout(skipTimer); };
// A routine sync that found the lock taken: look again soon, and after a couple of minutes of that, say so.
function skipped() {
  if (!skips++) firstSkip = Date.now();
  if (Date.now() - firstSkip >= timing.busyNoteAfter) emit({ state: 'syncing', error: null, progress: BUSY_NOTE });
  clearTimeout(skipTimer);
  skipTimer = setTimeout(() => syncNow({ skipIfBusy: true }), timing.skipRetry);
  return { ok: false, reason: 'skipped' };
}

async function run() {
  const auth = await session();
  if (!auth) return;
  emit({ state: 'syncing', error: null, progress: null });
  const token = auth.access_token;
  const settings0 = await db.getSettings();
  if (settings0.resendFailed) resendFailed = true;
  if (settings0.resendPending && !resendGaveUp) await tryStartOver(auth.user.id);
  // Days off stored over the entry limit (a single device that got there before the limit existed): the row was set aside as too large
  // and counted as sent, so nothing would send it until the next change. Saving the trimmed copy is that change.
  const trimmed = overLimitDayFlags(settings0.restDays);
  if (trimmed) await db.setSetting('restDays', trimmed).catch(err => console.error('Could not trim the days off', err));       // (the rest of the sync goes on)
  let st = (await db.getSettings()).syncState || { userId: auth.user.id, lastSeq: 0, pushedUntil: 0, lastSync: 0 };

  // 1. Pull what changed on the server since last time. The first request starts a little behind the bookmark
  //    (pullStart, sync-merge.js): a change numbered below it can have become visible after the bookmark moved past it.
  //    Those rows come again and are skipped as already applied. The bookmark itself only ever moves forward.
  let applied = 0, pulled = 0, gotNotes = false;
  st = startPull(st, Date.now());
  let from = pullStart(st);
  const t0 = Date.now(), from0 = from;
  let pageSize = PAGE;          // smaller after a timeout, for the rest of this sync (getPageSafely)
  for (;;) {
    const after = from;
    const page = await getPageSafely((seq, n) => supa.getChanges(token, seq, n), after, pageSize);
    const rows = page.rows, at = page.at;       // (the send time of the request that worked: an earlier time would be the unsafe direction)
    pageSize = page.size;
    if (rows.length) {
      const got = await db.applyRemote(rows);
      applied += got;
      if (got && rows.some(r => r.store === 'cards' && r.data?.noteId)) gotNotes = true;     // (rows read again that changed nothing don't count)
      pulled += rows.length;
      if (pulled >= PAGE) emit({ progress: `Downloaded ${pulled.toLocaleString()} changes…` });   // big first syncs
      from = Math.max(from, ...rows.map(r => Number(r.seq)));
    }
    // The bookmark (only ever forward) and the log of requests are saved together, page by page, so a pull cut off
    // midway carries on near where it stopped.
    const lastSeq = Math.max(st.lastSeq, from);
    st = { ...st, lastSeq, seqLog: logPull(st.seqLog, { t: at, seq: lastSeq, from: after, to: rows.length ? Math.max(...rows.map(r => Number(r.seq))) : after, n: rows.length }, { t0, from: from0, reach: rows.length < pageSize ? Infinity : from }) };
    await db.setSetting('syncState', st);
    if (rows.length < pageSize) break;
  }

  // Cloze cards from two devices can disagree about their note's text: make them agree again.
  if (gotNotes) await healNotes();

  // 2. Pictures first: send new ones before the cards that use them, and fetch ones that cards from other
  //    devices use (so they work offline). A picture problem (e.g. storage not set up yet) doesn't stop the
  //    rest of the sync; it's reported as a note.
  let mediaNote = null;
  try { mediaNote = await syncMedia(auth); } catch (err) { console.error('Picture sync failed', err); mediaNote = err.message; }

  // 3. Push what changed here. Anything changed while this runs is caught by the next sync.
  const pushStart = Date.now();
  const changes = await db.localChangesSince(st.pushedUntil);
  // A clock that's ahead counts as at most a day ahead (the server does the same). A record over the server's size
  // limit is left out and remembered (named in the note), so it can't block everything else.
  const { ok: rows, big } = splitOversized(capTimes(newestOnly([
    ...Object.entries(changes.records).flatMap(([name, list]) => list.map(r => rowFromRecord(name, r))),
    ...changes.tombstones.map(rowFromTombstone),
    ...changes.settings.map(s => rowFromSetting(s.key, trimForPush(s.key, s.value), s.time))
  ])));
  const pushed = await pushSafely(part => supa.putRows(token, part), rows, {
    onProgress: (i, n) => { if (n > BATCH) emit({ progress: `Sending ${i.toLocaleString()} of ${n.toLocaleString()} changes…` }); }
  });
  // Records too big to send, kept until they are shortened (editing one makes it a new change, which is tried again)
  // or deleted. Anything that went through now is no longer a problem.
  const wentKeys = new Set(pushed.sent.map(r => `${r.store}|${r.id}`));
  const tooBig = [...(st.tooBig || []), ...big, ...pushed.bad.map(b => ({ store: b.row.store, id: b.row.id, label: rowLabel(b.row), bytes: rowBytes(b.row), ...(b.kind === 'id' ? { reason: 'id' } : {}) }))];
  const stillBig = [...new Map(tooBig.map(r => [`${r.store}|${r.id}`, r])).values()].filter(r => !wentKeys.has(`${r.store}|${r.id}`));
  // Rows the server's space limits held back stay "not sent yet": the bookmark doesn't move, so they go again next time.
  // (What did go is sent again too; the server ignores a copy it already has.)
  let spaceNote = null;
  if (pushed.held.length) {
    spaceNote = pushed.full === 'server' ? SERVER_FULL_MESSAGE : dataFullMessage(await fetchUsage(token));
  }

  st = { ...st, pushedUntil: pushed.held.length ? st.pushedUntil : pushStart - 1, lastSync: Date.now(), tooBig: stillBig };
  await db.setSetting('syncState', st);
  const note = [failedNote(), spaceNote, bigRowsNote(stillBig), mediaNote].filter(Boolean).join(' ') || null;
  const told = resendFailed;
  emit({ state: 'done', at: st.lastSync, applied, sent: pushed.sent.length, error: null, progress: null, note });
  if (told) { resendFailed = false; await db.setSetting('resendFailed', false).catch(() => {}); }
}

// ---------- pictures and sounds ----------
// Both are files in the same bucket. Pictures go first, so a problem with sounds can never hold them up.
// Returns a note to show under Settings → Sync (or null); a problem with the whole storage setup is thrown.
const MAX_NEW_AHEAD = 50;
const checkedOnServer = new Set();      // kept-back files already asked about (sync-quota.js alreadyOnServer); starts empty each time the app opens
async function syncMedia(auth) {
  const token = auth.access_token, uid = auth.user.id;
  const rows = await db.mediaToUpload();         // without their bytes; each file is loaded just before it is sent
  // Sounds the server turned away stay put (and aren't re-sent every time) until the app is opened again or Sync now is pressed.
  const pending = rows.filter(m => !(m.blocked === 'type' && !retrySounds));
  // Within the account's space limit (sync-quota.js): what doesn't fit waits on this device and goes when there's room.
  // Right after a re-upload every file is waiting, and on a nearly full account many are still on the server: ask about all of them
  // now (a few at a time), not 25 a sync, so the "account full" note doesn't stay for hours.
  // (The "missing" answers kept from before the reset are out of date: the account may have had the files since.)
  if (justResent) checkedOnServer.clear();
  const gate = await planMedia(auth, pending, checkedOnServer, justResent ? {
    cap: Infinity, size: 8, onProgress: (i, n) => { if (n > 3) emit({ progress: `Checking pictures already in your account: ${i} of ${n}…` }); }
  } : {});
  if (gate.done.length) await db.markUploaded(gate.done);         // the account already had them
  let upload;
  try {
    upload = await uploadMediaFiles(gate.send, async m => supa.uploadMedia(token, uid, m.id, m.type, (await db.getMedia(m.id)).data), {
      onSent: m => db.markUploaded([m.id]),
      onProgress: (i, n, kind) => { if (n > 3) emit({ progress: `Sending ${kind}s: ${i + 1} of ${n}…` }); }
    });
  } catch (err) {
    const refused = await explainRefusal(auth, err);      // the server itself turned a file away: full account, full server...
    if (!refused) throw err;
    gate.note = refused;
    upload = { sent: [], blocked: [], failed: [] };
  }
  if (upload.blocked.length) await db.markBlocked(upload.blocked, 'type');
  retrySounds = false;
  justResent = false;
  // What to tell the person: only files that are turned away now (this run), or were left out of it because they were before.
  // (A file that was blocked, tried again and went up is no longer a problem.)
  const left = [...upload.blocked.map(id => pending.find(m => m.id === id)), ...rows.filter(m => !pending.includes(m))].filter(Boolean);
  const blockedKinds = { picture: left.some(m => !isSoundRow(m)), sound: left.some(isSoundRow) };
  upload.failed.forEach(f => console.error('Could not send a file', f.id, f.message));

  // Pictures and sounds that cards here use but this device doesn't have yet are NOT all downloaded now (backlog 16: a new device
  // used to fetch the whole account, and the Free plan allows 5 GB of downloads a month). A card fetches its own files when it is
  // shown (downloadMedia). Here only a few are fetched ahead, for the cards due today and the next new ones, so studying right
  // after a sync works offline. "Keep all pictures and sounds on this device" (a setting of this device) fetches everything.
  const have = new Set(await db.mediaKeys());
  const cards = await db.getAll('cards');
  const settings = await db.getSettings();
  const keepAll = !!settings.keepAllMedia;
  const plan = planPrefetch({
    cards, have, keepAll, now: Date.now(),
    newAhead: Math.min(MAX_NEW_AHEAD, Number.isFinite(settings.newPerDay) ? settings.newPerDay : NEW_AHEAD),      // as many new cards as a day's limit
    statesById: keepAll ? undefined : new Map((await db.getAll('cardStates')).map(s => [s.cardId, s])),
    skip: id => !canTry(failedFetches.get(id), Date.now(), 'prefetch')
  });
  let spent = 0;
  const budget = keepAll ? Infinity : PREFETCH_BYTES;
  await runPool(plan.ids, async id => {
    if (spent >= budget) return;
    const got = await loadMedia(id, 'prefetch');
    if (got.error && isWholeStorageError(got.error)) throw got.error;      // storage isn't set up: say so (the note), don't try the rest
    if (got.media) spent += got.media.size;
  }, {
    onProgress: (n, total) => { if (total > 3) emit({ progress: keepAll ? `Downloading pictures and sounds: ${n} of ${total}…` : `Getting today's pictures and sounds: ${n} of ${total}…` }); }
  });
  // Pictures and sounds no card uses any more: remove them here, and mark them for deletion from the account; the account's copy
  // goes 30 days later if still unused (media-sweep.js), in case another device still needs it.
  const removed = await db.cleanMedia();
  await sweepMedia(token, uid, removed, cards);
  if (gate.full) return fullMessage(gate.full);
  if (gate.note) return gate.note;
  return blockedKinds.picture ? PICTURES_BLOCKED_NOTE : blockedKinds.sound ? SOUNDS_BLOCKED_NOTE : null;
}
async function sweepMedia(token, uid, removed, cards) {
  const { marks, gone } = await db.mediaMarks();
  // Files a card used last time and none does now, that this device never held (lazy loading): marked too, or the account would only grow.
  const used = db.usedMediaIds(cards);
  const dropped = droppedRefs({ prev: (await db.getSettings()).mediaRefs, used, userId: uid });
  removed = [...new Set([...removed, ...dropped])];
  const plan = planSweep({ marks, gone, removed, used, held: new Set(await db.mediaKeys()), now: Date.now() });
  const swept = [];
  for (const ids of chunks(plan.sweep, 100)) {
    try { await supa.deleteMedia(token, uid, ids); swept.push(...ids); } catch (err) { console.error(err); break; }      // a mark stays until its file is really gone
  }
  // Files the account lost but a card here still uses: back to "not uploaded" (they go up on the next pass), and the mark is cleared.
  if (plan.reupload.length) await db.markNotUploaded(plan.reupload);
  const now = Date.now();
  await db.setSettings([...plan.mark.map(id => [markKey(id), now]), ...plan.unmark.map(id => [markKey(id), null]),
    ...swept.map(id => [markKey(id), GONE]), ...plan.reupload.map(id => [markKey(id), null]),
    ['mediaRefs', { userId: uid, ids: [...used] }]]);          // (this device only: db.js LOCAL_ONLY)
}
async function fetchMedia(token, uid, id) {
  const got = await supa.downloadMedia(token, uid, id);
  if (!got) return null;
  const m = { id, type: storedType(got.type, got.data), data: got.data, size: got.data.byteLength, created: Date.now() };
  await db.putRemoteMedia(m);
  return m;
}

// ---------- downloading a file when a card needs it ----------
// The files this device lacks are fetched when they are first needed (lazy-media.js has the reasons and the rules). Everything goes
// through loadMedia, so one file is never downloaded twice at once (front and back of a card, a sound's check and its play button, a
// sync's look-ahead), and one that just failed is not asked for again straight away.
const inflight = new Map();           // id → the download in progress
const failedFetches = new Map();      // id → { at, reason, tries }; kept while the app is open
globalThis.addEventListener?.('online', () => { for (const [id, f] of failedFetches) if (f.reason === 'offline') failedFetches.delete(id); });
// kind: 'view' (a card shows it), 'prefetch' (a sync looks ahead) or 'force' (the person asked: an export)
// Returns { media, reason, error }: media is the saved file (or null); reason says why not ('offline', 'signed-out', 'missing', 'error').
export function loadMedia(id, kind = 'view') {
  const cur = inflight.get(id);
  if (cur && (kind !== 'force' || cur.real)) return cur.p;          // (a request that was only turned away by the backoff doesn't count for a person's own request)
  const entry = { real: false };
  entry.p = loadMediaNow(id, kind, entry).finally(() => { if (inflight.get(id) === entry) inflight.delete(id); });
  inflight.set(id, entry);
  return entry.p;
}
async function loadMediaNow(id, kind, entry) {
  const failed = (reason, error) => { failedFetches.set(id, failedAgain(failedFetches.get(id), reason, Date.now())); return { media: null, reason, error }; };
  const before = failedFetches.get(id);
  if (before && !canTry(before, Date.now(), kind)) return { media: null, reason: before.reason };
  if (globalThis.navigator?.onLine === false) return failed('offline');
  entry.real = true;
  let auth;
  try { auth = await session(); } catch (err) { return failed(supa.isSignedOutError(err) ? 'signed-out' : 'offline', err); }
  if (!auth) return { media: null, reason: 'signed-out' };
  try {
    const media = await fetchMedia(auth.access_token, auth.user.id, id);
    if (!media) return failed('missing');
    failedFetches.delete(id);
    return { media, reason: null };
  } catch (err) {
    return failed(err.code === 'network' || err.code === 'timeout' ? 'offline' : 'error', err);
  }
}
// One picture or sound, straight away (a card on screen needs it). null if it can't be had (see loadMedia for why).
export async function downloadMedia(id) {
  return (await loadMedia(id, 'view')).media;
}

// The files cards use that this device doesn't have: { pictures: [ids], sounds: [ids] } (sounds: false leaves sounds out; cards: only these).
export async function missingMedia({ sounds = true, cards } = {}) {
  const want = wantedMedia(cards || await db.getAll('cards'), new Set(await db.mediaKeys()));
  return { pictures: want.pictures, sounds: sounds ? want.sounds : [] };
}
// Fetch files now, for an export or before signing out (the person asked, so a recent failure doesn't stop it). Four at a time.
// ids: which files (default: every missing one). Returns { total, got, left, gone, reason }:
//   left    ids that could not be fetched just now (offline, signed out, a server problem): worth trying again
//   gone    ids the account doesn't have (nothing to fetch: they were swept or never uploaded)
//   reason  the first reason a file was not fetched ('offline', 'signed-out', 'missing', 'error'), or null
export async function downloadAllMedia({ ids, sounds = true, onProgress, signal } = {}) {
  if (!ids) { const m = await missingMedia({ sounds }); ids = [...m.pictures, ...m.sounds]; }
  const have = new Set(await db.mediaKeys());
  ids = [...new Set(ids)].filter(id => !have.has(id));
  let reason = null, got = 0, offlineRun = 0, stop = false;
  const gone = new Set();
  await runPool(ids, async id => {
    if (stop || signal?.aborted) return;
    const r = await loadMedia(id, 'force');
    if (r.media) { got++; offlineRun = 0; return; }
    reason ||= r.reason;
    if (r.reason === 'missing') { gone.add(id); offlineRun = 0; }
    else if (r.reason === 'signed-out' || (r.reason === 'offline' && ++offlineRun >= 2)) stop = true;      // no connection (or a very slow one): the rest would only wait for time-outs
  }, { onProgress }).catch(err => { if (!isWholeStorageError(err)) throw err; reason ||= 'error'; });
  const now = new Set(await db.mediaKeys());          // (a storage problem or a stop leaves the rest missing)
  return { total: ids.length, got, left: ids.filter(id => !now.has(id) && !gone.has(id)), gone: [...gone], reason, cancelled: !!signal?.aborted };
}
const cancelled = () => new supa.SupaError('Cancelled. Nothing was deleted.', { code: 'cancelled' });
// Before something that leaves this device on its own (Delete my synced data, Delete my account): make sure it holds the files its
// cards use, because afterwards the account can't give them back. Throws a message to show when some could not be fetched
// (code 'media_left': the person may go on anyway), or 'cancelled'. The caller asks for a fresh sign-in afterwards (a long download
// can outlast the token).
async function keepDeviceWhole({ onProgress, signal, anyway } = {}) {
  const r = await downloadAllMedia({ onProgress, signal });
  if (signal?.aborted) throw cancelled();
  if (r.left.length && !anyway) {
    const n = r.left.length;
    throw new supa.SupaError(`${n.toLocaleString()} ${n === 1 ? 'picture or sound' : 'pictures and sounds'} your cards use ${n === 1 ? "isn't" : "aren't"} on this device yet and couldn't be downloaded now, so ${n === 1 ? 'it' : 'they'} would be lost here. Connect to the internet and try again. Nothing was deleted.`, { code: 'media_left' });
  }
}

// ---------- when to sync ----------
export function startAutoSync() {
  if (started) return;
  started = true;
  db.onLocalChange(() => {
    clearTimeout(timer);
    timer = setTimeout(() => syncNow({ skipIfBusy: true }), AFTER_CHANGE);
  });
  addEventListener('online', () => syncNow({ skipIfBusy: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow({ skipIfBusy: true }); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow({ skipIfBusy: true }); }, EVERY);
  syncNow({ skipIfBusy: true });
}
