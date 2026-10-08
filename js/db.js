// Storage for the whole app, using IndexedDB (a database built into every browser).
// It can hold far more than localStorage, so big decks are fine.
//
// The database has 5 "stores" (think of them as tables):
//   decks       one row per deck            { id, name, color, created, course }
//   cards       one row per card            { id, deckId, front, back, tags, created }
//   cardStates  FSRS schedule for a card    { cardId, due, stability, difficulty, reps, lapses, state, lastReview }
//   reviewLog   one row per answer          { id (auto), cardId, timestamp, source, mode, correct, ms, rating }
//   settings    simple key → value pairs    e.g. 'theme' → { skin: 'ink', mode: 'auto' }
//
// Everything here returns a Promise, so callers use `await`.

const DB_NAME = 'study-sprint';
const DB_VERSION = 1;

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
  seeded: false      // true once the sample deck has been added on first open
};

let dbPromise = null;

// Open (and on first run, create) the database. Only happens once per page load.
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Runs only when the database is new or DB_VERSION goes up. This is where tables are created.
    req.onupgradeneeded = () => {
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
export async function put(name, value) { return done((await store(name, 'readwrite')).put(value)); }

// Save many rows in one go (much faster than one at a time, and all-or-nothing).
export async function putMany(name, values) {
  const db = await openDB();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  values.forEach(v => os.put(v));
  return finished(tx);
}

// ---------- ids ----------
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- decks ----------
export const getDecks = () => getAll('decks');
export const getDeck = id => get('decks', id);
export const saveDeck = deck => put('decks', deck);
export const getCardsInDeck = deckId => getAllByIndex('cards', 'deckId', deckId);

// Create a deck and (optionally) its cards in a single save.
export async function addDeckWithCards(deck, cards = []) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards'], 'readwrite');
  tx.objectStore('decks').put(deck);
  const cs = tx.objectStore('cards');
  cards.forEach(c => cs.put(c));
  return finished(tx);
}

// Delete a deck plus everything that belongs to it: its cards, their schedules and their review history.
// All in one transaction, so it can't half-finish.
export async function deleteDeck(deckId) {
  const db = await openDB();
  const tx = db.transaction(['decks', 'cards', 'cardStates', 'reviewLog'], 'readwrite');
  const cards = tx.objectStore('cards');
  const states = tx.objectStore('cardStates');
  const logIndex = tx.objectStore('reviewLog').index('cardId');
  tx.objectStore('decks').delete(deckId);
  cards.index('deckId').getAllKeys(deckId).onsuccess = e => {
    for (const cardId of e.target.result) {
      cards.delete(cardId);
      states.delete(cardId);
      // Walk every log row for this card and delete it.
      logIndex.openCursor(cardId).onsuccess = ev => {
        const cur = ev.target.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
    }
  };
  return finished(tx);
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
  tx.objectStore('cardStates').put(state);
  const req = tx.objectStore('reviewLog').add(log);
  await finished(tx);
  scheduleChanges++;
  return req.result;
}

// Save a review-log row without changing any schedule (e.g. a Play answer on a card that isn't due).
export async function addLog(log) {
  return done((await store('reviewLog', 'readwrite')).add(log));
}

// Undo a review: put the old schedule back (or remove it if the card was new) and delete the log row.
export async function undoReview(cardId, prevState, logId) {
  const db = await openDB();
  const tx = db.transaction(['cardStates', 'reviewLog'], 'readwrite');
  if (prevState) tx.objectStore('cardStates').put(prevState);
  else tx.objectStore('cardStates').delete(cardId);
  tx.objectStore('reviewLog').delete(logId);
  await finished(tx);
  scheduleChanges++;
}

// Every review-log row since a moment in time (e.g. since the start of today).
export async function getLogsSince(timestamp) {
  return done((await store('reviewLog')).index('timestamp').getAll(IDBKeyRange.lowerBound(timestamp)));
}

// ---------- settings ----------
// Returns every setting, filling in defaults for anything never saved.
export async function getSettings() {
  const os = await store('settings');
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  const saved = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  return { ...DEFAULT_SETTINGS, ...saved };
}
// The settings store keeps its key outside the value, so the key is passed separately.
export async function setSetting(key, value) {
  return done((await store('settings', 'readwrite')).put(value, key));
}

// ---------- wipe everything ----------
export async function resetAll() {
  const db = await openDB();
  const names = ['decks', 'cards', 'cardStates', 'reviewLog', 'settings'];
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
  data.decks.forEach(x => tx.objectStore('decks').put(x));
  data.cards.forEach(x => tx.objectStore('cards').put(x));
  data.cardStates.forEach(x => tx.objectStore('cardStates').put(x));
  data.reviewLog.forEach(x => tx.objectStore('reviewLog').put(x));
  Object.entries(data.settings || {}).forEach(([k, v]) => tx.objectStore('settings').put(v, k));
  await finished(tx);
  scheduleChanges++;
}
