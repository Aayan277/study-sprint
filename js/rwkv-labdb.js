// RWKV lab: the lab's own database. Everything the lab keeps (the weights you chose, the model's memory of each card, the settings, the
// comparison records) lives here and nowhere else: never in the app's main database, never in its settings, never synced or backed up.
// Used by the page and by the lab's worker. No network.
export const LAB_DB = 'study-sprint-rwkv-lab';
export const LAB_VERSION = 1;
// meta: key -> value ('settings', 'state').  weights: 'current'.  cards / notes / shared: key -> record.  preds: keyPath logId.
export const STORES = ['meta', 'weights', 'cards', 'notes', 'shared', 'preds'];
const BATCH = 500;

let dbp = null;

export function openLab() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(LAB_DB, LAB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === 'preds') db.createObjectStore(name, { keyPath: 'logId' }); else db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };      // another tab or the "remove" button wants to delete it
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error('Close other Study Sprint tabs and try again.')); };
  });
  return dbp;
}

const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('aborted')); });

export async function get(store, key) { return done((await openLab()).transaction(store).objectStore(store).get(key)); }
export async function getAll(store) { return done((await openLab()).transaction(store).objectStore(store).getAll()); }
// Every [key, value] of a store, in key order.
export async function getEntries(store) {
  const os = (await openLab()).transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([done(os.getAllKeys()), done(os.getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}
export async function count(store) { return done((await openLab()).transaction(store).objectStore(store).count()); }
export async function put(store, value, key) {
  const os = (await openLab()).transaction(store, 'readwrite').objectStore(store);
  return done(key === undefined ? os.put(value) : os.put(value, key));
}
export async function del(store, key) { return done((await openLab()).transaction(store, 'readwrite').objectStore(store).delete(key)); }

// Several writes in one all-or-nothing transaction.
//   puts     { store: [[key, value], ...] }  (for preds, [value, ...])
//   deletes  { store: [key, ...] }
export async function commit(puts = {}, deletes = {}) {
  const names = [...new Set([...Object.keys(puts), ...Object.keys(deletes)])].filter(n => (puts[n]?.length || deletes[n]?.length));
  if (!names.length) return;
  const tx = (await openLab()).transaction(names, 'readwrite');
  for (const n of names) {
    const os = tx.objectStore(n);
    for (const k of deletes[n] || []) os.delete(k);
    for (const item of puts[n] || []) { if (n === 'preds') os.put(item); else os.put(item[1], item[0]); }
  }
  await finished(tx);
}

// Many writes to one store, BATCH to a transaction.  items: [[key, value], ...] (preds: [value, ...])
export async function putMany(store, items) {
  for (let i = 0; i < items.length; i += BATCH) await commit({ [store]: items.slice(i, i + BATCH) });
}

// Forget the model's memory of the cards (and the comparison records), keeping the weights and settings.
export async function clearStates() {
  const names = ['cards', 'notes', 'shared', 'preds'];
  const tx = (await openLab()).transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await finished(tx);
}

export async function deleteLab() {
  if (dbp) { try { (await dbp).close(); } catch { /* it never opened */ } dbp = null; }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(LAB_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Study Sprint tabs and try again.'));
  });
}

// Does the lab database exist already? Never creates it.
export async function labExists() {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases === 'function') {
    try { return (await indexedDB.databases()).some(d => d.name === LAB_DB); } catch { /* fall through */ }
  }
  // No databases(): ask to open it, and cancel the creation if it was not there.
  return new Promise(resolve => {
    let existed = true;
    const req = indexedDB.open(LAB_DB);
    req.onupgradeneeded = () => { existed = false; req.transaction.abort(); };
    req.onsuccess = () => { req.result.close(); resolve(existed); };
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

export const DEFAULT_SETTINGS = { shadow: false, scheduler: 'fsrs', shadowSince: null };
export async function getSettings() { return { ...DEFAULT_SETTINGS, ...((await get('meta', 'settings')) || {}) }; }
export async function setSettings(patch) { const s = { ...(await getSettings()), ...patch }; await put('meta', s, 'settings'); return s; }
