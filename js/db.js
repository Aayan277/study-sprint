// Storage for the whole app, using IndexedDB (a database built into every browser).
// It can hold far more than localStorage, so big decks are fine.
//
// The database has 6 "stores" (think of them as tables):
//   decks       one row per deck            { id, name, color, created, course, updatedAt }
//   cards       one row per card            { id, deckId, front, back, tags, created, updatedAt }
//   cardStates  FSRS schedule for a card    { cardId, due, stability, difficulty, reps, lapses, state, lastReview, updatedAt, fsrs7? }
//                                           (fsrs7 = the FSRS-7 memory, only on cards FSRS-7 scheduled; see srs7.js)
//   reviewLog   one row per answer          { id (auto), uid, cardId, timestamp, source, mode, correct, ms, rating, updatedAt }
//   settings    simple key → value pairs    e.g. 'theme' → { skin: 'violet', mode: 'auto', oled: false }
//   deleted     what was deleted, and when  { key, store, id, deletedAt }
//   media       pictures on cards           { id, type, data (the file's bytes), size, created, uploaded }
//               (a card points to its pictures with frontImage / backImage = a media id, and to its sounds with
//               frontSounds / backSounds = lists of media ids: see media.js)
// updatedAt, uid and the deleted store are there for syncing between devices: see sync-data.js.
// Every save below stamps them, so other files never need to.
//
// Everything here returns a Promise, so callers use `await`.

const DB_NAME = 'study-sprint';
const DB_VERSION = 3;   // 1 → 2: added updatedAt, review uids and the deleted store (for sync). 2 → 3: media store

import { isMarkKey, isSeenKey, markKey, markId, seenKey, validMark, GONE } from './media-sweep.js';
import { acceptStatsLayout } from './stats-layout.js';
import { stamp, tombstone, tombstoneKey, upgradeRecord, acceptSetting, SYNC_ID, SYNCED_SETTINGS, MERGED_SETTINGS, SETTING_TIMES, randomId, isSyncedSetting } from './sync-data.js';
import { cleanFsrsParams, cleanIgnoreBefore, cleanFsrsVersion } from './sched-settings.js';
import { cleanGlossary } from './glossary.js';
import { decide, MERGERS, recordFromRow, needsPush, tombstoneNeedsPush, badRow, addDamaged } from './sync-merge.js';
import { dayStart, dayEnd } from './days.js';
import { validOcclusion } from './occlusion.js';
import { validFields, cleanFields } from './note-fields.js';
import { cleanAccept } from './accept.js';
import { cleanTypeIn } from './type-in.js';

export const DEFAULT_SETTINGS = {
  theme: { ui: 'original', skin: 'violet', mode: 'auto', oled: false }, // (a new install follows the device's light or dark setting; a saved choice is kept) ui: 'original' or 'clinical' (css/clinical.css); mode: 'dark', 'light', or 'auto' (follows the device); see themes.js
  cardAlign: 'auto', // card text alignment on this device: 'auto' (short text centred, long answers left), 'center' or 'left'. Never synced, like the theme
  compactDecks: true,    // Decks: search, sort, subdecks folded under their course and small play buttons (off = the old list). This device only
  ratingFeedback: true,  // Review: a ring on the pressed button, the interval floating up and an outline of the old card leaving. This device only
  smoothMotion: true,    // Smooth transitions: tabs slide and sheets spring (View Transitions). This device only
  singleKeys: true,      // Single-key shortcuts in Review, Play and the card sheet (E, I, R, D, Z, 1-4, ...); off for voice control and switch users (WCAG 2.1.4). This device only
  statsReadiness: true,  // Stats for one course: a readiness header with an Exam prep button, Mastery on top (off = no header). This device only
  targetRetention: 0.9,
  newPerDay: 20,
  timer: 8,          // seconds per question in Play
  reviewDecks: [],   // decks chosen on the Review screen; empty means all decks
  reviewTyping: false, // type answers instead of flipping
  learningSteps: '1m 10m',  // advanced scheduling (see sched-settings.js)
  relearningSteps: '10m',
  maxInterval: 36500,        // days
  fuzz: true,
  leechThreshold: 8,         // forgotten this many times = a leech (0 = off); see browse-logic.js
  leechAction: 'suspend',    // 'suspend' or 'tag'
  reviewLimit: null,         // reviews per day across all decks (null = no limit)
  ignoreBefore: null,        // 'YYYY-MM-DD' or null: the optimizer and the health check ignore reviews before this day (messy early history). Synced, newest wins
  fsrsParams: null,          // your own FSRS weights from the optimizer: { w, at, reviews, cards, logLoss, rmse, version } or null (the standard ones); see sched-settings.js. Synced, newest wins
  statsLayout: null,         // Customise Stats: { order, hidden, size } or null (the default layout); see stats-layout.js. Synced, newest wins
  fsrsVersion: 6,            // which FSRS schedules cards: 6 (standard) or 7 (beta, off by default); see sched-settings.js and docs/design/fsrs7-plan.md. Synced, newest wins
  dailyGoal: 20,             // not used since v4.10 (the Today ring counts today's work); still accepted in backups and sync so old values don't break
  playCountsAsReviews: false, // false: Play is practice only (no schedule, stats or streak changes). true: Play answers count as reviews. Synced
  easyDays: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal'],   // Sunday first: 'normal' | 'reduced' | 'minimum' (balance.js)
  restDays: {},      // days off for the streak: { 'YYYY-MM-DD': { on, at } }, merged per day when syncing (sync-merge.js)
  rescue: null,      // catch-up plan after a break: { start, days, backlog, pauseNew, at } (queue.js rescueToday). Synced, newest wins; Today clears it when it is over
  extraNew: null,    // { day, n }: extra new cards added for one day with Custom study
  appBadge: false,       // Settings → Study → Reminders: show the due count on the app icon (badge.js). This device only
  reminderTime: '19:00', // the time last used for the daily calendar reminder (reminders.js). This device only
  whatsNewSeen: null, // the newest version whose "What's new" card was shown or dismissed on this device (whats-new.js). This device only
  seeded: false,     // true once the sample deck has been added on first open
  onboarded: false   // true once the first-run start (js/onboarding.js) was finished or skipped (kept in backups)
};

let dbPromise = null;

// Open (and on first run, create) the database. Only happens once per page load.
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Runs only when the database is new or DB_VERSION goes up. This is where tables are created.
    req.onupgradeneeded = e => {
      const db = req.result;
      if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cards')) {
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('deckId', 'deckId');
      }
      if (!db.objectStoreNames.contains('cardStates')) {
        const st = db.createObjectStore('cardStates', { keyPath: 'cardId' });
        st.createIndex('due', 'due');
      }
      if (!db.objectStoreNames.contains('reviewLog')) {
        const log = db.createObjectStore('reviewLog', { keyPath: 'id', autoIncrement: true });
        log.createIndex('cardId', 'cardId');
        log.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      // Version 2: syncing groundwork.
      if (!db.objectStoreNames.contains('deleted')) db.createObjectStore('deleted', { keyPath: 'key' });
      // Version 3: pictures.
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      const logs = req.transaction.objectStore('reviewLog');
      if (!logs.indexNames.contains('uid')) logs.createIndex('uid', 'uid');
      // "What changed since the last sync?" is answered with these indexes instead of reading everything.
      for (const name of ['decks', 'cards', 'cardStates', 'reviewLog']) {
        const os = req.transaction.objectStore(name);
        if (!os.indexNames.contains('updatedAt')) os.createIndex('updatedAt', 'updatedAt');
      }
      const del = req.transaction.objectStore('deleted');
      if (!del.indexNames.contains('deletedAt')) del.createIndex('deletedAt', 'deletedAt');
      // Data saved by version 1: give every record its updatedAt (and every review its uid).
      if (e.oldVersion >= 1 && e.oldVersion < 2) {
        const now = Date.now();
        for (const name of ['decks', 'cards', 'cardStates', 'reviewLog']) {
          req.transaction.objectStore(name).openCursor().onsuccess = ev => {
            const cur = ev.target.result;
            if (!cur) return;
            cur.update(upgradeRecord(name, cur.value, now));
            cur.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Study Sprint tabs and reload.'));
  });
  return dbPromise;
}

// Turn an IndexedDB request into a Promise.
const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
// Resolves when a whole transaction has been saved to disk.
const finished = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Save was cancelled'));
});
// Runs the steps that fill a transaction, then waits for it to be saved. If a step throws, the transaction
// is cancelled so nothing is saved, and the error is passed on. (IndexedDB doesn't do this by itself when
// the code is inside an async function: it would save whatever was done before the error.)
async function inTx(tx, steps) {
  const saved = finished(tx);
  saved.catch(() => {});   // the cancel below makes this fail too: the error we rethrow is the one that matters
  try { await steps(); } catch (e) { try { tx.abort(); } catch (e2) { /* already finished */ } throw e; }
  await saved;
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---------- generic helpers ----------
export async function getAll(name) { return done((await store(name)).getAll()); }
// Every record of a store, read a few thousand at a time with a pause between, so a big review log doesn't hold the page up while
// it is turned into objects (getAll does all of it in one go). Same result as getAll, in key order. For the optimizer.
export async function getAllInPieces(name, size = 3000) {
  const out = [];
  let after = null;
  for (;;) {
    const os = await store(name);
    const piece = await done(os.getAll(after === null ? undefined : IDBKeyRange.lowerBound(after, true), size));
    out.push(...piece);
    if (piece.length < size) return out;
    after = piece[piece.length - 1][os.keyPath];
    await new Promise(r => setTimeout(r, 0));
  }
}
// ---------- cached reads of the cards and the schedules ----------
// Today, Decks, a deck's page, Review, Play, Stats and Browse all start by reading every card and every schedule, which is
// most of their time on a big account. This keeps the last read of each, until the data changes (dataVersion() goes up: every save
// below, changes from sync, an import, and another open tab all raise it, so a kept read is never older than the data).
//   getAllCached(name)                a copy of the rows that nobody else holds, so callers may sort or change them
//   getAllCached(name, { shared })    the kept rows themselves, for a caller that only reads (never sorts or changes them). Note that
//                                     saveReview/undoReview may later patch such an array in place (rows inserted, replaced or removed).
// The kept arrays stay in memory for the whole session. A save in another tab is only seen here when its BroadcastChannel message
// arrives, so for a few milliseconds after it a kept read can still be the old one.
// Only 'cards' and 'cardStates' are kept; any other store is read fresh.
const KEPT = ['cards', 'cardStates'];
// cardsGen goes up whenever a kept 'cards' array is changed in place (keptStill below only patches cardStates today). A cache built from
// the kept card rows (study-data.js sortedCopies) includes it in its key, so such a patch could never leave it stale.
let cardsGen = 0;
export const cardsGeneration = () => cardsGen;
const KEY_OF = { cards: 'id', cardStates: 'cardId' };
const kept = new Map();      // name -> { version, rows (once read), promise }
export async function getAllCached(name, { shared = false } = {}) {
  if (!KEPT.includes(name)) return getAll(name);
  let e = kept.get(name);
  if (!e || e.version !== dataChanges) {
    const mine = e = { version: dataChanges, rows: null, promise: null };
    mine.promise = getAll(name).then(rows => { mine.rows = rows; return rows; }, err => { if (kept.get(name) === mine) kept.delete(name); throw err; });
    kept.set(name, mine);
  }
  const rows = e.rows || await e.promise;
  return shared ? rows : rows.map(r => ({ ...r }));
}
// A save that changed only what the caller says: the kept reads that are still right stay (the version moves on with them).
//   patches  { cardStates: { put: [row, ...], del: [key, ...] } }: kept rows to change in step with the save
// Anything not named in `patches` or `unchanged` is dropped by the new version number, as for every other save.
function keptStill(patches = {}, unchanged = []) {
  try { return keptStillUnsafe(patches, unchanged); } catch (err) { console.warn('kept reads dropped:', err); return []; }       // (a save that is already committed must never fail because of this)
}
const cloneRow = row => (typeof structuredClone === 'function' ? structuredClone(row) : JSON.parse(JSON.stringify(row)));       // (Safari before 15.4 has no structuredClone)
function keptStillUnsafe(patches, unchanged) {
  const keep = [];
  for (const name of KEPT) {
    const e = kept.get(name);
    if (!e || e.version !== dataChanges) continue;            // already out of date (or never read)
    const patch = patches[name];
    if (patch) {
      if (!e.rows) continue;                                  // still being read: it may or may not hold this save
      const key = KEY_OF[name];
      const rows = e.rows;
      const find = k => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][key] < k) lo = m + 1; else hi = m; } return lo; };
      const ok = [...(patch.put || []), ...(patch.del || [])].every(x => typeof (x[key] ?? x) === 'string');
      if (!ok || rows.some((r, i) => i && !(rows[i - 1][key] < r[key]))) continue;       // keys that are not text, or rows not in key order: drop the read instead
      if (name === 'cards') cardsGen++;
      for (const k of patch.del || []) { const i = find(k); if (rows[i]?.[key] === k) rows.splice(i, 1); }
      for (const row of patch.put || []) { const i = find(row[key]); const c = cloneRow(row); if (rows[i]?.[key] === row[key]) rows[i] = c; else rows.splice(i, 0, c); }
      keep.push(e);
    } else if (unchanged.includes(name)) keep.push(e);
  }
  return keep;
}

// How many records a store holds, without reading them (Settings uses it for the review log).
export async function count(name) { return done((await store(name)).count()); }
export async function get(name, key) { return done((await store(name)).get(key)); }
export async function getAllByIndex(name, index, value) {
  return done((await store(name)).index(index).getAll(value));
}
// Saves here are made on this device, so they're stamped with the time (see sync-data.js).
export async function put(name, value) {
  const key = await done((await store(name, 'readwrite')).put(stamp(name, value)));
  changed();
  return key;
}

// Save many rows in one go (much faster than one at a time, and all-or-nothing).
export async function putMany(name, values) {
  const db = await openDB();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  const now = Date.now();
  await inTx(tx, () => values.forEach(v => os.put(stamp(name, v, now))));
  changed();
}

// ---------- ids ----------
export const newId = randomId;

// Record that something was deleted, inside a transaction that includes the 'deleted' store.
const markDeleted = (tx, storeName, id, now) => tx.objectStore('deleted').put(tombstone(storeName, id, now));

// ---------- decks ----------
export const getDecks = () => getAll('decks');
export const getDeck = id => get('decks', id);
export const saveDeck = deck => put('decks', deck);
export const getCardsInDeck = deckId => getAllByIndex('cards', 'deckId', deckId);

// Create a deck and (optionally) its cards in a single save.
// at: the change time to record (normally now). The sample deck uses 1, "older than anything", so after
// syncing, a delete or edit made on another device always wins over a fresh device's untouched copy.
export async function addDeckWithCards(deck, cards = [], { at = Date.now() } = {}) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards'], 'readwrite');
  const now = at;
  await inTx(tx, () => {
    tx.objectStore('decks').put(stamp('decks', deck, now));
    const cs = tx.objectStore('cards');
    cards.forEach(c => cs.put(stamp('cards', c, now)));
  });
  changed();
}

// Save a whole import in one go: new decks, the cards, and (from Anki) review history and schedules.
// All or nothing, so a failure never leaves an empty deck behind.
export async function addImport({ decks = [], cards = [], reviewLog = [], cardStates = [] }) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards', 'reviewLog', 'cardStates'], 'readwrite');
  const now = Date.now();
  await inTx(tx, () => {
    for (const [name, rows] of Object.entries({ decks, cards, reviewLog, cardStates })) {
      const os = tx.objectStore(name);
      rows.forEach(r => os.put(stamp(name, r, now)));
    }
  });
  scheduleChanges++;
  changed();
}

// Delete a deck plus everything that belongs to it: its cards, their schedules and their review history.
// All in one transaction, so it can't half-finish.
export async function deleteDeck(deckId) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards', 'cardStates', 'reviewLog', 'deleted'], 'readwrite');
  const now = Date.now();
  const cards = tx.objectStore('cards');
  tx.objectStore('decks').delete(deckId);
  markDeleted(tx, 'decks', deckId, now);
  cards.index('deckId').getAllKeys(deckId).onsuccess = e => {
    for (const cardId of e.target.result) deleteCardIn(tx, cardId, now);
  };
  await finished(tx);
  changed();
}

// Delete one card with its schedule and every review-log row, leaving deleted markers. Inside a transaction
// that includes cards, cardStates, reviewLog and deleted.
function deleteCardIn(tx, cardId, now) {
  tx.objectStore('cards').delete(cardId);
  markDeleted(tx, 'cards', cardId, now);
  deleteStateIn(tx, cardId, now);
  tx.objectStore('reviewLog').index('cardId').openCursor(cardId).onsuccess = ev => {
    const cur = ev.target.result;
    if (!cur) return;
    if (cur.value.uid) markDeleted(tx, 'reviewLog', cur.value.uid, now);
    cur.delete();
    cur.continue();
  };
}
// Remove a card's schedule (if it has one), leaving a deleted marker.
function deleteStateIn(tx, cardId, now) {
  const states = tx.objectStore('cardStates');
  states.getKey(cardId).onsuccess = e => {
    if (e.target.result === undefined) return;
    states.delete(cardId);
    markDeleted(tx, 'cardStates', cardId, now);
  };
}

// ---------- reviews ----------
// Counts schedule changes made while the app is open, so a paused Review session can tell
// whether Play changed any cards behind its back (and start fresh instead of resuming).
let scheduleChanges = 0;
export const scheduleVersion = () => scheduleChanges;

// Save a card's new schedule and its review-log row together. Returns the log row's id (for undo).
export async function saveReview(state, log) {
  const db = await openDB();
  const tx = db.transaction(['cardStates', 'reviewLog'], 'readwrite');
  const now = Date.now();
  const saved = stamp('cardStates', state, now);
  tx.objectStore('cardStates').put(saved);
  const req = tx.objectStore('reviewLog').add(stamp('reviewLog', log, now));
  await finished(tx);
  scheduleChanges++;
  changed(keptStill({ cardStates: { put: [saved] } }, ['cards']));      // (the kept cards and schedules stay right: this answer is added to them)
  return req.result;
}

// Save a review-log row without changing any schedule (e.g. a Play answer on a card that isn't due).
export async function addLog(log) {
  const id = await done((await store('reviewLog', 'readwrite')).add(stamp('reviewLog', log)));
  changed(keptStill({}, KEPT));       // (no card or schedule changed)
  return id;
}

// Undo a review: put the old schedule back (or remove it if the card was new) and delete the log row.
export async function undoReview(cardId, prevState, logId) {
  const db = await openDB();
  const tx = db.transaction(['cardStates', 'reviewLog', 'deleted'], 'readwrite');
  const now = Date.now();
  const restored = prevState ? stamp('cardStates', prevState, now) : null;
  if (restored) tx.objectStore('cardStates').put(restored);
  else deleteStateIn(tx, cardId, now);
  const logs = tx.objectStore('reviewLog');
  logs.get(logId).onsuccess = e => {
    if (e.target.result?.uid) markDeleted(tx, 'reviewLog', e.target.result.uid, now);
    logs.delete(logId);
  };
  await finished(tx);
  scheduleChanges++;
  changed(keptStill({ cardStates: restored ? { put: [restored] } : { del: [cardId] } }, ['cards']));
}

// Delete one review-log row and nothing else (Play's "I was right" on an answer that was only logged).
export async function deleteLogRow(logId) {
  const db = await openDB();
  const tx = db.transaction(['reviewLog', 'deleted'], 'readwrite');
  const now = Date.now();
  const logs = tx.objectStore('reviewLog');
  logs.get(logId).onsuccess = e => {
    if (e.target.result?.uid) markDeleted(tx, 'reviewLog', e.target.result.uid, now);
    logs.delete(logId);
  };
  await finished(tx);
  changed(keptStill({}, KEPT));       // (no card or schedule changed)
}

// Every review-log row since a moment in time (e.g. since the start of today).
export async function getLogsSince(timestamp) {
  return done((await store('reviewLog')).index('timestamp').getAll(IDBKeyRange.lowerBound(timestamp)));
}

// Every review-log row in a stretch of time: from `from` up to, not including, `to` (oldest first).
export async function getLogsBetween(from, to) {
  return done((await store('reviewLog')).index('timestamp').getAll(IDBKeyRange.bound(from, to, false, true)));
}

// Every review-log row of some cards (their cardIds), in no particular order: one small lookup in the cardId index for each card,
// all sent at once, so a deck's answers are read without reading the rest of the (much bigger) log.
export async function getLogsForCards(cardIds) {
  const ids = [...cardIds];
  const out = [];
  const tx = (await openDB()).transaction('reviewLog');
  const index = tx.objectStore('reviewLog').index('cardId');
  for (let i = 0; i < ids.length; i += 2000) {
    const parts = await Promise.all(ids.slice(i, i + 2000).map(id => done(index.getAll(id))));
    for (const rows of parts) for (const r of rows) out.push(r);
  }
  return out;
}

// For each stretch [from, to) in `ranges`, whether any answer was logged in it: [true, false, ...]. Every stretch is asked at once
// (a key cursor each, which reads no rows), so a hundred study days cost about what one did when they were asked one after another.
// The streak asks it for one study day per stretch.
export async function hasLogsIn(ranges) {
  if (!ranges.length) return [];
  const index = (await store('reviewLog')).index('timestamp');
  // (Only IndexedDB requests are made here, all in the same turn, so the transaction stays open.)
  const asks = ranges.map(([from, to]) => new Promise((resolve, reject) => {
    const req = index.openKeyCursor(IDBKeyRange.bound(from, to, false, true));
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  }));
  return Promise.all(asks);
}

// How many answers were logged on each study day, as [[start of the day, count], ...] (oldest first) for days that have any.
// Counts with the timestamp index, so none of the (many) rows are read. Stats uses it for the streak and calendar.
// Every row in the log is an answer (review, play or anki: see isAnswerLog), so none are filtered out here:
// filtering by source would mean reading every row, or a new index (a data format change).
// The days are found by asking about every study day in turn at once (a day's count, or a key cursor for the days further
// back, which only says whether there is an answer), not one after another: ~700 days take about the time of 30 asked singly.
//   exactSince  a time: days from then on get their real count; older days only say that they have answers (a count of 1), which is
//               all the streak and best streak need. Without it every day is counted exactly.
// Days before 2000 and days that start in the future are left out.
export async function getDayCounts({ exactSince = -Infinity } = {}) {
  const index = (await store('reviewLog')).index('timestamp');
  const first = await done(index.openKeyCursor(IDBKeyRange.lowerBound(Date.UTC(2000, 0, 1))));
  if (!first) return [];
  const now = Date.now();
  // The study days from the first answer's day to today, oldest first, as [start, end).
  const spans = [];
  for (let t = dayStart(first.key); t <= now; t = dayEnd(t)) spans.push([t, dayEnd(t)]);
  const exact = spans.filter(([t]) => t >= exactSince), rest = spans.filter(([t]) => t < exactSince);
  const out = [];
  // (Only IndexedDB requests are made here, in batches that are each sent in one turn, so the transaction stays open.)
  const ask = (list, one) => Promise.all(list.map(([from, to]) => one(IDBKeyRange.bound(from, to, false, true))));
  const counts = await ask(exact, range => done(index.count(range)));
  exact.forEach(([t], i) => { if (counts[i]) out.push([t, counts[i]]); });
  // Days before the exact stretch: only whether there is an answer. Asked in batches, so a very long history stays steady.
  for (let i = 0; i < rest.length; i += 500) {
    const part = rest.slice(i, i + 500);
    const has = await ask(part, range => new Promise((resolve, reject) => { const req = index.openKeyCursor(range); req.onsuccess = () => resolve(!!req.result); req.onerror = () => reject(req.error); }));
    part.forEach(([t], j) => { if (has[j]) out.push([t, 1]); });
  }
  return out.sort((x, y) => x[0] - y[0]);
}

// ---------- card list actions ----------
// Delete cards with their schedules and review history, all in one go.
export async function deleteCards(cardIds) {
  const db = await openDB();
  const tx = db.transaction(['cards', 'cardStates', 'reviewLog', 'deleted'], 'readwrite');
  const now = Date.now();
  for (const id of cardIds) deleteCardIn(tx, id, now);
  await finished(tx);
  scheduleChanges++;
  changed();
}

// Save a cloze note: every card of the note in one transaction, with the same change time.
//   plan    { update, add, remove } from planNoteSave() in cloze.js: cards to rewrite, blanks that need a new card,
//           and cards whose blank is gone (they are deleted with their schedule and history: the editor asks first)
//   common  fields every card of the note shares (deckId, noteId, tags, noteExtra). A value of undefined or ''
//           takes the field off the cards.
// Returns the saved cards.
export async function saveNote({ update = [], add = [], remove = [] }, common = {}) {
  const db = await openDB();
  const tx = db.transaction(['cards', 'cardStates', 'reviewLog', 'deleted'], 'readwrite');
  const now = Date.now();
  const saved = [];
  const shared = card => {
    const out = { ...card, ...common, noteEditedAt: now };     // when the note's text was last edited (healNotes picks the newest)
    for (const [k, v] of Object.entries(common)) if (v === undefined || v === '') delete out[k];
    return out;
  };
  await inTx(tx, () => {
    const cards = tx.objectStore('cards');
    for (const c of update) saved.push(shared(c));
    add.forEach((c, i) => saved.push(shared({ id: newId(), created: now + i, ...c })));
    saved.forEach(c => cards.put(stamp('cards', c, now)));
    for (const c of remove) deleteCardIn(tx, c.id, now);
  });
  scheduleChanges++;
  changed();
  return saved;
}

// Change schedules directly (set a due date), or remove them (reset a card to new).
// The review history is kept either way.
export async function putStates(states) { await putMany('cardStates', states); scheduleChanges++; }
export async function clearStates(cardIds) {
  const db = await openDB();
  const tx = db.transaction(['cardStates', 'deleted'], 'readwrite');
  const now = Date.now();
  cardIds.forEach(id => deleteStateIn(tx, id, now));
  await finished(tx);
  scheduleChanges++;
  changed();
}

// Every review-log row for one card (its history), oldest first.
export async function getCardLogs(cardId) {
  const rows = await getAllByIndex('reviewLog', 'cardId', cardId);
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

// Save edited cards (front, back, tags, suspended, buried, flag, deck). Counts as a schedule change
// because suspending or burying changes what Review shows.
export async function saveCards(cards) { await putMany('cards', cards); scheduleChanges++; }

// ---------- settings ----------
// Returns every setting, filling in defaults for anything never saved.
export async function getSettings() {
  const os = await store('settings');
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  const saved = Object.fromEntries(keys.map((k, i) => [k, values[i]]).filter(([k]) => !String(k).startsWith(PENDING)));
  return { ...DEFAULT_SETTINGS, ...saved, fsrsParams: cleanFsrsParams(saved.fsrsParams), ignoreBefore: cleanIgnoreBefore(saved.ignoreBefore), fsrsVersion: cleanFsrsVersion(saved.fsrsVersion) };
}
// The settings store keeps its key outside the value, so the key is passed separately.
// Settings that sync also note when they changed, in the '_times' setting.
// `at` (optional) is the time to record for a synced setting instead of now: a clear that should lose to any newer copy passes the old copy's own time.
export async function setSetting(key, value, { at: given } = {}) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  const os = tx.objectStore('settings');
  os.put(value, key);
  if (isSyncedSetting(key)) {
    // A merged setting must beat the version the server already holds even if another device's clock is ahead.
    os.get(SETTING_TIMES).onsuccess = e => {
      const times = e.target.result || {};
      const at = Number.isFinite(given) ? given : MERGED_SETTINGS.includes(key) || isMarkKey(key) ? Math.max(Date.now(), (times[key] || 0) + 1) : Date.now();
      os.put({ ...times, [key]: at }, SETTING_TIMES);
    };
  }
  await finished(tx);
  if (key === 'fsrsParams' || key === 'fsrsVersion') scheduleChanges++;       // an open Review session was planned with the old weights: start it again
  if (isSyncedSetting(key)) changed(keptStill({}, KEPT));       // (settings are not part of the kept cards and schedules; they are applied to them when read)
}

// Several settings in one go (one transaction, one change report): Paste a list in the glossary. pairs: [[key, value], ...]
export async function setSettings(pairs) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  const os = tx.objectStore('settings');
  let any = false;
  for (const [key, value] of pairs) { os.put(value, key); any ||= isSyncedSetting(key); }
  if (any) {
    os.get(SETTING_TIMES).onsuccess = e => {
      const times = { ...(e.target.result || {}) };
      const at = Date.now();
      // (A deletion mark is stamped later than the copy already known, so it wins even if this clock is behind: media-sweep.js.)
      for (const [key] of pairs) if (isSyncedSetting(key)) times[key] = isMarkKey(key) ? Math.max(at, (times[key] || 0) + 1) : at;
      os.put(times, SETTING_TIMES);
    };
  }
  await finished(tx);
  if (any) changed();
}

// ---------- wipe everything ----------
export async function resetAll() {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings', 'deleted', 'media'];
  const tx = db.transaction(names, 'readwrite');
  names.forEach(n => tx.objectStore(n).clear());
  await finished(tx);
  bumpVersion();        // (nothing is left: what was kept of the cards and schedules is out of date, and so are Stats' reads)
}

// ---------- backup ----------
// A backup is one JSON file with everything: decks, cards, schedules, review history, settings, pictures and sounds
// (as text: base64). A backup with sounds in it is version 2, so an older app says "made by a newer version" instead of
// calling it damaged; without sounds it stays version 1.
export const BACKUP_FORMAT = 'study-sprint-backup';
export const BACKUP_VERSION = 2;

// (Kept as the plain reference: the tests compare the streamed file, exportAllBlob, with this.)
export async function exportAll({ sounds = true } = {}) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards', 'cardStates', 'reviewLog', 'settings'], 'readonly');
  const all = name => done(tx.objectStore(name).getAll());
  const [decks, cards, cardStates, reviewLog, keys, values] = await Promise.all([
    all('decks'), all('cards'), all('cardStates'), all('reviewLog'),
    done(tx.objectStore('settings').getAllKeys()), done(tx.objectStore('settings').getAll())
  ]);
  // Pictures and sounds are read one at a time (not all at once). Without sounds, the ones cards list as sounds are never read at all.
  const skip = new Set();
  if (!sounds) for (const c of cards) for (const id of [...(Array.isArray(c.frontSounds) ? c.frontSounds : []), ...(Array.isArray(c.backSounds) ? c.backSounds : [])]) skip.add(id);
  const media = [];
  let hasSounds = false;
  for (const id of await mediaKeys()) {
    if (skip.has(id)) continue;
    const m = await getMedia(id);
    if (!m || (!sounds && isSoundType(m.type))) continue;
    if (isSoundType(m.type)) hasSounds = true;
    media.push({ id: m.id, type: m.type, data: toBase64(m.data), ...(m.name ? { name: m.name } : {}) });
  }
  // Sign-in details and sync bookmarks stay on this device (they're not part of your study data).
  const settings = Object.fromEntries(keys.map((k, i) => [k, values[i]]).filter(([k]) => !isLocalOnly(k)));
  return { format: BACKUP_FORMAT, version: hasSounds ? 2 : 1, exported: new Date().toISOString(), decks, cards: cards.map(safeFields), cardStates, reviewLog, settings, media };
}

// The same backup as exportAll, but built as a file (a Blob) a piece at a time: each store is read about 5,000 rows at a time, written
// out as text straight away (the browser keeps the pieces outside the page's memory) and the page gets a breather in between.
// So the whole backup is never in memory as objects, as one giant string and as a File all at once.
// The pieces are read in separate transactions, so a change made while it runs (a review answer, a sync) could land half in the
// file. dataVersion() is noted at the start and checked after the settings are written; if it moved, the file is built again
// (at most twice more; after that it is saved as it is, which is still a usable backup).
// The file is exactly what JSON.stringify(await exportAll(opts)) would give (same keys, same order), apart from the time in "exported".
// Returns { blob, cards, reviews } (the two counts are for the "Backup saved" message).
const EXPORT_ROWS = 5000;
const EXPORT_CHARS = 4e6;
const breathe = () => new Promise(r => setTimeout(r, 0));
export async function exportAllBlob({ sounds = true } = {}) {
  let out;
  for (let attempt = 0; attempt < 3; attempt++) {
    out = await buildBackupBlob(sounds, attempt === 2);
    if (out.stable) break;
  }
  return { blob: out.blob, cards: out.cards, reviews: out.reviews };
}
async function buildBackupBlob(sounds, last) {
  const version0 = dataVersion();
  const parts = ['{"format":' + JSON.stringify(BACKUP_FORMAT) + ',"version":', '1', ',"exported":' + JSON.stringify(new Date().toISOString())];
  const skip = new Set();
  const counts = {};
  // Writes `"name":[rows…]`, reading the store in key order, EXPORT_ROWS at a time.
  const writeStore = async (name, each = r => r, seen = () => {}) => {
    parts.push(`,"${name}":[`);
    let n = 0, after = null;
    for (;;) {
      const os = await store(name);
      const piece = await done(os.getAll(after === null ? undefined : IDBKeyRange.lowerBound(after, true), EXPORT_ROWS));
      if (piece.length) {
        for (const row of piece) seen(row);
        parts.push(new Blob([(n ? ',' : '') + piece.map(row => JSON.stringify(each(row))).join(',')]));
        n += piece.length;
      }
      if (piece.length < EXPORT_ROWS) break;
      after = piece[piece.length - 1][os.keyPath];
      await breathe();
    }
    parts.push(']');
    counts[name] = n;
    await breathe();
  };
  await writeStore('decks');
  await writeStore('cards', safeFields, c => {
    if (!sounds) for (const id of [...(Array.isArray(c.frontSounds) ? c.frontSounds : []), ...(Array.isArray(c.backSounds) ? c.backSounds : [])]) skip.add(id);
  });
  await writeStore('cardStates');
  await writeStore('reviewLog');
  // Sign-in details and sync bookmarks stay on this device (they're not part of your study data).
  const db = await openDB();
  const tx = db.transaction('settings', 'readonly');
  const [keys, values] = await Promise.all([done(tx.objectStore('settings').getAllKeys()), done(tx.objectStore('settings').getAll())]);
  parts.push(',"settings":' + JSON.stringify(Object.fromEntries(keys.map((k, i) => [k, values[i]]).filter(([k]) => !isLocalOnly(k)))));
  const stable = dataVersion() === version0;
  if (!stable && !last) return { stable };      // changed while reading: the caller starts again
  // Pictures and sounds, one at a time.
  parts.push(',"media":[');
  let hasSounds = false, first = true, pending = [], chars = 0;
  const flush = () => { if (pending.length) { parts.push(new Blob([pending.join('')])); pending = []; chars = 0; } };
  for (const id of await mediaKeys()) {
    if (skip.has(id)) continue;
    const m = await getMedia(id);
    if (!m || (!sounds && isSoundType(m.type))) continue;
    if (isSoundType(m.type)) hasSounds = true;
    const json = JSON.stringify({ id: m.id, type: m.type, data: toBase64(m.data), ...(m.name ? { name: m.name } : {}) });
    pending.push(first ? json : ',' + json); first = false;
    chars += json.length;
    if (chars > EXPORT_CHARS) { flush(); await breathe(); }
  }
  flush();
  parts.push(']}');
  parts[1] = hasSounds ? '2' : '1';
  return { stable, blob: new Blob(parts, { type: 'application/json' }), cards: counts.cards, reviews: counts.reviewLog };
}

// A card's other fields (note-fields.js) are cleaned to their limits on the way out, so a backup always passes checkBackup.
const safeFields = c => {
  if (c.noteFields === undefined || validFields(c.noteFields)) return c;
  const { noteFields, ...rest } = c, { fields } = cleanFields(noteFields);
  return fields.length ? { ...rest, noteFields: fields } : rest;
};

// How much room pictures and sounds take on this device: { pictures, sounds } in bytes. Kept up to date as files are added and
// removed (a small record in settings); worked out once, a file at a time, when there is none yet.
export async function mediaTotals() {
  const have = await getSettingRaw('mediaTotals');
  if (have) return { pictures: have.pictures, sounds: have.sounds };
  const db = await openDB();
  const out = { pictures: 0, sounds: 0 };
  const tx = db.transaction(['media', 'settings'], 'readwrite');
  await inTx(tx, async () => {
    await eachMedia(tx, m => { out[isSoundType(m.type) ? 'sounds' : 'pictures'] += m.size || m.data?.byteLength || 0; });
    tx.objectStore('settings').put({ ...out }, 'mediaTotals');
  });
  return out;
}

// Check a backup before using it. Returns an error message, or null if it looks right.
export function checkBackup(data) {
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) return "This isn't a Study Sprint backup file.";
  if (data.version > BACKUP_VERSION) return 'This backup was made by a newer version of the app. Update the app first.';
  for (const k of ['decks', 'cards', 'cardStates', 'reviewLog']) if (!Array.isArray(data[k])) return 'This backup file is damaged (missing ' + k + ').';
  // Every record needs its key (the field it's stored under), or saving it would fail halfway.
  const keyField = { decks: 'id', cards: 'id', cardStates: 'cardId' };
  for (const [k, field] of Object.entries(keyField)) {
    if (!data[k].every(r => r && typeof r === 'object' && validKey(r[field]))) return 'This backup file is damaged (a record in ' + k + ' has no ' + field + ').';
  }
  // Cloze fields end up in the page, so they must have the right type: a positive whole number, and text.
  if (!data.cards.every(c => (c.cloze === undefined || (Number.isInteger(c.cloze) && c.cloze > 0)) && [c.noteId, c.noteText].every(v => v === undefined || typeof v === 'string'))) {
    return 'This backup file is damaged (a card has invalid cloze fields).';
  }
  // Sounds are lists of up to 4 media ids on a card side.
  if (!data.cards.every(c => ['frontSounds', 'backSounds'].every(k => c[k] === undefined || (Array.isArray(c[k]) && c[k].length >= 1 && c[k].length <= MAX_SOUNDS_PER_SIDE && c[k].every(validKey))))) {
    return 'This backup file is damaged (a card has invalid sound fields).';
  }
  // A note's other fields (item A) are a short list of { name, text }; a reverse card (item 5) is marked reverse: true and shares a noteId.
  if (!data.cards.every(c => c.noteFields === undefined || validFields(c.noteFields))) return 'This backup file is damaged (a card has invalid note fields).';
  if (!data.cards.every(c => c.reverse === undefined || (c.reverse === true && typeof c.noteId === 'string' && c.noteId !== ''))) return 'This backup file is damaged (a card has an invalid reverse card link).';
  // Image-occlusion fields end up in style attributes, so the boxes must be plain numbers in range.
  if (!data.cards.every(c => c.occlusion === undefined || (validOcclusion(c.occlusion) && typeof c.noteId === 'string'))) {
    return 'This backup file is damaged (a card has invalid image-occlusion fields).';
  }
  // A review's id can be missing (one is given when it's saved), but otherwise must be a number.
  if (!data.reviewLog.every(r => r && typeof r === 'object' && (r.id === undefined || Number.isFinite(r.id)))) return 'This backup file is damaged (a record in reviewLog is broken).';
  // Deck colors go into style attributes, so only plain hex colors are allowed.
  if (!data.decks.every(d => d.color === undefined || SAFE_COLOR.test(d.color))) return 'This backup file is damaged (a deck has an invalid color).';
  if (data.media !== undefined && !(Array.isArray(data.media) && data.media.every(m => m && validKey(m.id) && typeof m.data === 'string' && ALLOWED_MEDIA_TYPES.includes(m.type)))) {
    return 'This backup file is damaged (a picture or sound is invalid or not a supported image or sound type).';
  }
  // dailyGoal (v4.9) is not used any more: old backups carry it and it is accepted whatever it holds.
  if (data.settings?.playCountsAsReviews != null && typeof data.settings.playCountsAsReviews !== 'boolean') return 'This backup file is damaged (the Play setting must be on or off).';
  // The catch-up plan is read as numbers and a flag, so nothing else may sit in it.
  if (data.settings?.rescue != null && !validRescue(data.settings.rescue)) return 'This backup file is damaged (the catch-up plan is invalid).';
  return null;
}
// The settings a backup restores: not this device's own (sign-in, sync bookmarks), and with fsrsParams cleaned. A value that
// does not clean (junk, or a version this app doesn't know) is left out altogether, rather than stored as null: a null would
// be stamped as a new "reset" and could wipe good weights that sync from another device. The rest of the backup still restores.
export function restoredSettings(settings) {
  return Object.entries(settings || {})
    .filter(([k]) => !isLocalOnly(k))
    .filter(([k, v]) => k !== 'fsrsParams' || v === null || cleanFsrsParams(v))
    .filter(([k, v]) => k !== 'ignoreBefore' || v === null || cleanIgnoreBefore(v))      // a junk or future date is left out
    .filter(([k, v]) => k !== 'fsrsVersion' || v === 6 || v === 7)       // junk is left out, not stored as 6 (a stamped 6 would switch other devices back)
    .filter(([k, v]) => k !== 'statsLayout' || acceptStatsLayout(v).ok)         // junk is left out
    .map(([k, v]) => (k === 'fsrsParams' && v !== null ? [k, cleanFsrsParams(v)] : k === 'statsLayout' ? [k, acceptStatsLayout(v).value] : [k, v]));
}
export const validRescue = r => !!r && typeof r === 'object' && !Array.isArray(r) && Number.isFinite(r.start) && Number.isInteger(r.days) && r.days >= 1 && r.days <= 10
  && Number.isFinite(r.backlog) && r.backlog >= 0 && (r.pauseNew === undefined || typeof r.pauseNew === 'boolean') && (r.at === undefined || Number.isFinite(r.at));
// A log row's `mixedWith` (the card whose answer was given by mistake, see confusion.js) is kept only when it is a
// string of 1 to 200 characters; anything else is dropped from the row.
export const MIXED_WITH_MAX = 200;
export function cleanMixedWith(row) {
  if (!row || !Object.hasOwn(row, 'mixedWith')) return row;
  const v = row.mixedWith;
  if (typeof v === 'string' && v.length >= 1 && v.length <= MIXED_WITH_MAX) return row;
  const { mixedWith, ...rest } = row;
  return rest;
}
const validKey = v => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v));
const SAFE_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];   // no SVG: it can contain scripts
export const ALLOWED_SOUND_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/flac'];     // (audio/x-wav is kept as audio/wav)
export const ALLOWED_MEDIA_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_SOUND_TYPES];
export const MAX_SOUNDS_PER_SIDE = 4;
export const isSoundType = type => String(type || '').startsWith('audio/');

// Replace everything on this device with a backup. All in one transaction: if anything fails,
// nothing changes.
//   everywhere: also replace what's in your sync account. The backup's records count as changed now (so
//               they're sent and win), and everything that was here but isn't in the backup gets a deleted
//               marker (so other devices delete it too).
export const NO_SPACE = 'Not enough space on this device to restore this backup.';
export async function importAll(data, { everywhere = false } = {}) {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings', 'deleted', 'media'];
  const tx = db.transaction(names, 'readwrite');
  try { await inTx(tx, async () => {
    const now = Date.now();
    // Pictures and sounds from the backup (older backups have none). Ones already here are kept.
    for (const m of data.media || []) {
      const bytes = fromBase64(m.data);
      tx.objectStore('media').put({ id: m.id, type: m.type, data: bytes, size: bytes.byteLength, ...(typeof m.name === 'string' ? { name: m.name.slice(0, 120) } : {}), created: now, uploaded: false });
      tx.objectStore('settings').put(true, PENDING + m.id);
      tx.objectStore('settings').delete('mediaTotals');
    }
    // What's here now, to mark as deleted if the backup doesn't have it.
    const before = {};
    if (everywhere) {
      for (const name of Object.keys(SYNC_ID)) {
        before[name] = (await done(tx.objectStore(name).getAll())).map(r => String(r[SYNC_ID[name]])).filter(id => id !== 'undefined');
      }
    }
    const oldKeys = await done(tx.objectStore('settings').getAllKeys());
    ['decks', 'cards', 'cardStates', 'reviewLog'].forEach(n => tx.objectStore(n).clear());
    // The cards are replaced without delete markers: the files the old cards used are not "dropped" (sync.js sweepMedia), so start that list again.
    if (!everywhere) tx.objectStore('settings').delete('mediaRefs');
    // Backups from before sync existed are filled in the same way as the version 2 upgrade.
    const kept = {};
    for (const name of Object.keys(SYNC_ID)) {
      kept[name] = new Set();
      for (const x of data[name]) {
        let rec = upgradeRecord(name, x, now);
        if (name === 'reviewLog') rec = cleanMixedWith(rec);
        if (name === 'cards') rec = cleanTypeIn(cleanAccept(rec));
        if (everywhere) { rec = { ...rec, updatedAt: now }; delete rec.syncedAt; }
        tx.objectStore(name).put(rec);
        tx.objectStore('deleted').delete(tombstoneKey(name, rec[SYNC_ID[name]]));   // an old delete marker would delete it again when syncing
        kept[name].add(String(rec[SYNC_ID[name]]));
      }
    }
    if (everywhere) {
      for (const name of Object.keys(SYNC_ID)) {
        for (const id of before[name]) if (!kept[name].has(id)) markDeleted(tx, name, id, now);
      }
    }
    // Settings are replaced too (on this device), except this device's sign-in and sync bookmarks.
    const settings = tx.objectStore('settings');
    oldKeys.filter(k => !isLocalOnly(k)).forEach(k => settings.delete(k));
    // (Glossary terms that are broken are dropped, not the whole backup, and a backup is never cut to the 2,000-term limit: cleanGlossary.)
    const restored = restoredSettings(cleanGlossary(data.settings, { limit: Infinity }));
    restored.forEach(([k, v]) => settings.put(v, k));
    // Note: `restDays` (days off) is a MERGED setting. Restoring replaces this device's copy, but the next sync merges
    // it with the account's, so a day off that the backup lacks comes back from the server rather than being deleted.
    if (everywhere) {
      // The backup's study settings win in the account too.
      const times = Object.fromEntries(restored.filter(([k]) => isSyncedSetting(k)).map(([k]) => [k, now]));
      // Terms that were here but are not in the backup are deleted in the account too (a null term, newer than theirs).
      // (Only keys the backup does not have at all: a term the backup holds, even a broken one, is never turned into a delete.)
      for (const k of oldKeys) if (typeof k === 'string' && k.startsWith('gloss:') && !Object.hasOwn(data.settings || {}, k)) { settings.put(null, k); times[k] = now; }
      settings.put(times, SETTING_TIMES);
    }
  }); } catch (e) {
    // A big backup (with sounds) on a nearly full device: it fails as one piece and everything stays as it was.
    if ([e?.name, e?.target?.error?.name, tx.error?.name].includes('QuotaExceededError')) throw Object.assign(new Error(NO_SPACE), { noSpace: true });
    throw e;
  }
  scheduleChanges++;
  changed();
}

// Delete every deck, card, schedule and review on this device and (when synced) on every device:
// each one leaves a deleted marker, which syncing sends to the others.
export async function deleteEverything() {
  const db = await openDB();
  const tx = db.transaction([...Object.keys(SYNC_ID), 'deleted'], 'readwrite');
  await inTx(tx, async () => {
    const now = Date.now();
    for (const name of Object.keys(SYNC_ID)) {
      const os = tx.objectStore(name);
      for (const r of await done(os.getAll())) {
        const id = r[SYNC_ID[name]];
        if (id !== undefined) markDeleted(tx, name, id, now);
      }
      os.clear();
    }
  });
  await setSettings([['mediaRefs', null]]);          // (the files those cards used are not "dropped": start the list again)
  scheduleChanges++;
  changed();
}

// ---------- syncing (used by sync.js) ----------
// Settings that belong to this device only: never synced, never in backups.
//   syncAuth   who's signed in (and their sign-in tokens)
//   syncState  sync bookmarks: the last server change seen, and when this device last sent its changes
//   resendPending  "Re-upload everything" was asked for; the next sync starts over from this device first (sync.js)
//   resendTries    how many times in a row that start-over failed (sync.js gives up after a few)
//   resendFailed   the start-over was given up; the sync note says so once (sync.js)
//   syncDamaged  { count, seen, items }: rows from the server that were skipped because they were malformed (sync-merge.js addDamaged); Settings → Sync tells the person once
//   pushBackoff  { userId, until, wait, kind, note }: the server or account was full, so automatic pushes wait until `until` (sync.js)
//   mediaCleanedAt  when this device last removed pictures and sounds no card uses (app.js tidyMedia: once a day)
//   lastBackup  when this device last saved a backup file (it never synced). Listed here so it stays out of backup files and a restore leaves this device's own date alone
//   mediaRefs  { userId, ids }: the files cards used at the last sweep, so a card deleted before this device held its picture still gets that file marked (media-sweep.js droppedRefs)
//   keepAllMedia  "Keep all pictures and sounds on this device" (Settings → Sync): sync downloads every file, not only what is needed soon (lazy-media.js)
//   appBadge, reminderTime, reminderUid  "Cards due on the app icon" and the daily reminder's time (Settings → Study → Reminders): a badge and a calendar belong to one device (badge.js, reminders.js)
//   whatsNewSeen  the newest version whose "What's new" card was seen on this device (whats-new.js): each device tells its own story
//   pendingSignup  { email, at }: an account was made and its confirmation email has not been followed yet (Settings → Sync shows it for 7 days)
//   mediaTotals, mediaIndexed, mp:<id>   book-keeping for pictures and sounds (see "pictures" below): sizes, and which files are not uploaded yet
export const LOCAL_ONLY = ['syncAuth', 'syncState', 'mediaTotals', 'mediaIndexed', 'resendPending', 'resendTries', 'resendFailed', 'syncDamaged', 'pushBackoff', 'mediaBackoff', 'lastBackup', 'mediaCleanedAt', 'keepAllMedia', 'mediaRefs', 'appBadge', 'reminderTime', 'reminderUid', 'whatsNewSeen', 'pendingSignup'];
// (Media deletion marks, "mdel:<id>", do sync but are left out of backups; "mseen:<id>" never leaves the device: see media-sweep.js.)
export const isLocalOnly = k => LOCAL_ONLY.includes(k) || String(k).startsWith(PENDING) || isMarkKey(k) || isSeenKey(k);

// Tell sync.js when something changed on this device, so it can send it.
const listeners = new Set();
export const onLocalChange = fn => { listeners.add(fn); };
function changed(still) {
  bumpVersion(still);
  listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

// Goes up whenever the saved data changes (a local save, or changes applied from the server). Stats compares it
// with the number it saw when it read the review log, to know if what it kept is out of date.
// Other open tabs of the app (e.g. the installed app and a browser tab) are told too, so their Stats refresh.
let dataChanges = 0;
export const dataVersion = () => dataChanges;
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('study-sprint-db') : null;
if (tabs) { tabs.onmessage = () => { dataChanges++; }; tabs.unref?.(); }   // unref: lets Node tests exit
// `still`: kept reads (see getAllCached) that this change left right, which move on to the new version instead of being dropped.
function bumpVersion(still = []) {
  dataChanges++;
  for (const e of still) e.version = dataChanges;
  tabs?.postMessage('changed');
}

// Everything changed on this device since a moment (ms), that the server doesn't have yet:
// { records: { decks: [...], ... }, tombstones: [...], settings: [{ key, value, time }] }
export async function localChangesSince(since) {
  const db = await openDB();
  const tx = db.transaction([...Object.keys(SYNC_ID), 'deleted', 'settings'], 'readonly');
  const after = IDBKeyRange.lowerBound(since, true);
  const records = {};
  for (const name of Object.keys(SYNC_ID)) {
    records[name] = (await done(tx.objectStore(name).index('updatedAt').getAll(after))).filter(r => needsPush(r, since));
  }
  const tombstones = (await done(tx.objectStore('deleted').index('deletedAt').getAll(after))).filter(t => tombstoneNeedsPush(t, since));
  const os = tx.objectStore('settings');
  const times = (await done(os.get(SETTING_TIMES))) || {};
  const settings = [];
  for (const key of Object.keys(times)) {
    if (isSyncedSetting(key) && times[key] > since) settings.push({ key, value: await done(os.get(key)), time: times[key] });
  }
  return { records, tombstones, settings };
}

// Forget which records and deleted markers the server already has, so the next sync sends all of them
// again (including ones that came from other devices). Used when the sync bookmarks start over.
export async function forgetSyncedMarks() {
  const db = await openDB();
  const tx = db.transaction([...Object.keys(SYNC_ID), 'deleted'], 'readwrite');
  await inTx(tx, async () => {
    for (const name of Object.keys(SYNC_ID)) {
      const os = tx.objectStore(name);
      for (const r of await done(os.getAll())) {
        if (r.syncedAt === undefined) continue;
        const { syncedAt, ...rest } = r;
        os.put(rest);
      }
    }
    const deleted = tx.objectStore('deleted');
    for (const t of await done(deleted.getAll())) if (t.synced) deleted.put({ ...t, synced: false });
  });
  bumpVersion();       // (the rows were rewritten, so what was kept of them is out of date)
}

// Save changes that came from the server. Each row only wins if it's newer than this device's version
// (see decide() in sync-merge.js). Not stamped and not reported as a local change, so it isn't sent back.
// Returns how many rows changed something here.
// A row that can't be a record (sync-merge.js badRow) is skipped, not fatal: it used to roll the whole page back, so that account's
// bookmark never moved again. Skipped rows are counted and listed in the local-only setting "syncDamaged" (see damagedNote).
export async function applyRemote(rows) {
  if (!rows.length) return 0;
  const bad = [];
  rows = rows.filter(row => { const why = badRow(row); if (why) bad.push({ store: String(row?.store ?? ''), id: String(row?.id ?? '').slice(0, 60), seq: Number(row?.seq) || 0, why }); return !why; });
  const db = await openDB();
  const tx = db.transaction([...Object.keys(SYNC_ID), 'deleted', 'settings'], 'readwrite');
  let applied = 0, schedules = false;
  await inTx(tx, async () => {
    const settingsStore = tx.objectStore('settings');
    const deleted = tx.objectStore('deleted');
    if (bad.length) settingsStore.put(addDamaged(await done(settingsStore.get('syncDamaged')), bad), 'syncDamaged');
    let times = (await done(settingsStore.get(SETTING_TIMES))) || {};
    // Settings first. Everything else waits in `todo`: one row per record (if a page holds two versions of
    // the same record, the newer one wins), so the reads below can all be sent at once.
    const todo = new Map();
    for (const row of rows) {
      if (row.store === 'settings') {
        if (MERGED_SETTINGS.includes(row.id)) {
          // Merged, not replaced: keep this device's days off and add the server's (per day, the later decision wins).
          const local = await done(settingsStore.get(row.id));
          const remote = row.data?.value;
          const [mergeFlags, sameFlags] = MERGERS[row.id];
          const merged = mergeFlags(local, remote);
          const changed = !sameFlags(merged, local);
          const sameAsRemote = sameFlags(merged, remote);
          if (changed) { settingsStore.put(merged, row.id); applied++; }
          if (changed || !sameAsRemote) {
            // If the server already has exactly this, remember its time. Otherwise stamp it now so the union is sent back once.
            times[row.id] = sameAsRemote ? Math.max(times[row.id] || 0, row.updated_at) : Math.max(Date.now(), row.updated_at + 1);
          }
          continue;
        }
        if (!isSyncedSetting(row.id) || decide(row, times[row.id] || 0) !== 'put') continue;
        const accepted = acceptSetting(row.id, row.data?.value);
        if (!accepted.ok) continue;                  // junk from the server is ignored
        // (A glossary term from another device is checked first; a broken one is stored as deleted.)
        settingsStore.put(row.id.startsWith('gloss:') ? cleanGlossary({ [row.id]: accepted.value })[row.id] ?? null : accepted.value, row.id);
        times[row.id] = row.updated_at;
        applied++;
        if (row.id === 'fsrsParams' || row.id === 'fsrsVersion') schedules = true;       // another device's weights: an open Review session was planned with the old ones
      } else if (row.store in SYNC_ID) {
        const key = `${row.store}:${row.id}`;
        if (!todo.has(key) || row.updated_at >= todo.get(key).updated_at) todo.set(key, row);
      }
    }
    // Look up what this device has for every row in one go (waiting for each row in turn was the slow part).
    // Only IndexedDB requests are awaited in here, so the transaction stays open.
    const found = await Promise.all([...todo.values()].map(async row => {
      const os = tx.objectStore(row.store);
      // Review-log rows are found by uid; everything else by its id.
      const [local, tomb] = await Promise.all([
        done(row.store === 'reviewLog' ? os.index('uid').get(row.id) : os.get(typeof row.data?.[SYNC_ID[row.store]] === 'number' ? Number(row.id) : row.id)),      // (a number id, which backups allow, is looked up as the number it is saved as)
        done(deleted.get(tombstoneKey(row.store, row.id)))
      ]);
      return { row, local, tomb };
    }));
    for (const { row, local, tomb } of found) {
      const os = tx.objectStore(row.store);
      const action = decide(row, Math.max(local?.updatedAt || 0, tomb?.deletedAt || 0));
      if (action === 'skip') continue;
      if (action === 'delete') {
        if (local) os.delete(row.store === 'reviewLog' ? local.id : row.id);
        deleted.put({ ...tombstone(row.store, row.id, row.updated_at), synced: true });
      } else {
        let record = recordFromRow(row);
        if (row.store === 'cards') record = cleanTypeIn(cleanAccept(record));      // a bad accepted-answers list or typing value from another device is dropped
        if (row.store === 'reviewLog') { if (local) record.id = local.id; else delete record.id; }
        os.put(record);
        if (tomb) deleted.delete(tomb.key);
      }
      if (row.store === 'cardStates' || row.store === 'cards') schedules = true;
      applied++;
    }
    settingsStore.put(times, SETTING_TIMES);
  });
  if (schedules) scheduleChanges++;
  if (applied > 0) bumpVersion();
  return applied;
}

// ---------- pictures (used by media.js and sync.js) ----------
// Saved as the file's bytes (an ArrayBuffer), which every browser stores reliably.
//   uploaded: whether the sync server has it yet
export const getMedia = id => get('media', id);
// Only the ids (not the bytes) of the files on this device.
export async function mediaKeys() { return done((await store('media')).getAllKeys()); }

// Book-keeping, so nothing needs to read every file's bytes: which files are not uploaded yet (a settings key "mp:<id>" each) and
// the totals (see mediaTotals). Both are kept in the same transaction as the file itself. Not in backups, not synced (isLocalOnly).
const PENDING = 'mp:';
const getSettingRaw = async key => done((await store('settings')).get(key));
// Go through the files one at a time (a cursor holds one file in memory, not all of them).
function eachMedia(tx, fn) {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('media').openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { const c = req.result; if (!c) return resolve(); fn(c.value); c.continue(); };
  });
}
// A file added, replaced or removed: update the pending marker and the totals (inside tx, which has 'media' and 'settings').
async function noteMedia(tx, id, before, after) {
  const s = tx.objectStore('settings');
  if (after && !after.uploaded) s.put(true, PENDING + id); else s.delete(PENDING + id);
  const totals = await done(s.get('mediaTotals'));
  if (!totals) return;
  const bytes = m => m.size || m.data?.byteLength || 0, kind = m => (isSoundType(m.type) ? 'sounds' : 'pictures');
  if (before) totals[kind(before)] = Math.max(0, totals[kind(before)] - bytes(before));
  if (after) totals[kind(after)] += bytes(after);
  s.put(totals, 'mediaTotals');
}
async function writeMedia(row) {
  const db = await openDB();
  const tx = db.transaction(['media', 'settings'], 'readwrite');
  await inTx(tx, async () => {
    const before = await done(tx.objectStore('media').get(row.id));
    tx.objectStore('media').put(row);
    await noteMedia(tx, row.id, before, row);
  });
}
export async function putMedia(m) {
  await writeMedia(m);
  changed();
}
// Pictures that came from the server (not reported as a change, so they aren't sent back).
export async function putRemoteMedia(m) { await writeMedia({ ...m, uploaded: true }); }
// Files not uploaded yet, without their bytes ({ id, type, size, blocked? }; getMedia(id) loads one just before it is sent), so a big
// library never sits in memory at once. The marker list is built once (a pass over the files) for a device that had files before it existed.
export async function mediaToUpload() {
  const db = await openDB();
  const tx = db.transaction(['media', 'settings'], 'readwrite');
  const rows = [];
  await inTx(tx, async () => {
    const s = tx.objectStore('settings');
    if (!(await done(s.get('mediaIndexed')))) {
      await eachMedia(tx, m => { if (!m.uploaded) s.put(true, PENDING + m.id); });
      s.put(true, 'mediaIndexed');
    }
    const ids = (await done(s.getAllKeys(IDBKeyRange.bound(PENDING, PENDING + '\uffff')))).map(k => k.slice(PENDING.length));
    for (const id of ids) {
      const m = await done(tx.objectStore('media').get(id));
      if (m && !m.uploaded) rows.push({ id: m.id, type: m.type, size: m.size || m.data?.byteLength || 0, ...(m.blocked ? { blocked: m.blocked } : {}) }); else s.delete(PENDING + id);
    }
  });
  return rows;
}
export async function markUploaded(ids) {
  const db = await openDB();
  const tx = db.transaction(['media', 'settings'], 'readwrite');
  const os = tx.objectStore('media');
  for (const id of ids) os.get(id).onsuccess = e => {
    if (e.target.result) { const { blocked, ...rest } = e.target.result; os.put({ ...rest, uploaded: true }); }
    tx.objectStore('settings').delete(PENDING + id);
  };
  return finished(tx);
}
// Mark every picture and sound as not uploaded, so the next sync sends them all again (a lost or restored server has none of
// them). Their bytes and the totals stay as they are. Each file is a record with its bytes, so this is done in small batches
// (one transaction each) rather than one huge one. Safe to run again if it is cut short.
export async function forgetUploadedMedia() {
  const db = await openDB();
  const ids = await done(db.transaction('media').objectStore('media').getAllKeys());
  for (let i = 0; i < ids.length; i += 25) {
    const tx = db.transaction(['media', 'settings'], 'readwrite');
    await inTx(tx, async () => {
      for (const id of ids.slice(i, i + 25)) {
        const m = await done(tx.objectStore('media').get(id));
        if (!m) continue;
        if (m.uploaded) tx.objectStore('media').put({ ...m, uploaded: false });
        tx.objectStore('settings').put(true, PENDING + id);
      }
    });
  }
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(true, 'mediaIndexed');      // the pending markers are complete now, so mediaToUpload needn't build them again
  await finished(tx);
}
// Files the server turned away for their type (not reported as a change). They stay not-uploaded; sync tries them again later.
export async function markBlocked(ids, reason) {
  const db = await openDB();
  const tx = db.transaction('media', 'readwrite');
  const os = tx.objectStore('media');
  for (const id of ids) os.get(id).onsuccess = e => { if (e.target.result) os.put({ ...e.target.result, blocked: reason }); };
  return finished(tx);
}
// The pictures and sounds marked for deletion from the account (media-sweep.js): { marks: { id: time }, gone: [ids] }.
// A mark's time is the later of the marker's and when this device first saw it (kept as "mseen:<id>", on this device only), so a
// wrong clock elsewhere can't shorten the 30 days. Un-marked files are left out of marks; "gone" ones were deleted from the account.
export async function mediaMarks(now = Date.now()) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  const os = tx.objectStore('settings');
  const marked = IDBKeyRange.bound(markKey(''), markKey('\uffff')), seenRange = IDBKeyRange.bound(seenKey(''), seenKey('\uffff'));
  const [keys, values, seenKeys, seenValues] = await Promise.all([done(os.getAllKeys(marked)), done(os.getAll(marked)), done(os.getAllKeys(seenRange)), done(os.getAll(seenRange))]);
  const seen = new Map(seenKeys.map((k, i) => [k.slice(seenKey('').length), seenValues[i]]));
  const marks = {}, gone = [], live = new Set();
  keys.forEach((k, i) => {
    const id = markId(k), v = values[i];
    if (v === GONE) gone.push(id);
    else if (typeof v === 'number' && validMark(v)) {
      live.add(id);
      if (!seen.has(id)) { os.put(now, seenKey(id)); seen.set(id, now); }
      marks[id] = Math.max(v, seen.get(id));
    }
  });
  for (const id of seen.keys()) if (!live.has(id)) os.delete(seenKey(id));         // no longer marked: forget when it was first seen
  await finished(tx);
  return { marks, gone };
}
// Files this device has that the account should get again (not reported as a change): back to "not uploaded".
export async function markNotUploaded(ids) {
  const db = await openDB();
  const tx = db.transaction(['media', 'settings'], 'readwrite');
  const os = tx.objectStore('media');
  for (const id of ids) os.get(id).onsuccess = e => {
    if (e.target.result) { os.put({ ...e.target.result, uploaded: false }); tx.objectStore('settings').put(true, PENDING + id); }
  };
  return finished(tx);
}
// The ids of every picture and sound that some card uses.
export function usedMediaIds(cards) {
  const used = new Set();
  for (const c of cards) {
    if (c.frontImage) used.add(c.frontImage);
    if (c.backImage) used.add(c.backImage);
    for (const id of [...(Array.isArray(c.frontSounds) ? c.frontSounds : []), ...(Array.isArray(c.backSounds) ? c.backSounds : [])]) used.add(id);
  }
  return used;
}
// Remove pictures and sounds no card uses any more (replaced, removed, or their card deleted). Ones added in the
// last hour are kept (their card may not be saved yet). Returns the removed ones that the server has.
export async function cleanMedia(now = Date.now()) {
  const db = await openDB();
  const tx = db.transaction(['cards', 'media', 'settings'], 'readwrite');
  const removed = [];
  await inTx(tx, async () => {
    const used = usedMediaIds(await done(tx.objectStore('cards').getAll()));
    // Only the ids are listed; the files nothing uses are looked at one by one (to check their age), the rest are never read.
    const unused = (await done(tx.objectStore('media').getAllKeys())).filter(id => !used.has(id));
    for (const id of unused) {
      const m = await done(tx.objectStore('media').get(id));
      if (!m || now - (m.created || 0) < 3600000) continue;
      tx.objectStore('media').delete(id);
      await noteMedia(tx, id, m, null);
      if (m.uploaded) removed.push(id);
    }
  });
  return removed;
}

// Bytes ↔ base64 text, for backups.
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}
