// Recently deleted: its own small database, `study-sprint-trash` (the same idea as the Own model's database in own-db.js).
// It is never synced, exported or backed up, and the main database (js/db.js) is not touched: delete this database and the feature
// is gone with no other change. Two stores:
//   entries  one row per delete action (the list reads only this)   { id, kind, title, deletedAt, settledAt, counts, mediaIds, ... }
//   parts    the deleted rows in pieces of about 2,000 rows         { pid: '<entry id>#<n>', gone: {...}, before: {...} }
// Every function takes an optional `idb` (the IndexedDB factory) so tests can pass a stand-in (tests/own-idb-fake.mjs).
// Each call opens the database, does its work and closes it, so no connection is ever left open to block an upgrade.

import { expired } from './trash-logic.js';

export const TRASH_DB_NAME = 'study-sprint-trash';
export const TRASH_DB_VERSION = 1;

export class TrashDbError extends Error {
  constructor(message, code = 'storage') { super(message); this.code = code; }
}

const factory = idb => idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
// Where the browser can list its databases, look there first so a read never creates an empty one. Anywhere else (or on any doubt) -> true.
async function mayExist(f) {
  try {
    if (typeof f.databases !== 'function') return true;
    const list = await f.databases();
    return !Array.isArray(list) || list.some(d => d && d.name === TRASH_DB_NAME);
  } catch { return true; }
}

// Opens the database. With forbidCreate it returns null when there is none yet and creates nothing (all the reads use this, so
// a person who never deletes anything never gets the database).
async function open({ idb, forbidCreate = false } = {}) {
  const f = factory(idb);
  if (!f) throw new TrashDbError('This browser cannot keep deleted items (no database available).');
  if (forbidCreate && !(await mayExist(f))) return null;
  return new Promise((resolve, reject) => {
    let req, missing = false;
    try { req = f.open(TRASH_DB_NAME, TRASH_DB_VERSION); } catch { reject(new TrashDbError('The Recently deleted database could not be opened.')); return; }
    req.onupgradeneeded = ev => {
      if (forbidCreate && !ev.oldVersion) {
        missing = true;
        try { req.transaction.abort(); } catch { /* already aborting */ }
        return;
      }
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: 'pid' });
    };
    req.onblocked = () => reject(new TrashDbError('Close other Study Sprint tabs, then try again.', 'blocked'));
    req.onerror = () => { if (missing) resolve(null); else reject(new TrashDbError('The Recently deleted database could not be opened.')); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();        // another tab wants to upgrade or delete: step aside
      resolve(db);
    };
  });
}

const isQuota = e => !!e && /Quota/.test(`${e.name} ${e.message}`);

// Runs fn(stores) in one transaction over the named stores. fn returns the requests whose results are wanted (a request or an array).
function run(db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx, out;
    try { tx = db.transaction(names, mode); out = fn(Object.fromEntries(names.map(n => [n, tx.objectStore(n)]))); } catch (e) { reject(new TrashDbError('The Recently deleted database could not be used.', isQuota(e) ? 'quota' : 'storage')); return; }
    tx.oncomplete = () => resolve(Array.isArray(out) ? out.map(r => r.result) : out && 'result' in out ? out.result : undefined);
    tx.onerror = tx.onabort = () => {
      const e = tx.error;
      reject(new TrashDbError('The Recently deleted database could not be read or written. The device may be out of space.', isQuota(e) ? 'quota' : 'storage'));
    };
  });
}

// Open, do the work, close. `create` lets the call create the database (only adding does).
async function withDb(opts, create, fn, whenMissing) {
  const db = await open({ idb: opts.idb, forbidCreate: !create });
  if (!db) return whenMissing;
  try { return await fn(db); } finally { try { db.close(); } catch { /* already closed */ } }
}

export const partKey = (entryId, n) => `${entryId}#${n}`;

// Saves an entry with all its pieces in ONE transaction, so an entry never exists without its rows. Throws TrashDbError
// (code 'quota' when the device is out of space).
export const addEntry = (entry, parts, opts = {}) => withDb(opts, true, db => run(db, ['entries', 'parts'], 'readwrite', s => {
  parts.forEach((p, n) => s.parts.put({ ...p, pid: partKey(entry.id, n) }));
  s.entries.put(entry);
}));

// Every entry, newest first. [] when there is no database.
export const listEntries = (opts = {}) => withDb(opts, false, async db => {
  const all = await run(db, ['entries'], 'readonly', s => s.entries.getAll());
  return all.sort((a, b) => b.deletedAt - a.deletedAt);
}, []);

// One piece of an entry's rows (n from 0), or undefined.
export const getPart = (entryId, n, opts = {}) => withDb(opts, false, db => run(db, ['parts'], 'readonly', s => s.parts.get(partKey(entryId, n))), undefined);

// Takes entries out, with their pieces. Resolves when saved.
export const removeEntries = (entries, opts = {}) => withDb(opts, false, db => run(db, ['entries', 'parts'], 'readwrite', s => {
  for (const e of entries) {
    for (let n = 0; n < (e.parts || 1); n++) s.parts.delete(partKey(e.id, n));
    s.entries.delete(e.id);
  }
}), undefined);
export const removeEntry = (entry, opts = {}) => removeEntries([entry], opts);

// Removes the entries that are over 30 days old. Returns how many went.
export async function purgeExpired(now = Date.now(), opts = {}) {
  const entries = await listEntries(opts);
  const ids = new Set(expired(entries, now));
  const old = entries.filter(e => ids.has(e.id));
  if (old.length) await removeEntries(old, opts);
  return old.length;
}

// Empties the list (a wipe of this device, Delete everywhere, Restore backup).
export const clearTrash = (opts = {}) => withDb(opts, false, db => run(db, ['entries', 'parts'], 'readwrite', s => { s.entries.clear(); s.parts.clear(); }), undefined);

// The pictures and sounds that entries still need: the main database's clean-up and the account sweep both keep them for 30 days.
export async function mediaIds(opts = {}) {
  const used = new Set();
  for (const e of await listEntries(opts)) for (const id of e.mediaIds || []) used.add(id);
  return used;
}

// For the clean-up and the account sweep: the ids to leave alone, or null when the list can't be read (then they must not clean).
export async function protectedMedia(opts = {}) {
  try { return await mediaIds(opts); } catch (err) { console.error('Recently deleted:', err); return null; }
}
