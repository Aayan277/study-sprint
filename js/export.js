// Exporting a deck, so your cards are never stuck in Study Sprint:
//   CSV         a spreadsheet file (Excel, Google Sheets, Numbers, Quizlet, or back into Study Sprint)
//   Anki deck   an .apkg file that Anki (desktop, AnkiDroid, AnkiMobile) can import
// The pure parts (CSV text, the Anki deck's contents) are tested by tests/export.test.js.
// makeApkg() packs the Anki file in the browser, with the same libraries the Anki import uses.

import { formatHTML, plainText } from './format.js';

// ---------- CSV ----------
// One row per card: front, back, tags. Cells with commas, quotes or line breaks are quoted.
// Cards from more than one deck (a deck with subdecks; each card has deckName) get a Deck column too.
const cell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCSV(cards) {
  const several = new Set(cards.map(c => c.deckName)).size > 1;
  const rows = [['Front', 'Back', 'Tags', ...(several ? ['Deck'] : [])],
    ...cards.map(c => [c.front, c.back, (c.tags || []).join(' '), ...(several ? [c.deckName] : [])])];
  // The invisible mark at the start (a "BOM") tells Excel the file is UTF-8, so accents and emoji survive.
  return '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// A safe file name from a deck name: "Cell Biology / Unit 2" → "Cell Biology - Unit 2".
export const fileName = (name, ext) => `${String(name || 'deck').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'deck'}.${ext}`;

// ---------- Anki ----------
// Card text → Anki's HTML: special characters escaped, line breaks as <br>, and bold, italics and lists
// as real formatting (format.js).
export const toAnkiHTML = text => formatHTML(text);

// Anki's duplicate check: the first 8 hex digits of the SHA-1 of the first field (as plain text), as a number.
export async function ankiChecksum(text) {
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return parseInt([...new Uint8Array(hash).slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(''), 16);
}

// A note's guid: a stable id from the card's id, so exporting the same deck again updates the cards in
// Anki instead of making duplicates.
export function ankiGuid(cardId) {
  let h = 0x811c9dc5, out = '';
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  for (let round = 0; round < 2; round++) {
    for (const ch of `${round}:${cardId}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    let n = h;
    for (let i = 0; i < 5; i++) { out += chars[n % chars.length]; n = Math.floor(n / chars.length); }
  }
  return out;
}

const BASIC_ID = 1_600_000_000_001;   // the note type's id (fixed, so re-exports reuse it in Anki)
const ANKI_CSS = '.card {\n  font-family: arial;\n  font-size: 20px;\n  text-align: center;\n  color: black;\n  background-color: white;\n}\n';

// Everything that goes in the Anki database, as plain values (no database yet).
//   deck   { id, name }    cards  [{ id, front, back, tags, frontImageFile?, backImageFile?, deckName? }]    now  ms
// deckName (e.g. "Psych 101::Unit 1") puts a card in that Anki deck (subdecks); otherwise it's deck.name.
// Returns { col, notes, cards } rows for the tables of Anki's older (and widely supported) file layout.
export async function ankiContents(deck, cards, now = Date.now()) {
  const secs = Math.floor(now / 1000);
  // One Anki deck per name, plus the parents of subdecks ("A::B" needs "A"). Ids: any unique numbers other
  // than 1 (Anki's Default deck).
  const names = [];
  for (const c of cards) {
    const parts = (c.deckName || deck.name).split('::');
    parts.forEach((_, i) => { const n = parts.slice(0, i + 1).join('::'); if (!names.includes(n)) names.push(n); });
  }
  if (!names.length) names.push(deck.name);
  const deckIds = new Map(names.map((n, i) => [n, now + i]));
  const deckId = deckIds.get(deck.name) ?? now;
  const model = {
    id: BASIC_ID, name: 'Study Sprint Basic', type: 0, mod: secs, usn: -1, sortf: 0, did: deckId,
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}', did: null, bqfmt: '', bafmt: '' }],
    flds: ['Front', 'Back'].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: ANKI_CSS, latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}', tags: [], vers: [], req: [[0, 'any', [0]]]
  };
  const deckRow = (id, name) => ({ id, name, desc: '', mod: secs, usn: -1, collapsed: false, browserCollapsed: false, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0], dyn: 0, conf: 1, extendNew: 10, extendRev: 50 });
  const dconf = { 1: { id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, perDay: 20, bury: false },
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 } } };
  const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: String(BASIC_ID), nextPos: cards.length + 1, sortType: 'noteFld', sortBackwards: false };
  const col = {
    id: 1, crt: secs - (secs % 86400), mod: now, scm: now, ver: 11, dty: 0, usn: 0, ls: 0,
    conf: JSON.stringify(conf), models: JSON.stringify({ [BASIC_ID]: model }),
    decks: JSON.stringify(Object.fromEntries([[1, deckRow(1, 'Default')], ...names.map(n => [deckIds.get(n), deckRow(deckIds.get(n), n)])])),
    dconf: JSON.stringify(dconf), tags: '{}'
  };
  const notes = [], ankiCards = [];
  for (const [i, c] of cards.entries()) {
    // A side's picture (if any) goes after its text, as <img src="file name"> (the file is in the package).
    const withPic = (html, file) => (file ? `${html}${html ? '<br>' : ''}<img src="${file}">` : html);
    const front = withPic(toAnkiHTML(c.front), c.frontImageFile), back = withPic(toAnkiHTML(c.back), c.backImageFile);
    const noteId = now + i, cardId = now + cards.length + i;
    notes.push({ id: noteId, guid: ankiGuid(c.id), mid: BASIC_ID, mod: secs, usn: -1,
      tags: (c.tags || []).length ? ` ${c.tags.map(t => t.replace(/\s+/g, '_')).join(' ')} ` : '',
      flds: `${front}\x1f${back}`, sfld: plainText(c.front), csum: await ankiChecksum(plainText(c.front)), flags: 0, data: '' });
    // New cards, in the deck's order.
    ankiCards.push({ id: cardId, nid: noteId, did: deckIds.get(c.deckName || deck.name), ord: 0, mod: secs, usn: -1, type: 0, queue: 0, due: i + 1,
      ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' });
  }
  return { col, notes, cards: ankiCards };
}

// Anki's tables (the older "schema 11" layout, which every Anki version can import).
export const ANKI_SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);`;

// Build the .apkg file: a zip with the database, the pictures (files "0", "1", …) and the list saying which
// is which ("media": {"0": "abc.jpg"}). Browser only.
export async function makeApkg(deck, cards) {
  const { getMedia } = await import('./db.js');
  const files = {}, names = {};
  const fileFor = async id => {
    if (!id) return null;
    const m = await getMedia(id);
    if (!m) return null;
    const name = `${id}.${m.type === 'image/png' ? 'png' : m.type === 'image/gif' ? 'gif' : m.type === 'image/webp' ? 'webp' : 'jpg'}`;
    if (!Object.values(names).includes(name)) {
      const n = String(Object.keys(names).length);
      names[n] = name;
      files[n] = new Uint8Array(m.data);
    }
    return name;
  };
  const withFiles = [];
  for (const c of cards) withFiles.push({ ...c, frontImageFile: await fileFor(c.frontImage), backImageFile: await fileFor(c.backImage) });
  const [{ loadSqlJs, FFLATE_URL }, contents] = await Promise.all([import('./anki-read.js'), ankiContents(deck, withFiles)]);
  const [SQL, { zipSync }] = await Promise.all([loadSqlJs(), import(FFLATE_URL)]);
  const db = new SQL.Database();
  try {
    db.exec(ANKI_SCHEMA);
    const insert = (table, row) => {
      const keys = Object.keys(row);
      db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
    };
    insert('col', contents.col);
    contents.notes.forEach(n => insert('notes', n));
    contents.cards.forEach(c => insert('cards', c));
    const bytes = db.export();
    return new Blob([zipSync({ 'collection.anki2': bytes, media: new TextEncoder().encode(JSON.stringify(names)), ...files })], { type: 'application/octet-stream' });
  } finally {
    db.close();
  }
}

// Save a file to the device (Downloads on a computer; the share/save sheet on a phone).
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
