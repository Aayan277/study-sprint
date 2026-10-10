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
import { rowFromRecord, rowFromTombstone, rowFromSetting, newestOnly, chunks } from './sync-merge.js';

const AFTER_CHANGE = 4000;            // wait this long after a change, so a burst of changes goes in one sync
const EVERY = 5 * 60 * 1000;          // and check for other devices' changes every 5 minutes while open
const PAGE = 1000;                    // rows per request when pulling
const BATCH = 500;                    // rows per request when pushing

let running = null, again = false, timer = 0, started = false;
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

export async function createAccount(email, password) { return signedIn(await supa.signUp(email.trim(), password)); }
export async function signIn(email, password) { return signedIn(await supa.signIn(email.trim(), password)); }

async function signedIn(session) {
  const { syncState } = await db.getSettings();
  await db.setSetting('syncAuth', session);
  // A different account than last time on this device (or the first): start from the beginning, so
  // everything here is sent and everything on the server is merged in.
  if (!syncState || syncState.userId !== session.user.id) {
    await db.setSetting('syncState', { userId: session.user.id, lastSeq: 0, pushedUntil: 0, lastSync: 0 });
  }
  return syncNow();
}

// Sign out on this device. Its data stays here. (Signing back in to the same account carries on where it
// left off; changes made meanwhile are sent then.)
export async function signOut() {
  const { syncAuth } = await db.getSettings();
  if (syncAuth) await supa.signOut(syncAuth.access_token);
  await db.setSetting('syncAuth', null);
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

// ---------- syncing ----------
// Sync now. If a sync is already running, one more runs straight after it (so nothing is missed).
export function syncNow() {
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
  emit({ state: 'syncing', error: null });
  const token = auth.access_token;
  let st = (await db.getSettings()).syncState || { userId: auth.user.id, lastSeq: 0, pushedUntil: 0, lastSync: 0 };

  // 1. Pull what changed on the server since last time.
  let applied = 0;
  for (;;) {
    const rows = await supa.getChanges(token, st.lastSeq, PAGE);
    if (!rows.length) break;
    applied += await db.applyRemote(rows);
    st = { ...st, lastSeq: Math.max(st.lastSeq, ...rows.map(r => Number(r.seq))) };
    await db.setSetting('syncState', st);
    if (rows.length < PAGE) break;
  }

  // 2. Push what changed here. Anything changed while this runs is caught by the next sync.
  const pushStart = Date.now();
  const changes = await db.localChangesSince(st.pushedUntil);
  const rows = newestOnly([
    ...Object.entries(changes.records).flatMap(([name, list]) => list.map(r => rowFromRecord(name, r))),
    ...changes.tombstones.map(rowFromTombstone),
    ...changes.settings.map(s => rowFromSetting(s.key, s.value, s.time))
  ]);
  for (const part of chunks(rows, BATCH)) await supa.putRows(token, part);

  st = { ...st, pushedUntil: pushStart - 1, lastSync: Date.now() };
  await db.setSetting('syncState', st);
  emit({ state: 'done', at: st.lastSync, applied, sent: rows.length, error: null });
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
