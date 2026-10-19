// The "Suggest tags" sheet (deck ⋯ menu, and Browse > Tools). Loaded when first needed; it is in the service worker's CORE list.
// It reads the cards' text on the device (js/autotag.js, in a worker through js/keywords-job.js), lists the topics it found with a tick box,
// a name you can change and the cards each one would go on, and only when you press "Add" are the tags written, through the normal card save
// (so sync and backups see them like any other edit). Tags are only ever added, never taken off a card. Undo takes back exactly what was added.
//   openAutotagSheet({ deckId, cardIds, refresh })   deckId: a deck and its subdecks; cardIds: instead, these cards (Browse's list)

import * as db from './db.js';
import { runKeywordJob } from './keywords-job.js';
import { notesOf, deckWordsOf, applyTags, undoTags } from './autotag.js';
import { parseTags } from './browse-logic.js';
import { tagWords, normTag } from './tag-tree.js';
import { subtreeIds } from './deck-tree.js';
import { splitTooBig, tooLargeNote } from './quota.js';
import { $, esc, plural, toast, openSheet, closeSheet, guardSheet, askClose } from './ui.js';

const MAX_SHOWN = 100;                   // cards listed under a tag
export const NONE_FOUND = 'No clear topics found in these cards. Tags work best when cards share words like ‘kidney’ or ‘cell cycle’.';
const INTRO = "Topics found in this deck's cards. Rename them, untick what you don't want, then add them. Tags you already have stay as they are.";
const SAME_NAME = "Same name as another tag: they'll be one tag";

const num = n => n.toLocaleString('en');

// What a tag row's name is once the folder is in front of it: spaces become '-', '' when it is not exactly one tag.
export function fullName(name, folder = '') {
  const own = String(name ?? '').trim().replace(/\s+/g, '-');
  if (parseTags(own).length !== 1) return '';
  const f = String(folder ?? '').trim().replace(/\s+/g, '-').split('::').filter(Boolean).join('::');
  return (f && parseTags(f).length === 1 ? f + '::' : '') + parseTags(own)[0];
}

export async function openAutotagSheet({ deckId = null, cardIds = null, refresh = async () => {} } = {}) {
  const [decks, all] = await Promise.all([db.getDecks(), db.getAll('cards')]);
  const inScope = cardIds ? new Set(cardIds) : null, tree = deckId && !inScope ? subtreeIds(decks, deckId) : null;
  const cards = all.filter(c => (inScope ? inScope.has(c.id) : tree ? tree.has(c.deckId) : true));
  const notes = notesOf(cards), byNote = new Map(notes.map(n => [n.id, n]));
  let job = null, tags = [];
  const ticked = new Set(), off = new Map();            // tag index → ticked; tag index → note ids unticked

  openSheet(`
    <h2 id="sheetTitle" tabindex="-1">Suggest tags</h2>
    <div id="atBody"></div>
    <p class="sr-only" id="atLive" role="status" aria-live="polite"></p>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="atCancel">Cancel</button>
      <button class="btn primary" type="button" id="atAdd" disabled>Add tags</button>
    </div>`, { side: true });
  const stop = () => { job?.cancel(); job = null; };
  document.addEventListener('sheet-closing', stop, { once: true });
  $('atCancel').addEventListener('click', askClose);
  const live = msg => { const el = $('atLive'); if (el) el.textContent = msg; };
  const alive = () => !!$('atBody') && !!$('atAdd');

  // ---------- reading ----------
  const total = cards.length;
  $('atBody').innerHTML = `<p id="atProg" aria-hidden="true">Reading ${num(total)} ${total === 1 ? 'card' : 'cards'}… 0%</p>
    <button class="btn ghost small" type="button" id="atStop">Stop</button>`;
  live(`Reading ${num(total)} ${total === 1 ? 'card' : 'cards'}`);
  const say = msg => { if (!alive()) return; $('atBody').innerHTML = `<p class="note" id="atMsg">${esc(msg)}</p>`; live(msg); };
  $('atStop').addEventListener('click', () => { stop(); say('Stopped. Close this and try again when you are ready.'); });

  const existing = new Set(all.flatMap(c => tagWords(c.tags).map(normTag)));
  job = runKeywordJob('autotag', { notes: notes.map(n => ({ id: n.id, front: n.front, text: n.text, cardIds: n.cardIds })), deckWords: deckId ? deckWordsOf(decks, deckId) : [], existingTags: [...existing] }, {
    timeoutMs: 120000,
    onProgress: ({ progress }) => { const p = $('atProg'); if (p) p.textContent = `Reading ${num(total)} ${total === 1 ? 'card' : 'cards'}… ${Math.round(progress * 100)}%`; }
  });
  const outcome = await job.promise;
  job = null;
  if (!alive()) return;
  if (outcome.status === 'cancelled') return;
  if (outcome.status === 'timeout') { say('This took too long. Try a smaller deck.'); return; }
  if (outcome.status === 'error') { say("Couldn't find tags in these cards."); return; }
  tags = outcome.result.tags;
  if (!tags.length) { say(NONE_FOUND); return; }
  tags.forEach((_, i) => ticked.add(i));

  // ---------- the list ----------
  const rowHtml = (t, i) => `<li data-i="${i}">
      <div class="ts-name"><label class="pick-wrap"><input type="checkbox" class="pick" checked aria-label="Use tag ${esc(t.name)}"></label>
        <input class="tag-name" value="${esc(t.name)}" aria-label="Tag name" autocapitalize="off" autocomplete="off" spellcheck="false" data-was="${esc(t.name)}"></div>
      <div class="ts-meta"><span class="muted small ts-count">${plural(t.count, 'card')}</span>
        ${t.exists ? '<span class="muted small">Already a tag: these cards are added to it</span>' : ''}
        <button class="btn ghost small" type="button" aria-expanded="false" aria-controls="tc-${i}">Cards</button></div>
      <p class="ts-err small" hidden></p>
      <div class="ts-cards" id="tc-${i}" hidden></div>
    </li>`;
  $('atBody').innerHTML = `<p class="note" style="margin-top:0">${esc(INTRO)}</p>
    <label class="field"><span>Put them in a folder (optional)</span><input id="tagFolder" placeholder="e.g. renal" autocapitalize="off" autocomplete="off"></label>
    <ul class="tag-sugs" aria-label="Suggested tags">${tags.map(rowHtml).join('')}</ul>`;
  live(`Found ${plural(tags.length, 'tag')}`);
  if ($('atBody').contains(document.activeElement) || document.activeElement === document.body) $('sheetTitle').focus({ preventScroll: true });

  const rows = () => [...document.querySelectorAll('#atBody .tag-sugs li')];
  // The cards a tag would go on: its cards, less the notes unticked under it.
  const cardsOf = i => { const skip = off.get(i); return skip ? tags[i].noteIds.filter(n => !skip.has(n)).flatMap(n => byNote.get(n).cardIds) : tags[i].cardIds; };
  const dirty = () => rows().some((li, i) => !li.querySelector('.pick').checked || li.querySelector('.tag-name').value !== li.querySelector('.tag-name').dataset.was) || off.size > 0 || !!$('tagFolder')?.value.trim();

  // The plan as it stands: [{ name, cardIds }], rows with the same name made one, and the problems found.
  const plan = () => {
    const by = new Map(), problems = new Map(), f = $('tagFolder').value;
    rows().forEach((li, i) => {
      if (!li.querySelector('.pick').checked) return;
      const input = li.querySelector('.tag-name');
      const name = fullName(input.value, f);
      if (!name) { problems.set(i, "A tag can't be empty"); return; }
      const ids = cardsOf(i);
      const e = by.get(name);
      if (e) { problems.set(i, SAME_NAME); e.rows.push(i); for (const id of ids) e.ids.add(id); } else by.set(name, { name, ids: new Set(ids), rows: [i] });
    });
    for (const e of by.values()) if (e.rows.length > 1) for (const r of e.rows) problems.set(r, SAME_NAME);
    return { list: [...by.values()].map(e => ({ name: e.name, cardIds: [...e.ids] })), problems };
  };
  const refreshFooter = () => {
    const { list, problems } = plan();
    const n = new Set(list.flatMap(p => p.cardIds)).size;
    const broken = [...problems.values()].some(m => m !== SAME_NAME);
    const add = $('atAdd');
    add.textContent = list.length ? `Add ${plural(list.length, 'tag')} to ${plural(n, 'card')}` : 'Add tags';
    add.disabled = !list.length || broken;
    rows().forEach((li, i) => {
      const err = li.querySelector('.ts-err'), msg = problems.get(i) || '';
      err.textContent = msg; err.hidden = !msg;
      li.classList.toggle('off', !li.querySelector('.pick').checked);
    });
    rows().forEach((li, i) => { li.querySelector('.ts-count').textContent = plural(cardsOf(i).length, 'card'); });
  };
  guardSheet(dirty);
  refreshFooter();

  const body = $('atBody');
  body.addEventListener('input', e => {
    if (e.target.matches('.pick, .tag-name, #tagFolder')) refreshFooter();
    if (e.target.matches('.tag-name')) { const li = e.target.closest('li'); li.querySelector('.pick').setAttribute('aria-label', `Use tag ${e.target.value.trim() || 'with no name'}`); }
  });
  body.addEventListener('change', e => {
    if (e.target.matches('.ts-cards input')) {
      const li = e.target.closest('li'), i = +li.dataset.i, skip = off.get(i) || new Set();
      if (e.target.checked) skip.delete(e.target.dataset.note); else skip.add(e.target.dataset.note);
      skip.size ? off.set(i, skip) : off.delete(i);
      refreshFooter();
    }
  });
  // On leaving a name: tidy it (spaces become '-', lower case) and say what is wrong with it.
  body.addEventListener('focusout', e => {
    if (!e.target.matches('.tag-name')) return;
    const own = e.target.value.trim().replace(/\s+/g, '-').toLowerCase();
    if (own !== e.target.value && parseTags(own).length === 1) e.target.value = own;
    refreshFooter();
  });
  body.addEventListener('click', e => {
    const b = e.target.closest('button[aria-controls]');
    if (!b) return;
    const box = $(b.getAttribute('aria-controls')), open = b.getAttribute('aria-expanded') !== 'true', i = +b.closest('li').dataset.i;
    b.setAttribute('aria-expanded', String(open));
    box.hidden = !open;
    if (open && !box.childElementCount) {
      const t = tags[i], shown = t.noteIds.slice(0, MAX_SHOWN), skip = off.get(i);
      box.innerHTML = shown.map(id => `<label><input type="checkbox" data-note="${esc(id)}" ${skip?.has(id) ? '' : 'checked'}> <span>${esc(byNote.get(id).front.replace(/\s+/g, ' ').slice(0, 120) || '(no text)')}</span></label>`).join('')
        + (t.noteIds.length > shown.length ? `<p class="muted small">Showing ${num(shown.length)} of ${num(t.noteIds.length)}</p>` : '');
    }
  });

  // ---------- saving ----------
  $('atAdd').addEventListener('click', async () => {
    const { list, problems } = plan();
    const bad = [...problems].find(([, m]) => m !== SAME_NAME);
    if (bad) { const li = rows()[bad[0]]; li.querySelector('.tag-name').focus(); return; }
    if (!list.length) return;
    $('atAdd').disabled = true;
    const fresh = await db.getAll('cards');                                 // (read again: a card may have been edited while the sheet was open)
    const { changed, added } = applyTags(fresh, list);
    const { big } = splitTooBig(changed);
    const bigNotes = new Set(big.map(c => c.noteId || c.id));
    const fits = changed.filter(c => !bigNotes.has(c.noteId || c.id));
    if (fits.length) await db.saveCards(fits);
    const done = new Map(fits.map(c => [c.id, added.get(c.id)]));
    const names = new Set([...done.values()].flat());
    closeSheet();
    const left = tooLargeNote(changed.length - fits.length);
    toast(fits.length ? `Added ${plural(names.size, 'tag')} to ${plural(fits.length, 'card')}${left ? '. ' + left : ''}` : (left || 'Nothing to add: the cards already have these tags'),
      fits.length ? { hold: true, link: { href: '#', label: 'Undo', onClick: async () => {
        const now = await db.getAll('cards');
        const back = undoTags(now, done);
        if (back.length) await db.saveCards(back);
        toast('Tags removed');
        await refresh();
      } } } : {});
    await refresh();
  });
}
