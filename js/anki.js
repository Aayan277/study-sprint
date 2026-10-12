// Turning Anki notes into Study Sprint cards. Pure functions (no page, no files), tested by tests/anki.test.js.
// anki-read.js opens the .apkg file and hands its notes to notesToImport() below.
//
// How Anki stores things, in short:
//   note       one fact, with several fields (e.g. Front and Back), plus tags
//   note type  says which fields a note has. "Cloze" notes hide parts of one text: {{c1::answer::hint}}
//   deck       where the note's cards live. Subdecks are written "Parent::Child"
// Fields are HTML. Bold, italics and lists are kept (as format.js marks); other formatting, images and sounds
// are left out.

import { htmlToMarks } from './format.js';

// HTML → plain text, keeping line breaks (formatting dropped). Fields themselves keep their bold,
// italics and lists as marks: see htmlToMarks in format.js.
export const htmlToText = html => htmlToMarks(html, { marks: false });

export const hasImage = html => /<img\b/i.test(String(html ?? ''));

// The picture file names in a field, in order: <img src="brain.png"> → ['brain.png'].
export function imageNames(html) {
  return [...String(html ?? '').matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map(m => htmlToMarks(m[1] ?? m[2] ?? m[3], { marks: false }))
    .map(n => { try { return decodeURIComponent(n); } catch { return n; } })
    .filter(Boolean);
}

// The list of pictures in a newer Anki file (after unzipping and decompressing its "media" file). It's a
// small "protobuf" record: a list of entries, each with the picture's name (field 1) and, sometimes, the
// zip file it's stored in (field 255); otherwise entry number i is in zip file "i".
// Returns [{ name, zipName }].
export function mediaList(bytes) {
  const read = (buf, fields) => {
    let i = 0;
    const varint = () => { let n = 0, shift = 0, b; do { b = buf[i++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return n; };
    while (i < buf.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key & 7;
      if (wire === 0) fields(field, varint());
      else if (wire === 2) { const len = varint(); fields(field, buf.subarray(i, i + len)); i += len; }
      else if (wire === 5) i += 4;
      else if (wire === 1) i += 8;
      else break;
    }
  };
  const out = [];
  read(bytes, (field, value) => {
    if (field !== 1 || !(value instanceof Uint8Array)) return;
    const entry = { name: '', zipName: undefined };
    read(value, (f, v) => {
      if (f === 1) entry.name = new TextDecoder().decode(v);
      if (f === 255 && typeof v === 'number') entry.zipName = String(v);
    });
    out.push(entry);
  });
  return out;
}

// Cloze: which numbers does a text use? "{{c1::a}} {{c2::b}} {{c1::c}}" → [1, 2]
const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
export function clozeNumbers(text) {
  return [...new Set([...String(text).matchAll(CLOZE)].map(m => +m[1]))].sort((a, b) => a - b);
}

// One card for cloze number n: that cloze is hidden as […] (or [hint]) on the front, the others are shown,
// and the back is the hidden answer(s).
export function clozeCard(text, n) {
  const answers = [];
  const front = String(text).replace(CLOZE, (m, num, answer, hint) => {
    if (+num !== n) return answer;
    answers.push(answer);
    return hint ? `[${hint}]` : '[…]';
  });
  return { front, back: answers.join(', ') };
}

// Turn Anki notes into rows for the import preview.
//   notes   [{ mid, fields: [html, ...], tags: [...], deck: 'Parent::Child' }]
//   models  Map note type id → { name, fields: [field names], cloze: true/false }
// Returns the same shape as the other importers ({ columns, rows, format }), plus:
//   tags    tags for each row
//   decks   the Anki deck each row came from
//   images  how many notes had pictures
//   pictures  each row's picture names { front, back } (the first picture on each side; extraImages counts
//             notes with more than that, which are left out)
//   ankiIds   the Anki card each row came from, so its review history can come along
//   reviews   Map Anki card id → its review history, for the rows' cards that have one
//   occluded  for each row, true if it came from an image-occlusion note (see below)
//   progress  { cards, reviews }: how many rows have history, and how many reviews in all
// Rows are [front, back, any other fields]. Cloze notes give one row per cloze number, with their
// other fields (like Back Extra) after the back.
//
// Image-occlusion notes (a cloze note whose first field holds "image-occlusion:") hide parts of a picture. Study
// Sprint can't do that yet, so each one comes in as a plain picture card: the heading (or "Diagram") on the front,
// the picture on the back. Without this they became broken "[…]" cards.
export const isOcclusionNote = note => String(note.fields?.[0] ?? '').includes('image-occlusion:');
const fieldIndex = (model, name, fallback) => {
  const i = (model.fields || []).findIndex(f => String(f).trim().toLowerCase() === name);
  return i >= 0 ? i : fallback;
};
export function notesToImport(notes, models, reviews = new Map()) {
  const rows = [], tags = [], decks = [], ankiIds = [], pictures = [], occluded = [];
  let images = 0, extraImages = 0;
  const usedTypes = new Set();
  for (const note of notes) {
    const model = models.get(String(note.mid)) || { name: '', fields: [], cloze: false };
    const text = note.fields.map(f => htmlToMarks(f));       // bold, italics and lists kept as marks
    if (note.fields.some(hasImage)) images++;
    // One picture per side: the first in the front field, and the first in the other fields for the back.
    const frontPics = imageNames(note.fields[0]), backPics = note.fields.slice(1).flatMap(imageNames);
    const pics = { front: frontPics[0] || null, back: backPics[0] || null };
    if (frontPics.length > 1 || backPics.length > 1) extraImages++;
    const noteTags = (note.tags || []).map(t => t.toLowerCase());
    if (isOcclusionNote(note)) {
      // Fields of the Image Occlusion note type: Occlusion, Image, Header, Back Extra, Comments.
      const image = imageNames(note.fields[fieldIndex(model, 'image', 1)])[0] || null;
      const header = text[fieldIndex(model, 'header', 2)]?.trim();
      const extra = text[fieldIndex(model, 'back extra', 3)]?.trim();
      rows.push([header || 'Diagram', extra || '']); tags.push(noteTags); decks.push(note.deck || '');
      pictures.push({ front: null, back: image }); ankiIds.push(null); occluded.push(true);       // its masks' history doesn't fit a plain picture card
      usedTypes.add('occlusion');
      continue;
    }
    const nums = clozeNumbers(note.fields[0] ?? '');
    if (model.cloze || nums.length) {
      // Cloze text is in the first field. Turn it to text first so hidden answers lose their formatting too.
      for (const n of nums) {
        const { front, back } = clozeCard(text[0], n);
        rows.push([front, back, ...text.slice(1)]); tags.push(noteTags); decks.push(note.deck || ''); pictures.push(pics); occluded.push(false);
        ankiIds.push(note.cards?.[n - 1] ?? null);      // blank number n is Anki card number n - 1
      }
      usedTypes.add('cloze');
    } else {
      rows.push(text); tags.push(noteTags); decks.push(note.deck || ''); pictures.push(pics); occluded.push(false);
      ankiIds.push(note.cards?.[0] ?? null);            // the front → back card (a reverse card's history isn't used)
      usedTypes.add(String(note.mid));
    }
  }
  const width = Math.max(2, ...rows.map(r => r.length));
  const padded = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  // One ordinary note type: use its field names. Otherwise number them.
  const only = usedTypes.size === 1 && !usedTypes.has('cloze') ? models.get([...usedTypes][0]) : null;
  const columns = Array.from({ length: width }, (_, i) =>
    (only && only.fields[i]) || (i === 0 ? 'Front (field 1)' : i === 1 ? 'Back (field 2)' : `Field ${i + 1}`));
  const used = new Map(ankiIds.filter(id => id && reviews.get(id)?.length).map(id => [id, reviews.get(id)]));
  return { columns, rows: padded, tags, decks, images, extraImages, pictures, occluded, ankiIds, reviews: used, progress: progressOf(ankiIds, used),
    format: { id: 'anki', label: 'from the Anki deck' }, headerSkipped: false };
}

// How many rows have review history, and how many reviews that is.
function progressOf(ankiIds, reviews) {
  let cards = 0, count = 0;
  for (const id of ankiIds) {
    const n = (id && reviews.get(id)?.filter(countsAsReview).length) || 0;
    if (n) { cards++; count += n; }
  }
  return { cards, reviews: count };
}
const isAnswer = e => e.ease >= 1 && e.ease <= 4;

// What Anki's own FSRS code makes of the history rows (rslib: revlog/mod.rs and scheduler/fsrs/params.rs):
//   cram     an answer in a filtered deck that doesn't touch the schedule (type 3, factor 0): ignored
//   reset    "Forget" (type 4, factor 0): the card is new again, so the history before it no longer counts.
//            A manual change that leaves the card with no gap at all (ivl 0) is a reset too: that is how earlier
//            versions of this app read it, and some exports carry a factor on those rows.
// Everything else with a button (1-4) is a real review. Changes made by hand ("Set due date") are skipped.
export const isCram = e => e.type === 3 && e.factor === 0;
export const isReset = e => e.ease === 0 && e.type === 4 && (e.factor === 0 || e.ivl === 0);
export const countsAsReview = e => isAnswer(e) && !isCram(e);

// FSRS-6's default weights w8, w9, w10 (the same ts-fsrs 5.4.2 uses): how fast a Good answer grows the stability.
const W8 = 1.8722, W9 = 0.1666, W10 = 0.796;
const DAY = 86400000;

// A card state to start from when Anki's history is cut off (the first row we have isn't the card's first
// learning step, so earlier reviews are missing). Like Anki's own FSRS import, it turns Anki's interval and ease
// into FSRS memory: stability ~ the interval (a card is due at 90% recall), and the difficulty that makes a Good
// answer multiply the interval by the card's ease. The state is as of that row's review.
export function seedFromAnki(cardId, e) {
  const ivl = Math.max(0.1, e.ivl);
  const ease = e.factor >= 1300 && e.factor <= 9999 ? e.factor / 1000 : 2.5;      // unknown or odd: Anki's default
  const growth = Math.exp(W8) * ivl ** -W9 * (Math.exp(W10 * 0.1) - 1);            // how much a Good answer grows S per point of (11 - D)
  const difficulty = Math.min(10, Math.max(1, 11 - (ease - 1) / growth));
  return { cardId, due: e.timestamp + ivl * DAY, stability: ivl, difficulty, elapsedDays: 0, scheduledDays: Math.round(ivl), learningSteps: 0,
    reps: 1, lapses: 0, state: 2, lastReview: e.timestamp };
}

// Rebuild a card's progress by replaying its Anki reviews, oldest first, through Study Sprint's FSRS.
//   entries  one card's Anki review history [{ timestamp, ease, ivl, ms, type, factor }]
//   rate     (state, rating, timestamp, isLast) → new state: Study Sprint's scheduler (srs.js rate).
//            isLast is true for the card's final review, which sets the due date.
//   cardId   for the seeded state of a cut-off history
// Returns { state, logs }: the card's final schedule (null if it ends up new) and review log rows
// (source 'anki') for its history and the stats. Anki's buttons 1–4 are the same as ours.
// Like Anki:
//   - cram reviews (filtered decks) are left out;
//   - "Forget" resets the card: only what comes after it sets the schedule (earlier reviews stay in the log);
//   - old Anki versions didn't log resets, so a new learning step after reviews starts the card again;
//   - a history that starts after the card's first learning step is cut off: it starts from Anki's interval
//     and ease at that row (seedFromAnki) instead of from a new card.
export function replayHistory(entries, rate, cardId = '') {
  // Split the reviews into runs, each starting from a new card. The last run is the card's schedule.
  const runs = [{ rows: [], canSeed: true }];
  for (const e of entries) {
    if (isReset(e)) { runs.push({ rows: [], canSeed: false }); continue; }
    if (!countsAsReview(e)) continue;
    const run = runs.at(-1);
    if (e.type === 0 && run.rows.length && run.rows.at(-1).type !== 0) runs.push({ rows: [e], canSeed: false });
    else run.rows.push(e);
  }
  const logs = [];
  let state = null;
  runs.forEach((run, r) => {
    state = null;
    const { rows } = run;
    let from = 0;
    if (run.canSeed && rows.length && rows[0].type !== 0 && rows[0].ivl > 0) {      // cut off: start from the first row's interval and ease
      state = seedFromAnki(cardId, rows[0]);
      logs.push(logOf(rows[0], 2));
      from = 1;
    }
    for (let i = from; i < rows.length; i++) {
      const before = state ? state.state : 0;
      state = rate(state, rows[i].ease, rows[i].timestamp, r === runs.length - 1 && i === rows.length - 1);
      logs.push(logOf(rows[i], before));
    }
  });
  return { state, logs };
}
const logOf = (e, before) => ({ timestamp: e.timestamp, source: 'anki', mode: 'flip', correct: e.ease > 1,
  ms: Math.max(0, Math.min(e.ms || 0, 60000)), rating: e.ease, state: before });

// Only the rows from one Anki deck (and its subdecks). deck = '' means all of them.
export function onlyDeck(result, deck) {
  if (!deck) return result;
  const keep = result.decks.map(d => d === deck || d.startsWith(deck + '::'));
  const pick = list => list.filter((_, i) => keep[i]);
  const ankiIds = pick(result.ankiIds || []);
  return { ...result, rows: pick(result.rows), tags: pick(result.tags), decks: pick(result.decks), pictures: pick(result.pictures || []), occluded: pick(result.occluded || []), ankiIds,
    progress: progressOf(ankiIds, result.reviews || new Map()) };
}

// The Anki decks in a result, with how many rows each has (subdecks counted in their parents too), A → Z.
export function deckList(result) {
  const counts = new Map();
  for (const d of result.decks) {
    const parts = d.split('::');
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('::');
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts].filter(([name]) => name).map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Keeping Anki's subdecks: each row's deck relative to what all the rows share, as a list of names.
// ['Psych', 'Psych::Unit 1', 'Psych::Unit 1::Lecture 3'] → [[], ['Unit 1'], ['Unit 1', 'Lecture 3']]
// (the shared part, "Psych", is the deck you import into). Decks from different top-level Anki decks
// keep their whole names: ['Bio', 'Chem::Acids'] → [['Bio'], ['Chem', 'Acids']].
export function subdeckPaths(names) {
  const split = names.map(n => String(n || '').split('::').map(s => s.trim()).filter(Boolean));
  let shared = split[0]?.length || 0;
  for (const p of split) {
    let i = 0;
    while (i < shared && i < p.length && p[i] === split[0][i]) i++;
    shared = i;
  }
  return split.map(p => p.slice(shared));
}
