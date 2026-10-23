// Card formatting: bold, italics and bullet lists, saved as simple marks in the card's text.
// Pure functions (no page), tested by tests/format.test.js.
//
//   **bold**        *italic*        - a bullet point (a line starting with "- " or "• ")
//   ｜見《み》る       furigana: a reading above its word (｜ before the word, the reading in 《 》; a ruby tag from an Anki card becomes this)
//
// Cards stay plain text underneath, so they sync, back up and export cleanly. The marks only count when
// they hug a word: "5 * 3 * 2" stays as it is. card-editor.js gives the B / I / • buttons.

import { holdMath, unholdMath, unescapeDollar, splitMath, texToPlain } from './math.js';

const escapeHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BOTH = /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g;      // ***bold and italic***
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
const ITALIC = /(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g;
const BULLET = /^\s*[-•]\s+(.*)$/;

// Furigana. Both brackets are Japanese ones, so ordinary text (math, [blanks], markdown links) never looks like it. The word is short, and the
// reading is not Chinese characters: 《 》 are also the brackets of a book title in Chinese ("推荐｜三体《刘慈欣》"), and that is no furigana.
const RUBY = /｜([^｜《》\n]{1,32}?)《([^｜《》\n]{1,64}?)》/g;
const isReading = reading => !/\p{Script=Han}/u.test(reading);
const hasRuby = s => { for (const m of s.matchAll(RUBY)) if (isReading(m[2])) return true; return false; };

// (The text is already escaped here, so the word and its reading can't bring any HTML with them.)
const inline = html => html.replace(RUBY, (m, base, reading) => (isReading(reading) ? `<ruby>${base}<rt>${reading}</rt></ruby>` : m)).replace(BOTH, '<b><i>$1</i></b>').replace(BOLD, '<b>$1</b>').replace(ITALIC, '$1<i>$2</i>');

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

// The marks taken out of text that has no formulas in it. Furigana: 'paren' keeps the reading as 見(み)る (searching, lists, exports),
// 'base' only the word (what to type), 'reading' only the reading (what to say).
const stripMarks = (s, ruby = 'paren') => s
  .split(/\r?\n/).map(l => { const m = BULLET.exec(l); return m ? `• ${m[1]}` : l; }).join('\n')
  .replace(RUBY, (m, base, reading) => (!isReading(reading) ? m : ruby === 'base' ? base : ruby === 'reading' ? reading : `${base}(${reading})`))
  .replace(BOTH, '$1').replace(BOLD, '$1').replace(ITALIC, '$1$2');

// Card text without the marks: for typed answers, Play's options, searching and short previews.
// A formula is kept exactly as written. ruby: how furigana comes out (see stripMarks); the default is 見(み)る.
export function plainText(text, { ruby = 'paren' } = {}) {
  const held = holdMath(String(text ?? ''));
  return unholdMath(stripMarks(held.text, ruby), held.items, it => it.raw);
}

// What to type to get a card right: plainText with each formula as plain words (\frac{a}{b} → a/b) and "\$" as "$".
export function answerText(text) {
  const held = holdMath(String(text ?? ''));
  return unholdMath(unescapeDollar(stripMarks(held.text, 'base')), held.items, it => texToPlain(it.tex));
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
  return unholdMath(unescapeDollar(stripMarks(held.text, 'base')), held.items, it => it.raw);
}

// Everything a typed answer can match, best first: the formulas as plain words (answerText), the text as written
// (so typing the LaTeX works, or a price or a path with its \$ signs), and the plain words with Greek letters as
// letters (α for \alpha). With furigana, the word is what to type (見る), and the reading (みる) is accepted too.
export function answerTargets(text) {
  const held = holdMath(String(text ?? ''));
  const base = unescapeDollar(stripMarks(held.text, 'base'));
  const out = [unholdMath(base, held.items, it => texToPlain(it.tex)), unholdMath(base, held.items, it => it.raw),
    unholdMath(base, held.items, it => texToPlain(it.tex, { greek: true })),
    ...(hasRuby(held.text) ? (r => [unholdMath(r, held.items, it => texToPlain(it.tex)), unholdMath(r, held.items, it => it.raw)])(unescapeDollar(stripMarks(held.text, 'reading'))) : [])];
  return out.filter((t, i) => t.trim() && out.indexOf(t) === i);
}

// Does the text use any formatting marks? (Formulas don't count, and their insides are not looked at.)
export const hasFormatting = text => {
  const s = holdMath(String(text ?? '')).text;
  return new RegExp(BOLD.source).test(s) || hasRuby(s) || new RegExp(ITALIC.source).test(s) || /^\s*[-•]\s+/m.test(s);
};

// The inside of a <ruby> tag as text: each word with its <rt> reading, as ｜見《み》 (marks: true) or 見(み). Only text comes out:
// tags are dropped, and the characters the mark uses are taken out of the word and reading so a mark can't be cut short.
// One pass over the tags. HTML lets </rt> and </rp> be left out: a reading ends at the next <rt>, <rp> or <rb>, or at the end.
// The nth reading belongs to the nth word (a word starts at an <rb>, or at text after a reading). Readings that have no word to
// belong to, and an absurdly long ruby (so a hostile field can't make this slow), come out as plain text.
const MAX_RUBY = 4000;
const RUBY_PART = /<(\/?)([a-z][a-z0-9]*)\b[^<>]*>|[^<]+|</gi;      // (a tag, a run of text, or a stray "<": no part can run past the next "<")
function rubyMarks(inner, marks) {
  const plain = () => inner.replace(/<[^<>]*>/g, '');
  if (inner.length > MAX_RUBY) return plain();
  const words = [];                      // { base, reading }: reading is null until its <rt> comes
  let where = 'base', reading = '', fresh = true, next = 0;      // fresh: the next text starts a new word; next: the word the next reading belongs to
  const endReading = () => { const w = words[next++]; if (w) w.reading = reading; reading = ''; return !!w; };
  for (const m of inner.matchAll(RUBY_PART)) {
    const name = m[2]?.toLowerCase();
    if (name === 'rt' || name === 'rp' || name === 'rb') {
      if (where === 'rt' && !endReading()) return plain();
      where = m[1] ? 'base' : name === 'rp' ? 'rp' : name === 'rt' ? 'rt' : 'base';          // (<rb> and the closing tags go back to the word)
      if (name === 'rb' && !m[1]) { words.push({ base: '', reading: null }); fresh = false; }
      else if (name === 'rt' && m[1]) fresh = true;
    } else if (!name) {
      if (where === 'rt') reading += m[0];
      else if (where === 'base' && !(fresh && !m[0].trim())) {
        if (fresh) { words.push({ base: '', reading: null }); fresh = false; }
        words.at(-1).base += m[0];
      }
    }
  }
  if (where === 'rt' && !endReading()) return plain();
  const clean = h => h.replace(/[｜《》]/g, '').replace(/\s+/g, ' ');
  return words.map(w => {
    const b = clean(w.base).trim(), r = clean(w.reading ?? '').trim();
    if (!r) return clean(w.base);
    if (!b) return r;
    return marks && b.length <= 32 && r.length <= 64 && isReading(r) ? `｜${b}《${r}》` : `${b}(${r})`;          // (a mark only when it would be drawn as ruby)
  }).join('');
}

// Every <ruby>…</ruby> in the HTML replaced by what fn makes of its inside. One pass: a <ruby> that is never closed is left as it is.
function mapRuby(html, fn) {
  const open = /<ruby\b[^<>]*>/gi, close = /<\/ruby\s*>/gi;
  let out = '', at = 0, m;
  while ((m = open.exec(html))) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    if (!end) break;
    out += html.slice(at, m.index) + fn(html.slice(open.lastIndex, end.index));
    at = open.lastIndex = end.index + end[0].length;
  }
  return out + html.slice(at);
}

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
  s = mapRuby(s, inner => rubyMarks(inner, marks));
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
