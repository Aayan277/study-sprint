// Cloze cards: one text with hidden parts, like "The {{c1::mitochondria::organelle}} makes {{c2::ATP}}".
// Each blank number (c1, c2, ...) becomes its own card. The cards of one text are called "siblings"; they share
// a noteId and the full text (noteText). Every card also keeps an ordinary front and back, computed here, so older
// versions of the app, backups, CSV export and search keep working.
// Pure functions (no page, no database), tested by tests/cloze.test.js.

import { formatHTML } from './format.js';
import { holdMath, unholdMath } from './math.js';

// {{c1::answer}} or {{c1::answer::hint}}
// Found by a scanner, not a regex. The regex this replaced, /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, reread the rest of
// the text from every position of an unclosed blank, so a few KB of "{{c1::a " took 150 ms and 50 KB never finished.
// What that regex found, and so what this finds (each blank starts after the end of the one before):
//   - "{{c", digits, "::" starts a blank; anything else is skipped one character on.
//   - The blank ends at the FIRST "}}" after that (a blank without one ends the search: nothing later can have one either).
//   - If a "::" comes before that "}}", it splits the text from the hint (the first "::": ":::" is "::" and then a ":" in
//     the hint, and "::}}" is an empty hint, "" and not missing). Otherwise there is no hint (undefined).
// Nested blanks, e.g. {{c1::a {{c2::b}} c}}, are NOT supported: the outer blank ends at the first "}}" (tests/cloze-nested.test.js pins this).
// Each blank is { index, end, num (a string), text, hint }. One pass: the first "::" is looked for once and kept.
export function clozeBlanks(s) {
  s = String(s ?? '');
  const out = [];
  let from = 0, colons = -2;                      // colons: where the next "::" is (-1 none left, -2 not looked for yet)
  for (;;) {
    const at = s.indexOf('{{c', from);
    if (at < 0) return out;
    let p = at + 3;
    while (p < s.length && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) p++;
    if (p === at + 3 || s.charCodeAt(p) !== 58 || s.charCodeAt(p + 1) !== 58) { from = at + 1; continue; }
    const num = s.slice(at + 3, p);
    p += 2;
    const close = s.indexOf('}}', p);
    if (close < 0) return out;
    if (colons !== -1 && colons < p) colons = s.indexOf('::', p);
    const hinted = colons !== -1 && colons < close;
    out.push({ index: at, end: close + 2, num, text: s.slice(p, hinted ? colons : close), hint: hinted ? s.slice(colons + 2, close) : undefined });
    from = close + 2;
  }
}
// String.replace for blanks: fn(match, num, text, hint) gives the replacement.
function replaceBlanks(s, fn) {
  let out = '', last = 0;
  for (const b of clozeBlanks(s)) {
    out += s.slice(last, b.index) + fn(s.slice(b.index, b.end), b.num, b.text, b.hint);
    last = b.end;
  }
  return out + s.slice(last);
}

// Formulas are lifted out before the blanks are looked for, so a }} inside one ({{c1::$\sqrt{x^{2}}$}}) does not end the
// blank. A blank that starts inside a formula is not a blank (it shows as typed). fn gets the text without formulas and a
// function that puts them back.
function withMath(text, fn) {
  const held = holdMath(String(text ?? ''));
  return fn(held.text, s => unholdMath(s, held.items, it => it.raw));
}

// Which numbers does a text use, smallest first? "{{c1::a}} {{c2::b}} {{c1::c}}" → [1, 2]
export function clozeNumbers(text) {
  return withMath(text, held => [...new Set(clozeBlanks(held).map(b => +b.num))].sort((a, b) => a - b));
}

// One card for blank number n: that blank is hidden as […] (or [hint]) on the front, the other blanks are
// shown, and the back is the hidden answer(s). The same number twice makes one card with both blanks hidden.
export function clozeCard(text, n) {
  return withMath(text, (held, back) => {
    const answers = [];
    const front = replaceBlanks(held, (m, num, answer, hint) => {
      if (+num !== n) return answer;
      answers.push(answer);
      return hint ? `[${hint}]` : '[…]';
    });
    return { front: back(front), back: back(answers.join(', ')) };
  });
}

// Does a text have at least one blank?
export const hasCloze = text => clozeNumbers(text).length > 0;

// The text with every blank filled in (what read-aloud says after the flip).
export const clozeFull = text => withMath(text, (held, back) => back(replaceBlanks(held, (m, num, answer) => answer)));

// Does this card show a blank of its note? (A card of a note whose text no longer has its number is shown as an
// ordinary card, from its saved front and back.)
export const hasBlank = card => !!card?.noteId && typeof card.noteText === 'string' && clozeNumbers(card.noteText).includes(card.cloze);

// ---------- showing a cloze card ----------
// Private characters stand in for the tags while formatHTML (which escapes everything) does its work, and are
// swapped for the real tags afterwards. So the card's text can never bring in a tag of its own.
const BLANK_OPEN = '', BLANK_CLOSE = '', ANS_OPEN = '', ANS_CLOSE = '';
const HID_OPEN = '\uE004', HID_CLOSE = '\uE005';      // the visible […] is hidden from a screen reader, which hears "blank" instead
const STRAY = /[-]/g;

// The text as HTML for one card.
//   side 'front'  blank n as […] (or the hint), the others shown
//   side 'back'   the full text with blank n marked as the answer
//   side 'all'    every blank marked (the editor's preview)
export function renderCloze(text, n, side = 'front') {
  const marked = withMath(String(text ?? '').replace(STRAY, ''), (held, back) => back(replaceBlanks(held, (m, num, answer, hint) => {
    if (side === 'all') return ANS_OPEN + answer + ANS_CLOSE;
    if (+num !== n) return answer;
    if (side === 'back') return ANS_OPEN + answer + ANS_CLOSE;
    return BLANK_OPEN + (hint ? `[${hint}]` : `${HID_OPEN}[…]${HID_CLOSE}`) + BLANK_CLOSE;
  })));
  return formatHTML(marked)
    .split(BLANK_OPEN).join('<span class="cloze-blank"><span class="sr-only">blank </span>').split(BLANK_CLOSE).join('</span>')
    .split(HID_OPEN).join('<span aria-hidden="true">').split(HID_CLOSE).join('</span>')
    .split(ANS_OPEN).join('<mark class="cloze-ans">').split(ANS_CLOSE).join('</mark>');
}

// ---------- the editor's buttons ----------
// Put {{cN::…}} around the selected text (nothing selected: an empty blank to type in). Returns the new text and
// the selection, like toggleWrap in format.js. A selection that already is a whole blank is left alone.
export function wrapBlank(value, start, end, n) {
  const sel = value.slice(start, end);
  const open = `{{c${n}::`;
  return { value: value.slice(0, start) + open + sel + '}}' + value.slice(end), start: start + open.length, end: start + open.length + sel.length };
}
// With nothing selected, the word the cursor is in or touching (so "New blank" hides that word).
export function wordAt(value, pos) {
  let start = pos, end = pos;
  while (start > 0 && /[\p{L}\p{N}'’-]/u.test(value[start - 1])) start--;
  while (end < value.length && /[\p{L}\p{N}'’-]/u.test(value[end])) end++;
  return [start, end];
}
// The next free blank number, and the one used last (for "same blank").
export const nextNumber = text => Math.max(0, ...clozeNumbers(text)) + 1;
export const lastNumber = text => Math.max(1, ...clozeNumbers(text));

// "Makes 3 cards: c1 c2 c3", or the reason it makes none.
export function makesText(text) {
  const nums = clozeNumbers(text);
  if (!nums.length) return 'Select a word and press New blank to hide it.';
  return `Makes ${nums.length} card${nums.length === 1 ? '' : 's'}: ${nums.map(n => 'c' + n).join(' ')}`;
}

// ---------- saving a note ----------
// Work out what saving a new text does to a note's existing cards (its siblings, with their card objects).
//   update  existing cards whose blank is still there: same id (so the schedule stays), new text, front and back
//   add     blanks that are new: { cloze, front, back, noteText }, for db.saveNote to give an id
//   remove  existing cards whose blank is gone (the editor asks first: their history goes too)
//   duplicates  the part of remove that is not a gone blank: a second card with the same number, or one without
//           a number. Of two cards with one number the higher score(card) stays (the caller scores a schedule and
//           reviews higher); on a tie the first stays.
//   error   set (and nothing else to do) when a blank is empty, with the message to show
export function planNoteSave(oldSiblings, newText, score = () => 0) {
  for (const m of withMath(newText, held => clozeBlanks(held))) {
    if (!m.text.trim()) return { update: [], add: [], remove: [], duplicates: [], error: `Blank c${m.num} is empty. Select the words to hide, then press New blank.` };
  }
  const byNumber = new Map();
  const duplicates = [];
  for (const card of oldSiblings) {
    if (card.cloze === undefined) duplicates.push(card);
    else if (!byNumber.has(card.cloze)) byNumber.set(card.cloze, card);
    else if (score(card) > score(byNumber.get(card.cloze))) { duplicates.push(byNumber.get(card.cloze)); byNumber.set(card.cloze, card); }
    else duplicates.push(card);
  }
  const remove = [...duplicates];
  const update = [], add = [];
  const nums = clozeNumbers(newText);
  for (const n of nums) {
    const { front, back } = clozeCard(newText, n);
    const old = byNumber.get(n);
    if (old) update.push({ ...old, cloze: n, front, back, noteText: newText });
    else add.push({ cloze: n, front, back, noteText: newText });
  }
  for (const [n, card] of byNumber) if (!nums.includes(n)) remove.push(card);
  return { update, add, remove, duplicates };
}

// What the editor says before it deletes cards: "c3 was removed: its card and review history go too." For
// duplicates it says "duplicate c4 removed", and a card without a blank number is "an extra card".
export function removalText({ remove, duplicates = [] }) {
  const byNumber = (a, b) => (a.cloze ?? 0) - (b.cloze ?? 0);
  const gone = remove.filter(c => !duplicates.includes(c)).sort(byNumber).map(c => 'c' + c.cloze);
  const extra = duplicates.slice().sort(byNumber).map(c => (c.cloze === undefined ? 'an extra card without a blank number' : 'duplicate c' + c.cloze));
  const join = list => (list.length < 3 ? list.join(' and ') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1));
  const parts = [];
  if (gone.length) parts.push(`${join(gone)} ${gone.length === 1 ? 'was' : 'were'} removed`);
  if (extra.length) parts.push(`${join(extra)} removed`);
  const one = remove.length === 1;
  return `${parts.join(' and ')}: ${one ? 'its card and review history go' : 'their cards and review history go'} too.`;
}

// Two devices can edit different siblings of one note while offline, and syncing keeps the newest of each card,
// so the siblings can end up with different texts. Make them agree again: the text with the latest noteEditedAt
// (the time the note's text was last edited, which saveNote writes on every sibling) wins, and the others get
// their front and back worked out from it. Saving a single card (suspend, bury, flag) re-stamps its updatedAt
// but keeps its old noteEditedAt, so it can't win. Equal times are settled by card id, so every device picks the
// same winner. Cards without noteEditedAt (saved before it existed) only compete with each other, by updatedAt.
// The fixed cards get the winner's noteEditedAt (never "now"), so healing can't beat a real edit made elsewhere.
// Returns the cards to save. (A sibling whose blank is no longer in the winning text is left as it is.)
export function healNotes(cards) {
  const notes = new Map();
  for (const c of cards) if (c.noteId && c.noteText !== undefined) (notes.get(c.noteId) || notes.set(c.noteId, []).get(c.noteId)).push(c);
  const fixed = [];
  for (const sibs of notes.values()) {
    const extraOf = s => s.noteExtra || '';          // '' and missing are the same
    const fieldsOf = s => JSON.stringify(s.noteFields?.length ? s.noteFields : null);          // the note's other fields (note-fields.js): none and [] are the same
    if (sibs.every(s => s.noteText === sibs[0].noteText && extraOf(s) === extraOf(sibs[0]) && fieldsOf(s) === fieldsOf(sibs[0]))) continue;
    const stamped = sibs.filter(s => s.noteEditedAt !== undefined);
    const time = stamped.length ? s => s.noteEditedAt : s => s.updatedAt || 0;
    const newest = (stamped.length ? stamped : sibs).reduce((a, b) => (time(b) > time(a) || (time(b) === time(a) && b.id > a.id) ? b : a));
    const nums = clozeNumbers(newest.noteText);
    for (const s of sibs) {
      if (!nums.includes(s.cloze)) continue;
      const { front, back } = clozeCard(newest.noteText, s.cloze);
      if (s.noteText === newest.noteText && extraOf(s) === extraOf(newest) && fieldsOf(s) === fieldsOf(newest) && s.front === front && s.back === back) continue;
      const card = { ...s, front, back, noteText: newest.noteText };
      if (newest.noteExtra) card.noteExtra = newest.noteExtra; else delete card.noteExtra;
      if (newest.noteFields?.length) card.noteFields = newest.noteFields; else delete card.noteFields;
      if (newest.noteEditedAt !== undefined) card.noteEditedAt = newest.noteEditedAt;
      fixed.push(card);
    }
  }
  return fixed;
}

// ---------- "Link cloze cards" (older imports) ----------
// Before notes existed, a cloze text came in as separate cards: "The […] makes ATP" → "mitochondria". This finds
// groups of such cards that belong together, so they can be turned into notes (keeping each card's schedule).
//   cards   all cards. Only cards that aren't in a note yet and whose front has exactly one […] or [hint].
// Returns { notes, skipped }:
//   notes    [{ deckId, noteText, members: [{ card, cloze }] }]   groups of 2 or more cards with the same full text
//   skipped  how many groups were left out because they were unclear (blanks that overlap)
// Rebuilding: put the back where the […] was. Cards of one deck with the same rebuilt text are one note.
const TOKEN = /\[[^\[\]\n]*\]/g;
export function planLinks(cards) {
  const groups = new Map();
  for (const card of cards) {
    if (card.noteId || card.cloze !== undefined) continue;
    const front = String(card.front ?? ''), back = String(card.back ?? '').trim();
    const tokens = [...front.matchAll(TOKEN)];
    if (tokens.length !== 1 || !back || /\{\{c\d+::/.test(front + back)) continue;
    const t = tokens[0];
    const text = front.slice(0, t.index) + back + front.slice(t.index + t[0].length);
    const hint = t[0] === '[…]' || t[0] === '[...]' ? '' : t[0].slice(1, -1);
    const key = card.deckId + '\u0000' + text;
    if (!groups.has(key)) groups.set(key, { deckId: card.deckId, text, found: [] });
    groups.get(key).found.push({ card, at: t.index, len: back.length, back, hint });
  }
  const notes = [];
  let skipped = 0;
  for (const g of groups.values()) {
    if (g.found.length < 2) continue;
    // "::" or braces in an answer or hint would be read as part of the {{c1::answer::hint}} markup.
    if (g.found.some(f => /::|\{\{|\}\}/.test(f.back + '\u0000' + f.hint))) { skipped++; continue; }
    const spans = g.found.slice().sort((a, b) => a.at - b.at);
    // Blanks must not overlap, or we can't tell which words each card hid.
    if (spans.some((s, i) => i && s.at < spans[i - 1].at + spans[i - 1].len)) { skipped++; continue; }
    // Wrap from the end so the earlier positions stay right. The blanks are numbered from the left.
    let noteText = g.text;
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      noteText = noteText.slice(0, s.at) + `{{c${i + 1}::${s.back}${s.hint ? '::' + s.hint : ''}}}` + noteText.slice(s.at + s.len);
    }
    notes.push({ deckId: g.deckId, noteText, members: spans.map((s, i) => ({ card: s.card, cloze: i + 1 })) });
  }
  return { notes, skipped };
}

// ---------- pasted cloze notes ----------
// Pasted lines with blanks ({{c1::…}}), one note per line, as an import result (the shape import.js and anki.js
// give: columns, rows and, for each row, its place in a note). Lines without a blank are left out.
//   Returns { result, notes, skipped }: notes is how many lines made cards.
export function parseCloze(text) {
  const rows = [], clozes = [];
  let notes = 0, skipped = 0;
  String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    const nums = clozeNumbers(line);
    if (!nums.length) { skipped++; return; }
    notes++;
    for (const n of nums) { const { front, back } = clozeCard(line, n); rows.push([front, back]); clozes.push({ noteKey: 'paste' + i, n, text: line }); }
  });
  return { result: { columns: ['Front', 'Back'], rows, clozes, format: { id: 'cloze', label: 'as cloze notes', skipped }, headerSkipped: false }, notes, skipped };
}
// Does pasted text have any line with a blank?
export const hasClozeLines = text => /\{\{c\d+::/.test(String(text ?? ''));

// Pasted text where some lines are cloze notes and the rest are ordinary cards ("term - definition"): both come in.
//   parse   the normal text parser (import.js parseText; passed in so this file stays free of it)
//   Returns { result, notes }: result is an import result like parse gives, with the cloze rows added after the others
//   and `clozes` null-padded so it lines up with `rows`; notes is how many cloze lines made cards (0: nothing changed).
// The other lines only count when they split cleanly into two sides; lines that don't are left out, like lines without a
// blank always were ("N lines without a blank were left out"). A markdown table is left alone.
export function withClozeLines(text, parse) {
  const src = String(text ?? '');
  const plain = parse(src);
  if (!hasClozeLines(src) || plain.format.id === 'table') return { result: plain, notes: 0 };
  // A spreadsheet-style paste (commas or tabs, maybe with quoted multi-line cells): decide per parsed row, never re-split the text.
  if (plain.format.id === 'separator' && (plain.format.sep === ',' || plain.format.sep === '\t')) {
    const width = plain.columns.length;
    const rows = [], clozes = [], tags = [], extras = [];
    let notes = 0;
    plain.rows.forEach((r, i) => {
      const nums = hasClozeLines(r[0]) ? clozeNumbers(r[0]) : [];
      if (!nums.length) { rows.push(r); clozes.push(plain.clozes?.[i] ?? null); tags.push(plain.tags?.[i] || []); extras.push(plain.noteExtras?.[i] ?? null); return; }
      notes++;
      for (const n of nums) {
        const { front, back } = clozeCard(r[0], n);
        rows.push(Array.from({ length: width }, (_, k) => [front, back][k] ?? ''));
        clozes.push({ noteKey: 'paste' + i, n, text: r[0] });
        tags.push(plain.tags?.[i] || []); extras.push(String(r[1] ?? '').trim() || null);
      }
    });
    if (!notes) return { result: plain, notes: 0 };
    return { notes, result: { ...plain, rows, clozes, noteExtras: extras, ...(plain.tags ? { tags } : {}),
      format: { ...plain.format, label: `${plain.format.label}, plus ${notes} cloze note${notes === 1 ? '' : 's'}` } } };
  }
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const isCloze = lines.map(hasClozeLines);
  const made = parseCloze(lines.filter((_, i) => isCloze[i]).join('\n'));
  if (!made.notes) return { result: plain, notes: 0 };
  const others = lines.filter((_, i) => !isCloze[i]);
  const rest = others.length ? parse(others.join('\n')) : null;
  const usable = rest && ['separator', 'bold'].includes(rest.format.id) && rest.rows.length;
  if (!usable) {
    made.result.format.skipped = others.length;
    return { result: made.result, notes: made.notes };
  }
  const width = rest.columns.length;
  const clozeRows = made.result.rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const label = `${rest.format.label}, plus ${made.notes} cloze note${made.notes === 1 ? '' : 's'}`;
  return {
    notes: made.notes,
    result: {
      ...rest,
      rows: [...rest.rows, ...clozeRows],
      clozes: [...rest.rows.map(() => null), ...made.result.clozes],
      ...(rest.tags ? { tags: [...rest.tags, ...clozeRows.map(() => [])] } : {}),
      format: { ...rest.format, label }
    }
  };
}
