// Card formatting: bold, italics and bullet lists, saved as simple marks in the card's text.
// Pure functions (no page), tested by tests/format.test.js.
//
//   **bold**        *italic*        - a bullet point (a line starting with "- " or "• ")
//
// Cards stay plain text underneath, so they sync, back up and export cleanly. The marks only count when
// they hug a word: "5 * 3 * 2" stays as it is. card-editor.js gives the B / I / • buttons.

import { holdMath, unholdMath, unescapeDollar, splitMath, texToPlain } from './math.js';

const escapeHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BOTH = /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g;      // ***bold and italic***
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
const ITALIC = /(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g;
const BULLET = /^\s*[-•]\s+(.*)$/;

const inline = html => html.replace(BOTH, '<b><i>$1</i></b>').replace(BOLD, '<b>$1</b>').replace(ITALIC, '$1<i>$2</i>');

// A formula as HTML.
//   'span'  a placeholder that js/math.js draws with KaTeX (the raw text shows until it has loaded, or if it can't)
//   'raw'   the formula as typed (the rich editor box, so it can be saved again exactly)
//   'anki'  \( ... \) or \[ ... \], which Anki draws
const mathPiece = (it, mode) => {
  if (mode === 'raw') return escapeHTML(it.raw).replace(/\n/g, '<br>');
  if (mode === 'anki') {
    const tex = escapeHTML(it.tex);              // newlines stay: a % comment in the TeX ends at the end of its line
    return it.display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
  }
  return `<span class="tex${it.display ? ' tex-d' : ''}" data-tex="${escapeHTML(it.tex)}">${escapeHTML(it.raw)}</span>`;
};

// Card text → HTML for showing it (everything else is escaped, so card text can't inject anything).
// No line-break characters in the result: lines are joined with <br>, and bullet lines become a list.
//   math: how formulas come out (see mathPiece). Formulas are lifted out first, so the marks inside them
//   ($a*b*c$) are never read as formatting.
export function formatHTML(text, { math = 'span' } = {}) {
  const held = holdMath(String(text ?? ''));
  const blocks = [];
  let list = null;
  const source = math === 'raw' ? held.text : unescapeDollar(held.text);
  for (const line of escapeHTML(source).split(/\r?\n/)) {
    const m = BULLET.exec(line);
    if (m) { if (!list) blocks.push(list = []); list.push(inline(m[1])); continue; }
    list = null;
    blocks.push(inline(line));
  }
  let out = '';
  blocks.forEach((b, i) => {
    if (Array.isArray(b)) out += `<ul>${b.map(li => `<li>${li}</li>`).join('')}</ul>`;
    else out += (i > 0 && !Array.isArray(blocks[i - 1]) ? '<br>' : '') + b;
  });
  return unholdMath(out, held.items, it => mathPiece(it, math));
}

// Only the formulas of a text drawn, the rest escaped (no bold, italics or lists): for lists and short previews that
// are plain text underneath. inline: true draws every formula in line (a display one too), for one-line places.
export function mathHTML(text, { inline: flat = false } = {}) {
  return splitMath(text).map(s => (s.type === 'text' ? escapeHTML(s.value)
    : mathPiece(flat ? { ...s, display: false } : s, 'span'))).join('');
}

// The marks taken out of text that has no formulas in it.
const stripMarks = s => s
  .split(/\r?\n/).map(l => { const m = BULLET.exec(l); return m ? `• ${m[1]}` : l; }).join('\n')
  .replace(BOTH, '$1').replace(BOLD, '$1').replace(ITALIC, '$1$2');

// Card text without the marks: for typed answers, Play's options, searching and short previews.
// A formula is kept exactly as written.
export function plainText(text) {
  const held = holdMath(String(text ?? ''));
  return unholdMath(stripMarks(held.text), held.items, it => it.raw);
}

// What to type to get a card right: plainText with each formula as plain words (\frac{a}{b} → a/b) and "\$" as "$".
export function answerText(text) {
  const held = holdMath(String(text ?? ''));
  return unholdMath(unescapeDollar(stripMarks(held.text)), held.items, it => texToPlain(it.tex));
}

// A card as one short phrase for a screen reader: "What is x²? Answer: a square" (formulas as plain words, long text cut off, no marks).
// For a name on a list row, where the picture of the formula (KaTeX) would be read out symbol by symbol.
export function spokenCard(front, back, max = 160) {
  const clip = s => { const t = answerText(s).replace(/\[…\]/g, 'blank').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
  const f = clip(front), b = clip(back);
  return b ? `${f || 'Picture'}${/[.!?…:]$/.test(f) ? '' : '.'} Answer: ${b}` : f || 'Picture';
}

// A list row as one phrase: the card (spokenCard), then what the row shows only in pictures or badges: Reverse / Cloze, a picture or sound,
// the deck it is in, its status and flag. Each part ends in a full stop unless it already ends in punctuation. About 160 characters of card text.
export function spokenRow({ front, back, reverse = false, cloze = 0, pic = false, sound = false, typing = false, where = '', status = '', flag = '' }) {
  const parts = [reverse ? 'Reverse card' : '', cloze > 0 ? `Cloze card, blank ${cloze}` : '', spokenCard(front, back, 70), pic ? 'Has a picture' : '', sound ? 'Has a sound' : '', typing ? 'Typing card' : '',
    where ? `In ${where}` : '', status, flag ? `${flag} flag` : ''].filter(Boolean);
  return parts.map((p, i) => (i < parts.length - 1 && !/[.!?…:]$/.test(p) ? `${p}.` : p)).join(' ');
}

// The raw text typed as it stands (formulas as written), with "\$" as "$". The other thing a typed answer may match.
export function rawAnswerText(text) {
  const held = holdMath(String(text ?? ''));
  return unholdMath(unescapeDollar(stripMarks(held.text)), held.items, it => it.raw);
}

// Everything a typed answer can match, best first: the formulas as plain words (answerText), the text as written
// (so typing the LaTeX works, or a price or a path with its \$ signs), and the plain words with Greek letters as
// letters (α for \alpha).
export function answerTargets(text) {
  const held = holdMath(String(text ?? ''));
  const base = unescapeDollar(stripMarks(held.text));
  const out = [unholdMath(base, held.items, it => texToPlain(it.tex)), unholdMath(base, held.items, it => it.raw),
    unholdMath(base, held.items, it => texToPlain(it.tex, { greek: true }))];
  return out.filter((t, i) => t.trim() && out.indexOf(t) === i);
}

// Does the text use any formatting marks? (Formulas don't count, and their insides are not looked at.)
export const hasFormatting = text => {
  const s = holdMath(String(text ?? '')).text;
  return new RegExp(BOLD.source).test(s) || new RegExp(ITALIC.source).test(s) || /^\s*[-•]\s+/m.test(s);
};

// HTML → card text, keeping bold, italics and lists as marks (from Anki fields, or the rich editor on a
// computer). Everything else (colors, fonts, images…) is dropped.
//   marks: false gives plain text instead (bullets as "• ").
export function htmlToMarks(html, { marks = true } = {}) {
  // Marks must hug the words, so move spaces from inside <b> … </b> to outside.
  const wrap = (mark, inner) => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
  };
  let s = String(html ?? '')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\[sound:[^\]]*\]/g, '');
  if (marks) {
    s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, inner) => wrap('**', inner))
      .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, inner) => wrap('*', inner));
  }
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(li|tr|h\d|ul|ol)>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '')
    .replace(/<(div|p|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, marks ? '- ' : '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

// ---------- the B / I / • buttons on a plain text box (phones) ----------
// Each takes the box's text and selection and returns the new text and selection.

// Bold or italic: wrap the selection in the mark, or unwrap it if it's already wrapped.
// With nothing selected, the word under the cursor is used.
export function toggleWrap(value, start, end, mark) {
  if (start === end) {
    while (start > 0 && /\S/.test(value[start - 1])) start--;
    while (end < value.length && /\S/.test(value[end])) end++;
  }
  let sel = value.slice(start, end);
  const lead = sel.match(/^\s*/)[0].length, trail = sel.match(/\s*$/)[0].length;    // keep spaces outside
  start += lead; end -= trail; sel = value.slice(start, end);
  const n = mark.length;
  const isWrapped = (s, e) => value.slice(s - n, s) === mark && value.slice(e, e + n) === mark &&
    (n === 2 || (value[s - n - 1] !== '*' && value[e + n] !== '*'));
  if (sel && isWrapped(start, end)) {
    return { value: value.slice(0, start - n) + sel + value.slice(end + n), start: start - n, end: end - n };
  }
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length > 2 * n && (n === 2 || !sel.startsWith('**'))) {
    const inner = sel.slice(n, -n);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  if (!sel) return { value: value.slice(0, start) + mark + mark + value.slice(end), start: start + n, end: start + n };
  return { value: value.slice(0, start) + mark + sel + mark + value.slice(end), start: start + n, end: end + n };
}

// Bullets: turn the selected lines into a list, or back into plain lines if they all are already.
export function toggleBullets(value, start, end) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  let to = value.indexOf('\n', Math.max(start, end - 1));
  if (to < 0) to = value.length;
  const lines = value.slice(from, to).split('\n');
  const all = lines.every(l => BULLET.test(l) || !l.trim());
  const changed = lines.map(l => (!l.trim() ? l : all ? l.replace(/^\s*[-•]\s+/, '') : BULLET.test(l) ? l : `- ${l}`)).join('\n');
  const out = value.slice(0, from) + changed + value.slice(to);
  return { value: out, start: from, end: from + changed.length };
}

// ---------- what a card face shows ----------
// The deck label on a card: only the last two levels of the path ("Unit 2 › Synapses"), the full path as a tooltip.
export const shortDeckPath = path => String(path || '').split(' › ').slice(-2).join(' › ');
// How long an answer is: 'long' from 160 characters, 'xlong' from 320 (smaller, left-aligned; see .flash-back in styles.css).
export const answerSize = text => (text.length > 320 ? ' long xlong' : text.length > 160 ? ' long' : '');
