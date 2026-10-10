// The front / back boxes for editing a card, with B / I / • (bold, italic, bullet list) buttons.
// Formatting is saved as simple marks in the text (see format.js), whichever box is used:
//   phones and tablets   a plain text box, the buttons add the marks, and a preview shows the result
//   computers            a Word-style box: text looks bold while you type (Ctrl/⌘+B, Ctrl/⌘+I), and is
//                        turned back into marks when saved
// Usage: put cardTextField(...) in the form's HTML, then read it with readCardText(id) / clear it with
// setCardText(id, ''). The buttons and shortcuts are wired once, below, for every box.

import { formatHTML, htmlToMarks, toggleWrap, toggleBullets, hasFormatting } from './format.js';
import { esc, toast } from './ui.js';
import { addImage, imgHTML } from './media.js';

const RICH = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');

//   image: the side's picture (a media id), shown under the box with Remove; the toolbar's picture
//          button adds or replaces it. Read it back with readCardImage(id).
export function cardTextField(id, label, value = '', { rows = 2, placeholder = '', image = null } = {}) {
  const pics = `<div class="img-row" id="${id}Img" data-media-id="${esc(image || '')}">${pictureHTML(id, image)}</div>
      <input type="file" id="${id}File" accept="image/*" hidden data-img-file="${id}">`;
  const tools = `<span class="fmt-tools" role="toolbar" aria-label="Formatting">
      <button type="button" data-fmt="bold" data-for="${id}" aria-label="Bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" data-fmt="italic" data-for="${id}" aria-label="Italic" title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" data-fmt="list" data-for="${id}" aria-label="Bullet list" title="Bullet list">•</button>
      <button type="button" data-img-add="${id}" aria-label="Add a picture" title="Add a picture"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5L5 20"/></svg></button></span>`;
  if (RICH.matches) {
    return `<div class="field fmt-field"><span class="fmt-head"><span id="${id}Lbl">${esc(label)}</span>${tools}</span>
      <div class="rich" id="${id}" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="${id}Lbl"
        data-rich="1" data-placeholder="${esc(placeholder)}" style="--rows:${rows}">${formatHTML(value)}</div>${pics}</div>`;
  }
  return `<div class="field fmt-field"><span class="fmt-head"><label for="${id}">${esc(label)}</label>${tools}</span>
      <textarea id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
      <div class="fmt-preview" id="${id}Prev" aria-label="Preview" ${hasFormatting(value) ? '' : 'hidden'}>${formatHTML(value)}</div>${pics}</div>`;
}

const pictureHTML = (id, image) => (image
  ? `${imgHTML(image, 'img-thumb')}<button type="button" class="btn ghost small" data-img-remove="${id}">Remove picture</button>` : '');

// The side's picture (a media id), or null.
export const readCardImage = id => document.getElementById(id + 'Img')?.dataset.mediaId || null;
export function setCardImage(id, image) {
  const row = document.getElementById(id + 'Img');
  row.dataset.mediaId = image || '';
  row.innerHTML = pictureHTML(id, image);
}

// The box's text, with formatting as marks.
export function readCardText(id) {
  const el = document.getElementById(id);
  return el.dataset.rich ? htmlToMarks(el.innerHTML) : el.value;
}
export function setCardText(id, text) {
  const el = document.getElementById(id);
  if (el.dataset.rich) el.innerHTML = formatHTML(text);
  else { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
}

function applyFormat(id, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.dataset.rich) {
    el.focus();
    document.execCommand(kind === 'list' ? 'insertUnorderedList' : kind);
    return;
  }
  const r = kind === 'list'
    ? toggleBullets(el.value, el.selectionStart, el.selectionEnd)
    : toggleWrap(el.value, el.selectionStart, el.selectionEnd, kind === 'bold' ? '**' : '*');
  el.value = r.value;
  el.focus();
  el.setSelectionRange(r.start, r.end);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Pictures: the toolbar button opens the photo picker; the chosen photo is shrunk and saved straight away.
document.addEventListener('click', e => {
  const add = e.target.closest?.('[data-img-add]');
  if (add) document.getElementById(add.dataset.imgAdd + 'File')?.click();
  const rm = e.target.closest?.('[data-img-remove]');
  if (rm) setCardImage(rm.dataset.imgRemove, null);
});
document.addEventListener('change', async e => {
  const id = e.target.dataset?.imgFile;
  if (!id || !e.target.files[0]) return;
  const file = e.target.files[0];
  e.target.value = '';
  const row = document.getElementById(id + 'Img');
  row.innerHTML = '<span class="muted small">Adding picture…</span>';
  try {
    setCardImage(id, await addImage(file));
  } catch (err) {
    console.error(err);
    setCardImage(id, row.dataset.mediaId || null);
    toast(err.message || "Couldn't add that picture");
  }
});

// Pressing a button mustn't take the focus (and the selection) away from the box.
document.addEventListener('mousedown', e => { if (e.target.closest?.('[data-fmt]')) e.preventDefault(); });
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-fmt]');
  if (b) applyFormat(b.dataset.for, b.dataset.fmt);
});
// The live preview under a plain box.
document.addEventListener('input', e => {
  const prev = e.target.id && document.getElementById(e.target.id + 'Prev');
  if (!prev || !prev.classList.contains('fmt-preview')) return;
  prev.innerHTML = formatHTML(e.target.value);
  prev.hidden = !hasFormatting(e.target.value);
});
// Ctrl/⌘+B and Ctrl/⌘+I in either kind of box.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'b' && k !== 'i') return;
  const t = e.target;
  if (!t?.id || !(t.dataset?.rich || document.getElementById(t.id + 'Prev'))) return;
  e.preventDefault();
  applyFormat(t.id, k === 'b' ? 'bold' : 'italic');
});
// Pasting into the Word-style box brings in plain text only (no fonts or colors from other sites).
document.addEventListener('paste', e => {
  if (!e.target.closest?.('[data-rich]')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
