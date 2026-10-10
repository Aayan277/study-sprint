// Opening an Anki deck file (.apkg, or a whole collection .colpkg) in the browser.
// An .apkg is a zip file holding an SQLite database of notes. Three small libraries do the work.
// They only download when someone picks an Anki file, and are saved for offline use after that.
//   fflate   unzips the file
//   fzstd    unpacks the database in newer Anki files (2.1.50+), which is compressed
//   sql.js   reads the SQLite database
// readAnkiFile() returns { notes, models, reviews, media } for notesToImport() in anki.js.

import { mediaList } from './anki.js';

export const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
const FZSTD_URL = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/esm/index.mjs';
const SQLJS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/';

export async function readAnkiFile(file) {
  const { unzipSync } = await import(FFLATE_URL);
  const zip = new Uint8Array(await file.arrayBuffer());
  let files;
  try {
    // Unpack just the database and the list of pictures for now: the pictures themselves can be large,
    // so they're unpacked one by one later, only the ones the cards use (see media.get below).
    files = unzipSync(zip, { filter: f => /^(collection\.anki2(1b?)?|media)$/.test(f.name) });
  } catch (err) {
    throw new Error('not-anki');
  }
  // Newest format first. Newer files also hold an old-format collection.anki2 that only says "please update Anki".
  const newFormat = !!files['collection.anki21b'];
  const zstd = newFormat ? await import(FZSTD_URL) : null;
  let bytes = null;
  if (newFormat) bytes = zstd.decompress(files['collection.anki21b']);
  else bytes = files['collection.anki21'] || files['collection.anki2'];
  if (!bytes) throw new Error('not-anki');

  const SQL = await loadSqlJs();
  const db = new SQL.Database(bytes);
  let result;
  try {
    result = readCollection(db);
  } finally {
    db.close();
  }

  // The pictures: which file in the zip holds each one. Older files list them as JSON ({"0": "brain.png"});
  // newer ones as a small compressed binary list, in zip order (see mediaList in anki.js).
  const members = new Map();      // picture name → zip member name
  try {
    if (newFormat && files.media) mediaList(zstd.decompress(files.media)).forEach((name, i) => members.set(name.name, name.zipName ?? String(i)));
    else if (files.media) Object.entries(JSON.parse(new TextDecoder().decode(files.media))).forEach(([member, name]) => members.set(name, member));
  } catch (err) {
    console.error('Could not read the list of pictures', err);
  }
  result.media = {
    has: name => members.has(name),
    // A picture's bytes and type, or null.
    async get(name) {
      const member = members.get(name);
      if (member === undefined) return null;
      const got = unzipSync(zip, { filter: f => f.name === member })[member];
      if (!got) return null;
      return { data: newFormat ? zstd.decompress(got) : got, type: imageType(name) };
    }
  };
  return result;
}

const imageType = name => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' })[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

// sql.js isn't an ES module, so it's added as a <script> once. (Also used to make Anki files: export.js.)
let sqlPromise = null;
export function loadSqlJs() {
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

  // A note's deck is the deck of its first card. Each note also keeps its cards' ids by card number (ord),
  // so their review history can be matched up: ord 0 is the front → back card, and for cloze notes
  // ord n - 1 is blank number n.
  const deckOfNote = new Map(), cardsOfNote = new Map();
  for (const [id, nid, did, ord] of q('SELECT id, nid, did, ord FROM cards ORDER BY ord DESC')) {
    deckOfNote.set(nid, did);
    if (!cardsOfNote.has(nid)) cardsOfNote.set(nid, {});
    cardsOfNote.get(nid)[ord] = String(id);
  }

  // Review history (only there when the deck was exported with "Include scheduling information").
  //   id = when (ms), ease = button (1 Again … 4 Easy, 0 = changed by hand), time = ms taken, type 4/5 = manual change
  const reviews = new Map();
  if (tables.has('revlog')) {
    for (const [id, cid, ease, ivl, time, type] of q('SELECT id, cid, ease, ivl, time, type FROM revlog ORDER BY id')) {
      const key = String(cid);
      if (!reviews.has(key)) reviews.set(key, []);
      reviews.get(key).push({ timestamp: id, ease, ivl, ms: time, type });
    }
  }

  const notes = q('SELECT id, mid, flds, tags FROM notes ORDER BY id').map(([id, mid, flds, tags]) => ({
    mid: String(mid),
    fields: String(flds).split('\x1f'),
    tags: String(tags || '').trim().split(/\s+/).filter(Boolean),
    deck: deckNames.get(String(deckOfNote.get(id))) || '',
    cards: cardsOfNote.get(id) || {}
  }));
  return { notes, models, reviews };
}
