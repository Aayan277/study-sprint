// A note's other fields (item A): Anki notes often have more than a front and back. AnKing cloze notes, for example, have
// Text, Extra, Personal Notes, First Aid, Sketchy, and so on. Each extra field keeps its name and is shown on the back as a
// folded section ("First Aid", closed until you open it).
//
// On the card they are the list noteFields: [{ name, text }] (text in card text format, like a front or back). Every card
// of a note carries the same list, as with noteExtra. Pure functions (no page, no database) except the editor helpers at
// the bottom, which read and draw the form; tested by tests/anki.test.js and tests/export.test.js.

export const MAX_FIELDS = 24;         // per note
export const MAX_NAME = 60;           // characters in a field's name
export const MAX_TEXT = 20000;        // characters in a field's text

const escapeHTML = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Is this a good noteFields value? (Used when a backup is checked.)
export const validFields = list => Array.isArray(list) && list.length <= MAX_FIELDS
  && list.every(f => plainObject(f) && typeof f.name === 'string' && typeof f.text === 'string' && f.name.length <= MAX_NAME && f.text.length <= MAX_TEXT);

// Tidy a list of { name, text }: names trimmed and cut to 60 characters, empty fields dropped, text cut to 20,000
// characters with "…", at most 24 fields. Duplicate names are both kept.
// Returns { fields, cut } where cut counts the fields that were shortened or dropped for being over a limit.
export function cleanFields(list) {
  const fields = [];
  let cut = 0;
  for (const f of Array.isArray(list) ? list : []) {
    const text = String(f?.text ?? '').trim();
    if (!text) continue;
    if (fields.length >= MAX_FIELDS) { cut++; continue; }
    const name = String(f?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || `Field ${fields.length + 1}`;
    if (text.length > MAX_TEXT) { fields.push({ name, text: text.slice(0, MAX_TEXT - 1) + '…' }); cut++; } else fields.push({ name, text });
  }
  return { fields, cut };
}

// ---------- Anki's HTML ----------
// A field goes out as <details><summary>Name</summary>text</details>, which Anki shows as a folded section.
//   toHTML  turns card text into HTML (export.js passes toAnkiHTML)
export const toDetails = (fields, toHTML) =>
  (fields || []).map(f => `<details><summary>${escapeHTML(f.name)}</summary>${toHTML(f.text)}</details>`).join('');

// The reverse: pull the <details><summary> blocks out of a field's HTML.
// Returns { rest, fields: [{ name, html }] }: the HTML that is left, and each block's name (still HTML) and content.
const DETAILS = /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
const trimBreaks = html => String(html).replace(/^(\s|<br\s*\/?>)+|(\s|<br\s*\/?>)+$/gi, '');
export function parseDetails(html) {
  const fields = [];
  const rest = String(html ?? '').replace(DETAILS, (m, summary, body) => { fields.push({ name: summary, html: trimBreaks(body) }); return ''; });
  return { rest: fields.length ? trimBreaks(rest) : String(html ?? ''), fields };
}

// ---------- Review ----------
// The folded sections under an answer. isOpen(name) says whether a section was left open (Review remembers it for each
// field name on this device). format turns card text into HTML (format.js formatHTML, passed in so that this file, which the
// app loads at start for backup checks, needs nothing else).
export const noteFieldsHTML = (fields, isOpen, format) => (fields || []).map(f =>
  `<details class="note-field" data-field="${escapeHTML(String(f.name).toLowerCase())}" ${isOpen(f.name) ? 'open' : ''}><summary>${escapeHTML(f.name)}</summary><div class="note-field-body">${format(f.text)}</div></details>`).join('');

// ---------- the card editor ----------
// A fold "Other fields (N)" with a box for each field (labelled with its name) and a Remove field button.
export function noteFieldsEditHTML(p, fields) {
  if (!fields?.length) return '';
  return `<details class="card-info nf-ed" id="${p}Fields">
    <summary>Other fields (<span data-nf-count>${fields.length}</span>)</summary>
    ${fields.map((f, i) => `<div class="field nf-row" data-nf data-name="${escapeHTML(f.name)}">
      <label for="${p}Nf${i}"><span>${escapeHTML(f.name)}</span></label>
      <textarea id="${p}Nf${i}" rows="3" data-nf-text>${escapeHTML(f.text)}</textarea>
      <button class="btn ghost small" type="button" data-nf-remove aria-label="Remove field ${escapeHTML(f.name)}">Remove field</button></div>`).join('')}
  </details>`;
}
// The fields as they are now in the form (a field with no text is dropped), or undefined when the form has none.
export function readNoteFields(p) {
  const box = document.getElementById(p + 'Fields');
  if (!box) return undefined;
  const list = [...box.querySelectorAll('[data-nf]')].map(r => ({ name: r.dataset.name, text: r.querySelector('[data-nf-text]').value.trim() })).filter(f => f.text);
  return cleanFields(list).fields;
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', e => {
    const b = e.target.closest?.('[data-nf-remove]');
    if (!b) return;
    const box = b.closest('.nf-ed'), row = b.closest('[data-nf]');
    const next = row.nextElementSibling?.querySelector?.('textarea') || row.previousElementSibling?.querySelector?.('textarea');
    row.remove();
    const left = box.querySelectorAll('[data-nf]').length;
    box.querySelector('[data-nf-count]').textContent = left;
    if (next) next.focus(); else box.querySelector('summary').focus();
  });
}
