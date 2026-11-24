// The Recently deleted sheet: Settings → Your data → More settings → Recently deleted. Lazy loaded (settings.js).
// One row per delete (cards or a deck), with Restore and Delete now; Empty clears the list. The explanation is in js/help.js
// ("recently-deleted"), not on this screen. The work itself is in js/trash.js.

import * as db from './db.js';
import * as trash from './trash.js';
import { daysLeft } from './trash-logic.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon } from './ui.js';
import { helpLink } from './help.js';
import { openDeckPicker } from './deck-picker.js';
import { drawSidebar } from './sidebar.js';
import { go as navGo } from './nav.js';

const DAY = 86400000;

const ago = (at, now) => {
  const d = Math.max(0, Math.floor((now - at) / DAY));
  return d === 0 ? 'Deleted today' : `Deleted ${plural(d, 'day')} ago`;
};

// The text of one row. Exported for the tests.
export function rowHTML(e, now = Date.now()) {
  const left = daysLeft(e, now);
  const counts = [plural(e.counts?.cards || 0, 'card'), e.counts?.reviews ? plural(e.counts.reviews, 'review') : ''].filter(Boolean).join(' · ');
  const when = `${ago(e.deletedAt, now)}${left <= 3 ? ` · ${plural(Math.max(1, left), 'day')} left` : ''}`;
  return `<li class="tr-row" data-id="${esc(e.id)}">
    <span class="tr-ico" aria-hidden="true">${icon(e.kind === 'deck' ? 'layers' : 'trash')}</span>
    <div class="tr-main"><b class="tr-title">${esc(e.title || 'Deleted cards')}</b>
      <span class="tr-meta">${esc(counts)}</span><span class="tr-meta">${esc(when)}</span></div>
    <div class="tr-acts"><button class="btn primary small" type="button" data-act="restore">Restore</button>
      <button class="btn ghost small" type="button" data-act="drop">Delete now</button></div>
    <div class="tr-box"></div></li>`;
}

export async function openTrashSheet({ now = () => Date.now() } = {}) {
  openSheet(`
    <h2 id="sheetTitle">Recently deleted</h2>${helpLink('recently-deleted', '?', 'About Recently deleted')}
    <div id="trBox"></div>
    <ul class="tr-list" id="trList" aria-label="Recently deleted"></ul>
    <div class="sheet-actions">
      <button class="btn ghost danger" type="button" id="trEmpty" hidden>Empty</button>
      <button class="btn ghost" type="button" id="trClose">Close</button>
    </div>`);
  $('trClose').addEventListener('click', closeSheet);
  let busy = false;

  const draw = async () => {
    const entries = await trash.list({ now: now() });
    if (!$('trList')) return;                          // the sheet was closed meanwhile
    $('trList').innerHTML = entries.length ? entries.map(e => rowHTML(e, now())).join('') : '<li class="tr-none"><div class="empty"><b>Nothing here</b></div></li>';
    $('trEmpty').hidden = !entries.length;
    return entries;
  };

  // A small yes/no inside the sheet (not a browser pop-up), like the other confirmations.
  const ask = (box, text, buttons) => new Promise(resolve => {
    box.innerHTML = `<div class="confirm" role="alertdialog" aria-label="${esc(text)}"><p>${esc(text)}</p><div class="sheet-actions">${buttons.map(([v, label, cls]) => `<button class="btn ${cls || 'ghost'}" type="button" data-v="${v}">${esc(label)}</button>`).join('')}</div></div>`;
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { box.innerHTML = ''; resolve(b.dataset.v); }));
    box.querySelector('button')?.focus();
  });

  // The card's deck was deleted too: restore it as well, or pick another deck.
  const pickDeck = (box) => async ({ name, inTrash }) => {
    const text = inTrash ? `Its deck “${name}” was deleted too.` : `Its deck “${name}” is gone.`;
    const v = await ask(box, text, [...(inTrash ? [['too', `Restore “${name}” too`, 'primary']] : []), ['pick', 'Choose a deck', inTrash ? 'ghost' : 'primary'], ['no', 'Cancel']]);
    if (v === 'too') return { restoreToo: true };
    if (v !== 'pick') return null;
    return new Promise(resolve => {
      const sheet = $('sheet');
      sheet.addEventListener('close', () => resolve(null), { once: true });          // dismissed without a choice (after a pick this is too late to matter)
      db.getDecks().then(decks => openDeckPicker({ decks, title: 'Choose a deck', allLabel: null, onPick: id => resolve(id ? { deckId: id } : null) }));
    });
  };

  const restore = async row => {
    const entries = await trash.list({ now: now() });
    const entry = entries.find(e => e.id === row.dataset.id);
    if (!entry) { await draw(); return; }
    const box = row.querySelector('.tr-box');
    row.querySelectorAll('button[data-act]').forEach(b => { b.disabled = true; });
    const onProgress = ({ done, total }) => { if (total > 1 && $('trList')) box.innerHTML = `<p class="tr-prog" role="status">Restoring… ${done} of ${total}</p>`; };
    let res;
    try { res = await trash.restoreEntry(entry.id, { onProgress, pickDeck: pickDeck(box) }); } catch (err) {
      console.error(err);
      toast("Couldn't restore all of it. Try again: what came back stays.");
      busy = false; if ($('trList')) await draw(); return;
    }
    if (res.cancelled || res.missing) { if ($('trList')) { box.innerHTML = ''; await draw(); } return; }
    const parts = [];
    if (res.newer) parts.push(`${res.newer} changed on another device and ${res.newer === 1 ? 'was' : 'were'} left as ${res.newer === 1 ? 'it is' : 'they are'}.`);
    if (res.noDeck) parts.push(`${plural(res.noDeck, 'card')} had no deck and ${res.noDeck === 1 ? 'was' : 'were'} not restored.`);
    toast(parts.length ? `Restored ${plural(res.cards, 'card')}. ${parts.join(' ')}` : `Restored “${res.title}”`);
    closeSheet();
    drawSidebar();
    const target = res.deckId && await db.getDeck(res.deckId);
    navGo(target ? `#/deck/${res.deckId}` : '#/decks');
  };

  $('trList').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]');
    if (!b || busy) return;
    const row = b.closest('.tr-row');
    if (b.dataset.act === 'restore') { busy = true; try { await restore(row); } finally { busy = false; } return; }
    const v = await ask(row.querySelector('.tr-box'), "Delete for good? This can't be undone.", [['no', 'Cancel'], ['yes', 'Delete for good', 'danger solid']]);
    if (v !== 'yes') return;
    const entry = (await trash.list({ now: now() })).find(x => x.id === row.dataset.id);
    if (entry) await trash.deleteNow(entry);
    await draw();
  });
  $('trEmpty').addEventListener('click', async () => {
    const v = await ask($('trBox'), "Delete everything in Recently deleted for good? This can't be undone.", [['no', 'Cancel'], ['yes', 'Empty', 'danger solid']]);
    if (v !== 'yes') return;
    await trash.emptyList();
    await draw();
  });
  await draw();
}
