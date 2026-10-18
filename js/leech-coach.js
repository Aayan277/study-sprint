// "Cards you keep forgetting" (Round 2, B7): the fix-it panel on the Review finish screen and Play results.
// Loaded lazily by finish-extras.js. One row per card that became a leech this session, with ways to fix it:
//   Memory hook   a trick saved on the card (noteExtra), shown under the answer
//   Split         one card into 2 to 4 smaller ones (the back is split on ; line breaks and bullets)
//   Comparison    side by side with the card it gets mixed up with (or one you pick), then a comparison card
//   Edit          the usual editor
//   Delete / Keep suspended / Fix later
// Hook and Edit bring the card back into reviews (unsuspended, no "leech" tag) with its schedule untouched.
// Cards that are gone (deleted, synced away) are skipped.

import * as db from './db.js';
import { openSheet, closeSheet, esc, toast, $ } from './ui.js';
import { plainText } from './format.js';
import { isPair, unpaired } from './reverse.js';
import { partnerOf, pairsFor } from './confusion.js';
import { savedTooBigNote } from './quota.js';
import { MAX_PARTS, splitBack, splitCards, unleeched, parked, canSplit, withoutLeechTag, forgottenText } from './leech-logic.js';

// After a card of a pair is deleted, its partner is an ordinary card again.
async function unpairPartner(card) {
  if (!isPair(card)) return;
  const left = (await db.getAll('cards')).filter(c => c.id !== card.id && isPair(c) && c.noteId === card.noteId);
  if (left.length) await db.saveCards(left.map(unpaired));
}

// ---------- the panel ----------
const rowHTML = (card, lapses) => `
  <li class="coach-row" data-id="${esc(card.id)}">
    <div class="coach-card"><span class="coach-f">${esc(plainText(card.front) || '(picture)')}</span><span class="coach-b">${esc(plainText(card.back || card.noteText || '') || '(picture)')}</span>
      ${lapses ? `<span class="coach-n mono">${forgottenText(lapses)}</span>` : ''}</div>
    <div class="coach-acts" role="group" aria-label="Fix this card">
      <button class="btn ghost small" type="button" data-act="hook">Memory hook</button>
      ${canSplit(card) ? '<button class="btn ghost small" type="button" data-act="split">Split</button>' : ''}
      <button class="btn ghost small" type="button" data-act="compare">Comparison</button>
      <button class="btn ghost small" type="button" data-act="edit">Edit</button>
    </div>
    <div class="coach-more">
      <button class="link" type="button" data-act="delete">Delete</button>
      <button class="link" type="button" data-act="park">Keep suspended</button>
      <button class="link" type="button" data-act="later">Fix later</button>
    </div>
    <div class="coach-confirm" aria-live="polite"></div>
  </li>`;

// The panel's HTML for these card ids ('' when none of them exist any more).
export async function coachHTML(ids) {
  const found = (await Promise.all([...new Set(ids)].map(async id => [await db.get('cards', id), await db.get('cardStates', id)]))).filter(([c]) => c);
  if (!found.length) return '';
  const one = found.length === 1;
  return `<section class="coach" aria-labelledby="coachTitle"><h2 id="coachTitle" tabindex="-1">Cards you keep forgetting</h2>
    <p class="note">${one ? 'This card keeps' : 'These cards keep'} slipping. Fixing ${one ? 'it' : 'them'} usually works better than more repeats.</p>
    <ul class="coach-list">${found.map(([c, s]) => rowHTML(c, s?.lapses || 0)).join('')}</ul></section>`;
}

// Takes the row away; the section goes when it was the last one (the slot hides itself when it is empty).
// Focus goes to the next (or previous) row's first button, else the section title; when the last row goes, to whatever
// comes before the panel on the screen (so keyboard and screen-reader users aren't dropped at the top of the page).
// (A moment later: closing the sheet that started the action would otherwise take the focus back to the removed button.)
const focusSoon = el => setTimeout(() => { if (el?.isConnected) el.focus(); }, 0);
function dropRow(row, slot) {
  const sec = row.closest('.coach');
  const next = row.nextElementSibling || row.previousElementSibling;
  const target = next?.querySelector('button') || sec?.querySelector('#coachTitle');
  row.remove();
  if (sec && !sec.querySelector('.coach-row')) {
    sec.remove(); slot.hidden = !slot.innerHTML.trim();
    const before = [...(slot.parentElement || document).querySelectorAll('a[href], button:not([disabled])')]
      .filter(x => slot.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING && x.offsetParent !== null).pop();
    focusSoon(before);
  } else focusSoon(target);
}
const cardOf = async id => (await db.get('cards', id)) || null;

// One listener on the slot; rows come and go.
export function wireCoach(slot) {
  if (slot.dataset.coachWired) return;
  slot.dataset.coachWired = '1';
  slot.addEventListener('click', async e => {
    const btn = e.target.closest('.coach [data-act]');
    if (!btn) return;
    const row = btn.closest('.coach-row'), id = row.dataset.id, act = btn.dataset.act;
    const card = await cardOf(id);
    const done = msg => { if (msg) toast(msg); dropRow(row, slot); };
    if (!card) return done('That card is gone');
    if (act === 'later') { dropRow(row, slot); return toast('Okay. You’ll find it under Leeches in All cards.', { link: { href: '#/browse/leech', label: 'Open Leeches' } }); }
    if (act === 'park') { await db.saveCards([parked(card)]); return done('Kept suspended. It’s under Suspended in All cards.'); }
    if (act === 'delete') return askDelete(row, card, done, btn);
    if (act === 'hook') return openHook(card, done);
    if (act === 'split') return openSplit(card, done);
    if (act === 'compare') return openPartner(card, done);
    if (act === 'edit') return openEdit(card, done);
  });
}

// The inline "are you sure?": Cancel takes the focus when it shows, and gives it back to the button that asked.
function askDelete(row, card, done, opener) {
  const box = row.querySelector('.coach-confirm');
  box.innerHTML = `<div class="confirm"><p>Delete this card and its history? This can’t be undone.</p><div class="sheet-actions">
    <button class="btn ghost small" type="button" data-no>Cancel</button><button class="btn danger solid small" type="button" data-yes>Delete</button></div></div>`;
  const no = box.querySelector('[data-no]'), yes = box.querySelector('[data-yes]');
  no.addEventListener('click', () => { box.innerHTML = ''; opener?.focus(); });
  yes.addEventListener('click', async () => {
    if (yes.disabled) return;
    yes.disabled = true;                                  // a double tap must not delete twice
    try { await db.deleteCards([card.id]); await unpairPartner(card); done('Card deleted'); } catch (err) { console.error(err); yes.disabled = false; toast("Couldn't delete the card. Try again."); }
  });
  no.focus();
  yes.scrollIntoView({ block: 'nearest' });
}

// ---------- Memory hook ----------
function openHook(card, done) {
  openSheet(`
    <h2 id="sheetTitle">Add a memory hook</h2>
    <form id="hookForm" class="coach-form">
      <p class="coach-q">${esc(plainText(card.front))}<br><b>${esc(plainText(card.back || card.noteText || ''))}</b></p>
      <label class="field"><span>A trick to remember it</span>
        <textarea id="hookText" rows="3" placeholder="A picture, a rhyme, what it sounds like…">${esc(card.noteExtra || '')}</textarea></label>
      <p class="note">It shows under the answer. The card goes back into your reviews with its schedule as it is.</p>
      <p class="err" id="hookErr" hidden></p>
      <div class="sheet-actions"><button class="btn ghost" type="button" id="hookCancel">Cancel</button><button class="btn primary" type="submit">Save hook</button></div>
    </form>`);
  $('hookCancel').addEventListener('click', closeSheet);
  $('hookText').focus();
  let busy = false;                                       // a double tap on Save must save once
  $('hookForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const text = $('hookText').value.trim();
    if (!text) { $('hookErr').textContent = 'Write a hook first, or cancel.'; $('hookErr').hidden = false; return; }
    busy = true;
    const btn = document.querySelector('#sheet button[form=hookForm], #hookForm [type=submit]');       // (the sheet moves the buttons to its footer)
    btn.disabled = true;
    try {
      const fresh = await cardOf(card.id);
      if (!fresh) { closeSheet(); return done('That card is gone'); }
      // A cloze card's extra belongs to its whole note.
      const sibs = fresh.noteId ? (await db.getAll('cards')).filter(c => c.noteId === fresh.noteId && c.id !== fresh.id) : [];
      const cards = [{ ...unleeched(fresh), noteExtra: text }, ...sibs.map(c => ({ ...c, noteExtra: text }))];
      // A hook that makes the card too large to sync is refused, like in the card editor.
      const big = savedTooBigNote(cards);
      if (big) { busy = false; btn.disabled = false; $('hookErr').textContent = big; $('hookErr').hidden = false; return; }
      await db.saveCards(cards);
      closeSheet();
      done('Hook saved. It’s back in your reviews.');
    } catch (err) {
      console.error(err);
      busy = false; btn.disabled = false;
      $('hookErr').textContent = "Couldn't save the hook. Try again."; $('hookErr').hidden = false;
    }
  });
}

// ---------- Split ----------
function openSplit(card, done) {
  const backs = splitBack(card.back);
  const partHTML = (i, back = '') => `
    <li class="split-row" data-split-row>
      <label class="field"><span>Card ${i + 1} front</span><input class="split-f" value="${esc(card.front)}" autocomplete="off"></label>
      <label class="field"><span>Card ${i + 1} back</span><textarea class="split-b" rows="2">${esc(back)}</textarea></label>
    </li>`;
  openSheet(`
    <h2 id="sheetTitle">Split into smaller cards</h2>
    <form id="splitForm" class="coach-form">
      <p class="note">One small fact per card is easier to remember. Edit the pieces if they’re not quite right.</p>
      <ol class="split-list" id="splitList">${backs.map((b, i) => partHTML(i, b)).join('')}</ol>
      <button class="btn ghost small" type="button" id="splitAdd" ${backs.length >= MAX_PARTS ? 'hidden' : ''}>+ Add a card</button>
      <fieldset class="split-orig"><legend>The original card</legend>
        <label class="radio-row"><input type="radio" name="splitOrig" value="keep" checked> Keep it, suspended</label>
        <label class="radio-row"><input type="radio" name="splitOrig" value="delete"> Delete it</label></fieldset>
      <div id="splitConfirm"></div>
      <p class="err" id="splitErr" hidden></p>
      <div class="sheet-actions"><button class="btn ghost" type="button" id="splitCancel">Cancel</button><button class="btn primary" type="submit">Split</button></div>
    </form>`);
  $('splitCancel').addEventListener('click', closeSheet);
  $('splitAdd').addEventListener('click', () => {
    const list = $('splitList');
    if (list.children.length >= MAX_PARTS) return;
    list.insertAdjacentHTML('beforeend', partHTML(list.children.length));
    list.lastElementChild.querySelector('.split-b').focus();
    $('splitAdd').hidden = list.children.length >= MAX_PARTS;
  });
  const read = () => [...document.querySelectorAll('[data-split-row]')].map(r => ({ front: r.querySelector('.split-f').value, back: r.querySelector('.split-b').value }));
  let busy = false;                    // a double tap on Split (or on the confirm) must make the cards once
  const submitBtn = () => document.querySelector('#sheet button[form=splitForm], #splitForm [type=submit]');
  const buttons = () => [submitBtn(), $('cfYes')].filter(Boolean);
  const go = async () => {
    if (busy) return;
    busy = true; buttons().forEach(b => { b.disabled = true; });
    try {
      const fresh = await cardOf(card.id);
      if (!fresh) { closeSheet(); return done('That card is gone'); }
      const made = splitCards(fresh, read(), { newId: db.newId });
      const keep = document.querySelector('input[name=splitOrig]:checked')?.value === 'keep';
      await db.saveCards([...made, ...(keep ? [parked(fresh)] : [])]);
      if (!keep) { await db.deleteCards([fresh.id]); await unpairPartner(fresh); }
      closeSheet();
      done(`Split into ${made.length} cards${keep ? '. The original stays suspended.' : '.'}`);
    } catch (err) {
      console.error(err);
      busy = false; buttons().forEach(b => { b.disabled = false; });
      $('splitErr').textContent = "Couldn't split the card. Try again."; $('splitErr').hidden = false;
    }
  };
  $('splitForm').addEventListener('submit', e => {
    e.preventDefault();
    if (busy) return;
    if (read().filter(r => r.front.trim() && r.back.trim()).length < 2) { $('splitErr').textContent = 'Fill in at least two cards (a front and a back each).'; $('splitErr').hidden = false; return; }
    $('splitErr').hidden = true;
    if (document.querySelector('input[name=splitOrig]:checked')?.value !== 'delete') return go();
    $('splitConfirm').innerHTML = `<div class="confirm"><p>Delete the original card and its history? This can’t be undone.</p><div class="sheet-actions">
      <button class="btn ghost small" type="button" id="cfNo">Cancel</button><button class="btn danger solid small" type="button" id="cfYes">Split and delete it</button></div></div>`;
    $('cfNo').addEventListener('click', () => { $('splitConfirm').innerHTML = ''; submitBtn()?.focus(); });
    $('cfYes').addEventListener('click', go);
    $('cfNo').focus();
    $('cfYes').scrollIntoView({ block: 'nearest' });
  });
}

// ---------- Comparison ----------
async function openPartner(card, done) {
  const { loadPairs, openCompare } = await import('./compare-sheet.js');
  const { pairs, cardsById } = await loadPairs();
  const pair = pairsFor([card.id], pairs).find(p => cardsById.has(partnerOf(p, card.id)));
  const onDone = () => done('Comparison card made.');
  if (pair) return openCompare(card, cardsById.get(partnerOf(pair, card.id)), { onDone });
  const pool = [...cardsById.values()].filter(c => c.id !== card.id && !c.noteId && c.front);
  openSheet(`
    <h2 id="sheetTitle">What does it get mixed up with?</h2>
    <p class="note">Pick a card that looks or sounds like it. You’ll see them side by side.</p>
    <label class="field"><span>Search your cards</span><input type="search" id="partnerQ" autocomplete="off" placeholder="A word from the front or back"></label>
    <ul class="partner-list" id="partnerList"></ul>`);
  const draw = () => {
    const q = $('partnerQ').value.trim().toLowerCase();
    const list = pool.filter(c => !q || plainText(c.front).toLowerCase().includes(q) || plainText(c.back).toLowerCase().includes(q))
      .sort((a, b) => (b.deckId === card.deckId) - (a.deckId === card.deckId)).slice(0, 8);
    $('partnerList').innerHTML = list.length
      ? list.map(c => `<li><button type="button" class="partner-pick" data-pid="${esc(c.id)}"><span class="coach-f">${esc(plainText(c.front))}</span><span class="coach-b">${esc(plainText(c.back))}</span></button></li>`).join('')
      : '<li class="note">No cards match.</li>';
  };
  draw();
  $('partnerQ').addEventListener('input', draw);
  $('partnerList').addEventListener('click', e => {
    const b = e.target.closest('[data-pid]');
    if (b) openCompare(card, cardsById.get(b.dataset.pid), { onDone });
  });
}

// ---------- Edit ----------
async function openEdit(card, done) {
  const { openCardPanel } = await import('./browse.js');
  const [decks, st] = await Promise.all([db.getDecks(), db.get('cardStates', card.id)]);
  // The leech tag is already off the card the editor sees: saving an edit to a cloze card must not give it to the siblings.
  openCardPanel(withoutLeechTag(card), {
    decks, statesById: new Map(st ? [[card.id, st]] : []), mode: 'edit', closeAfter: ['edit'],
    onAction: async (act, fresh) => {
      if (act !== 'edit' || !fresh) return;
      await db.saveCards([unleeched(fresh)]);
      done('Saved. It’s back in your reviews.');
    }
  });
}
