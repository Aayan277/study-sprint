// Own model: its private database. A separate IndexedDB, never the main one, so nothing in here is ever synced, exported or
// backed up. It is only created when the owner first loads a model file. Stores:
//   meta   (settings / state / fingerprint)    model (the loaded file as bytes + its sha256)    tuned (later step)
//   cards / notes / shared (memory states)     preds (one record per scored review, keyed by logId)
// This file is a thin layer: open, read, write, delete. The logic around it lives elsewhere and is tested with a stand-in database.
// Every function takes an optional `idb` (the IndexedDB factory) so tests can pass a stand-in.

export const OWN_DB_NAME = 'study-sprint-own';
export const OWN_DB_VERSION = 1;
export const OWN_STORES = ['meta', 'model', 'tuned', 'cards', 'notes', 'shared', 'preds'];
const KEYLESS = new Set(OWN_STORES.filter(s => s !== 'preds')); // preds uses its own logId as the key

export class OwnDbError extends Error {
  constructor(message, code = 'storage') { super(message); this.code = code; }
}

const factory = idb => idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
const wrap = req => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(new OwnDbError('The Own database could not be read or written.'));
});

// Opens (and, unless forbidCreate, creates) the database. With forbidCreate it returns null when the database does not exist yet,
// and creates nothing (used by the worker and by anything that only reads). Throws OwnDbError in plain English.
export function openOwnDb({ idb, forbidCreate = false } = {}) {
  const f = factory(idb);
  if (!f) return Promise.reject(new OwnDbError('This browser cannot store the Own model (no database available).'));
  return new Promise((resolve, reject) => {
    let req, missing = false;
    try { req = f.open(OWN_DB_NAME, OWN_DB_VERSION); } catch { reject(new OwnDbError('The Own database could not be opened.')); return; }
    req.onupgradeneeded = ev => {
      if (forbidCreate && !ev.oldVersion) { // nothing there yet: do not create it
        missing = true;
        try { req.transaction.abort(); } catch { /* already aborting */ }
        return;
      }
      const db = req.result;
      for (const s of OWN_STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, KEYLESS.has(s) ? undefined : { keyPath: 'logId' });
    };
    req.onblocked = () => reject(new OwnDbError('Close other Study Sprint tabs, then try again.', 'blocked'));
    req.onerror = () => { if (missing) resolve(null); else reject(new OwnDbError('The Own database could not be opened.')); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // another tab wants to upgrade or delete: step aside
      resolve(makeHandle(db));
    };
  });
}

function makeHandle(db) {
  const run = (store, mode, fn) => new Promise((resolve, reject) => {
    let tx, out;
    try { tx = db.transaction(store, mode); out = fn(tx.objectStore(store)); } catch { reject(new OwnDbError('The Own database could not be used.')); return; }
    tx.oncomplete = () => resolve(out && out.__reqs ? out.__reqs.map(r => r.result) : out && out.__req ? out.__req.result : out);
    tx.onerror = tx.onabort = () => reject(new OwnDbError('The Own database could not be read or written. The device may be out of space.'));
  });
  const req = r => ({ __req: r });
  return {
    db,
    get: (store, key) => run(store, 'readonly', s => req(s.get(key))),
    getAll: store => run(store, 'readonly', s => req(s.getAll())),
    // `key` is ignored for stores that carry their own key (preds)
    put: (store, key, value) => run(store, 'readwrite', s => { s.put(...(store === 'preds' ? [value] : [value, key])); }),
    putMany: (store, rows) => run(store, 'readwrite', s => { for (const r of rows) s.put(r); }), // preds only
    // Many entries of one store in a single transaction: [[key, value], ...] (stores that carry their own key use the value only)
    putEntries: (store, entries) => run(store, 'readwrite', s => { for (const [k, v] of entries) s.put(...(store === 'preds' ? [v] : [v, k])); }),
    deleteKeys: (store, keys) => run(store, 'readwrite', s => { for (const k of keys) s.delete(k); }),
    // Every entry of a store as [[key, value], ...]
    getEntries: store => run(store, 'readonly', s => ({ __reqs: [s.getAllKeys(), s.getAll()] })).then(([ks, vs]) => ks.map((k, i) => [k, vs[i]])),
    delete: (store, key) => run(store, 'readwrite', s => { s.delete(key); }),
    clear: store => run(store, 'readwrite', s => { s.clear(); }),
    close: () => { try { db.close(); } catch { /* already closed */ } }
  };
}

// True when the Own database already exists. Creates nothing.
export async function ownDbExists({ idb } = {}) {
  const h = await openOwnDb({ idb, forbidCreate: true });
  if (!h) return false;
  h.close();
  return true;
}

// Deletes the whole Own database (model, memory, records). Resolves true when it is gone, throws OwnDbError if another tab blocks it.
export function deleteOwnDb({ idb } = {}) {
  const f = factory(idb);
  if (!f) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let req;
    try { req = f.deleteDatabase(OWN_DB_NAME); } catch { reject(new OwnDbError('The Own database could not be removed.')); return; }
    req.onsuccess = () => resolve(true);
    req.onblocked = () => reject(new OwnDbError('Close other Study Sprint tabs, then try again.', 'blocked'));
    req.onerror = () => reject(new OwnDbError('The Own database could not be removed.'));
  });
}
