// Syncing this device with Supabase, so every device has the same decks, cards, progress and study settings.
//
// One sync does two things:
//   1. Pull: ask the server for every change since the last one this device saw (by its change number, seq),
//      and save each one unless this device has a newer version (db.applyRemote).
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
import { planMedia, explainRefusal, fetchUsage } from './sync-quota.js';
import { fullMessage, splitOversized, capTimes, rowLabel, rowBytes, bigRowsNote, dataFullMessage, SERVER_FULL_MESSAGE } from './quota.js';
import { pushSafely } from './sync-push.js';
import { storedType } from './audio-type.js';
import { rowFromRecord, rowFromTombstone, rowFromSetting, newestOnly, chunks, parseAuthLink, uploadMediaFiles, runPool, isSoundRow, SOUNDS_BLOCKED_NOTE, PICTURES_BLOCKED_NOTE } from './sync-merge.js';

const AFTER_CHANGE = 4000;            // wait this long after a change, so a burst of changes goes in one sync
const EVERY = 5 * 60 * 1000;          // and check for other devices' changes every 5 minutes while open
const PAGE = 1000;                    // rows per request when pulling
const BATCH = 500;                    // rows per request when pushing

let running = null, again = false, timer = 0, started = false;
let retrySounds = true;       // sounds the server turned away are tried again once each time the app opens, and on Sync now
let last = { state: 'idle', at: 0, applied: 0, sent: 0, error: null };

function emit(detail) {
  last = { ...last, ...detail };
  dispatchEvent(new CustomEvent('sync', { detail: last }));
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
export async function deleteServerData() {
  const auth = await session();
  if (!auth) throw new supa.SupaError('Sign in first.');
  await supa.deleteAllRows(auth.access_token, auth.user.id);
  try { await supa.deleteMedia(auth.access_token, auth.user.id, await supa.listMedia(auth.access_token, auth.user.id)); } catch (err) { console.error(err); }
  await signOut({ forget: true });
}

// Delete the account itself: its files, its synced data, and the sign-in. This device keeps its own data and is
// signed out. (Needs supabase/limits.sql on the project.)
export async function deleteAccount() {
  const auth = await session();
  if (!auth) throw new supa.SupaError('Sign in first.');
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
  await db.setSetting('syncAuth', null);
  if (forget) await db.setSetting('syncState', null);
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
export function syncNow({ retry = false } = {}) {
  if (retry) retrySounds = true;
  if (running) { again = true; return running; }
  running = run()
    .catch(err => {
      console.error('Sync failed', err);
      emit(supa.isSignedOutError(err) ? { state: 'signed-out', error: err.message } : { state: 'error', error: err.message });
    })
    .finally(() => {
      running = null;
      if (again) { again = false; syncNow(); }
    });
  return running;
}

async function run() {
  const auth = await session();
  if (!auth) return;
  emit({ state: 'syncing', error: null, progress: null });
  const token = auth.access_token;
  let st = (await db.getSettings()).syncState || { userId: auth.user.id, lastSeq: 0, pushedUntil: 0, lastSync: 0 };

  // 1. Pull what changed on the server since last time.
  let applied = 0, pulled = 0, gotNotes = false;
  for (;;) {
    const rows = await supa.getChanges(token, st.lastSeq, PAGE);
    if (!rows.length) break;
    applied += await db.applyRemote(rows);
    if (rows.some(r => r.store === 'cards' && r.data?.noteId)) gotNotes = true;
    pulled += rows.length;
    if (pulled >= PAGE) emit({ progress: `Downloaded ${pulled.toLocaleString()} changes…` });   // big first syncs
    st = { ...st, lastSeq: Math.max(st.lastSeq, ...rows.map(r => Number(r.seq))) };
    await db.setSetting('syncState', st);
    if (rows.length < PAGE) break;
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
    ...changes.settings.map(s => rowFromSetting(s.key, s.value, s.time))
  ])));
  const pushed = await pushSafely(part => supa.putRows(token, part), rows, {
    onProgress: (i, n) => { if (n > BATCH) emit({ progress: `Sending ${i.toLocaleString()} of ${n.toLocaleString()} changes…` }); }
  });
  // Records too big to send, kept until they are shortened (editing one makes it a new change, which is tried again)
  // or deleted. Anything that went through now is no longer a problem.
  const wentKeys = new Set(pushed.sent.map(r => `${r.store}|${r.id}`));
  const tooBig = [...(st.tooBig || []), ...big, ...pushed.bad.map(b => ({ store: b.row.store, id: b.row.id, label: rowLabel(b.row), bytes: rowBytes(b.row) }))];
  const stillBig = [...new Map(tooBig.map(r => [`${r.store}|${r.id}`, r])).values()].filter(r => !wentKeys.has(`${r.store}|${r.id}`));
  // Rows the server's space limits held back stay "not sent yet": the bookmark doesn't move, so they go again next time.
  // (What did go is sent again too; the server ignores a copy it already has.)
  let spaceNote = null;
  if (pushed.held.length) {
    spaceNote = pushed.full === 'server' ? SERVER_FULL_MESSAGE : dataFullMessage(await fetchUsage(token));
  }

  st = { ...st, pushedUntil: pushed.held.length ? st.pushedUntil : pushStart - 1, lastSync: Date.now(), tooBig: stillBig };
  await db.setSetting('syncState', st);
  const note = [spaceNote, bigRowsNote(stillBig), mediaNote].filter(Boolean).join(' ') || null;
  emit({ state: 'done', at: st.lastSync, applied, sent: pushed.sent.length, error: null, progress: null, note });
}

// ---------- pictures and sounds ----------
// Both are files in the same bucket. Pictures go first, so a problem with sounds can never hold them up.
// Returns a note to show under Settings → Sync (or null); a problem with the whole storage setup is thrown.
async function syncMedia(auth) {
  const token = auth.access_token, uid = auth.user.id;
  const rows = await db.mediaToUpload();
  // Sounds the server turned away stay put (and aren't re-sent every time) until the app is opened again or Sync now is pressed.
  const pending = rows.filter(m => !(m.blocked === 'type' && !retrySounds));
  // Within the account's space limit (sync-quota.js): what doesn't fit waits on this device and goes when there's room.
  const gate = await planMedia(auth, pending);
  let upload;
  try {
    upload = await uploadMediaFiles(gate.send, m => supa.uploadMedia(token, uid, m.id, m.type, m.data), {
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
  // What to tell the person: only files that are turned away now (this run), or were left out of it because they were before.
  // (A file that was blocked, tried again and went up is no longer a problem.)
  const left = [...upload.blocked.map(id => pending.find(m => m.id === id)), ...rows.filter(m => !pending.includes(m))].filter(Boolean);
  const blockedKinds = { picture: left.some(m => !isSoundRow(m)), sound: left.some(isSoundRow) };
  upload.failed.forEach(f => console.error('Could not send a file', f.id, f.message));

  // Pictures and sounds that cards here use but this device doesn't have yet. Four at a time.
  const have = new Set(await db.mediaKeys());
  const cards = await db.getAll('cards');
  const wantOf = fields => [...new Set(cards.flatMap(c => fields.flatMap(f => (Array.isArray(c[f]) ? c[f] : [c[f]]))).filter(id => id && !have.has(id)))];
  for (const [kind, ids] of [['pictures', wantOf(['frontImage', 'backImage'])], ['sounds', wantOf(['frontSounds', 'backSounds'])]]) {
    await runPool(ids, id => fetchMedia(token, uid, id), {
      onProgress: (n, total) => { if (total > 3) emit({ progress: `Downloading ${kind}: ${n} of ${total}…` }); }
    });
  }
  // Pictures and sounds no card uses any more: remove them here and from the account.
  const removed = await db.cleanMedia();
  if (removed.length) await supa.deleteMedia(token, uid, removed).catch(err => console.error(err));
  if (gate.full) return fullMessage(gate.full);
  if (gate.note) return gate.note;
  return blockedKinds.picture ? PICTURES_BLOCKED_NOTE : blockedKinds.sound ? SOUNDS_BLOCKED_NOTE : null;
}
async function fetchMedia(token, uid, id) {
  const got = await supa.downloadMedia(token, uid, id);
  if (!got) return null;
  const m = { id, type: storedType(got.type, got.data), data: got.data, size: got.data.byteLength, created: Date.now() };
  await db.putRemoteMedia(m);
  return m;
}
// One picture, straight away (a card on screen needs it). null if signed out or the account doesn't have it.
export async function downloadMedia(id) {
  const auth = await session().catch(() => null);
  return auth ? fetchMedia(auth.access_token, auth.user.id, id) : null;
}

// ---------- when to sync ----------
export function startAutoSync() {
  if (started) return;
  started = true;
  db.onLocalChange(() => {
    clearTimeout(timer);
    timer = setTimeout(syncNow, AFTER_CHANGE);
  });
  addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, EVERY);
  syncNow();
}
