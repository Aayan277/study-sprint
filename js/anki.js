// Turning Anki notes into Study Sprint cards. Pure functions (no page, no files), tested by tests/anki.test.js.
// anki-read.js opens the .apkg file and hands its notes to notesToImport() below.
//
// How Anki stores things, in short:
//   note       one fact, with several fields (e.g. Front and Back), plus tags
//   note type  says which fields a note has. "Cloze" notes hide parts of one text: {{c1::answer::hint}}
//   deck       where the note's cards live. Subdecks are written "Parent::Child"
// Fields are HTML. Study Sprint cards are plain text, so formatting is dropped and images and sounds are left out.

// HTML → plain text, keeping line breaks.
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\[sound:[^\]]*\]/g, '')                          // audio
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')                                   // every other tag, images included
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export const hasImage = html => /<img\b/i.test(String(html ?? ''));

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
//   images  how many notes had images (left out)
//   ankiIds   the Anki card each row came from, so its review history can come along
//   reviews   Map Anki card id → its review history, for the rows' cards that have one
//   progress  { cards, reviews }: how many rows have history, and how many reviews in all
// Rows are [front, back, any other fields]. Cloze notes give one row per cloze number, with their
// other fields (like Back Extra) after the back.
export function notesToImport(notes, models, reviews = new Map()) {
  const rows = [], tags = [], decks = [], ankiIds = [];
  let images = 0;
  const usedTypes = new Set();
  for (const note of notes) {
    const model = models.get(String(note.mid)) || { name: '', fields: [], cloze: false };
    const text = note.fields.map(htmlToText);
    if (note.fields.some(hasImage)) images++;
    const noteTags = (note.tags || []).map(t => t.toLowerCase());
    const nums = clozeNumbers(note.fields[0] ?? '');
    if (model.cloze || nums.length) {
      // Cloze text is in the first field. Turn it to text first so hidden answers lose their formatting too.
      for (const n of nums) {
        const { front, back } = clozeCard(text[0], n);
        rows.push([front, back, ...text.slice(1)]); tags.push(noteTags); decks.push(note.deck || '');
        ankiIds.push(note.cards?.[n - 1] ?? null);      // blank number n is Anki card number n - 1
      }
      usedTypes.add('cloze');
    } else {
      rows.push(text); tags.push(noteTags); decks.push(note.deck || '');
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
  return { columns, rows: padded, tags, decks, images, ankiIds, reviews: used, progress: progressOf(ankiIds, used),
    format: { id: 'anki', label: 'from the Anki deck' }, headerSkipped: false };
}

// How many rows have review history, and how many reviews that is.
function progressOf(ankiIds, reviews) {
  let cards = 0, count = 0;
  for (const id of ankiIds) {
    const n = (id && reviews.get(id)?.filter(isAnswer).length) || 0;
    if (n) { cards++; count += n; }
  }
  return { cards, reviews: count };
}
const isAnswer = e => e.ease >= 1 && e.ease <= 4;

// Rebuild a card's progress by replaying its Anki reviews, oldest first, through Study Sprint's FSRS.
//   entries  one card's Anki review history [{ timestamp, ease, ivl, ms, type }]
//   rate     (state, rating, timestamp) → new state: Study Sprint's scheduler (srs.js rate)
// Returns { state, logs }: the card's final schedule (null if it ends up new) and review log rows
// (source 'anki') for its history and the stats. Anki's buttons 1–4 are the same as ours.
// Entries with no button (ease 0) are changes made by hand in Anki: "Forget" (interval 0) resets the
// card to new, others (like "Set due date") are skipped.
export function replayHistory(entries, rate) {
  let state = null;
  const logs = [];
  for (const e of entries) {
    if (!isAnswer(e)) {
      if ((e.type === 4 || e.type === 5) && e.ivl === 0) state = null;
      continue;
    }
    const before = state ? state.state : 0;
    state = rate(state, e.ease, e.timestamp);
    logs.push({ timestamp: e.timestamp, source: 'anki', mode: 'flip', correct: e.ease > 1,
      ms: Math.max(0, Math.min(e.ms || 0, 60000)), rating: e.ease, state: before });
  }
  return { state, logs };
}

// Only the rows from one Anki deck (and its subdecks). deck = '' means all of them.
export function onlyDeck(result, deck) {
  if (!deck) return result;
  const keep = result.decks.map(d => d === deck || d.startsWith(deck + '::'));
  const pick = list => list.filter((_, i) => keep[i]);
  const ankiIds = pick(result.ankiIds || []);
  return { ...result, rows: pick(result.rows), tags: pick(result.tags), decks: pick(result.decks), ankiIds,
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
