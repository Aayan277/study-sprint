// Card formatting: bold, italics and bullet lists, saved as simple marks in the card's text.
// Pure functions (no page), tested by tests/format.test.js.
//
//   **bold**        *italic*        - a bullet point (a line starting with "- " or "• ")
//
// Cards stay plain text underneath, so they sync, back up and export cleanly. The marks only count when
// they hug a word: "5 * 3 * 2" stays as it is. card-editor.js gives the B / I / • buttons.

const escapeHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BOTH = /\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g;      // ***bold and italic***
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*/g;
const ITALIC = /(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g;
const BULLET = /^\s*[-•]\s+(.*)$/;

const inline = html => html.replace(BOTH, '<b><i>$1</i></b>').replace(BOLD, '<b>$1</b>').replace(ITALIC, '$1<i>$2</i>');

// Card text → HTML for showing it (everything else is escaped, so card text can't inject anything).
// No line-break characters in the result: lines are joined with <br>, and bullet lines become a list.
export function formatHTML(text) {
  const blocks = [];
  let list = null;
  for (const line of escapeHTML(text).split(/\r?\n/)) {
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
  return out;
}

// Card text without the marks: for typed answers, Play's options, searching and short previews.
export const plainText = text => String(text ?? '')
  .split(/\r?\n/).map(l => { const m = BULLET.exec(l); return m ? `• ${m[1]}` : l; }).join('\n')
  .replace(BOTH, '$1').replace(BOLD, '$1').replace(ITALIC, '$1$2');

// Does the text use any formatting marks?
export const hasFormatting = text => {
  const s = String(text ?? '');
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
