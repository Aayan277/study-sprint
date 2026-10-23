// Exporting a deck, so your cards are never stuck in Study Sprint:
//   CSV         a spreadsheet file (Excel, Google Sheets, Numbers, Quizlet, or back into Study Sprint)
//   Anki deck   an .apkg file that Anki (desktop, AnkiDroid, AnkiMobile) can import
// The pure parts (CSV text, the Anki deck's contents) are tested by tests/export.test.js.
// makeApkg() packs the Anki file in the browser, with the same libraries the Anki import uses.

import { formatHTML, plainText } from './format.js';
import { hasBlank, clozeCard } from './cloze.js';
import { isOcclusion, hasMasks, ankiOcclusionText, groupsOf, occLabel } from './occlusion.js';
import { isPair } from './reverse.js';
import { toDetails } from './note-fields.js';
import { ancestors, effectiveDeck } from './deck-tree.js';
import { isTypingCard } from './type-in.js';

// ---------- CSV ----------
// One row per card: front, back, tags. Cells with commas, quotes or line breaks are quoted.
// Cards from more than one deck (a deck with subdecks; each card has deckName) get a Deck column too.
// A card with its reverse card (see reverse.js) is one row, the forward card, and a "Both directions" column says "yes" for it:
// import makes the reverse card again. (Only added when some card has one.)
// A cloze card is a row of its own (see clozeRowOf below). Image occlusion cards go out as plain cards.
// A cell that starts with = + - @ (or a tab or line break) would be run as a formula by Excel or Sheets, so it gets a ' in front. Import takes it off again.
const cell = v => {
  let s = String(v ?? '');
  if (/^'*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// The notes whose cards are a full pair here: noteId → true. (A reverse card whose forward card isn't in the list goes out as an ordinary card.)
const fullPairs = cards => {
  const f = new Set(cards.filter(c => isPair(c) && !c.reverse).map(c => c.noteId));
  return new Set(cards.filter(c => isPair(c) && c.reverse && f.has(c.noteId)).map(c => c.noteId));
};
// A cloze card goes out as its own readable row: Front with the blank shown as […], Back with the answer. That is what a
// spreadsheet or Quizlet can use. A "Cloze note" column holds the note's full {{c1::…}} text, so Study Sprint can put the rows
// of one note back together (import.js). Only the blanks that still have a card are written: a card you deleted stays deleted.
// A "Cloze extra" column (only when some note has an extra line) holds the note's extra line.
const clozeRowOf = c => (hasBlank(c) ? { ...c, ...clozeCard(c.noteText, c.cloze), isCloze: true } : c);
// The rows of the file, header first, as lists of cells. csvRows(cards).length - 1 is what the file holds.
export function csvRows(cards) {
  cards = cards.map(clozeRowOf);
  const pairs = fullPairs(cards);
  cards = cards.filter(c => !(isPair(c) && c.reverse && pairs.has(c.noteId)));
  const several = new Set(cards.map(c => c.deckName)).size > 1;
  const both = c => isPair(c) && !c.reverse && pairs.has(c.noteId);
  const anyBoth = cards.some(both);
  const anyCloze = cards.some(c => c.isCloze), anyExtra = cards.some(c => c.isCloze && c.noteExtra);
  return [['Front', 'Back', 'Tags', ...(several ? ['Deck'] : []), ...(anyBoth ? ['Both directions'] : []), ...(anyCloze ? ['Cloze note'] : []), ...(anyExtra ? ['Cloze extra'] : [])],
    ...cards.map(c => [c.front, c.back, (c.tags || []).join(', '), ...(several ? [c.deckName] : []), ...(anyBoth ? [both(c) ? 'yes' : ''] : []),
      ...(anyCloze ? [c.isCloze ? c.noteText : ''] : []), ...(anyExtra ? [c.isCloze ? c.noteExtra || '' : ''] : [])])];
}
export const csvRowCount = cards => csvRows(cards).length - 1;
export function toCSV(cards) {
  // The invisible mark at the start (a "BOM") tells Excel the file is UTF-8, so accents and emoji survive.
  return '\uFEFF' + csvRows(cards).map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// A safe file name from a deck name: "Cell Biology / Unit 2" → "Cell Biology - Unit 2".
export const fileName = (name, ext) => {
  // Control characters out, at most 80 characters (counted as whole characters, so an emoji is never cut in half), no dots or spaces at the ends.
  const base = Array.from(String(name || 'deck').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ')).slice(0, 80).join('').replace(/^[.\s]+|[.\s]+$/g, '');
  return `${base || 'deck'}.${ext}`;
};

// A deck's cards ready to export or share: each with its deck named from the exported deck down ("Unit 1::Lecture 3"), oldest first.
export function cardsForExport(deck, decks, deckCards) {
  const nameOf = id => { const chain = ancestors(decks, id); return chain.slice(0, chain.findIndex(d => d.id === deck.id) + 1).reverse().map(d => d.name).join('::'); };
  // typed: Review types this card's answer (its own setting or its deck's). Anki has no deck default, so the effective value is written
  // on each card: it comes back in Study Sprint as a card of its own (see ankiContents, anki.js typedOrds).
  const typesByDeck = new Map();
  const dflt = id => { if (!typesByDeck.has(id)) typesByDeck.set(id, !!effectiveDeck(decks, id)?.typeAnswers); return typesByDeck.get(id); };
  return deckCards.map(c => ({ ...c, deckName: nameOf(c.deckId), typed: isTypingCard(c, dflt(c.deckId)) })).sort((a, b) => a.created - b.created);
}

// ---------- Anki ----------
// Card text → Anki's HTML: special characters escaped, line breaks as <br>, and bold, italics and lists
// as real formatting (format.js). Formulas become \( ... \) and \[ ... \], which Anki draws.
export const toAnkiHTML = text => formatHTML(text, { math: 'anki' });

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
const CLOZE_ID = 1_600_000_000_002;   // the Cloze note type
const IO_ID = 1_600_000_000_003;      // the Image Occlusion note type
const BASIC_REV_ID = 1_600_000_000_004;   // Basic (and reversed card): a card with its reverse card is one note with two cards
const BASIC_TYPE_ID = 1_600_000_000_005;  // Basic (type in the answer): the question side has a box to type the Back
const CLOZE_TYPE_ID = 1_600_000_000_006;  // Cloze (type in the answer)
const REV_TYPE_IDS = { '10': 1_600_000_000_007, '01': 1_600_000_000_008, '11': 1_600_000_000_009 };      // reversed card with card 1 / card 2 / both typed
const ANKI_CSS = '.card {\n  font-family: arial;\n  font-size: 20px;\n  text-align: center;\n  color: black;\n  background-color: white;\n}\n';

// Anki's own Image Occlusion note type (rslib/src/image_occlusion/notetype.rs, Anki 23.10+): a cloze type whose
// Occlusion field holds the boxes. Its card template draws the picture and the boxes with Anki's own script, so these
// texts are copied from Anki as they are (including the English names of the fields and the button).
const IO_FIELDS = ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'];
const IO_QFMT = `{{#Header}}<div>{{Header}}</div>{{/Header}}
<div style="display: none">{{cloze:Occlusion}}</div>
<div id="err"></div>
<div id="image-occlusion-container">
    {{Image}}
    <canvas id="image-occlusion-canvas"></canvas>
</div>
<script>
try {
    anki.imageOcclusion.setup();
} catch (exc) {
    document.getElementById("err").innerHTML = \`Error loading image occlusion. Is your Anki version up to date?<br><br>\${exc}\`;
}
</script>
`;
const IO_AFMT = `${IO_QFMT}
<div><button id="toggle">Toggle Masks</button></div>
{{#Back Extra}}<div>{{Back Extra}}</div>{{/Back Extra}}
`;
const IO_CSS = `#image-occlusion-canvas {
    --inactive-shape-color: #ffeba2;
    --active-shape-color: #ff8e8e;
    --inactive-shape-border: 1px #212121;
    --active-shape-border: 1px #212121;
    --highlight-shape-color: #ff8e8e00;
    --highlight-shape-border: 1px #ff8e8e;
}

.card {
    font-family: arial;
    font-size: 20px;
    text-align: center;
    color: black;
    background-color: white;
}
`;

// Everything that goes in the Anki database, as plain values (no database yet).
//   deck   { id, name }    cards  [{ id, front, back, tags, frontImageFile?, backImageFile?, frontSoundFiles?, backSoundFiles?, deckName? }]    now  ms
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
  // Cards that are blanks of one cloze note go out as one Anki Cloze note (a card for each blank number); the
  // rest are Basic notes, one each.
  // Cards of one image-occlusion picture likewise go out as one Anki Image Occlusion note.
  // A card and its reverse card (reverse.js) go out as one "Basic (and reversed card)" note with two cards.
  let groups = [];                       // [{ cloze: true, cards } | { occ: true, cards } | { pair: true, cards } | { cloze: false, card }]
  const byNote = new Map();
  const pairs = fullPairs(cards);
  for (const c of cards) {
    const kind = hasBlank(c) ? 'cloze' : isOcclusion(c) && hasMasks(c) ? 'occ' : isPair(c) && pairs.has(c.noteId) ? 'pair' : null;
    if (kind) {
      const key = kind + ':' + c.noteId;
      if (!byNote.has(key)) { byNote.set(key, { cloze: kind === 'cloze', occ: kind === 'occ', pair: kind === 'pair', cards: [] }); groups.push(byNote.get(key)); }
      byNote.get(key).cards.push(c);
    } else groups.push({ cloze: false, card: c });
  }
  // An occlusion note needs its picture file in the package (else it goes out as Basic cards, as does a card whose
  // group isn't among the boxes of the note's first card).
  for (const g of groups.filter(x => x.occ)) {
    const ok = g.cards.some(c => c.backImageFile) ? groupsOf(g.cards[0].occlusion.masks) : [];
    const lost = g.cards.filter(c => !ok.includes(c.occlusion.n));
    if (!lost.length) continue;
    g.cards = g.cards.filter(c => ok.includes(c.occlusion.n));
    groups.push(...lost.map(card => ({ cloze: false, card: { ...card, typed: false } })));
  }
  groups = groups.filter(g => !g.occ || g.cards.length);
  const usesCloze = groups.some(g => g.cloze && !g.cards.some(c => c.typed));      // (a note with a typed card uses the typed Cloze type instead)
  // Anki's own Cloze note type (type 1): the Text field has the blanks, "{{cloze:Text}}" shows one at a time.
  const clozeModel = {
    ...model, id: CLOZE_ID, name: 'Study Sprint Cloze', type: 1, sortf: 0,
    tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}', did: null, bqfmt: '', bafmt: '' }],
    flds: ['Text', 'Back Extra'].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: `${ANKI_CSS}\n.cloze {\n  font-weight: bold;\n  color: blue;\n}\n.nightMode .cloze {\n  color: lightblue;\n}\n`, req: [[0, 'any', [0]]]
  };
  // "Basic (and reversed card)": card 1 asks Front, card 2 asks Back. The question is only that field; the memory hook, the other
  // fields (as <details> sections) and the back's sounds are in a third field, Back Extra, shown on the answer side of both cards.
  const revModel = {
    ...model, id: BASIC_REV_ID, name: 'Study Sprint Basic (and reversed card)',
    tmpls: [
      { name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}<br>\n{{Back Extra}}', did: null, bqfmt: '', bafmt: '' },
      { name: 'Card 2', ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}<br>\n{{Back Extra}}', did: null, bqfmt: '', bafmt: '' }],
    flds: ['Front', 'Back', 'Back Extra'].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    req: [[0, 'any', [0]], [1, 'any', [1]]]
  };
  // Typing cards (type-in.js): the question side has a {{type:…}} box. In a Basic type the Back field holds only the answer (the back's picture,
  // sounds, hook and other fields are in Back Extra), or Anki would ask for all of it to be typed.
  const typedQ = (shown, typed) => `{{${shown}}}\n\n{{type:${typed}}}`;
  const typedA = (shown, typed) => `{{${shown}}}\n\n<hr id=answer>\n\n{{type:${typed}}}<br>\n{{Back Extra}}`;
  const extraField = name => ({ name, ord: 2, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] });
  const typeModel = {
    ...model, id: BASIC_TYPE_ID, name: 'Study Sprint Basic (type in the answer)',
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: typedQ('Front', 'Back'), afmt: typedA('Front', 'Back'), did: null, bqfmt: '', bafmt: '' }],
    flds: [...model.flds, extraField('Back Extra')]
  };
  const typeClozeModel = {
    ...clozeModel, id: CLOZE_TYPE_ID, name: 'Study Sprint Cloze (type in the answer)',
    tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}\n\n{{type:cloze:Text}}', afmt: '{{cloze:Text}}\n\n{{type:cloze:Text}}<br>\n{{Back Extra}}', did: null, bqfmt: '', bafmt: '' }]
  };
  // A reversed card with card 1 and/or card 2 typed: the typed card's box is the field it answers with (card 1: Back; card 2: Front).
  const revTypeModel = key => ({
    ...revModel, id: REV_TYPE_IDS[key], name: `Study Sprint Basic (and reversed card, type in the answer on ${key === '10' ? 'card 1' : key === '01' ? 'card 2' : 'both cards'})`,
    tmpls: [key[0] === '1' ? { ...revModel.tmpls[0], qfmt: typedQ('Front', 'Back'), afmt: typedA('Front', 'Back') } : revModel.tmpls[0],
      key[1] === '1' ? { ...revModel.tmpls[1], qfmt: typedQ('Back', 'Front'), afmt: typedA('Back', 'Front') } : revModel.tmpls[1]]
  });
  const pairKey = g => `${g.cards.find(x => !x.reverse)?.typed ? 1 : 0}${g.cards.find(x => x.reverse)?.typed ? 1 : 0}`;
  const usedRevKeys = [...new Set(groups.filter(g => g.pair).map(pairKey))];
  const usesRev = usedRevKeys.includes('00');
  const usesTypedBasic = groups.some(g => !g.cloze && !g.occ && !g.pair && g.card.typed);
  const usesTypedCloze = groups.some(g => g.cloze && g.cards.some(c => c.typed));
  const usesOcc = groups.some(g => g.occ);
  // Anki's Image Occlusion type (a cloze type, "original stock kind" 6). Sorted by Header, which is also what sfld holds.
  const occModel = {
    ...model, id: IO_ID, name: 'Study Sprint Image Occlusion', type: 1, originalStockKind: 6, sortf: 2,
    tmpls: [{ name: 'Image Occlusion', ord: 0, qfmt: IO_QFMT, afmt: IO_AFMT, did: null, bqfmt: '', bafmt: '' }],
    flds: IO_FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [], tag: ord, preventDeletion: ord < 4 })),
    css: IO_CSS, req: [[0, 'any', [0]]]
  };
  const deckRow = (id, name) => ({ id, name, desc: '', mod: secs, usn: -1, collapsed: false, browserCollapsed: false, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0], dyn: 0, conf: 1, extendNew: 10, extendRev: 50 });
  const dconf = { 1: { id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, perDay: 20, bury: false },
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 } } };
  const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: String(BASIC_ID), nextPos: cards.length + 1, sortType: 'noteFld', sortBackwards: false };
  const col = {
    id: 1, crt: secs - (secs % 86400), mod: now, scm: now, ver: 11, dty: 0, usn: 0, ls: 0,
    conf: JSON.stringify(conf), models: JSON.stringify({ [BASIC_ID]: model, ...(usesRev ? { [BASIC_REV_ID]: revModel } : {}), ...(usesCloze ? { [CLOZE_ID]: clozeModel } : {}), ...(usesOcc ? { [IO_ID]: occModel } : {}),
      ...(usesTypedBasic ? { [BASIC_TYPE_ID]: typeModel } : {}), ...(usesTypedCloze ? { [CLOZE_TYPE_ID]: typeClozeModel } : {}),
      ...Object.fromEntries(usedRevKeys.filter(k => k !== '00').map(k => [REV_TYPE_IDS[k], revTypeModel(k)])) }),
    decks: JSON.stringify(Object.fromEntries([[1, deckRow(1, 'Default')], ...names.map(n => [deckIds.get(n), deckRow(deckIds.get(n), n)])])),
    dconf: JSON.stringify(dconf), tags: '{}'
  };
  // A side's picture (if any) goes after its text, as <img src="file name"> (the file is in the package).
  const withPic = (html, file) => (file ? `${html}${html ? '<br>' : ''}<img src="${file}">` : html);
  // Its sounds go last in the field, as [sound:file name] (Anki's own way; importing the file here gives them back).
  const withSounds = (html, files) => `${html}${(files || []).map(f => `[sound:${f}]`).join('')}`;
  // The note's other fields (item A) go last, as folded sections Anki shows closed.
  const fieldsHTML = c => toDetails(c.noteFields, toAnkiHTML);
  const tagsOf = c => ((c.tags || []).length ? ` ${c.tags.map(t => t.replace(/\s+/g, '_')).join(' ')} ` : '');
  const notes = [], ankiCards = [];
  let cardCount = 0;
  // Every note needs a guid of its own, or Anki drops the cards of the notes that repeat one. The several cards an Anki note type with several
  // card templates made here (templateOrd, one noteId) all carry the Anki note's guid, but go out as notes of their own: only the one with the
  // lowest templateOrd keeps it, and the others get a guid made from their own card id.
  const lowest = new Map();          // noteId → the lowest templateOrd among its sibling cards
  for (const c of cards) if (c.noteId && Number.isInteger(c.templateOrd)) lowest.set(c.noteId, Math.min(lowest.get(c.noteId) ?? Infinity, c.templateOrd));
  const keepsGuid = c => !(c.noteId && Number.isInteger(c.templateOrd)) || lowest.get(c.noteId) === c.templateOrd;
  const usedGuids = new Set();
  for (const [i, g] of groups.entries()) {
    const noteId = now + i;
    const first = g.cards ? g.cards[0] : g.card;
    let note;
    if (g.occ) {
      // Occlusion = the boxes, Image = the picture (its file is in the package), Comments = the labels, numbered.
      const { masks, header } = first.occlusion;
      const labels = groupsOf(masks).map((n, k) => [k + 1, occLabel(masks, n)]).filter(([, l]) => l).map(([k, l]) => `${k}. ${toAnkiHTML(l)}`).join('<br>');
      const file = g.cards.find(c => c.backImageFile)?.backImageFile;
      const sort = String(header || '').trim() || 'Image occlusion';
      note = { id: noteId, guid: first.ankiGuid || ankiGuid(first.noteId), mid: IO_ID, mod: secs, usn: -1, tags: tagsOf(first),
        flds: [ankiOcclusionText(masks), file ? `<img src="${file}">` : '', toAnkiHTML(header || ''), toAnkiHTML(first.noteExtra || ''), labels].join('\x1f'),
        sfld: sort, csum: await ankiChecksum(sort), flags: 0, data: '' };
      // Group n is Anki card number n - 1.
      for (const c of g.cards.slice().sort((a, b) => a.occlusion.n - b.occlusion.n)) {
        ankiCards.push({ id: now + groups.length + cardCount++, nid: noteId, did: deckIds.get(c.deckName || deck.name), ord: c.occlusion.n - 1, mod: secs, usn: -1, type: 0, queue: 0, due: cardCount,
          ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' });
      }
    } else if (g.cloze) {
      const text = withSounds(withPic(toAnkiHTML(first.noteText), g.cards.find(c => c.frontImageFile)?.frontImageFile), g.cards.find(c => c.frontSoundFiles?.length)?.frontSoundFiles);
      const extra = withSounds(withPic(toAnkiHTML(first.noteExtra || ''), g.cards.find(c => c.backImageFile)?.backImageFile) + fieldsHTML(first), g.cards.find(c => c.backSoundFiles?.length)?.backSoundFiles);
      note = { id: noteId, guid: first.ankiGuid || ankiGuid(first.noteId), mid: g.cards.some(c => c.typed) ? CLOZE_TYPE_ID : CLOZE_ID, mod: secs, usn: -1, tags: tagsOf(first),
        flds: `${text}\x1f${extra}`, sfld: plainText(first.noteText), csum: await ankiChecksum(plainText(first.noteText)), flags: 0, data: '' };
      // Blank number n is Anki card number n - 1.
      for (const c of g.cards.slice().sort((a, b) => a.cloze - b.cloze)) {
        ankiCards.push({ id: now + groups.length + cardCount++, nid: noteId, did: deckIds.get(c.deckName || deck.name), ord: c.cloze - 1, mod: secs, usn: -1, type: 0, queue: 0, due: cardCount,
          ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' });
      }
    } else {
      // A card with its reverse card is one note with two cards (the forward card's sides are the note's two fields).
      const c = g.pair ? g.cards.find(x => !x.reverse) : g.card;
      const front = withSounds(withPic(toAnkiHTML(c.front), c.frontImageFile), c.frontSoundFiles);
      let back = withPic(toAnkiHTML(c.back), c.backImageFile);
      let flds;
      if (!g.pair && c.typed) {
        // A typing card: Back is only the answer; its picture, hook, other fields and sounds go in Back Extra (shown with the answer).
        const hook = c.noteExtra && String(c.noteExtra).trim() ? toAnkiHTML(c.noteExtra) : '';
        flds = `${front}\x1f${toAnkiHTML(c.back)}\x1f${withSounds(withPic(hook, c.backImageFile) + fieldsHTML(c), c.backSoundFiles)}`;
      } else if (g.pair) {
        // The hook, the other fields and the back's sounds go in Back Extra, so the reverse card's question is the Back field alone.
        const hook = c.noteExtra && String(c.noteExtra).trim() ? toAnkiHTML(c.noteExtra) : '';
        flds = `${front}\x1f${back}\x1f${withSounds(hook + fieldsHTML(c), c.backSoundFiles)}`;
      } else {
        // The memory hook (noteExtra) goes at the end of Back as an Extra line, then the other fields.
        if (c.noteExtra && String(c.noteExtra).trim()) back += `${back ? '<br><br>' : ''}${toAnkiHTML(c.noteExtra)}`;
        flds = `${front}\x1f${withSounds(back + fieldsHTML(c), c.backSoundFiles)}`;
      }
      note = { id: noteId, guid: (keepsGuid(c) && c.ankiGuid) || ankiGuid(g.pair ? c.noteId : c.id), mid: g.pair ? (pairKey(g) === '00' ? BASIC_REV_ID : REV_TYPE_IDS[pairKey(g)]) : c.typed ? BASIC_TYPE_ID : BASIC_ID, mod: secs, usn: -1, tags: tagsOf(c),
        flds, sfld: plainText(c.front), csum: await ankiChecksum(plainText(c.front)), flags: 0, data: '' };
      // New cards, in the deck's order. Card 1 is the forward card, card 2 the reverse one.
      for (const [ord, x] of (g.pair ? [c, g.cards.find(y => y.reverse)] : [c]).entries()) {
        ankiCards.push({ id: now + groups.length + cardCount++, nid: noteId, did: deckIds.get(x.deckName || deck.name), ord, mod: secs, usn: -1, type: 0, queue: 0, due: cardCount,
          ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, odue: 0, odid: 0, flags: 0, data: '' });
      }
    }
    for (let n = 0; usedGuids.has(note.guid); ) note.guid = ankiGuid(`${note.guid}:${++n}`);          // (never two notes with one guid)
    usedGuids.add(note.guid);
    notes.push(note);
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

// Build the .apkg file: a zip with the database, the pictures and sounds (files "0", "1", …) and the list saying which
// is which ("media": {"0": "abc.jpg"}). Browser only.
export async function makeApkg(deck, cards) {
  const { getMedia } = await import('./db.js');
  const { soundExt } = await import('./media.js');
  const files = {}, names = {};
  const fileFor = async id => {
    if (!id) return null;
    const m = await getMedia(id);
    if (!m) return null;
    const name = `${id}.${m.type.startsWith('audio/') ? soundExt(m.type) : m.type === 'image/png' ? 'png' : m.type === 'image/gif' ? 'gif' : m.type === 'image/webp' ? 'webp' : 'jpg'}`;
    if (!Object.values(names).includes(name)) {
      const n = String(Object.keys(names).length);
      names[n] = name;
      files[n] = new Uint8Array(m.data);
    }
    return name;
  };
  const withFiles = [];
  const soundFiles = async ids => (await Promise.all((ids || []).map(fileFor))).filter(Boolean);
  for (const c of cards) withFiles.push({ ...c, frontImageFile: await fileFor(c.frontImage), backImageFile: await fileFor(c.backImage), frontSoundFiles: await soundFiles(c.frontSounds), backSoundFiles: await soundFiles(c.backSounds) });
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
