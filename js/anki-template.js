// Anki card templates: what a note type's card shows on its front and back. Pure functions (no page, no files), tested by
// tests/anki-template.test.js. anki.js uses them for note types whose card shows more than the first two fields.
//
// In Anki a note type has card templates. Each one says what the front shows (qfmt) and what the back shows (afmt):
//   {{Field}}                the field's text
//   {{#Field}} ... {{/Field}}  only when the field has something in it       {{^Field}} ... {{/Field}}  only when it is empty
//   {{FrontSide}}            (back only) the front again, which the back usually starts with, then <hr id=answer>
//   {{furigana:Field}}       a filter: the field changed in some way (see FILTERS)

import { htmlToMarks } from './format.js';

// Anki's rule for a conditional section: a field is empty only when it holds nothing but ASCII whitespace and bare <br>, </br>, <div>, </div>
// tags (no attributes). &nbsp;, a picture (<img>), a sound, a <div class="x"> or any other content counts as filled.
export const fieldIsEmpty = html => /^(?:[ \t\n\v\f\r]|<\/?(?:br|div) ?\/?>)*$/i.test(String(html ?? ''));

const escapeHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Anki's reading syntax: "漢字[かんじ]" (a word, then its reading in brackets; a space before the word ends the one before).
// [sound:...] is not a reading. Long fields are left alone, so a huge field can't make the search slow.
const READING = / ?([^ >]+?)\[(.+?)\]/g;
const MAX_FILTERED = 100000;
const readings = (html, draw) => (html.length > MAX_FILTERED || !html.includes('[') ? html
  : html.replace(READING, (m, base, reading) => (/^(sound:|\$)/.test(reading) ? m : draw(base, reading))));

// The filters we know. Others (cloze:, edit:, tts and so on) show the field as it is.
//   text      the field without its HTML        hint  Anki folds the field behind a link; here it is simply shown
//   furigana  the reading above the word        kana  the readings only        kanji  the words only
const FILTERS = {
  text: html => escapeHTML(htmlToMarks(html, { marks: false })),
  hint: html => html,
  furigana: html => readings(html, (base, reading) => `<ruby>${base}<rt>${reading}</rt></ruby>`),
  kana: html => readings(html, (base, reading) => reading),
  kanji: html => readings(html, base => base)
};

// ---------- reading a template ----------
// A template becomes a list of pieces: { text }, { field, filters } or a section { name, not, kids }.
const MAX_DEPTH = 40;
const parsed = new Map();          // template text → pieces (a deck has the same few templates for thousands of notes)
function parseTemplate(fmt) {
  const src = String(fmt ?? '');
  if (parsed.has(src)) return parsed.get(src);
  // Scripts and styles are no text; a picture written into the template itself (a logo) is not the note's picture.
  const clean = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const root = { kids: [] }, stack = [root];
  const add = piece => stack.at(-1).kids.push(piece);
  const text = s => { const t = s.replace(/<img\b[^>]*>/gi, '').replace(/\s+/g, ' '); if (t) add({ text: t }); };      // (line breaks in a template are only spaces, as in a web page)
  let at = 0;
  for (const m of clean.matchAll(/\{\{([^{}]*)\}\}/g)) {
    text(clean.slice(at, m.index));
    at = m.index + m[0].length;
    const raw = m[1].trim();
    if (raw[0] === '#' || raw[0] === '^') {
      if (stack.length >= MAX_DEPTH) continue;
      const section = { name: raw.slice(1).trim(), not: raw[0] === '^', kids: [] };
      add(section); stack.push(section);
    } else if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      let i = stack.length - 1;
      while (i > 0 && stack[i].name !== name) i--;
      if (i > 0) stack.length = i;               // (a closing tag with no opening one is ignored)
    } else {
      const parts = raw.split(':').map(p => p.trim());
      add({ field: parts.pop(), filters: parts });
    }
  }
  text(clean.slice(at));
  if (parsed.size > 200) parsed.clear();
  parsed.set(src, root.kids);
  return root.kids;
}

// The note type's first card template, the one that makes the front → back card.
export const firstTemplate = model => (model?.templates || []).find(t => t?.ord === 0) || (model?.templates || [])[0] || null;

// The fields a template puts on the card (not the ones it only asks about in a {{#Field}} section, and not a {{type:Field}} box).
function shownIn(pieces, out = new Set()) {
  for (const p of pieces) {
    if (p.kids) shownIn(p.kids, out);
    else if (p.field !== undefined && !p.filters.includes('type') && p.field !== 'FrontSide') out.add(p.field);
  }
  return out;
}
// The names of the model's fields that the first card template shows, on either side: a Set.
export function shownFields(model) {
  const t = firstTemplate(model);
  if (!t) return new Set();
  const shown = shownIn([...parseTemplate(t.qfmt), ...parseTemplate(t.afmt)]);
  return new Set((model.fields || []).map(f => String(f).trim()).filter(f => shown.has(f)));
}

// ---------- drawing a card ----------
const MAX_OUT = 2_000_000;           // characters one side may grow to (a template that names a big field again and again)
const CONTROL = /[\u0001\u0002]/g;     // used inside this file as markers: never from a field

function draw(pieces, fields, front, budget) {
  let out = '';
  for (const p of pieces) {
    if (budget.left <= 0) break;
    let piece = '';
    if (p.text !== undefined) piece = p.text;
    else if (p.kids) {
      const filled = fields.has(p.name) && !fieldIsEmpty(fields.get(p.name));
      if (filled !== p.not) piece = draw(p.kids, fields, front, budget);          // {{#F}} when filled, {{^F}} when empty (an unknown field counts as empty)
    } else if (!p.filters.includes('type')) {                          // ({{type:F}} is the answer box, which the app draws itself)
      piece = p.field === 'FrontSide' ? front : fields.get(p.field) ?? '';
      for (const f of [...p.filters].reverse()) if (Object.hasOwn(FILTERS, f)) piece = FILTERS[f](piece);
    }
    budget.left -= piece.length;
    out += piece;
  }
  return out;
}

const ANSWER_LINE = /<hr\s+id\s*=\s*["']?answer["']?\s*\/?>/i;
const FRONT_MARK = '\u0002';

// A note drawn with its note type's first card template: { q, a } as HTML. `a` is only what the back adds: what comes after
// <hr id=answer> when the template has one, else the back without the {{FrontSide}} part (Review shows the front above the back).
//   fieldHTML  the note's fields (HTML), in the note type's order
export function renderCard(model, fieldHTML) {
  const t = firstTemplate(model);
  const fields = new Map();
  (model.fields || []).forEach((n, i) => {
    const name = String(n).trim();
    if (!fields.has(name)) fields.set(name, String(fieldHTML[i] ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(CONTROL, ''));
  });
  const q = draw(parseTemplate(t?.qfmt), fields, '', { left: MAX_OUT });
  let a = draw(parseTemplate(t?.afmt), fields, FRONT_MARK, { left: MAX_OUT });
  const hr = ANSWER_LINE.exec(a);
  if (hr) a = a.slice(hr.index + hr[0].length);
  return { q, a: a.split(FRONT_MARK).join('') };
}

// Card HTML → the app's card text, one line for each <div>, <p> and <br>. Bold, italics and lists become marks (format.js htmlToMarks),
// the readings of <ruby> too, and everything else (scripts, styles, pictures, sounds, other tags) is dropped: it is text and nothing else.
export function htmlToLines(html) {
  const s = String(html ?? '').replace(CONTROL, '').replace(/<\/?(?:div|p)\b[^>]*>/gi, '\u0001').replace(/\s*\u0001\s*/g, '\u0001');      // (\u0001: a line break between blocks)
  return htmlToMarks(s).replace(/\u0001*\n\u0001*/g, '\n').replace(/\u0001+/g, '\n')
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
