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

const ITALIC = /(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g;

// Linear scanners. A text from an imported file or a synced card can be hostile (50 KB of "**a " or "<ruby"), and a regex that tries every
// start and rereads to the end of the text each time takes seconds. These give the same answers as the regexes in the comments, in one pass.
const isSpace = ch => /\s/.test(ch);
const LINE_END = /[\n\r\u2028\u2029]/g;
// A search for "the first match at or after pos" that remembers its last answer: asking again from a later position (up to that answer)
// costs nothing, and "nothing left" stays nothing. The positions asked about only ever go up.
const memoNext = find => {
  let from = -1, at = -1;
  return pos => (from >= 0 && pos >= from && (at < 0 || pos <= at) ? at : (from = pos, at = find(pos)));
};

// ***bold and italic*** (n = 3) or **bold** (n = 2), as the regex  \*\*(?=\S)(.+?)(?<=\S)\*\*  does: the inside starts and ends on a non-space,
// has no line break, and ends at the first closing run of stars that follows a non-space. The text between the marks becomes
// open + inside + close. testOnly: just say whether there is any such pair.
function replaceMarks(text, n, open, close, testOnly = false) {
  const stars = '*'.repeat(n);
  let i = text.indexOf(stars);
  if (i < 0) return testOnly ? false : text;
  const closer = memoNext(pos => { for (let j = text.indexOf(stars, pos); j >= 0; j = text.indexOf(stars, j + 1)) if (!isSpace(text[j - 1])) return j; return -1; });
  const lineEnd = (re => memoNext(pos => { re.lastIndex = pos; const m = re.exec(text); return m ? m.index : -1; }))(new RegExp(LINE_END));
  let out = '', at = 0;
  while (i >= 0) {
    const a = i + n;                                     // where the inside starts
    if (a < text.length && !isSpace(text[a])) {
      const j = closer(a + 1);
      if (j < 0) break;                                  // no closing marks left anywhere: no later start can match either
      const brk = lineEnd(a);
      if (brk < 0 || brk > j) {
        if (testOnly) return true;
        out += text.slice(at, i) + open + text.slice(a, j) + close;
        at = i = j + n;
        i = text.indexOf(stars, i);
        continue;
      }
    }
    i = text.indexOf(stars, i + 1);
  }
  return testOnly ? false : out + text.slice(at);
}
const BOTH = (text, open, close) => replaceMarks(text, 3, open, close);
const BOLD = (text, open, close) => replaceMarks(text, 2, open, close);

// A bullet line ("- text", "• text"): the text after the bullet, or null. Same as  /^\s*[-•]\s+(.*)$/  (the spaces before and after the
// bullet are taken whole, and the text must have no line break in it).
function bulletText(line) {
  let b = 0;
  while (b < line.length && isSpace(line[b])) b++;
  if (line[b] !== '-' && line[b] !== '•') return null;
  let c = b + 1;
  if (c >= line.length || !isSpace(line[c])) return null;
  while (c < line.length && isSpace(line[c])) c++;
  const rest = line.slice(c);
  return new RegExp(LINE_END).test(rest) ? null : rest;
}
// Does any line start with a bullet?  Same as  /^\s*[-•]\s+/m.test(text)  : a bullet after spaces (and line breaks) that begin at the
// very start of the text, or that include a line break (a line starts right after it).
function hasBulletLine(text) {
  let start = true, brk = false;
  const lineEnd = new RegExp(LINE_END.source);
  for (let b = 0; b < text.length; b++) {
    const ch = text[b];
    if (isSpace(ch)) { if (lineEnd.test(ch)) brk = true; continue; }
    if ((ch === '-' || ch === '•') && b + 1 < text.length && isSpace(text[b + 1]) && (start || brk)) return true;
    start = brk = false;
  }
  return false;
}

// Furigana. Both brackets are Japanese ones, so ordinary text (math, [blanks], markdown links) never looks like it. The word is short, and the
// reading is not Chinese characters: 《 》 are also the brackets of a book title in Chinese ("推荐｜三体《刘慈欣》"), and that is no furigana.
const RUBY = /｜([^｜《》\n]{1,32}?)《([^｜《》\n]{1,64}?)》/g;
const isReading = reading => !/\p{Script=Han}/u.test(reading);
const hasRuby = s => { for (const m of s.matchAll(RUBY)) if (isReading(m[2])) return true; return false; };

// (The text is already escaped here, so the word and its reading can't bring any HTML with them.)
const inline = html => BOLD(BOTH(html.replace(RUBY, (m, base, reading) => (isReading(reading) ? `<ruby>${base}<rt>${reading}</rt></ruby>` : m)), '<b><i>', '</i></b>'), '<b>', '</b>').replace(ITALIC, '$1<i>$2</i>');

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
    const item = bulletText(line);
    if (item !== null) { if (!list) blocks.push(list = []); list.push(inline(item)); continue; }
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
const stripLines = (s, ruby) => s
  .split(/\r?\n/).map(l => { const item = bulletText(l); return item !== null ? `• ${item}` : l; }).join('\n')
  .replace(RUBY, (m, base, reading) => (!isReading(reading) ? m : ruby === 'base' ? base : ruby === 'reading' ? reading : `${base}(${reading})`));
const stripMarks = (s, ruby = 'paren') => BOLD(BOTH(stripLines(s, ruby), '', ''), '', '').replace(ITALIC, '$1$2');

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
  return replaceMarks(s, 2, '', '', true) || hasRuby(s) || new RegExp(ITALIC.source).test(s) || hasBulletLine(s);
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

// Tags found in one pass (the regexes these replace reread to the end of the text from every "<" that has no ">" after it, which a hostile
// field can use to make them take seconds). Each is the same as the regex in its comment, with a failed search remembered so it is not repeated.
const sameWord = (s, pos, word) => {                      // the lower case word at pos, in any case (ASCII only, like a regex's i flag)
  for (let k = 0; k < word.length; k++) {
    let c = s.charCodeAt(pos + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== word.charCodeAt(k)) return false;
  }
  return true;
};
// <name ...> for any of the names, as  <(name1|name2)\b[^>]*>  (word: with the \b; without it, "<link" is a "<li" tag too). Replaced by
// fn(name), or with pair: true the whole  <name ...> inside </name>  (the first closing tag, whatever is between) by fn(name, inside).
// A tag that is never closed, or has no ">" at all, is left as it is.
function replaceTags(html, names, { word = false, pair = false }, fn) {
  const nextGt = memoNext(pos => html.indexOf('>', pos));
  const unclosed = {};
  const findClose = (name, from) => {
    for (let q = html.indexOf('</', from); q >= 0; q = html.indexOf('</', q + 1)) if (sameWord(html, q + 2, name) && html[q + 2 + name.length] === '>') return q;
    return -1;
  };
  let out = '', at = 0, p = html.indexOf('<');
  while (p >= 0) {
    const name = names.find(n => sameWord(html, p + 1, n));
    let end = -1, repl = '';
    if (name && !(word && /\w/.test(html.charAt(p + 1 + name.length)))) {
      const gt = nextGt(p + 1 + name.length);
      if (gt < 0) break;                                    // no ">" left anywhere: no later tag can match either
      if (!pair) { end = gt + 1; repl = fn(name); }
      else if (!unclosed[name]) {
        const q = findClose(name, gt + 1);
        if (q < 0) unclosed[name] = true;                   // no closing tag left: a later one can't find one either
        else { end = q + name.length + 3; repl = fn(name, html.slice(gt + 1, q)); }
      }
    }
    if (end < 0) { p = html.indexOf('<', p + 1); continue; }
    out += html.slice(at, p) + repl;
    at = end;
    p = html.indexOf('<', at);
  }
  return out + html.slice(at);
}
// Every "<" … ">" with something in between gone: the same as  .replace(/<[^>]+>/g, '')
function stripTags(html) {
  let out = '', at = 0, p = html.indexOf('<');
  while (p >= 0) {
    const gt = html.indexOf('>', p + 1);
    if (gt < 0) break;
    if (gt === p + 1) { p = html.indexOf('<', p + 1); continue; }          // "<>" is not a tag
    out += html.slice(at, p);
    at = gt + 1;
    p = html.indexOf('<', at);
  }
  return out + html.slice(at);
}
// Every [sound:…] gone (up to the first "]"): the same as  .replace(/\[sound:[^\]]*\]/g, '')
function stripSounds(html) {
  let out = '', at = 0, p = html.indexOf('[sound:');
  while (p >= 0) {
    const end = html.indexOf(']', p + 7);
    if (end < 0) break;
    out += html.slice(at, p);
    at = end + 1;
    p = html.indexOf('[sound:', at);
  }
  return out + html.slice(at);
}

// HTML → card text, keeping bold, italics and lists as marks (from Anki fields, or the rich editor on a
// computer). Everything else (colors, fonts, images…) is dropped.
//   marks: false gives plain text instead (bullets as "• ").
export function htmlToMarks(html, { marks = true } = {}) {
  // Marks must hug the words, so move spaces from inside <b> … </b> to outside.
  const wrap = (mark, inner) => {
    let a = 0, z = inner.length;                                 // (the spaces at each end, taken whole)
    while (a < z && isSpace(inner[a])) a++;
    while (z > a && isSpace(inner[z - 1])) z--;
    return a < z ? `${inner.slice(0, a)}${mark}${inner.slice(a, z)}${mark}${inner.slice(z)}` : inner;
  };
  let s = stripSounds(replaceTags(String(html ?? ''), ['style', 'script'], { pair: true }, () => ''));
  s = mapRuby(s, inner => rubyMarks(inner, marks));
  if (marks) {
    s = replaceTags(s, ['b', 'strong'], { word: true, pair: true }, (name, inner) => wrap('**', inner));
    s = replaceTags(s, ['i', 'em'], { word: true, pair: true }, (name, inner) => wrap('*', inner));
  }
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(li|tr|h\d|ul|ol)>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '');
  s = replaceTags(s, ['div', 'p', 'ul', 'ol'], { word: true }, () => '\n');
  s = replaceTags(s, ['li'], {}, () => (marks ? '- ' : '• '));
  return stripTags(s)
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
  const all = lines.every(l => bulletText(l) !== null || !l.trim());
  const changed = lines.map(l => (!l.trim() ? l : all ? l.replace(/^\s*[-•]\s+/, '') : bulletText(l) !== null ? l : `- ${l}`)).join('\n');
  const out = value.slice(0, from) + changed + value.slice(to);
  return { value: out, start: from, end: from + changed.length };
}

// ---------- what a card face shows ----------
// The deck label on a card: only the last two levels of the path ("Unit 2 › Synapses"), the full path as a tooltip.
export const shortDeckPath = path => String(path || '').split(' › ').slice(-2).join(' › ');
// How long an answer is: 'long' from 160 characters, 'xlong' from 320 (smaller, left-aligned; see .flash-back in styles.css).
export const answerSize = text => (text.length > 320 ? ' long xlong' : text.length > 160 ? ' long' : '');
// Several short lines (a template card: the word, its meaning, the question...): the first line leads and the others sit under it,
// smaller and quieter (.fl-lead and .fl-rest in styles.css). Only 3 to 8 plain lines, the first no longer than `first` characters, the others
// no longer than `rest`, all of it no longer than `total`; anything else (a paragraph, a list, a formula, a blank line) is left as it is.
// `text` is the plain text, `html` what formatHTML made of it; the words and their order stay the same, so a screen reader reads it as before.
export function leadLines(text, html, { first, rest, total }) {
  const lines = String(text).split('\n').map(l => l.trim());
  if (lines.length < 3 || lines.length > 8 || lines.some(l => !l) || text.length > total) return html;
  if (lines[0].length > first || lines.some((l, i) => i && l.length > rest)) return html;
  if (/<(?:ul|ol|img|div|p|pre|table|button|audio|h\d)\b|class="tex/.test(html)) return html;
  const cut = html.indexOf('<br>');
  if (cut < 1 || html.split('<br>').length !== lines.length) return html;
  return `<span class="fl-lead">${html.slice(0, cut + 4)}</span><span class="fl-rest">${html.slice(cut + 4)}</span>`;
}
export const isLead = html => html.startsWith('<span class="fl-lead">');
export const FRONT_LINES = { first: 18, rest: 48, total: 120 }, BACK_LINES = { first: 18, rest: 80, total: 160 };
