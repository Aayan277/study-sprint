// A searchable deck tree in a sheet: choose one deck, or "All decks". Stats uses it for its course picker; it is
// written to be reused (Play, Study options) with different `title`, `allLabel` and `counts`.
//
//   openDeckPicker({ decks, selected, title, allLabel, counts, onPick })
//     decks     every deck (the tree is made from parentId)
//     selected  the chosen deck's id, or '' for all decks
//     allLabel  the first row's text; null leaves that row out (a picker that needs a real deck)
//     counts    optional Map deck id → a short text shown at the right of its row (e.g. "12 due")
//     onPick(id)  called with the deck's id ('' for all decks) after the sheet closes

import { $, esc, plural, openSheet, closeSheet, icon } from './ui.js';
import { deckTreeRows } from './deck-tree.js';

export function openDeckPicker({ decks, selected = '', title = 'Choose a deck', allLabel = 'All decks', counts = null, onPick }) {
  const colors = new Map(decks.map(d => [d.id, d.color]));
  const rowHTML = r => `<li role="presentation"><button type="button" class="pick-row${r.context ? ' ctx' : ''}" role="option" data-id="${esc(r.id)}" aria-selected="${r.id === selected}" style="--depth:${r.depth};--deck:${esc(colors.get(r.id) || 'var(--accent)')}">
      <i class="dot" aria-hidden="true"></i><span class="pick-name">${esc(r.name)}${r.course ? ` <small>${esc(r.course)}</small>` : ''}</span>${counts?.has(r.id) ? `<span class="pick-n mono">${esc(counts.get(r.id))}</span>` : ''}</button></li>`;
  const allRow = allLabel === null ? '' : `<li role="presentation"><button type="button" class="pick-row pick-all" role="option" data-id="" aria-selected="${selected === ''}">
      <span class="pick-name">${esc(allLabel)}</span></button></li>`;
  openSheet(`
    <h2 id="sheetTitle">${esc(title)}</h2>
    <label class="deck-search">${icon('search')}<input id="pickQ" type="search" placeholder="Search ${plural(decks.length, 'deck')}" aria-label="Search decks" autocomplete="off"></label>
    <ul class="pick-list" id="pickList" role="listbox" aria-label="Decks"></ul>
    <p class="note" id="pickNone" hidden></p>`);
  const draw = () => {
    const q = $('pickQ').value;
    const rows = deckTreeRows(decks, q);
    $('pickList').innerHTML = (q.trim() ? '' : allRow) + rows.map(rowHTML).join('');
    $('pickNone').hidden = rows.length > 0;
    $('pickNone').textContent = rows.length ? '' : `No decks match “${q.trim()}”.`;
  };
  draw();
  $('pickQ').addEventListener('input', draw);
  const pick = id => { closeSheet(); onPick(id); };
  $('pickList').addEventListener('click', e => { const b = e.target.closest('.pick-row'); if (b) pick(b.dataset.id); });
  // Arrow keys walk the list from the search box (and back); Enter or Space on a row picks it, as for any button.
  const rows = () => [...document.querySelectorAll('#pickList .pick-row')];
  $('pickQ').addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); (rows().find(r => r.getAttribute('aria-selected') === 'true') || rows()[0])?.focus(); } });
  $('pickList').addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = rows(), i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowUp' && i <= 0) $('pickQ').focus(); else list[Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
  });
  // With a mouse, start typing straight away. On a phone the keyboard waits until you tap the box.
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) $('pickQ').focus();
  else rows().find(r => r.getAttribute('aria-selected') === 'true')?.scrollIntoView({ block: 'center' });
}
