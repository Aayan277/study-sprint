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
// Rows are [front, back, any other fields]. Cloze notes give one row per cloze number, with their
// other fields (like Back Extra) after the back.
export function notesToImport(notes, models) {
  const rows = [], tags = [], decks = [];
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
      }
      usedTypes.add('cloze');
    } else {
      rows.push(text); tags.push(noteTags); decks.push(note.deck || '');
      usedTypes.add(String(note.mid));
    }
  }
  const width = Math.max(2, ...rows.map(r => r.length));
  const padded = rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  // One ordinary note type: use its field names. Otherwise number them.
  const only = usedTypes.size === 1 && !usedTypes.has('cloze') ? models.get([...usedTypes][0]) : null;
  const columns = Array.from({ length: width }, (_, i) =>
    (only && only.fields[i]) || (i === 0 ? 'Front (field 1)' : i === 1 ? 'Back (field 2)' : `Field ${i + 1}`));
  return { columns, rows: padded, tags, decks, images, format: { id: 'anki', label: 'from the Anki deck' }, headerSkipped: false };
}

// Only the rows from one Anki deck (and its subdecks). deck = '' means all of them.
export function onlyDeck(result, deck) {
  if (!deck) return result;
  const keep = result.decks.map(d => d === deck || d.startsWith(deck + '::'));
  const pick = list => list.filter((_, i) => keep[i]);
  return { ...result, rows: pick(result.rows), tags: pick(result.tags), decks: pick(result.decks) };
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
