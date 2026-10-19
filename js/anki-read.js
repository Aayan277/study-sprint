// Opening an Anki deck file (.apkg, or a whole collection .colpkg) in the browser.
// An .apkg is a zip file holding an SQLite database of notes. Three small libraries do the work.
// They only download when someone picks an Anki file, and are saved for offline use after that.
//   fflate   unzips the file
//   fzstd    unpacks the database in newer Anki files (2.1.50+), which is compressed
//   sql.js   reads the SQLite database
// readAnkiFile() returns { notes, models, reviews, media } for notesToImport() in anki.js.
// media.has(name) / media.info(name) → { size, type } / media.get(name) → { data, type } tell about the pictures and sounds inside.

import { mediaList, templateFormats } from './anki.js';

export const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
const FZSTD_URL = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/esm/index.mjs';
const SQLJS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/';

// A "zip bomb" is a small file that unpacks to something huge. What is unpacked from a deck file (the database and the list of
// pictures: together, and each picture or sound later on) and what the zstd unpacker writes out may not pass this, the same
// 100 MB as a .pptx (js/doc-import.js). The file is then refused with a message that says why.
export const MAX_UNPACKED = 100 * 1024 * 1024;
export const ankiTooBigMessage = () => "That Anki file unpacks to more than 100 MB of cards, so it can't be opened here. Export a smaller deck from Anki (a few decks at a time) and try again.";
const tooBig = () => Object.assign(new Error('too-big'), { code: 'too-big', message: ankiTooBigMessage() });

// fzstd's decompress() with a ceiling: it is run as a stream so the size is counted as each block comes out, and the file is
// refused at once when it passes the cap (a file can claim a small size and still unpack huge). `zstd` is the fzstd module.
export function unzstd(zstd, bytes, cap = MAX_UNPACKED) {
  const parts = [];
  let size = 0;
  const stream = new zstd.Decompress(chunk => {
    size += chunk.length;
    if (size > cap) throw tooBig();
    parts.push(chunk);
  });
  stream.push(bytes, true);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function readAnkiFile(file) {
  const { unzipSync } = await import(FFLATE_URL);
  const zip = new Uint8Array(await file.arrayBuffer());
  let files;
  const entrySizes = new Map();      // zip member name → its size when unpacked (older files; in newer ones the list says)
  let unpacked = 0;
  try {
    // Unpack just the database and the list of pictures for now: the pictures themselves can be large,
    // so they're unpacked one by one later, only the ones the cards use (see media.get below).
    // (The filter also sees every file's size on the way, which is how the sounds' sizes are known without unpacking them.)
    files = unzipSync(zip, {
      filter: f => {
        entrySizes.set(f.name, f.originalSize);
        if (!/^(collection\.anki2(1b?)?|media)$/.test(f.name)) return false;
        unpacked += f.originalSize;
        if (unpacked > MAX_UNPACKED) throw tooBig();
        return true;
      }
    });
  } catch (err) {
    if (err?.code === 'too-big') throw err;
    throw new Error('not-anki');
  }
  // Newest format first. Newer files also hold an old-format collection.anki2 that only says "please update Anki".
  const newFormat = !!files['collection.anki21b'];
  const zstd = newFormat ? await import(FZSTD_URL) : null;
  let bytes = null;
  if (newFormat) bytes = unzstd(zstd, files['collection.anki21b']);
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
  const sizes = new Map();        // picture name → its size in bytes, when known
  try {
    if (newFormat && files.media) mediaList(unzstd(zstd, files.media)).forEach((name, i) => { members.set(name.name, name.zipName ?? String(i)); if (name.size) sizes.set(name.name, name.size); });
    else if (files.media) Object.entries(JSON.parse(new TextDecoder().decode(files.media))).forEach(([member, name]) => members.set(name, member));
  } catch (err) {
    if (err?.code === 'too-big') throw err;
    console.error('Could not read the list of pictures', err);
  }
  result.mediaBytes = [...members].reduce((n, [name, member]) => n + (sizes.get(name) ?? entrySizes.get(member) ?? 0), 0);   // about how much the deck's pictures and sounds take (for the size warning)
  // One picture or sound's bytes, or null when it unpacks to more than `cap` bytes. (`cap` is what is left of the budget of one getMany call.)
  const unpackMedia = (bytes, cap = MAX_UNPACKED) => {
    if (!newFormat) return bytes.length > cap ? null : bytes;
    try { return unzstd(zstd, bytes, cap); } catch (err) { if (err?.code === 'too-big') return null; throw err; }
  };
  result.media = {
    has: name => members.has(name),
    // { size, type } of a picture or sound without unpacking it, or null when the file isn't in the package.
    info(name) {
      const member = members.get(name);
      if (member === undefined) return null;
      return { size: sizes.get(name) ?? entrySizes.get(member) ?? 0, type: fileType(name) };
    },
    // Several files at once, in one pass over the zip (it is searched once for the whole batch, not once for each file):
    // a Map name → { data, type } of the ones found. Ask for a few dozen at a time, so they don't all sit in memory together.
    // One call unpacks at most MAX_UNPACKED bytes in all (a running total, so a batch of big files cannot add up to gigabytes). Names left
    // for the next call because the budget ran out are in the result's `deferred` list: ask for those again. A file that alone is over the
    // cap is not found (and not deferred), as in get().
    async getMany(names) {
      const wanted = new Map();                    // zip member → names that use it
      for (const name of names) { const m = members.get(name); if (m !== undefined) wanted.set(m, [...(wanted.get(m) || []), name]); }
      const later = new Set();                     // members that did not fit in this call's budget
      let used = 0;
      const got = wanted.size ? unzipSync(zip, {
        filter: f => {
          if (!wanted.has(f.name) || f.originalSize > MAX_UNPACKED) return false;
          if (used + f.originalSize > MAX_UNPACKED) { later.add(f.name); return false; }
          used += f.originalSize;
          return true;
        }
      }) : {};
      const out = new Map();
      out.deferred = [];
      let unpacked = 0;                            // zstd output so far (the zip's own sizes are of the packed files)
      for (const [member, list] of wanted) {
        if (later.has(member)) { out.deferred.push(...list); continue; }
        if (!got[member]) continue;
        const data = unpackMedia(got[member], MAX_UNPACKED - unpacked);
        if (!data) { if (unpacked > 0) out.deferred.push(...list); continue; }      // (past the budget with others already unpacked: next call; alone it is just too big)
        if (newFormat) unpacked += data.length;
        for (const name of list) out.set(name, { data, type: fileType(name) });
      }
      return out;
    },
    // A picture's or sound's bytes and type, or null.
    async get(name) {
      const member = members.get(name);
      if (member === undefined) return null;
      const got = unzipSync(zip, { filter: f => f.name === member && f.originalSize <= MAX_UNPACKED })[member];
      if (!got) return null;
      const data = unpackMedia(got);
      return data ? { data, type: fileType(name) } : null;
    }
  };
  return result;
}

// The sound types the app keeps (by file name), or null: mp3, m4a/mp4/aac, ogg/opus, webm, wav and flac. Anki writes names
// in any case, and a file with another ending (like .wma or .amr) is a sound the app can't keep.
export const audioType = name => ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', wav: 'audio/wav', flac: 'audio/flac' })[String(name).split('.').pop().toLowerCase()] || null;
const fileType = name => audioType(name) || imageType(name);
const imageType = name => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' })[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

// sql.js isn't an ES module, so it can't be imported like the other libraries (and so the import map in index.html can't check it).
// Both of its files are fetched with their SHA-384 fingerprint, which the browser checks (a different file is refused), the script is
// run from a blob and the checked .wasm bytes are handed straight to it: the same way as the pdf.js worker (js/doc-import.js).
// Nothing the CDN could swap is ever run. The fingerprints are of the 1.12.0 files; version in SQLJS_BASE: tests/anki-cap.test.js pins the version and both fingerprints together. (Also used to make Anki files: export.js.)
export const NO_WASM_MESSAGE = 'Anki files need iOS 16 or newer (or use a computer).';
export const SQLJS_JS_INTEGRITY = 'sha384-1fHJox8K973mCCD3PTAOc0ljrAGXD2VeK8zf+vNIdx55pWPULNlpxKMkU8bF4nUd';
export const SQLJS_WASM_INTEGRITY = 'sha384-R/MwdqDq6/VfWyY+p8u2RAFr+3gVOgzxeJqDeDxCnpQaVqOc9tEFLu4wdQfoDpb5';
let sqlPromise = null;
export function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const get = async (file, integrity) => {
        const res = await fetch(SQLJS_BASE + file, { integrity, mode: 'cors' });
        if (!res.ok) throw new Error('Could not load sql.js');
        return res.arrayBuffer();
      };
      const [js, wasm] = await Promise.all([get('sql-wasm.js', SQLJS_JS_INTEGRITY), get('sql-wasm.wasm', SQLJS_WASM_INTEGRITY)]);
      const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = url;
          s.onload = resolve;
          s.onerror = () => reject(new Error('Could not load sql.js'));
          document.head.append(s);
        });
      } finally { URL.revokeObjectURL(url); }
      // iOS 15 and older do not know the policy's 'wasm-unsafe-eval' and refuse to run WebAssembly: say so instead of a generic error.
      try {
        if (typeof WebAssembly === 'undefined') throw new Error('no WebAssembly');
        return await window.initSqlJs({ wasmBinary: wasm });
      } catch (err) {
        if (!(typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.CompileError) && !/WebAssembly|wasm|CSP|Content Security|unsafe-eval|EvalError/i.test(String(err?.message))) throw err;      // (only the "this phone cannot run WebAssembly" failures)
        throw Object.assign(new Error(NO_WASM_MESSAGE), { code: 'no-wasm', cause: err });
      }
    })().catch(err => { sqlPromise = null; throw err; });     // let a later try (e.g. back online) start again
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
      models.set(String(id), { name, fields: [], templates: [], cloze: !!config && config[0] === 8 && config[1] === 1 });
    }
    for (const [ntid, , name] of q('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord')) models.get(String(ntid))?.fields.push(name);
    // The card types: what each one asks (its front template). Cards that ask with the Back field are reverse cards.
    if (tables.has('templates')) for (const [ntid, ord, config] of q('SELECT ntid, ord, config FROM templates ORDER BY ntid, ord')) models.get(String(ntid))?.templates.push({ ord, ...templateFormats(config) });
    for (const [id, name] of q('SELECT id, name FROM decks')) deckNames.set(String(id), String(name).split('\x1f').join('::'));
  } else {
    const [[modelsJson, decksJson] = []] = q('SELECT models, decks FROM col');
    for (const [id, m] of Object.entries(JSON.parse(modelsJson || '{}'))) {
      models.set(String(id), { name: m.name, fields: [...m.flds].sort((a, b) => a.ord - b.ord).map(f => f.name), cloze: m.type === 1,
        templates: [...(m.tmpls || [])].sort((a, b) => a.ord - b.ord).map(t => ({ ord: t.ord, qfmt: String(t.qfmt ?? ''), afmt: String(t.afmt ?? '') })) });
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
  //   id = when (ms), ease = button (1 Again … 4 Easy, 0 = changed by hand), ivl = the new gap (days; negative = seconds),
  //   time = ms taken, type = 0 learning, 1 review, 2 relearning, 3 filtered deck (cram), 4 manual change, 5 rescheduled,
  //   factor = the card's ease in permille after the answer (0 for a cram review and for "Forget": see replayHistory in anki.js)
  const reviews = new Map();
  if (tables.has('revlog')) {
    for (const [id, cid, ease, ivl, time, type, factor] of q('SELECT id, cid, ease, ivl, time, type, factor FROM revlog ORDER BY id')) {
      const key = String(cid);
      if (!reviews.has(key)) reviews.set(key, []);
      reviews.get(key).push({ timestamp: id, ease, ivl, ms: time, type, factor });
    }
  }

  const notes = q('SELECT id, guid, mid, flds, tags FROM notes ORDER BY id').map(([id, guid, mid, flds, tags]) => ({
    id: String(id), guid: String(guid || ''),
    mid: String(mid),
    fields: String(flds).split('\x1f'),
    tags: String(tags || '').trim().split(/\s+/).filter(Boolean),
    deck: deckNames.get(String(deckOfNote.get(id))) || '',
    cards: cardsOfNote.get(id) || {}
  }));
  return { notes, models, reviews };
}
