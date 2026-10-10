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
//   media       pictures on cards           { id, type, data (the file's bytes), size, created, uploaded }
//               (a card points to its pictures with frontImage / backImage = a media id: see media.js)
// updatedAt, uid and the deleted store are there for syncing between devices: see sync-data.js.
// Every save below stamps them, so other files never need to.
//
// Everything here returns a Promise, so callers use `await`.

const DB_NAME = 'study-sprint';
const DB_VERSION = 3;   // 1 → 2: added updatedAt, review uids and the deleted store (for sync). 2 → 3: media store

import { stamp, tombstone, tombstoneKey, upgradeRecord, SYNC_ID, SYNCED_SETTINGS, SETTING_TIMES, randomId } from './sync-data.js';
import { decide, recordFromRow, needsPush, tombstoneNeedsPush } from './sync-merge.js';

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
  values.forEach(v => os.put(stamp(name, v, now)));
  await finished(tx);
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
  tx.objectStore('decks').put(stamp('decks', deck, now));
  const cs = tx.objectStore('cards');
  cards.forEach(c => cs.put(stamp('cards', c, now)));
  await finished(tx);
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
  tx.objectStore('cardStates').put(stamp('cardStates', state, now));
  const req = tx.objectStore('reviewLog').add(stamp('reviewLog', log, now));
  await finished(tx);
  scheduleChanges++;
  changed();
  return req.result;
}

// Save a review-log row without changing any schedule (e.g. a Play answer on a card that isn't due).
export async function addLog(log) {
  const id = await done((await store('reviewLog', 'readwrite')).add(stamp('reviewLog', log)));
  changed();
  return id;
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
  changed();
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
  changed();
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
  await finished(tx);
  if (SYNCED_SETTINGS.includes(key)) changed();
}

// ---------- wipe everything ----------
export async function resetAll() {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings', 'deleted', 'media'];
  const tx = db.transaction(names, 'readwrite');
  names.forEach(n => tx.objectStore(n).clear());
  return finished(tx);
}

// ---------- backup ----------
// A backup is one JSON file with everything: decks, cards, schedules, review history, settings and pictures
// (as text: base64).
export const BACKUP_FORMAT = 'study-sprint-backup';
export const BACKUP_VERSION = 1;

export async function exportAll() {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards', 'cardStates', 'reviewLog', 'settings', 'media'], 'readonly');
  const all = name => done(tx.objectStore(name).getAll());
  const [decks, cards, cardStates, reviewLog, keys, values, mediaRows] = await Promise.all([
    all('decks'), all('cards'), all('cardStates'), all('reviewLog'),
    done(tx.objectStore('settings').getAllKeys()), done(tx.objectStore('settings').getAll()), all('media')
  ]);
  const media = mediaRows.map(m => ({ id: m.id, type: m.type, data: toBase64(m.data) }));
  // Sign-in details and sync bookmarks stay on this device (they're not part of your study data).
  const settings = Object.fromEntries(keys.map((k, i) => [k, values[i]]).filter(([k]) => !LOCAL_ONLY.includes(k)));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: new Date().toISOString(), decks, cards, cardStates, reviewLog, settings, media };
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
//   everywhere: also replace what's in your sync account. The backup's records count as changed now (so
//               they're sent and win), and everything that was here but isn't in the backup gets a deleted
//               marker (so other devices delete it too).
export async function importAll(data, { everywhere = false } = {}) {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings', 'deleted', 'media'];
  const tx = db.transaction(names, 'readwrite');
  const saved = finished(tx);
  const now = Date.now();
  // Pictures from the backup (older backups have none). Ones already here are kept.
  for (const m of data.media || []) {
    const bytes = fromBase64(m.data);
    tx.objectStore('media').put({ id: m.id, type: m.type, data: bytes, size: bytes.byteLength, created: now, uploaded: false });
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
  // Backups from before sync existed are filled in the same way as the version 2 upgrade.
  const kept = {};
  for (const name of Object.keys(SYNC_ID)) {
    kept[name] = new Set();
    for (const x of data[name]) {
      let rec = upgradeRecord(name, x, now);
      if (everywhere) { rec = { ...rec, updatedAt: now }; delete rec.syncedAt; }
      tx.objectStore(name).put(rec);
      kept[name].add(String(rec[SYNC_ID[name]]));
    }
  }
  if (everywhere) {
    for (const name of Object.keys(SYNC_ID)) {
      for (const id of before[name]) if (!kept[name].has(id)) markDeleted(tx, name, id, now);
    }
  }
  // Settings are replaced too, except this device's sign-in and sync bookmarks.
  const settings = tx.objectStore('settings');
  oldKeys.filter(k => !LOCAL_ONLY.includes(k)).forEach(k => settings.delete(k));
  const restored = Object.entries(data.settings || {}).filter(([k]) => !LOCAL_ONLY.includes(k));
  restored.forEach(([k, v]) => settings.put(v, k));
  if (everywhere) {
    // The backup's study settings win in the account too.
    settings.put(Object.fromEntries(SYNCED_SETTINGS.filter(k => restored.some(([r]) => r === k)).map(k => [k, now])), SETTING_TIMES);
  }
  await saved;
  scheduleChanges++;
  changed();
}

// Delete every deck, card, schedule and review on this device and (when synced) on every device:
// each one leaves a deleted marker, which syncing sends to the others.
export async function deleteEverything() {
  const db = await openDB();
  const tx = db.transaction([...Object.keys(SYNC_ID), 'deleted'], 'readwrite');
  const saved = finished(tx);
  const now = Date.now();
  for (const name of Object.keys(SYNC_ID)) {
    const os = tx.objectStore(name);
    for (const r of await done(os.getAll())) {
      const id = r[SYNC_ID[name]];
      if (id !== undefined) markDeleted(tx, name, id, now);
    }
    os.clear();
  }
  await saved;
  scheduleChanges++;
  changed();
}

// ---------- syncing (used by sync.js) ----------
// Settings that belong to this device only: never synced, never in backups.
//   syncAuth   who's signed in (and their sign-in tokens)
//   syncState  sync bookmarks: the last server change seen, and when this device last sent its changes
export const LOCAL_ONLY = ['syncAuth', 'syncState'];

// Tell sync.js when something changed on this device, so it can send it.
const listeners = new Set();
export const onLocalChange = fn => { listeners.add(fn); };
function changed() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

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
  for (const key of SYNCED_SETTINGS) {
    if (times[key] > since) settings.push({ key, value: await done(os.get(key)), time: times[key] });
  }
  return { records, tombstones, settings };
}

// Save changes that came from the server. Each row only wins if it's newer than this device's version
// (see decide() in sync-merge.js). Not stamped and not reported as a local change, so it isn't sent back.
// Returns how many rows changed something here.
export async function applyRemote(rows) {
  if (!rows.length) return 0;
  const db = await openDB();
  const tx = db.transaction([...Object.keys(SYNC_ID), 'deleted', 'settings'], 'readwrite');
  const saved = finished(tx);
  let applied = 0, schedules = false;
  const settingsStore = tx.objectStore('settings');
  const deleted = tx.objectStore('deleted');
  let times = (await done(settingsStore.get(SETTING_TIMES))) || {};
  for (const row of rows) {
    if (row.store === 'settings') {
      if (!SYNCED_SETTINGS.includes(row.id) || decide(row, times[row.id] || 0) !== 'put') continue;
      settingsStore.put(row.data?.value, row.id);
      times = { ...times, [row.id]: row.updated_at };
      applied++;
      continue;
    }
    if (!(row.store in SYNC_ID)) continue;
    const os = tx.objectStore(row.store);
    // Review-log rows are found by uid; everything else by its id.
    const local = row.store === 'reviewLog' ? await done(os.index('uid').get(row.id)) : await done(os.get(row.id));
    const tomb = await done(deleted.get(tombstoneKey(row.store, row.id)));
    const action = decide(row, Math.max(local?.updatedAt || 0, tomb?.deletedAt || 0));
    if (action === 'skip') continue;
    if (action === 'delete') {
      if (local) os.delete(row.store === 'reviewLog' ? local.id : row.id);
      deleted.put({ ...tombstone(row.store, row.id, row.updated_at), synced: true });
    } else {
      const record = recordFromRow(row);
      if (row.store === 'reviewLog') { if (local) record.id = local.id; else delete record.id; }
      os.put(record);
      if (tomb) deleted.delete(tomb.key);
    }
    if (row.store === 'cardStates' || row.store === 'cards') schedules = true;
    applied++;
  }
  settingsStore.put(times, SETTING_TIMES);
  await saved;
  if (schedules) scheduleChanges++;
  return applied;
}

// ---------- pictures (used by media.js and sync.js) ----------
// Saved as the file's bytes (an ArrayBuffer), which every browser stores reliably.
//   uploaded: whether the sync server has it yet
export const getMedia = id => get('media', id);
export async function putMedia(m) {
  await done((await store('media', 'readwrite')).put(m));
  changed();
}
// Pictures that came from the server (not reported as a change, so they aren't sent back).
export async function putRemoteMedia(m) { await done((await store('media', 'readwrite')).put({ ...m, uploaded: true })); }
export async function mediaToUpload() { return (await getAll('media')).filter(m => !m.uploaded); }
export async function markUploaded(ids) {
  const db = await openDB();
  const tx = db.transaction('media', 'readwrite');
  const os = tx.objectStore('media');
  for (const id of ids) os.get(id).onsuccess = e => { if (e.target.result) os.put({ ...e.target.result, uploaded: true }); };
  return finished(tx);
}
// Remove pictures no card uses any more (replaced, removed, or their card deleted). Pictures added in the
// last hour are kept (their card may not be saved yet). Returns the removed ones that the server has.
export async function cleanMedia(now = Date.now()) {
  const db = await openDB();
  const tx = db.transaction(['cards', 'media'], 'readwrite');
  const saved = finished(tx);
  const used = new Set();
  for (const c of await done(tx.objectStore('cards').getAll())) { if (c.frontImage) used.add(c.frontImage); if (c.backImage) used.add(c.backImage); }
  const removed = [];
  for (const m of await done(tx.objectStore('media').getAll())) {
    if (used.has(m.id) || now - (m.created || 0) < 3600000) continue;
    tx.objectStore('media').delete(m.id);
    if (m.uploaded) removed.push(m.id);
  }
  await saved;
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
