// Anki card templates: what a note type's card shows on its front and back. Pure functions (no page, no files), tested by
// tests/anki-template.test.js. anki.js uses them for note types whose card shows more than the first two fields.
//
// In Anki a note type has card templates. Each one says what the front shows (qfmt) and what the back shows (afmt):
//   {{Field}}                the field's text
//   {{#Field}} ... {{/Field}}  only when the field has something in it       {{^Field}} ... {{/Field}}  only when it is empty
//   {{FrontSide}}            (back only) the front again, which the back usually starts with, then <hr id=answer>
//   {{furigana:Field}}       a filter: the field changed in some way (see FILTERS)
// A {{Field}} written inside a tag (<span data-x="{{Field}}">) or an HTML comment is not on the card, and a template's <!-- comment --> is dropped.

import { htmlToMarks } from './format.js';

// Anki's rule for a conditional section: a field is empty only when it holds nothing but ASCII whitespace and bare <br>, </br>, <div>, </div>
// tags (no attributes). &nbsp;, a picture (<img>), a sound, a <div class="x"> or any other content counts as filled.
export const fieldIsEmpty = html => /^(?:[ \t\n\v\f\r]|<\/?(?:br|div) ?\/?>)*$/i.test(String(html ?? ''));

const SCRIPTS = /<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const escapeHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Anki's reading syntax: "漢字[かんじ]" (a word, then its reading in brackets; a space before the word ends the one before).
// [sound:...] is not a reading. The word and the reading are short and have no brackets of their own, and a long field is left alone,
// so a hostile field can't make the search slow.
const READING = / ?([^ >[\]]{1,64})\[([^\]\n]{1,128})\]/g;
const MAX_FILTERED = 50000;
const readings = (html, draw) => (html.length > MAX_FILTERED || !html.includes('[') ? html
  : html.replace(READING, (m, base, reading) => (/^(sound:|\$)/.test(reading) ? m : draw(base, reading))));

// The filters we know. Others (cloze:, edit:, tts and so on) show the field as it is.
//   text      the field without its HTML        hint  Anki folds the field behind a link; here the field is a folded section (see shownIn)
//   furigana  the reading above the word        kana  the readings only        kanji  the words only
const FILTERS = {
  text: html => escapeHTML(htmlToMarks(html, { marks: false })),
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
  // Scripts, styles and comments are no text (an unclosed one runs to the end, as in a web page); a picture written into the template itself
  // (a logo) is not the note's picture. The template's own <hr id=answer> becomes ANSWER_MARK, so a field with such a line in it can't pass for it.
  const clean = src.replace(SCRIPTS, '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(ANSWER_LINE_ALL, ANSWER_MARK);
  const root = { kids: [] }, stack = [root];
  const add = piece => stack.at(-1).kids.push(piece);
  const text = s => { const t = s.replace(/<img\b[^<>]*>/gi, '').replace(/\s+/g, ' '); if (t) add({ text: t }); };      // (line breaks in a template are only spaces, as in a web page)
  let at = 0, inTag = false;          // inTag: the next {{ }} is written inside a tag (after a "<" with no ">" yet)
  for (const m of clean.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const before = clean.slice(at, m.index);
    text(before);
    let lt = -1;
    for (const t of before.matchAll(/<[a-z/!?]/gi)) lt = t.index;
    const gt = before.lastIndexOf('>');
    if (lt > gt) inTag = true; else if (gt > lt) inTag = false;
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
      add({ field: parts.pop(), filters: parts, inTag });
    }
  }
  text(clean.slice(at));
  if (parsed.size > 200) parsed.clear();
  parsed.set(src, root.kids);
  return root.kids;
}

// The note type's first card template, the one that makes the front → back card.
export const firstTemplate = model => (model?.templates || []).find(t => t?.ord === 0) || (model?.templates || [])[0] || null;
// The card template with this card number (ord), or null. (A template with no number of its own counts by its place in the list.)
export const templateAt = (model, ord) => (model?.templates || []).find((t, i) => (Number.isInteger(t?.ord) ? t.ord : i) === ord) || null;

// The fields a template puts on the card (not the ones it only asks about in a {{#Field}} section, not a {{type:Field}} box, not one
// written inside a tag, and not one only behind {{hint:Field}}, which Anki shows on a click: that one stays a folded section).
function shownIn(pieces, out = new Set()) {
  for (const p of pieces) {
    if (p.kids) shownIn(p.kids, out);
    else if (p.field !== undefined && !p.inTag && !p.filters.includes('type') && !p.filters.includes('hint') && p.field !== 'FrontSide') out.add(p.field);
  }
  return out;
}
// The names of the model's fields that a card template shows, on either side: a Set. By default the first template; pass `templates`
// (a list) for a note that brings several cards, and every field any of them shows counts.
export function shownFields(model, templates = [firstTemplate(model)]) {
  const list = templates.filter(Boolean);
  if (!list.length) return new Set();
  const shown = shownIn(list.flatMap(t => [...parseTemplate(t.qfmt), ...parseTemplate(t.afmt)]));
  return new Set((model.fields || []).map(f => String(f).trim()).filter(f => shown.has(f)));
}

// ---------- drawing a card ----------
const MAX_OUT = 2_000_000;           // characters one side may grow to (a template that names a big field again and again)
const CONTROL = /[\u0001-\u0003]/g;     // used inside this file as markers: never from a field

function draw(pieces, fields, front, budget) {
  let out = '';
  for (const p of pieces) {
    if (budget.left <= 0) break;
    let piece = '';
    if (p.text !== undefined) piece = p.text;
    else if (p.kids) {
      const filled = fields.has(p.name) && !fieldIsEmpty(fields.get(p.name));
      if (filled !== p.not) piece = draw(p.kids, fields, front, budget);          // {{#F}} when filled, {{^F}} when empty (an unknown field counts as empty)
    } else if (!p.inTag && !p.filters.includes('type') && !p.filters.includes('hint')) {          // ({{type:F}} is the answer box, which the app draws itself; a field inside a tag or behind hint: shows nothing here)
      piece = p.field === 'FrontSide' ? front : fields.get(p.field) ?? '';
      for (const f of [...p.filters].reverse()) if (Object.hasOwn(FILTERS, f)) piece = FILTERS[f](piece);
    }
    budget.left -= piece.length;
    out += piece;
  }
  return out;
}

const ANSWER_LINE_ALL = /<hr\s+id\s*=\s*["']?answer["']?\s*\/?>/gi;
const ANSWER_MARK = '\u0003';            // where the template's own <hr id=answer> was
const FRONT_MARK = '\u0002';

// A note drawn with one of its note type's card templates (the first unless `template` is given): { q, a } as HTML. `a` is only what the back adds: what comes after
// <hr id=answer> when the template has one, else the back without the {{FrontSide}} part (Review shows the front above the back).
//   fieldHTML  the note's fields (HTML), in the note type's order
export function renderCard(model, fieldHTML, template = firstTemplate(model)) {
  const t = template;
  const fields = new Map();
  (model.fields || []).forEach((n, i) => {
    const name = String(n).trim();
    if (!fields.has(name)) fields.set(name, String(fieldHTML[i] ?? '').replace(SCRIPTS, '').replace(CONTROL, ''));
  });
  const q = draw(parseTemplate(t?.qfmt), fields, '', { left: MAX_OUT }).split(ANSWER_MARK).join('');
  let a = draw(parseTemplate(t?.afmt), fields, FRONT_MARK, { left: MAX_OUT });
  const cut = a.indexOf(ANSWER_MARK);
  if (cut >= 0) a = a.slice(cut + 1);
  return { q, a: a.split(FRONT_MARK).join('').split(ANSWER_MARK).join('') };
}

// Card HTML → the app's card text, one line for each <div>, <p> and <br>. Bold, italics and lists become marks (format.js htmlToMarks),
// the readings of <ruby> too, and everything else (scripts, styles, pictures, sounds, other tags) is dropped: it is text and nothing else.
export function htmlToLines(html) {
  const s = String(html ?? '').replace(CONTROL, '').replace(/<\/?(?:div|p)\b[^<>]*>/gi, '\u0001').split('\u0001').map(l => l.trim()).join('\u0001');      // (\u0001: a line break between blocks)
  return htmlToMarks(s).replace(/\u0001{2,}/g, '\u0001').replace(/\u0001?\n\u0001?/g, '\n').replace(/\u0001/g, '\n')
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
