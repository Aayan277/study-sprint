// Storage for the whole app, using IndexedDB (a database built into every browser).
// It can hold far more than localStorage, so big decks are fine.
//
// The database has 6 "stores" (think of them as tables):
//   decks       one row per deck            { id, name, color, created, course, updatedAt }
//   cards       one row per card            { id, deckId, front, back, tags, created, updatedAt }
//   cardStates  FSRS schedule for a card    { cardId, due, stability, difficulty, reps, lapses, state, lastReview, updatedAt }
//   reviewLog   one row per answer          { id (auto), uid, cardId, timestamp, source, mode, correct, ms, rating, updatedAt }
//   settings    simple key → value pairs    e.g. 'theme' → { skin: 'ink', mode: 'auto' }
//   deleted     what was deleted, and when  { key, store, id, deletedAt }
// updatedAt, uid and the deleted store are there for syncing between devices: see sync-data.js.
// Every save below stamps them, so other files never need to.
//
// Everything here returns a Promise, so callers use `await`.

const DB_NAME = 'study-sprint';
const DB_VERSION = 2;   // 1 → 2: added updatedAt, review uids and the deleted store (for sync)

import { stamp, tombstone, upgradeRecord, SYNCED_SETTINGS, SETTING_TIMES, randomId } from './sync-data.js';

export const DEFAULT_SETTINGS = {
  theme: { skin: 'ink', mode: 'auto' }, // mode: 'auto' follows the device's light/dark setting, or 'light' / 'dark'
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
  extraNew: null,    // { day, n }: extra new cards added for one day with Custom study
  seeded: false      // true once the sample deck has been added on first open
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
      const logs = req.transaction.objectStore('reviewLog');
      if (!logs.indexNames.contains('uid')) logs.createIndex('uid', 'uid');
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

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---------- generic helpers ----------
export async function getAll(name) { return done((await store(name)).getAll()); }
export async function get(name, key) { return done((await store(name)).get(key)); }
export async function getAllByIndex(name, index, value) {
  return done((await store(name)).index(index).getAll(value));
}
// Saves here are made on this device, so they're stamped with the time (see sync-data.js).
export async function put(name, value) { return done((await store(name, 'readwrite')).put(stamp(name, value))); }

// Save many rows in one go (much faster than one at a time, and all-or-nothing).
export async function putMany(name, values) {
  const db = await openDB();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  const now = Date.now();
  values.forEach(v => os.put(stamp(name, v, now)));
  return finished(tx);
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
export async function addDeckWithCards(deck, cards = []) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards'], 'readwrite');
  const now = Date.now();
  tx.objectStore('decks').put(stamp('decks', deck, now));
  const cs = tx.objectStore('cards');
  cards.forEach(c => cs.put(stamp('cards', c, now)));
  return finished(tx);
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
  return finished(tx);
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
  tx.objectStore('cardStates').put(stamp('cardStates', state, now));
  const req = tx.objectStore('reviewLog').add(stamp('reviewLog', log, now));
  await finished(tx);
  scheduleChanges++;
  return req.result;
}

// Save a review-log row without changing any schedule (e.g. a Play answer on a card that isn't due).
export async function addLog(log) {
  return done((await store('reviewLog', 'readwrite')).add(stamp('reviewLog', log)));
}

// Undo a review: put the old schedule back (or remove it if the card was new) and delete the log row.
export async function undoReview(cardId, prevState, logId) {
  const db = await openDB();
  const tx = db.transaction(['cardStates', 'reviewLog', 'deleted'], 'readwrite');
  const now = Date.now();
  if (prevState) tx.objectStore('cardStates').put(stamp('cardStates', prevState, now));
  else deleteStateIn(tx, cardId, now);
  const logs = tx.objectStore('reviewLog');
  logs.get(logId).onsuccess = e => {
    if (e.target.result?.uid) markDeleted(tx, 'reviewLog', e.target.result.uid, now);
    logs.delete(logId);
  };
  await finished(tx);
  scheduleChanges++;
}

// Every review-log row since a moment in time (e.g. since the start of today).
export async function getLogsSince(timestamp) {
  return done((await store('reviewLog')).index('timestamp').getAll(IDBKeyRange.lowerBound(timestamp)));
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
  const saved = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  return { ...DEFAULT_SETTINGS, ...saved };
}
// The settings store keeps its key outside the value, so the key is passed separately.
// Settings that sync also note when they changed, in the '_times' setting.
export async function setSetting(key, value) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  const os = tx.objectStore('settings');
  os.put(value, key);
  if (SYNCED_SETTINGS.includes(key)) {
    os.get(SETTING_TIMES).onsuccess = e => os.put({ ...(e.target.result || {}), [key]: Date.now() }, SETTING_TIMES);
  }
  return finished(tx);
}

// ---------- wipe everything ----------
export async function resetAll() {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings', 'deleted'];
  const tx = db.transaction(names, 'readwrite');
  names.forEach(n => tx.objectStore(n).clear());
  return finished(tx);
}

// ---------- backup ----------
// A backup is one JSON file with everything: decks, cards, schedules, review history and settings.
export const BACKUP_FORMAT = 'study-sprint-backup';
export const BACKUP_VERSION = 1;

export async function exportAll() {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards', 'cardStates', 'reviewLog', 'settings'], 'readonly');
  const all = name => done(tx.objectStore(name).getAll());
  const [decks, cards, cardStates, reviewLog, keys, values] = await Promise.all([
    all('decks'), all('cards'), all('cardStates'), all('reviewLog'),
    done(tx.objectStore('settings').getAllKeys()), done(tx.objectStore('settings').getAll())
  ]);
  const settings = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: new Date().toISOString(), decks, cards, cardStates, reviewLog, settings };
}

// Check a backup before using it. Returns an error message, or null if it looks right.
export function checkBackup(data) {
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) return "This isn't a Study Sprint backup file.";
  if (data.version > BACKUP_VERSION) return 'This backup was made by a newer version of the app. Update the app first.';
  for (const k of ['decks', 'cards', 'cardStates', 'reviewLog']) if (!Array.isArray(data[k])) return 'This backup file is damaged (missing ' + k + ').';
  return null;
}

// Replace everything on this device with a backup. All in one transaction: if anything fails,
// nothing changes.
export async function importAll(data) {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings'];
  const tx = db.transaction(names, 'readwrite');
  names.forEach(n => tx.objectStore(n).clear());
  // Backups from before sync existed are filled in the same way as the version 2 upgrade.
  const now = Date.now();
  for (const name of ['decks', 'cards', 'cardStates', 'reviewLog']) {
    data[name].forEach(x => tx.objectStore(name).put(upgradeRecord(name, x, now)));
  }
  Object.entries(data.settings || {}).forEach(([k, v]) => tx.objectStore('settings').put(v, k));
  await finished(tx);
  scheduleChanges++;
}
