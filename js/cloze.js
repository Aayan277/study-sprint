// Cloze cards: one text with hidden parts, like "The {{c1::mitochondria::organelle}} makes {{c2::ATP}}".
// Each blank number (c1, c2, ...) becomes its own card. The cards of one text are called "siblings"; they share
// a noteId and the full text (noteText). Every card also keeps an ordinary front and back, computed here, so older
// versions of the app, backups, CSV export and search keep working.
// Pure functions (no page, no database), tested by tests/cloze.test.js.

import { formatHTML } from './format.js';

// {{c1::answer}} or {{c1::answer::hint}}
const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

// Which numbers does a text use, smallest first? "{{c1::a}} {{c2::b}} {{c1::c}}" → [1, 2]
export function clozeNumbers(text) {
  return [...new Set([...String(text ?? '').matchAll(CLOZE)].map(m => +m[1]))].sort((a, b) => a - b);
}

// One card for blank number n: that blank is hidden as […] (or [hint]) on the front, the other blanks are
// shown, and the back is the hidden answer(s). The same number twice makes one card with both blanks hidden.
export function clozeCard(text, n) {
  const answers = [];
  const front = String(text ?? '').replace(CLOZE, (m, num, answer, hint) => {
    if (+num !== n) return answer;
    answers.push(answer);
    return hint ? `[${hint}]` : '[…]';
  });
  return { front, back: answers.join(', ') };
}

// Does a text have at least one blank?
export const hasCloze = text => clozeNumbers(text).length > 0;

// ---------- showing a cloze card ----------
// Private characters stand in for the tags while formatHTML (which escapes everything) does its work, and are
// swapped for the real tags afterwards. So the card's text can never bring in a tag of its own.
const BLANK_OPEN = '', BLANK_CLOSE = '', ANS_OPEN = '', ANS_CLOSE = '';
const STRAY = /[-]/g;

// The text as HTML for one card.
//   side 'front'  blank n as […] (or the hint), the others shown
//   side 'back'   the full text with blank n marked as the answer
//   side 'all'    every blank marked (the editor's preview)
export function renderCloze(text, n, side = 'front') {
  const marked = String(text ?? '').replace(STRAY, '').replace(CLOZE, (m, num, answer, hint) => {
    if (side === 'all') return ANS_OPEN + answer + ANS_CLOSE;
    if (+num !== n) return answer;
    if (side === 'back') return ANS_OPEN + answer + ANS_CLOSE;
    return BLANK_OPEN + (hint ? `[${hint}]` : '[…]') + BLANK_CLOSE;
  });
  return formatHTML(marked)
    .split(BLANK_OPEN).join('<span class="cloze-blank">').split(BLANK_CLOSE).join('</span>')
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
export function planNoteSave(oldSiblings, newText) {
  const byNumber = new Map();
  const remove = [];
  for (const card of oldSiblings) {
    if (card.cloze !== undefined && !byNumber.has(card.cloze)) byNumber.set(card.cloze, card);
    else remove.push(card);          // a second card with the same number, or one without a number
  }
  const update = [], add = [];
  const nums = clozeNumbers(newText);
  for (const n of nums) {
    const { front, back } = clozeCard(newText, n);
    const old = byNumber.get(n);
    if (old) update.push({ ...old, cloze: n, front, back, noteText: newText });
    else add.push({ cloze: n, front, back, noteText: newText });
  }
  for (const [n, card] of byNumber) if (!nums.includes(n)) remove.push(card);
  return { update, add, remove };
}

// Two devices can edit different siblings of one note while offline, and syncing keeps the newest of each card,
// so the siblings can end up with different texts. Make them agree again: the text of the most recently edited
// sibling wins, and the others get their front and back worked out from it. Returns the cards to save.
// (A sibling whose blank is no longer in the winning text is left as it is.)
export function healNotes(cards) {
  const notes = new Map();
  for (const c of cards) if (c.noteId && c.noteText !== undefined) (notes.get(c.noteId) || notes.set(c.noteId, []).get(c.noteId)).push(c);
  const fixed = [];
  for (const sibs of notes.values()) {
    if (sibs.every(s => s.noteText === sibs[0].noteText && s.noteExtra === sibs[0].noteExtra)) continue;
    const newest = sibs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) || ((b.updatedAt || 0) === (a.updatedAt || 0) && b.id > a.id) ? b : a));
    const nums = clozeNumbers(newest.noteText);
    for (const s of sibs) {
      if (!nums.includes(s.cloze)) continue;
      const { front, back } = clozeCard(newest.noteText, s.cloze);
      if (s.noteText === newest.noteText && s.noteExtra === newest.noteExtra && s.front === front && s.back === back) continue;
      const card = { ...s, front, back, noteText: newest.noteText };
      if (newest.noteExtra) card.noteExtra = newest.noteExtra; else delete card.noteExtra;
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
