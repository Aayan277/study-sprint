// Opening an Anki deck file (.apkg, or a whole collection .colpkg) in the browser.
// An .apkg is a zip file holding an SQLite database of notes. Three small libraries do the work.
// They only download when someone picks an Anki file, and are saved for offline use after that.
//   fflate   unzips the file
//   fzstd    unpacks the database in newer Anki files (2.1.50+), which is compressed
//   sql.js   reads the SQLite database
// readAnkiFile() returns { notes, models } for notesToImport() in anki.js.

const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
const FZSTD_URL = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/esm/index.mjs';
const SQLJS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/';

export async function readAnkiFile(file) {
  const { unzipSync } = await import(FFLATE_URL);
  let files;
  try {
    // Only unpack the database: the media (images, audio) can be large and isn't used.
    files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: f => /^collection\.anki2(1b?)?$/.test(f.name) });
  } catch (err) {
    throw new Error('not-anki');
  }
  // Newest format first. Newer files also hold an old-format collection.anki2 that only says "please update Anki".
  let bytes = null;
  if (files['collection.anki21b']) bytes = (await import(FZSTD_URL)).decompress(files['collection.anki21b']);
  else bytes = files['collection.anki21'] || files['collection.anki2'];
  if (!bytes) throw new Error('not-anki');

  const SQL = await loadSqlJs();
  const db = new SQL.Database(bytes);
  try {
    return readCollection(db);
  } finally {
    db.close();
  }
}

// sql.js isn't an ES module, so it's added as a <script> once.
let sqlPromise = null;
function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SQLJS_BASE + 'sql-wasm.js';
      s.onload = () => window.initSqlJs({ locateFile: f => SQLJS_BASE + f }).then(resolve, reject);
      s.onerror = () => reject(new Error('Could not load sql.js'));
      document.head.append(s);
    }).catch(err => { sqlPromise = null; throw err; });     // let a later try (e.g. back online) start again
  }
  return sqlPromise;
}

// Read note types, decks and notes. Anki has two layouts:
//   newer (schema 18): note types, fields and decks have their own tables
//   older (schema 11): they're JSON inside the "col" table
function readCollection(db) {
  const q = sql => { const r = db.exec(sql); return r.length ? r[0].values : []; };
  const tables = new Set(q("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r[0]));
  if (!tables.has('notes')) throw new Error('not-anki');
  const models = new Map(), deckNames = new Map();

  if (tables.has('notetypes')) {
    // The config is a small binary (protobuf) record. It starts with bytes 8, 1 when the note type is Cloze.
    for (const [id, name, config] of q('SELECT id, name, config FROM notetypes')) {
      models.set(String(id), { name, fields: [], cloze: !!config && config[0] === 8 && config[1] === 1 });
    }
    for (const [ntid, , name] of q('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord')) models.get(String(ntid))?.fields.push(name);
    for (const [id, name] of q('SELECT id, name FROM decks')) deckNames.set(String(id), String(name).split('\x1f').join('::'));
  } else {
    const [[modelsJson, decksJson] = []] = q('SELECT models, decks FROM col');
    for (const [id, m] of Object.entries(JSON.parse(modelsJson || '{}'))) {
      models.set(String(id), { name: m.name, fields: [...m.flds].sort((a, b) => a.ord - b.ord).map(f => f.name), cloze: m.type === 1 });
    }
    for (const [id, d] of Object.entries(JSON.parse(decksJson || '{}'))) deckNames.set(String(id), d.name);
  }

  // A note's deck is the deck of its first card.
  const deckOfNote = new Map();
  for (const [nid, did] of q('SELECT nid, did FROM cards ORDER BY ord DESC')) deckOfNote.set(nid, did);

  const notes = q('SELECT id, mid, flds, tags FROM notes ORDER BY id').map(([id, mid, flds, tags]) => ({
    mid: String(mid),
    fields: String(flds).split('\x1f'),
    tags: String(tags || '').trim().split(/\s+/).filter(Boolean),
    deck: deckNames.get(String(deckOfNote.get(id))) || ''
  }));
  return { notes, models };
}
