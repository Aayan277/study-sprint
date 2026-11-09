// A small in-memory stand-in for IndexedDB, just enough for js/own-db.js (open/upgrade, stores, get/put/delete/clear/getAll, delete database).
// Used only by tests. Values are copied on the way in and out, like the real thing (typed arrays survive).
const later = fn => setTimeout(fn, 0);

export function makeFakeIdb({ blockDelete = false, failWrites = false } = {}) {
  const dbs = new Map(); // name -> { version, stores: Map(name -> { keyPath, rows: Map }) }
  const conns = new Map(); // name -> the connections opened so far
  const log = { opened: 0 };
  const idb = {
    log, dbs,
    open(name, version) {
      log.opened++;
      const req = { result: null, error: null };
      later(() => {
        let rec = dbs.get(name);
        const old = rec ? rec.version : 0;
        let aborted = false;
        if (!rec || rec.version < version) {
          rec = rec || { version: 0, stores: new Map() };
          const draft = { version, stores: new Map([...rec.stores].map(([k, v]) => [k, { keyPath: v.keyPath, rows: new Map(v.rows) }])) };
          const db = makeDb(name, draft);
          req.result = db; req.oldVersion = old;
          req.transaction = { abort() { aborted = true; } };
          if (req.onupgradeneeded) req.onupgradeneeded({ oldVersion: old });
          if (aborted) { req.error = new Error('AbortError'); if (req.onerror) req.onerror({}); return; }
          dbs.set(name, draft);
        }
        const db = makeDb(name, dbs.get(name));
        (conns.get(name) || conns.set(name, new Set()).get(name)).add(db);
        req.result = db;
        if (req.onsuccess) req.onsuccess({});
      });
      return req;
    },
    deleteDatabase(name) {
      const req = {};
      later(() => {
        if (blockDelete) { if (req.onblocked) req.onblocked({}); return; }
        for (const c of conns.get(name) || []) if (!c.closed && c.onversionchange) c.onversionchange({});      // like a real browser: connections are told and step aside
        conns.delete(name);
        dbs.delete(name);
        if (req.onsuccess) req.onsuccess({});
      });
      return req;
    }
  };
  function makeDb(name, rec) {
    const db = {
      version: rec.version, onversionchange: null, closed: false,
      objectStoreNames: { contains: n => rec.stores.has(n) },
      createObjectStore(n, opts) { rec.stores.set(n, { keyPath: opts && opts.keyPath, rows: new Map() }); },
      close() { db.closed = true; },
      transaction(names) {
        if (db.closed) throw new Error('InvalidStateError');
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!rec.stores.has(n)) throw new Error('NotFoundError');
        const tx = { oncomplete: null, onerror: null, onabort: null };
        const pending = [];
        const objectStore = n => {
          const st = rec.stores.get(n);
          const act = fn => { const r = { result: undefined }; pending.push(() => { r.result = fn(); if (r.onsuccess) r.onsuccess({}); }); return r; };
          return {
            put(value, key) {
              if (failWrites) throw new Error('QuotaExceededError');
              const k = st.keyPath ? value[st.keyPath] : key;
              if (k === undefined) throw new Error('DataError');
              return act(() => { st.rows.set(k, structuredClone(value)); return k; });
            },
            get: key => act(() => (st.rows.has(key) ? structuredClone(st.rows.get(key)) : undefined)),
            getAll: () => act(() => [...st.rows.values()].map(v => structuredClone(v))),
            getAllKeys: () => act(() => [...st.rows.keys()]),
            delete: key => act(() => { st.rows.delete(key); }),
            clear: () => act(() => { st.rows.clear(); })
          };
        };
        tx.objectStore = objectStore;
        later(() => { for (const p of pending) p(); if (tx.oncomplete) tx.oncomplete({}); });
        return tx;
      }
    };
    return db;
  }
  return idb;
}
