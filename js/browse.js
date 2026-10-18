// The card list (browser): every card in a deck (or in all decks), with search, filters and sorting,
// and everything you can do to a card: edit, add, suspend, bury, flag, move, reset, set due date,
// delete and card info. Tap a card for its panel, or tap Select to act on several at once.
// Statuses, search and sorting live in browse-logic.js.

import * as db from './db.js';
import { browseCards, cardStatus, isSuspended, isBuried, buryUntil, parseTags, duplicateCards, FLAGS, FILTERS, FILTER_GROUPS, SORTS, replaceInCards, tagCounts, renameTag, renameTagExact, renameTagPrefix } from './browse-logic.js';
import { hasFolders, tagTree, tagTreeHTML, wireTagTree } from './tag-tree.js';
import { acceptedOf, parseAccepted } from './accept.js';
import { daysAgoStart } from './stats-calc.js';
import { formatInterval } from './queue.js';
import { watchAdd, readCardText, setCardText, readCardImage, readCardSounds, setCardSounds, noteKinds, clozeFields, readKind, lastKind, occlusionFields, readOcclusion, resetOcclusion, basicFields, readBack, stepsProblem, stepsOn, clearBasic } from './card-editor.js';
import { isPair, canReverse, reverseOf, reverseSwitchHTML, pairPlan, isStructured, unpaired, syncPairChanges, loneIds } from './reverse.js';
import { cleanFields } from './note-fields.js';
import { savedTooBigNote, splitTooBig, tooLargeNote } from './quota.js';
import { noteFieldsEditHTML, readNoteFields } from './note-fields.js';
import { planNoteSave, removalText, planLinks, clozeCard, renderCloze } from './cloze.js';
import { planOcclusionSave, occRemovalText, hasMasks, groupIndex } from './occlusion.js';
import { plainText, mathHTML, spokenRow } from './format.js';
import { soundsHTML } from './audio.js';
import { ancestors, subtreeIds, deckPath, deckChoices } from './deck-tree.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon, showFieldError, guardSheet, formSnapshot, askClose, guardedGo, sheetDirty, setDraftStasher } from './ui.js';
import { singleKeysOn, stripKeys } from './shortcuts.js';
import { go as navGo } from './nav.js';

const PAGE = 150;          // rows drawn at a time; "Show more" adds another page
const RATING = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const shortDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Remembered while the app is open, so going into a card and back keeps your search.
const memory = { query: '', filter: 'all', sort: 'added-old' };   // oldest first = the order you added them

// The filter dropdown's options, grouped (Status / Flags / Problems).
function filterOptions(current) {
  const label = new Map(FILTERS);
  const opt = k => `<option value="${k}" ${k === current ? 'selected' : ''}>${label.get(k)}</option>`;
  return FILTER_GROUPS.map(([group, keys]) => group ? `<optgroup label="${group}">${keys.map(opt).join('')}</optgroup>` : keys.map(opt).join('')).join('');
}

// ---------- the "All cards" screen (#/browse) ----------
// `filter` (the route's argument, #/browse/leech) sets the list's starting filter.
export async function renderBrowseAll(el, filter) {
  el.innerHTML = `
    <button class="back" type="button" id="back">‹ Decks</button>
    <div class="screen-head"><div><h1>All cards</h1></div></div>
    <section id="browser"></section>`;
  $('back').addEventListener('click', () => { navGo('#/decks'); });
  await mountBrowser($('browser'), { deckId: null, filter });
}

// ---------- the list ----------
// Draws the card list into `box`. deckId = null means all decks; a deck's list includes its subdecks.
// onChange runs after anything changes (the deck page uses it to refresh its counts).
// data (optional): what loadAll() just read (decks, allCards, statesById), for the first draw, so the deck page does not read every card
// and schedule a second time. Later reloads (after a change) read the database again.
export async function mountBrowser(box, { deckId, onChange = () => {}, filter, data = null }) {
  const B = { deckId, selecting: false, selected: new Set(), shown: PAGE, ...memory };
  if (filter && FILTERS.some(([k]) => k === filter)) B.filter = filter;      // a link to a filter (#/browse/leech) starts on it
  let decks, cards, statesById, inside;

  let given = data;
  const load = async () => {
    if (given) {
      const { decks: d, allCards, statesById: given_ } = given;
      given = null;
      decks = [...d].sort((a, b) => a.created - b.created);
      inside = deckId ? subtreeIds(decks, deckId) : null;
      // (loadAll puts the cards in deck order; the database gives them by id, which is the order ties in a sort fall back on.)
      cards = (inside ? allCards.filter(x => inside.has(x.deckId)) : [...allCards]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      statesById = new Map(given_);       // (a copy: the card panel keeps this map in step with its own changes)
      return;
    }
    const [d, c, s] = await Promise.all([db.getDecks(), db.getAllCached('cards'), db.getAllCached('cardStates')]);
    decks = d.sort((a, b) => a.created - b.created);
    inside = deckId ? subtreeIds(decks, deckId) : null;      // this deck and its subdecks
    cards = inside ? c.filter(x => inside.has(x.deckId)) : c;
    statesById = new Map(s.map(x => [x.cardId, x]));
  };
  await load();
  // You already moved to another screen while the cards loaded: don't draw into a box that has left the page (the $() lookups below
  // would find nothing and throw).
  if (!box.isConnected) return;

  // With no cards at all there is one friendly empty state, not a search box over an empty list.
  const emptyArt = `<svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true"><rect x="34" y="10" width="62" height="74" rx="10" fill="none" stroke="var(--line-strong)" stroke-width="2" transform="rotate(8 65 47)"/><rect x="24" y="14" width="62" height="74" rx="10" fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="2"/><path d="M55 38v26M42 51h26" stroke="var(--accent-text)" stroke-width="3.5" stroke-linecap="round"/></svg>`;
  box.innerHTML = `
    <div class="empty empty-first" id="brEmpty" hidden>${emptyArt}<b>No cards yet</b>
      <p>Paste a list like <code>term - definition</code> and it becomes cards. Or add them one at a time.</p>
      <div class="empty-btns"><a class="btn primary" href="#/import${deckId ? '/' + encodeURIComponent(deckId) : ''}">${icon('paste')} Paste cards</a>
        <button class="btn ghost" type="button" id="brAddFirst">${icon('plus')} Add one card</button></div></div>
    <div id="brMain">
    <div class="mhead br-head">
      <h2>Cards <span class="count mono" id="brTotal"></span></h2>
      <div class="head-actions">
        <button class="btn ghost small" type="button" id="brTags">Tools</button>
        <button class="btn ghost small" type="button" id="brSelect">Select</button>
        <button class="btn primary small" type="button" id="brAdd">+ Add card</button>
      </div>
    </div>
    <div class="br-controls">
      <input type="search" id="brQuery" placeholder="Search cards" aria-label="Search cards" value="${esc(B.query)}" autocomplete="off">
      <select id="brFilter" aria-label="Show">${filterOptions(B.filter)}</select>
      <select id="brSort" aria-label="Sort by">${SORTS.map(([k, l]) => `<option value="${k}" ${k === B.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <p class="note br-count" id="brCount" aria-live="polite"></p>
    <ul class="crows" id="brList"></ul>
    <button class="btn ghost small" type="button" id="brMore" hidden>Show more</button>
    <div class="bulkbar" id="brBulk" hidden>
      <span id="brSel" class="mono" aria-live="polite"></span>
      <button class="btn ghost small" type="button" id="brAll">Select all</button>
      <button class="btn primary small" type="button" id="brActions">Actions…</button>
    </div></div>`;

  // Which deck a row is in: the full path in All cards; on a deck's page, the subdeck below it (if any).
  const where = card => {
    if (!deckId) return deckPath(decks, card.deckId);
    const chain = ancestors(decks, card.deckId);
    return chain.slice(0, chain.findIndex(d => d.id === deckId)).reverse().map(d => d.name).join(' › ');
  };
  const draw = () => {
    $('brEmpty').hidden = cards.length > 0;
    $('brMain').hidden = cards.length === 0;
    const list = browseCards(cards, statesById, B);
    B.visible = list;
    $('brTotal').textContent = `(${cards.length})`;
    $('brCount').textContent = list.length === cards.length ? plural(list.length, 'card') : `Showing ${list.length} of ${plural(cards.length, 'card')}`;
    const now = Date.now();
    $('brList').innerHTML = list.length ? list.slice(0, B.shown).map(({ card, state }) => {
      const st = cardStatus(card, state, now);
      const flag = FLAGS.find(f => f.id === card.flag);
      const sel = B.selected.has(card.id);
      return `<li class="crow${sel ? ' selected' : ''}" data-id="${esc(card.id)}">
        <button type="button" class="crow-btn" aria-label="${esc(spokenRow({ front: card.front, back: card.back, reverse: isPair(card) && !!card.reverse, cloze: Number(card.cloze), pic: !!(card.frontImage || card.backImage), sound: !!(card.frontSounds?.length || card.backSounds?.length), where: where(card), status: st.label, flag: flag?.name }))}" ${B.selecting ? `role="checkbox" aria-checked="${sel}"` : ''}>
          ${B.selecting ? '<span class="tick" aria-hidden="true"></span>' : ''}
          <span class="crow-main"><span class="f">${isPair(card) && card.reverse ? '<span class="rev-pill" title="Reverse card: asks the back, expects the front">Reverse</span> ' : ''}${Number(card.cloze) > 0 ? `<span class="ckind" title="Cloze card, blank ${Number(card.cloze)}">c${Number(card.cloze)}</span> ` : ''}${occBadge(card)}${card.frontImage || card.backImage ? '<span class="pic-mark" title="Has a picture" aria-label="Has a picture">▣</span> ' : ''}${card.frontSounds?.length || card.backSounds?.length ? '<span class="pic-mark snd-mark" title="Has sound" aria-label="Has sound">♪</span> ' : ''}${mathHTML(plainText(card.front), { inline: true })}</span><span class="b">${mathHTML(plainText(card.back), { inline: true })}</span>
            ${where(card) ? `<span class="d">${esc(where(card))}</span>` : ''}</span>
          <span class="crow-meta"><span class="st st-${st.key}">${esc(st.label)}</span>
            ${flag ? `<i class="flagdot" style="background:${flag.color}" title="${flag.name} flag" aria-label="${flag.name} flag"></i>` : ''}</span>
        </button></li>`;
    }).join('') : `<li class="empty">${cards.length ? 'No cards match.' : 'No cards yet. Tap + Add card, or import some.'}</li>`;
    $('brMore').hidden = list.length <= B.shown;
    $('brBulk').hidden = !B.selecting;
    $('brSelect').textContent = B.selecting ? 'Cancel' : 'Select';
    selCount();
  };
  // "3 selected" and what the Select all button will do (select everything shown, or clear if that's already selected).
  const selCount = () => {
    $('brSel').textContent = `${B.selected.size} selected`;
    $('brAll').textContent = B.visible.length && B.visible.every(x => B.selected.has(x.card.id)) ? 'Clear' : 'Select all';
  };

  // Something changed: reload from the database and redraw.
  const refresh = async () => { await load(); if (!box.isConnected) return; draw(); onChange(); };

  const remember = () => Object.assign(memory, { query: B.query, filter: B.filter, sort: B.sort });
  let typing = 0;      // (the timer checks box.isConnected: leaving Browse within the 150 ms must not draw into a box that is gone)
  $('brQuery').addEventListener('input', e => { clearTimeout(typing); typing = setTimeout(() => { if (!box.isConnected) return; B.query = e.target.value; B.shown = PAGE; remember(); draw(); }, 150); });
  $('brFilter').addEventListener('change', e => { B.filter = e.target.value; B.shown = PAGE; remember(); draw(); });
  $('brSort').addEventListener('change', e => { B.sort = e.target.value; remember(); draw(); });
  $('brMore').addEventListener('click', () => { B.shown += PAGE; draw(); });
  $('brSelect').addEventListener('click', () => { B.selecting = !B.selecting; B.selected.clear(); draw(); });
  $('brAll').addEventListener('click', () => {
    const all = B.visible.map(x => x.card.id);
    const every = all.every(id => B.selected.has(id));
    all.forEach(id => (every ? B.selected.delete(id) : B.selected.add(id)));
    draw();
  });
  $('brList').addEventListener('click', e => {
    const row = e.target.closest('.crow'); if (!row) return;
    const id = row.dataset.id;
    if (B.selecting) {
      // The row is changed where it stands: redrawing the list would drop the focus and the screen reader's "checked / not checked".
      B.selected.has(id) ? B.selected.delete(id) : B.selected.add(id);
      row.classList.toggle('selected', B.selected.has(id));
      row.querySelector('.crow-btn')?.setAttribute('aria-checked', String(B.selected.has(id)));
      selCount();
      return;
    }
    guardedGo(() => openCardPanel(cards.find(c => c.id === id), { decks, statesById, refresh }));      // (asks first if the open panel holds unsaved edits)
  });
  $('brAdd').addEventListener('click', () => openAddCard({ decks, deckId, refresh }));
  $('brAddFirst').addEventListener('click', () => openAddCard({ decks, deckId, refresh }));
  $('brTags').addEventListener('click', () => openTools(cards, { scope: deckId ? 'this deck' : 'all decks', refresh }));
  $('brActions').addEventListener('click', () => {
    if (!B.selected.size) { toast('Select some cards first'); return; }
    openBulkActions(cards.filter(c => B.selected.has(c.id)), { decks, statesById, refresh, clear: () => { B.selected.clear(); } });
  });
  draw();
}

// ---------- one card's panel ----------
// ctx: { decks, statesById, refresh, onAction, closeAfter, showInfo, mode }
//   onAction(act, freshCard, freshState)  optional: told about each change (used by Review and Play)
//   closeAfter  actions that close the sheet instead of reopening the card's panel (Review and Play close it after
//               every change, so you are straight back at the card)
//   showInfo    open the "Card info" section straight away
//   mode        'full' (default, the card list): everything about the card in one panel
//               'actions' (Review, Play): a short sheet of Edit, Flag, Bury, Suspend and More (More opens the full panel)
//               'edit': just the editor (Front, Back, Tags), for the E key
let panelFor = null;      // the card the editor panel was last opened for (Undo of a duplicate looks here)
export async function openCardPanel(card, ctx) {
  if (!card) return;
  panelFor = card;
  if (ctx.mode === 'actions') return openCardActions(card, ctx);
  if (ctx.mode === 'edit') return openCardEdit(card, ctx);
  const { decks, statesById, showInfo = false } = ctx;
  const state = statesById.get(card.id);
  const studied = state && state.state !== 0;
  const logs = await db.getCardLogs(card.id);
  const maxN = await noteMaxN(card);
  const partner = await partnerOf(card);
  const now = Date.now();
  const status = cardStatus(card, state, now);
  // In a side panel (wide screens), highlight the card it's showing.
  document.querySelectorAll('.crow').forEach(r => r.classList.toggle('sel', r.dataset.id === card.id));

  openSheet(`
    <h2 id="sheetTitle">Card <span class="st st-${status.key}">${esc(status.label)}</span></h2>
    <form id="ceForm" class="sheet-in" style="padding:0">
      ${cardFieldsHTML(card, maxN, partner)}
      <div class="sheet-actions"><button class="btn primary" type="submit">Save changes</button></div>
    </form>
    ${partner ? `<p class="note rev-line">${card.reverse ? 'Reverse card' : 'Has a reverse card'} · <button class="link" type="button" id="revOpen">Open the other direction</button></p>` : ''}

    <div class="act-grid">
      <button class="btn ghost small" type="button" data-act="suspend">${isSuspended(card) ? 'Unsuspend' : 'Suspend'}</button>
      <button class="btn ghost small" type="button" data-act="bury">${isBuried(card, now) ? 'Unbury' : 'Bury until tomorrow'}</button>
      <button class="btn ghost small" type="button" data-act="duplicate" title="${isClozeCard(card) || hasMasks(card) ? 'Copies the whole note, all its cards' : partner ? 'Copies the pair, both directions' : 'Makes a new copy of this card'}">${icon('plus')} Duplicate</button>
      <button class="btn ghost small" type="button" data-act="reset" ${studied ? '' : 'disabled'}>Reset to new</button>
      <button class="btn danger small" type="button" data-act="delete">Delete…</button>
    </div>
    <div id="ceConfirm"></div>

    <div class="field"><span id="flagLbl">Flag</span>${flagButtons(card.flag || 0)}</div>
    <div class="field"><span>Move to deck</span>${moveRow(decks, card.deckId)}</div>
    <div class="field"><span>Set due date</span>${studied ? dueRow() : '<p class="note" style="margin:0">Review this card once first, then you can set its due date.</p>'}</div>

    <div id="ceMixed" class="mixed-with" hidden></div>

    <details class="card-info" ${showInfo ? 'open' : ''}>
      <summary>Card info</summary>
      <dl class="info-grid">
        <dt>Added</dt><dd>${card.created > 1e12 ? shortDate(card.created) : '–'}</dd>
        ${hasMasks(card) ? `<dt>Type</dt><dd>Image occlusion, part ${groupIndex(card.occlusion.masks, card.occlusion.n).k} of ${groupIndex(card.occlusion.masks, card.occlusion.n).total}</dd>` : ''}
        <dt>Status</dt><dd>${esc(status.label)}</dd>
        ${studied ? `
        <dt>Due</dt><dd>${state.due <= now ? 'Now' : `${shortDate(state.due)} (in ${formatInterval(state.due - now)})`}</dd>
        <dt>Remembered for</dt><dd>about ${formatInterval(state.stability * 86400000)} <span class="muted">(stability)</span></dd>
        <dt>Difficulty</dt><dd>${state.difficulty.toFixed(1)} / 10</dd>
        <dt>Reviews</dt><dd>${state.reps}</dd>
        <dt>Forgotten</dt><dd>${plural(state.lapses, 'time')}</dd>` : ''}
        <dt>Answers</dt><dd>${logs.length} (${logs.filter(l => l.correct).length} right)</dd>
      </dl>
      ${logs.length ? `<table class="history"><thead><tr><th>When</th><th>Where</th><th>Answer</th><th>Time</th></tr></thead><tbody>
        ${logs.slice(-30).reverse().map(l => `<tr><td>${shortDate(l.timestamp)}</td><td>${{ play: 'Play', test: 'Test', anki: 'Anki' }[l.source] || 'Review'}</td>
          <td class="${l.correct ? 'ok' : 'no'}">${RATING[l.rating] || (l.correct ? 'Right' : 'Wrong')}</td><td class="mono">${l.ms ? (l.ms / 1000).toFixed(1) + 's' : ''}</td></tr>`).join('')}
      </tbody></table>${logs.length > 30 ? '<p class="note">Showing the last 30.</p>' : ''}` : '<p class="note">No answers yet.</p>'}
    </details>`, { side: true });

  const { save, again } = cardOps(card, ctx);
  wireCardForm(card, ctx, 'Saved', partner);
  $('revOpen')?.addEventListener('click', () => guardedGo(() => openCardPanel(partner, ctx)));
  document.querySelectorAll('#sheet [data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    // Each of these ends by showing the panel again, which would throw away unsaved edits: with some, they ask first (guardedGo).
    if (act === 'suspend') guardedGo(() => toggleSuspend(card, save));
    if (act === 'bury') guardedGo(() => toggleBury(card, save));
    if (act === 'duplicate') guardedGo(() => duplicateAndEdit(card, ctx));
    if (act === 'reset') confirmIn('ceConfirm', 'Reset this card to new? Its schedule starts over (its answer history is kept).', 'Reset', () => guardedGo(() => db.clearStates([card.id]).then(() => again('Reset to new', 'reset'))));
    if (act === 'delete' && partner) askDeletePair(card, partner, again);
    else if (act === 'delete') confirmIn('ceConfirm', isClozeCard(card) ? 'Delete this card and its history? The note’s other cards stay (edit the note to take the blank out of its text). This can’t be undone.'
      : hasMasks(card) ? 'Delete this card and its history? The picture’s other cards stay (take the box out when you edit the picture). This can’t be undone.' : 'Delete this card and its history? This can’t be undone.', 'Delete card', () => guardedGo(() => db.deleteCards([card.id]).then(() => again('Card deleted', 'delete'))));
  }));
  wireFlags(f => guardedGo(() => save({ flag: f }, f ? `${FLAGS.find(x => x.id === f).name} flag` : 'Flag removed', 'flag')));
  wireMove(deckId => guardedGo(() => save({ deckId }, `Moved to ${deckPath(decks, deckId)}`, 'move')));
  showMixedWith(card);
  if (studied) wireDue(days => guardedGo(() => db.putStates([dueIn(state, days)]).then(() => again(days ? `Due in ${plural(days, 'day')}` : 'Due today', 'due'))));
}

// "Often mixed up with: X (3×) · Compare": the cards this one is confused with (see confusion.js), filled in a moment
// after the panel opens because it reads the last 90 days of the log. Up to two partners.
async function showMixedWith(card) {
  try {
    const { loadPairs, cardLabel } = await import('./compare-sheet.js');
    const { cardsById, pairs } = await loadPairs();
    const box = $('ceMixed');
    if (!box?.isConnected) return;
    const mine = pairs.filter(p => p.a === card.id || p.b === card.id).slice(0, 2);
    if (!mine.length) return;
    box.innerHTML = mine.map(p => { const other = cardsById.get(p.a === card.id ? p.b : p.a);
      return `<p class="mixed-line">Often mixed up with: <b>${esc(cardLabel(other, 40))}</b> <span class="mono">(${p.count}×)</span> · <button type="button" class="link" data-mix-with="${esc(other.id)}">Compare</button></p>`; }).join('');
    box.hidden = false;
    box.addEventListener('click', async e => {
      const id = e.target.closest('[data-mix-with]')?.dataset.mixWith;
      if (id) { const m = await import('./compare-sheet.js'); guardedGo(() => m.openCompare(card, cardsById.get(id), { onDismiss: () => {
        box.querySelector(`[data-mix-with="${CSS.escape(id)}"]`)?.closest('.mixed-line')?.remove();         // no longer mixed up: drop its line
        if (!box.querySelector('.mixed-line')) box.hidden = true;
      } })); }
    });
  } catch (err) { console.warn('mixed up with:', err); }     // the panel is fine without it
}

// The short sheet for a card in Review or Play: the few things you do while studying, and More for the rest.
// The text selected on the card, for "Add to glossary": a tap on the ⋯ button can clear the selection before the sheet opens, so
// it is also noted as a press starts (and used if it is only moments old).
let pressed = { text: '', at: 0 };
const selectedText = () => String(getSelection?.() || '').replace(/\s+/g, ' ').trim().slice(0, 80);
document.addEventListener('pointerdown', () => { pressed = { text: selectedText(), at: Date.now() }; }, true);
async function openCardActions(card, ctx) {
  const picked = selectedText() || (Date.now() - pressed.at < 2000 ? pressed.text : '');
  const state = ctx.statesById.get(card.id);
  const now = Date.now();
  const status = cardStatus(card, state, now);
  openSheet(stripKeys(`
    <h2 id="sheetTitle">Card <span class="st st-${status.key}">${esc(status.label)}</span></h2>
    <p class="act-front">${mathHTML(plainText(card.front), { inline: true })}</p>
    <div class="act-list">
      <button type="button" class="act-row" data-go="edit" aria-keyshortcuts="E">${icon('edit')}<span>Edit card</span><kbd aria-hidden="true">E</kbd></button>
      <div class="act-row act-flags" role="group" aria-labelledby="flagLbl"><span class="act-fl" id="flagLbl">Flag</span>
        ${FLAGS.map(f => `<button type="button" class="act-flag" data-flag="${f.id}" style="--c:${f.color}" aria-pressed="${card.flag === f.id}" aria-label="${f.name} flag"></button>`).join('')}</div>
      <button type="button" class="act-row" data-act="bury" aria-keyshortcuts="-">${icon('moon')}<span>${isBuried(card, now) ? 'Unbury' : 'Bury until tomorrow'}</span><kbd aria-hidden="true">-</kbd></button>
      <button type="button" class="act-row" data-act="suspend" aria-keyshortcuts="@">${icon('pause')}<span>${isSuspended(card) ? 'Unsuspend' : 'Suspend'}</span><kbd aria-hidden="true">@</kbd></button>
      <button type="button" class="act-row" data-go="glossary">${icon('plus')}<span>Add to glossary${picked ? `<small>“${esc(picked)}”</small>` : ''}</span></button>
      <button type="button" class="act-row" data-go="more">${icon('more')}<span>More<small>Move, due date, reset, delete, card info</small></span>${icon('chevron')}</button>
    </div>`), { side: true });
  const { save } = cardOps(card, ctx);
  const sheet = $('sheet');
  sheet.querySelector('[data-go="glossary"]').addEventListener('click', () => import('./glossary-sheet.js').then(m => m.openTermForm({ term: picked, back: 'close' })).catch(err => console.error(err)));
  sheet.querySelector('[data-go="edit"]').addEventListener('click', () => openCardEdit(card, ctx));
  sheet.querySelector('[data-go="more"]').addEventListener('click', () => openCardPanel(card, { ...ctx, mode: 'full' }));
  sheet.querySelector('[data-act="bury"]').addEventListener('click', () => toggleBury(card, save));
  sheet.querySelector('[data-act="suspend"]').addEventListener('click', () => toggleSuspend(card, save));
  wireFlags(f => { const next = f === card.flag ? 0 : f; save({ flag: next }, next ? `${FLAGS.find(x => x.id === next).name} flag` : 'Flag removed', 'flag'); });
}

// The shortcuts shown in the short sheet (E, - and @) work while it is open. Review's and Play's own keys stand aside
// when a sheet is open, so they are handled here, on whatever short sheet is showing.
document.addEventListener('keydown', e => {
  const sheet = document.getElementById('sheet');
  if (!sheet?.open || !sheet.querySelector('.act-list') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!singleKeysOn() || e.target.closest?.('input, textarea, select')) return;
  const pick = { e: '[data-go="edit"]', E: '[data-go="edit"]', '-': '[data-act="bury"]', '@': '[data-act="suspend"]' }[e.key];
  if (pick) { e.preventDefault(); sheet.querySelector(pick)?.click(); }
});

// The short editor: Front, Back and Tags (with the formatting buttons and pictures), Cancel and Save always in view.
async function openCardEdit(card, ctx) {
  const maxN = await noteMaxN(card);
  const partner = await partnerOf(card);
  openSheet(`
    <h2 id="sheetTitle">Edit card</h2>
    <form id="ceForm" class="sheet-in" style="padding:0">
      ${cardFieldsHTML(card, maxN, partner)}
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="ceCancel">Cancel</button>
        <button class="btn primary" type="submit">Save <kbd aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵'}</kbd></button>
      </div>
    </form>`, { side: true });
  $('ceCancel').addEventListener('click', closeSheet);
  wireCardForm(card, ctx, 'Card saved', partner);
}

// ---------- shared by the card sheets ----------
// What happens after a change to one card: refresh the list, tell the caller, then close the sheet or show the card's
// full panel again with fresh data.
function cardOps(card, ctx) {
  const { statesById, refresh = async () => {}, onAction, closeAfter = [] } = ctx;
  const again = async (msg, act) => {
    if (msg) toast(msg);
    await refresh();
    const fresh = (await db.get('cards', card.id));
    const st = await db.get('cardStates', card.id);
    if (st) statesById.set(card.id, st); else statesById.delete(card.id);
    if (onAction) await onAction(act, fresh, st);
    if (fresh && !closeAfter.includes(act)) openCardPanel(fresh, { ...ctx, mode: 'full', showInfo: false }); else closeSheet();
  };
  // A cloze card's deck and tags belong to its whole note, so they change on every sibling; flags, suspend and bury
  // are the card's own.
  const save = async (changes, msg, act) => {
    const wholeNote = card.noteId && ('deckId' in changes || 'tags' in changes);
    const sibs = wholeNote ? (await db.getAll('cards')).filter(c => c.noteId === card.noteId && c.id !== card.id) : [];
    const shared = { ...('deckId' in changes ? { deckId: changes.deckId } : {}), ...('tags' in changes ? { tags: changes.tags } : {}) };
    const merged = { ...card, ...changes };
    if ('noteExtra' in changes && !changes.noteExtra) delete merged.noteExtra;      // an emptied memory hook is no hook
    if ('noteFields' in changes) { const f = cleanFields(changes.noteFields).fields; if (f.length) merged.noteFields = f; else delete merged.noteFields; }      // no other fields is no list, and the list is kept within its limits
    for (const k of ['frontSounds', 'backSounds']) if (k in changes && !changes[k]?.length) delete merged[k];      // and no sounds is no list
    if ('acceptAnswers' in changes && !changes.acceptAnswers?.length) delete merged.acceptAnswers;      // and no accepted answers is none
    await db.saveCards([merged, ...sibs.map(c => ({ ...c, ...shared }))]);
    return again(msg, act);
  };
  return { again, save };
}
// Is this a cloze card (one of the cards made from a cloze note)?
const isClozeCard = card => !!card.noteId && typeof card.noteText === 'string';
// A badge for the list: which part of its picture an image-occlusion card hides ("2/5").
const occBadge = card => {
  if (!hasMasks(card)) return '';
  const { k, total } = groupIndex(card.occlusion.masks, card.occlusion.n);
  return `<span class="ckind" title="Image occlusion, part ${k} of ${total}">${k}/${total}</span> `;
};
// The highest part number used by any card of this picture note: a new box must never reuse one, even a number that
// is missing from the boxes this card holds (a sync can leave a sibling's number out).
const noteMaxN = async card => (card.noteId && hasMasks(card)
  ? Math.max(0, ...(await db.getAll('cards')).filter(c => c.noteId === card.noteId).map(c => c.occlusion?.n).filter(Number.isInteger))
  : 0);
// pair: the other card when this one has a reverse card (or is one), else null
const cardFieldsHTML = (card, maxN = 0, pair = null) => `
      ${isClozeCard(card) ? clozeFields('ce', card.noteText, card.noteExtra || '') + (card.frontSounds?.length || card.backSounds?.length ? `<div class="field"><span>Sounds</span>${soundsHTML(card.frontSounds)}${soundsHTML(card.backSounds)}</div>` : '') + noteFieldsEditHTML('ce', card.noteFields) : hasMasks(card) ? occlusionFields('ce', card, '', { maxN }) : `
      ${basicFields('ce', { front: card.front, back: card.back, frontImage: card.frontImage, backImage: card.backImage, hook: card.noteExtra || '' })}
      ${reverseSwitchHTML('ce', { on: !!pair, blocked: isStructured(card) })}
      ${noteFieldsEditHTML('ce', card.noteFields)}`}
      <label class="field"><span>Tags (separated by spaces or commas)</span><input id="ceTags" value="${esc((card.tags || []).join(', '))}" autocomplete="off"></label>
      ${acceptedOf(card).length && !isClozeCard(card) && !hasMasks(card) ? `<label class="field"><span>Other accepted answers (separated by commas)</span><input id="ceAccept" value="${esc(acceptedOf(card).join(', '))}" autocomplete="off"></label>` : ''}
      <div id="ceFormConfirm"></div>
      <p class="err" id="ceErr" role="alert" hidden></p>`;
// The form's error: read out, linked to the field it is about (aria-invalid + aria-describedby) and the cursor goes there. Without `field`, the
// first box of the form that is showing (the Text of a cloze note, the Front of a card, the picture button of a picture note).
const showErr = (id, text, field) => {
  const p = id.slice(0, 2);
  const shown = [p + 'Text', p + 'Front', p + 'OccChoose', p + 'OccEdit'].map($).find(x => x && !x.closest('[hidden]'));
  showFieldError(field ? $(field) : shown, $(id), text);
};
function wireCardForm(card, ctx, msg, pair = null) {
  const ops = cardOps(card, ctx);
  if (!isClozeCard(card) && !hasMasks(card)) { setCardSounds('ceFront', card.frontSounds || []); setCardSounds('ceBack', card.backSounds || []); wireRevSwitch('ce', $('ceForm')); }
  $('ceForm').addEventListener('submit', e => {
    e.preventDefault();
    if (isClozeCard(card)) return saveClozeNote(card, ops, msg);
    if (hasMasks(card)) return saveOcclusionNote(card, ops, msg);
    const front = readCardText('ceFront').trim(), back = readBack('ce').trim();
    const frontImage = readCardImage('ceFront'), backImage = readCardImage('ceBack');
    const frontSounds = readCardSounds('ceFront'), backSounds = readCardSounds('ceBack');
    // Each side needs something on it: text, a picture or a sound.
    if (!(front || frontImage || frontSounds.length) || !(back || backImage || backSounds.length)) { showErr('ceErr', 'A card needs a front and a back (text or a picture, or a sound).', front || frontImage || frontSounds.length ? 'ceBack' : 'ceFront'); return; }
    const why = stepsProblem('ce');
    if (why) { showErr('ceErr', why); return; }
    const noteExtra = readCardText('ceHook').trim(), tags = parseTags($('ceTags').value), noteFields = readNoteFields('ce');
    const accept = $('ceAccept') ? { acceptAnswers: parseAccepted($('ceAccept').value) } : {};
    const both = !!$('ceRevOn')?.checked && !stepsOn('ce');
    // A card over the server's size limit would never sync, so it is stopped here, not set aside later.
    const big = savedTooBigNote([{ ...card, front, back, frontImage, backImage, frontSounds, backSounds, noteExtra, tags, ...accept, ...(noteFields !== undefined ? { noteFields } : {}) }]);
    if (big) { showErr('ceErr', big); return; }
    if (pair || both) return saveWithReverse(card, pair, both, { front, back, frontImage, backImage, frontSounds, backSounds, ...accept }, { tags, noteExtra, noteFields }, ops, msg);
    ops.save({ front, back, frontImage, backImage, frontSounds, backSounds, noteExtra, tags, ...accept, ...(noteFields !== undefined ? { noteFields } : {}) }, msg, 'edit');
  });
  // Ctrl/⌘+Enter saves from inside a box.
  $('ceForm').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('ceForm').requestSubmit(); } });
  // Back, ×, a tap outside or Esc with edits not saved asks "Discard changes?" (nothing changed: it just closes).
  const base = formSnapshot($('ceForm'));
  $('ceForm').dataset.cardId = card.id;
  formBase = { id: card.id, vals: fieldVals($('ceForm')) };
  guardSheet(() => !!$('ceForm') && formSnapshot($('ceForm')) !== base);
  restoreDraft(card);
}

// Changing screen closes the card panel. Edits that were not saved are kept (not asked about: the screen has already changed)
// and put back if that card's panel is opened again, for up to 30 minutes. Only the fields that were edited come back, and only
// where the card has not changed meanwhile (a sync, another device): those are left out, and the toast says so.
let draft = null, formBase = null;      // formBase: the form's field values as the panel opened
const fieldVals = form => Object.fromEntries([...form.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
  .filter(el => el.id && !['file', 'button', 'submit', 'hidden'].includes(el.type))
  .map(el => [el.id, el.isContentEditable ? el.innerHTML : (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value]));
setDraftStasher(what => (what === 'clear' ? (draft = null) : stashCardDraft()));
function stashCardDraft() {
  const f = $('ceForm');
  if (!f || !sheetDirty() || !formBase || formBase.id !== f.dataset.cardId) return;
  const cur = fieldVals(f);
  const fields = Object.keys(cur).filter(id => cur[id] !== formBase.vals[id]).map(id => ({ id, v: cur[id], base: formBase.vals[id], rich: $(id).isContentEditable }));
  if (fields.length) draft = { id: f.dataset.cardId, at: Date.now(), fields };
}
function restoreDraft(card) {
  const d = draft;
  if (!d) return;
  if (Date.now() - d.at > 30 * 60000) { draft = null; return; }
  if (d.id !== card.id) return;                // another card: it waits for its own card
  draft = null;
  const now = fieldVals($('ceForm'));          // the form was just built from the card as it is now
  let back = 0, left = 0;
  for (const x of d.fields) {
    const el = $(x.id);
    if (!el || !$('ceForm').contains(el)) continue;
    if (now[x.id] !== x.base) { left++; continue; }       // this field changed elsewhere since: keep the card's newer value
    if (x.rich) el.innerHTML = x.v; else if (typeof x.v === 'boolean') el.checked = x.v; else el.value = x.v;
    back++;
  }
  if (left) toast(back ? 'Your unsaved edits are back, but some were left out because this card changed on another device' : 'Your unsaved edits were left out because this card changed on another device');
  else if (back) toast('Your unsaved edits to this card are back');
}

// ---------- cards that work in both directions (reverse.js) ----------
// The other card of a pair (a card and its reverse card), or null.
async function partnerOf(card) {
  if (!isPair(card)) return null;
  return (await db.getAll('cards')).find(c => c.id !== card.id && isPair(c) && c.noteId === card.noteId) || null;
}
// The "Both directions" switch hides, with a note, while "Answer in steps" is on.
function wireRevSwitch(p, form) {
  form.addEventListener('change', e => {
    if (e.target.dataset?.modeFor !== p) return;      // the Answer: Text | Steps | Elements choice
    const blocked = stepsOn(p);
    $(p + 'RevRow').hidden = blocked; $(p + 'RevNote').hidden = !blocked;
  });
}
// Saving a basic card that is, or becomes, one of a pair. `pair` is its other card (null for an ordinary card), `both` says whether the
// switch is on, `sides` the front, back, pictures and sounds as edited, `shared` the fields both cards share (tags, hook, other fields).
//   pair + both     both cards are saved, the other one swapped to match
//   pair, not both  the reverse card goes (asks first) and the other card becomes an ordinary card
//   no pair + both  the card gets a reverse card
async function saveWithReverse(card, pair, both, sides, shared, ops, msg) {
  const common = { deckId: card.deckId, tags: shared.tags, noteExtra: shared.noteExtra, noteFields: shared.noteFields?.length ? shared.noteFields : undefined };
  const go = async () => {
    if (pair && both) {
      await db.saveNote({ update: pairPlan(card, pair, sides) }, { ...common, noteId: card.noteId });
    } else if (pair) {
      const [a, b] = pairPlan(card, pair, sides);
      const [keep, drop] = a.reverse ? [b, a] : [a, b];
      await db.saveNote({ update: [unpaired(keep)], remove: [drop] }, { ...common, noteId: undefined });
    } else {
      const fwd = { ...unpaired(card), ...sides };
      for (const k of ['frontImage', 'backImage']) if (!fwd[k]) delete fwd[k];
      for (const k of ['frontSounds', 'backSounds']) if (!fwd[k]?.length) delete fwd[k];
      if (!canReverse(fwd)) { showErr('ceErr', "This card can't have a reverse card."); return; }
      await db.saveNote({ update: [fwd], add: [reverseOf(fwd, db.newId())] }, { ...common, noteId: db.newId() });
    }
    return ops.again(msg, 'edit');
  };
  if (pair && !both) {
    const steps = stepsOn('ce');
    return confirmIn('ceFormConfirm', steps ? "Step-by-step cards can't have a reverse card. Save and remove the reverse card?" : 'Remove the reverse card? Its schedule and history go.',
      steps ? 'Save and remove it' : 'Remove reverse card', go);
  }
  return go();
}
// Deleting one card of a pair: both, or just this one (the other turns into an ordinary card).
function askDeletePair(card, partner, again) {
  $('ceConfirm').innerHTML = `<div class="confirm"><p>This card has a reverse card.</p><div class="sheet-actions">
    <button class="btn ghost" type="button" id="cfNo">Cancel</button><button class="btn ghost" type="button" id="cfOnly">Only this one</button>
    <button class="btn danger solid" type="button" id="cfBoth">Delete both</button></div></div>`;
  $('cfNo').addEventListener('click', () => { $('ceConfirm').innerHTML = ''; });
  $('cfBoth').addEventListener('click', () => guardedGo(() => db.deleteCards([card.id, partner.id]).then(() => again('Both cards deleted', 'delete'))));
  $('cfOnly').addEventListener('click', () => guardedGo(async () => { await db.saveCards([unpaired(partner)]); await db.deleteCards([card.id]); return again('Card deleted', 'delete'); }));
  $('cfBoth').scrollIntoView({ block: 'nearest' });
}

// Saving a cloze note: every card of the note at once. A blank that was taken out deletes its card and history,
// so that asks first (in the page, like the other confirmations).
// The text is read and planned again when the save actually happens (it may have changed, or a sync may have
// changed the note, since the question was shown); if that removes a card nobody confirmed, it asks again.
// The buttons are off while saving, so a double-click can't save twice (which would add a blank's card twice).
let savingNote = false;
async function saveClozeNote(card, ops, msg) {
  const planNow = async () => {
    const sibs = (await db.getAll('cards')).filter(c => c.noteId === card.noteId);
    // Of two cards with the same blank number, the one with a schedule or the most reviews stays.
    const states = new Set((await db.getAll('cardStates')).map(s => s.cardId));
    const reviews = new Map(await Promise.all(sibs.map(async c => [c.id, (await db.getCardLogs(c.id)).length])));
    return planNoteSave(sibs, readCardText('ceText').trim(), c => (states.has(c.id) ? 1e9 : 0) + reviews.get(c.id));
  };
  const busy = on => document.querySelectorAll('#ceForm button, button[form=ceForm]').forEach(b => { b.disabled = on; });
  const guarded = async fn => {
    if (savingNote) return;
    savingNote = true; busy(true);
    try { await fn(); } finally { savingNote = false; busy(false); }
  };
  // confirmed: ids of the cards the person agreed to remove
  const go = async confirmed => {
    const plan = await planNow();
    if (plan.error) { showErr('ceErr', plan.error); return; }
    if (!plan.update.length && !plan.add.length) { showErr('ceErr', 'Add at least one blank: select a word, then press New blank.'); return; }
    // (The note's sounds come along to a blank added now, as they are shared by all its cards.)
    const common = { deckId: card.deckId, noteId: card.noteId, tags: parseTags($('ceTags').value), noteExtra: readCardText('ceExtra').trim(), noteFields: readNoteFields('ce')?.length ? readNoteFields('ce') : undefined, frontSounds: card.frontSounds, backSounds: card.backSounds };
    const big = savedTooBigNote([...plan.update, ...plan.add], common);
    if (big) { showErr('ceErr', big); return; }
    $('ceErr').hidden = true;
    if (plan.remove.some(c => !confirmed.has(c.id))) return ask(plan);
    await db.saveNote(plan, common);
    return ops.again(msg, 'edit');
  };
  const ask = plan => confirmIn('ceFormConfirm', removalText(plan), 'Remove and save', () => guarded(() => go(new Set(plan.remove.map(c => c.id)))));
  return guarded(() => go(new Set()));
}

// Saving an image-occlusion picture: every card of the note at once, the same way as a cloze note (above). Labels and
// the header go to all of them; a box taken out deletes its card and history, so that asks first.
async function saveOcclusionNote(card, ops, msg) {
  const planNow = async () => {
    const sibs = (await db.getAll('cards')).filter(c => c.noteId === card.noteId);
    const states = new Set((await db.getAll('cardStates')).map(s => s.cardId));
    const reviews = new Map(await Promise.all(sibs.map(async c => [c.id, (await db.getCardLogs(c.id)).length])));
    return planOcclusionSave(sibs, readOcclusion('ce'), c => (states.has(c.id) ? 1e9 : 0) + reviews.get(c.id));
  };
  const busy = on => document.querySelectorAll('#ceForm button, button[form=ceForm]').forEach(b => { b.disabled = on; });
  const guarded = async fn => {
    if (savingNote) return;
    savingNote = true; busy(true);
    try { await fn(); } finally { savingNote = false; busy(false); }
  };
  const go = async confirmed => {
    const plan = await planNow();
    if (plan.error) { showErr('ceErr', plan.error); return; }
    const common = { deckId: card.deckId, noteId: card.noteId, tags: parseTags($('ceTags').value), noteExtra: readCardText('ceOccExtra').trim() };
    const big = savedTooBigNote([...plan.update, ...plan.add], common);
    if (big) { showErr('ceErr', big); return; }
    $('ceErr').hidden = true;
    if (plan.remove.some(c => !confirmed.has(c.id))) return ask(plan);
    await db.saveNote(plan, common);
    return ops.again(msg, 'edit');
  };
  const ask = plan => confirmIn('ceFormConfirm', occRemovalText(plan), 'Remove and save', () => guarded(() => go(new Set(plan.remove.map(c => c.id)))));
  return guarded(() => go(new Set()));
}
const toggleSuspend = (card, save) => save({ suspended: !isSuspended(card) }, isSuspended(card) ? 'Unsuspended' : 'Suspended', isSuspended(card) ? 'unsuspend' : 'suspend');
const toggleBury = (card, save) => save({ buriedUntil: isBuried(card) ? 0 : buryUntil() }, isBuried(card) ? 'Unburied' : 'Buried until tomorrow', isBuried(card) ? 'unbury' : 'bury');

// ---------- duplicating ----------
// A duplicate is a new card (or, for a cloze or image-occlusion note, a new note with all its cards) with the same deck, text,
// tags, pictures, memory hook and accepted answers, and a fresh schedule (see duplicateCards in browse-logic.js).
// Undo deletes the copies again (they have no schedule or history to lose, unless they were studied in the meantime).
const undoDuplicate = (copies, refresh) => ({
  hold: true,
  link: { href: '#', label: 'Undo', onClick: async () => {
    // The copies and any card added to their notes since (a new blank, say) go. If the editor is showing one of them, it
    // closes first, so a Save in it can't bring a deleted copy back.
    const noteIds = new Set(copies.map(c => c.noteId).filter(Boolean));
    const ids = new Set(copies.map(c => c.id));
    for (const c of await db.getAll('cards')) if (c.noteId && noteIds.has(c.noteId)) ids.add(c.id);
    const shown = panelFor;
    if (shown && document.getElementById('sheet')?.open && (ids.has(shown.id) || (shown.noteId && noteIds.has(shown.noteId)))) closeSheet();
    await db.deleteCards([...ids]);
    toast(copies.length === 1 ? 'Copy removed' : 'Copies removed');
    await refresh();
  } }
});
// One card: make the copy, then open it in the editor.
async function duplicateAndEdit(card, ctx) {
  const { copies, firstCopy } = duplicateCards([card], await db.getAll('cards'), db.newId);
  await db.saveCards(copies);
  const { refresh = async () => {}, decks, statesById } = ctx;
  await refresh();
  // The copy opens with only the lists and refresh: the screen that opened the original (Review, Play) knows nothing of
  // the copy, so its onAction / closeAfter must not apply to it.
  await openCardPanel(firstCopy, { decks, statesById, refresh, mode: 'full', showInfo: false });
  toast('Duplicated. Editing the copy.', undoDuplicate(copies, refresh));
}

// ---------- acting on several cards ----------
function openBulkActions(selected, { decks, statesById, refresh, clear }) {
  const n = selected.length;
  const studied = selected.filter(c => statesById.get(c.id)?.state > 0);
  openSheet(`
    <h2 id="sheetTitle">${plural(n, 'card')} selected</h2>
    <div class="act-grid">
      <button class="btn ghost small" type="button" data-act="suspend">Suspend</button>
      <button class="btn ghost small" type="button" data-act="unsuspend">Unsuspend</button>
      <button class="btn ghost small" type="button" data-act="bury">Bury until tomorrow</button>
      <button class="btn ghost small" type="button" data-act="unbury">Unbury</button>
      <button class="btn ghost small" type="button" data-act="duplicate" title="Makes new copies; a cloze or picture note is copied with all its cards, a reverse pair in both directions">${icon('plus')} Duplicate</button>
      <button class="btn ghost small" type="button" data-act="reset" ${studied.length ? '' : 'disabled'}>Reset to new</button>
      <button class="btn ghost small" type="button" data-act="reverse">Both directions</button>
      <button class="btn danger small" type="button" data-act="delete">Delete…</button>
    </div>
    <div id="ceConfirm"></div>
    <div class="field"><span>Flag</span>${flagButtons(-1)}</div>
    <div class="field"><span>Move to deck</span>${moveRow(decks, null)}</div>
    <details class="card-info" id="frBox">
      <summary>Find and replace</summary>
      <form id="frForm" class="fr-form">
        <label class="field"><span>Find</span><input id="frFind" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label class="field"><span>Replace with</span><input id="frWith" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div class="chips" role="group" aria-label="Where">
          ${[['both', 'Front and back'], ['front', 'Front'], ['back', 'Back']].map(([v, l], i) => `<label class="chip"><input type="radio" name="frIn" value="${v}" ${i ? '' : 'checked'}><span>${l}</span></label>`).join('')}
        </div>
        <label class="check"><input type="checkbox" id="frCase"> Match capitals</label>
        <p class="note" id="frCount" aria-live="polite">Type what to find.</p>
        <button class="btn primary small" type="submit" id="frGo" disabled>Replace</button>
      </form>
    </details>
    <div class="field"><span>Set due date</span>${studied.length ? dueRow() + (studied.length < n ? `<p class="note">Applies to the ${studied.length} you've studied. New cards are skipped.</p>` : '') : '<p class="note" style="margin:0">None of these have been reviewed yet.</p>'}</div>
    `, { side: true });
  const done = async msg => { toast(msg); closeSheet(); await refresh(); };
  const update = (changes, msg) => db.saveCards(selected.map(c => ({ ...c, ...changes }))).then(() => done(msg));
  document.querySelectorAll('#sheet [data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'suspend') update({ suspended: true }, `Suspended ${plural(n, 'card')}`);
    if (act === 'unsuspend') update({ suspended: false }, `Unsuspended ${plural(n, 'card')}`);
    if (act === 'bury') update({ buriedUntil: buryUntil() }, `Buried ${plural(n, 'card')} until tomorrow`);
    if (act === 'unbury') update({ buriedUntil: 0 }, `Unburied ${plural(n, 'card')}`);
    if (act === 'duplicate') (async () => {
      const { copies } = duplicateCards(selected, await db.getAll('cards'), db.newId);
      await db.saveCards(copies);
      closeSheet();
      toast(`Duplicated ${plural(copies.length, 'card')}`, undoDuplicate(copies, refresh));
      await refresh();
    })();
    if (act === 'reset') confirmIn('ceConfirm', `Reset ${plural(studied.length, 'card')} to new? Their schedules start over (history is kept).`, 'Reset', () => db.clearStates(studied.map(c => c.id)).then(() => done(`Reset ${plural(studied.length, 'card')}`)));
    if (act === 'reverse') bulkReverse(selected, done);
    if (act === 'delete') confirmIn('ceConfirm', `Delete ${plural(n, 'card')} and their history? This can’t be undone.`, `Delete ${plural(n, 'card')}`, async () => {
      await db.deleteCards(selected.map(c => c.id));
      // A card whose partner is deleted becomes an ordinary card again.
      const gone = new Set(selected.map(c => c.id)), notes = new Set(selected.filter(isPair).map(c => c.noteId));
      const left = notes.size ? (await db.getAll('cards')).filter(c => isPair(c) && notes.has(c.noteId) && !gone.has(c.id)) : [];
      if (left.length) await db.saveCards(left.map(unpaired));
      clear();
      return done(`Deleted ${plural(n, 'card')}`);
    });
  }));
  // Find and replace: shows how many cards would change as you type.
  // A card with a reverse card changes both (the other one is swapped to match): see syncPairChanges in reverse.js.
  let everyCard = selected;
  const loaded = selected.some(isPair) ? db.getAll('cards').then(all => { everyCard = all; frCount(); }) : Promise.resolve();
  const frChanges = () => syncPairChanges(replaceInCards(selected, { find: $('frFind').value, replace: $('frWith').value,
    field: document.querySelector('#sheet [name=frIn]:checked').value, matchCase: $('frCase').checked }), everyCard);
  const frCount = () => {
    const n2 = $('frFind').value ? frChanges().length : 0;
    $('frCount').textContent = !$('frFind').value ? 'Type what to find.' : n2 ? `Changes ${plural(n2, 'card')}.` : 'No matches in these cards.';
    $('frGo').disabled = !n2;
  };
  $('frForm').addEventListener('input', frCount);
  $('frForm').addEventListener('submit', async e => {
    e.preventDefault();
    await loaded;
    const all = frChanges();
    if (!all.length) return;
    // A card that would end up too large to sync is left as it was (and so is its reverse card, so a pair never disagrees).
    const big = splitTooBig(all).big, bigNotes = new Set(big.filter(isPair).map(c => c.noteId));
    const changed = all.filter(c => !big.includes(c) && !(isPair(c) && bigNotes.has(c.noteId)));
    const dropped = all.length - changed.length;
    const left = dropped > big.length ? `${plural(dropped, 'card')} ${dropped === 1 ? 'was' : 'were'} left unchanged, because a card or its reverse card was too large` : tooLargeNote(dropped);
    if (!changed.length) { $('frCount').textContent = `${left}.`; return; }
    await db.saveCards(changed);
    done(`Replaced in ${plural(changed.length, 'card')}${left ? `. ${left}` : ''}`);
  });
  wireFlags(f => update({ flag: f }, f ? `Flagged ${plural(n, 'card')} ${FLAGS.find(x => x.id === f).name.toLowerCase()}` : `Removed flags from ${plural(n, 'card')}`));
  wireMove(deckId => update({ deckId }, `Moved ${plural(n, 'card')} to ${deckPath(decks, deckId)}`));
  if (studied.length) wireDue(days => db.putStates(studied.map(c => dueIn(statesById.get(c.id), days))).then(() => done(`${plural(studied.length, 'card')} due ${days ? `in ${plural(days, 'day')}` : 'today'}`)));
}

// "Both directions" for the selected cards. The cards are read again first (a sync or another tab may have changed them) and again when
// the question is answered. A card that carries a pair's noteId but has no partner counts as an ordinary card and can be paired again.
async function bulkReverse(selected, done) {
  const ids = selected.map(c => c.id);
  const fresh = async () => {
    const all = await db.getAll('cards'), lone = loneIds(all), byId = new Map(all.map(c => [c.id, c]));
    const cards = ids.map(id => byId.get(id)).filter(Boolean);
    return { todo: cards.filter(c => (!isPair(c) || lone.has(c.id)) && canReverse(unpaired(c))), stuck: cards.filter(c => !isPair(c) && !canReverse(c)).length };
  };
  const { todo, stuck } = await fresh();
  if (!todo.length) { toast('None of these can get a reverse card'); return; }
  confirmIn('ceConfirm', `Add reverse cards to ${plural(todo.length, 'card')}?${stuck ? ` ${stuck} can't be reversed (cloze, image-occlusion or step-by-step cards).` : ''}`, `Add ${plural(todo.length, 'reverse card')}`, async () => {
    const now = Date.now(), { todo: again } = await fresh();
    const cards = again.flatMap(c => { const fwd = { ...unpaired(c), noteId: db.newId(), noteEditedAt: now }; return [fwd, { ...reverseOf(fwd, db.newId()), noteEditedAt: now }]; });
    await db.saveCards(cards);
    done(`Added ${plural(again.length, 'reverse card')}`);
  });
}

// ---------- tools ----------
// The Tools sheet: tags (rename or remove one everywhere in the list's cards, merging with an existing tag is
// fine) and "Link cloze cards" (older imports: turn separate fill-in-the-blank cards into notes).
function openTools(cards, { scope, refresh }) {
  const tags = tagCounts(cards);
  // Tags with "::" (Anki decks like AnKing) are shown as folders, opened one at a time; other tags stay a flat list.
  const folders = hasFolders(cards);
  const tree = folders ? tagTree(cards) : null;
  openSheet(`
    <h2 id="sheetTitle">Tools</h2>
    <h3 class="tool-h">Find by tag or question ID</h3>
    <p class="note">Paste the IDs of questions you missed in a question bank, or pick a tag, and study those cards. Looks in all decks.</p>
    <button class="btn ghost small" type="button" id="toolTagStudy">Find by tag or question ID</button>
    <h3 class="tool-h">Tags in ${esc(scope)}</h3>
    ${folders ? `<div class="tag-tree-box" id="tagTreeBox">${tagTreeHTML(tree, { mode: 'manage' })}</div>`
      : tags.length ? `<ul class="tag-list">${tags.map(({ tag, count }) => `
      <li data-tag="${esc(tag)}"><span class="tag-name">${esc(tag)}</span><span class="muted small">${plural(count, 'card')}</span>
        <button class="btn ghost small" type="button" data-tag-rename>Rename</button>
        <button class="btn ghost small" type="button" data-tag-remove>Remove</button></li>`).join('')}</ul>`
      : '<p class="note">No tags yet. Add them when editing a card.</p>'}
    <div id="tagEdit"></div>
    <h3 class="tool-h">Link cloze cards</h3>
    <p class="note">Cards imported before notes existed have one separate card for each blank (“The […] makes ATP” and “The mitochondria makes […]”). This finds cards of one deck that come from the same sentence and links them as one cloze note, so Review shows one of them a day. Schedules and history stay as they are. You see what it found first.</p>
    <button class="btn ghost small" type="button" id="linkFind">Find cards to link</button>
    <div id="linkOut" aria-live="polite"></div>`, { side: true });
  wireLinkTool(cards, { scope, refresh });
  $('toolTagStudy').addEventListener('click', async () => {
    try { (await import('./tag-study-sheet.js')).openTagStudySheet({ onChange: refresh }); }
    catch { toast("Couldn't open this. Check your connection and try again."); }
  });
  const apply = async (from, to, { folder = false, name = from, exact = false } = {}) => {
    const changed = folder ? renameTagPrefix(cards, from, to) : exact ? renameTagExact(cards, from, to) : renameTag(cards, from, to);
    await db.saveCards(changed);
    const what = folder ? `the folder “${name}”` : `“${from}”`;
    toast(to ? `Renamed ${what} on ${plural(changed.length, 'card')}` : `Removed ${what} from ${plural(changed.length, 'card')}`);
    await refresh();
    closeSheet();
  };
  const renameForm = (label, from, onGo) => {
    $('tagEdit').innerHTML = `<form class="confirm" id="tagForm"><label class="field"><span>${label}</span>
      <input id="tagNew" value="${esc(from)}" autocomplete="off" autocapitalize="off"></label>
      <div class="sheet-actions"><button class="btn ghost" type="button" id="tagNo">Cancel</button><button class="btn primary" type="submit">Rename</button></div></form>`;
    $('tagNew').select();
    $('tagNo').addEventListener('click', () => { $('tagEdit').innerHTML = ''; });
    $('tagForm').addEventListener('submit', e => { e.preventDefault(); const to = $('tagNew').value.trim(); if (to && to.toLowerCase() !== from) onGo(to); });
    $('tagForm').scrollIntoView({ block: 'nearest' });
  };
  if (tree) {
    // How many different tags a folder holds (a tag that is also a folder counts itself).
    const tagsIn = n => (n.own ? 1 : 0) + n.children.reduce((t, k) => t + tagsIn(k), 0);
    wireTagTree($('tagTreeBox'), tree, { mode: 'manage', on: {
      show: path => {
        // Close the sheet and put the folder in the search box (the list filters as if it was typed).
        closeSheet();
        const box = $('brQuery');
        if (!box) return;
        box.value = `tag:${/\s/.test(path) ? `"${path}"` : path}`;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.scrollIntoView({ block: 'nearest' });
      },
      rename: (path, node, li) => {
        const own = li.hasAttribute('data-own'), isFolder = node.children.length && !own;
        renameForm(isFolder ? `Rename the folder “${esc(node.name)}” to` : `Rename “${esc(own ? path : node.name)}” to`, path,
          to => (isFolder ? apply(path, to, { folder: true, name: node.name }) : apply(path, to, { exact: true })));
      },
      remove: (path, node, li) => {
        const own = li.hasAttribute('data-own'), isFolder = node.children.length && !own;
        if (isFolder) confirmIn('tagEdit', `Remove the folder “${node.name}” and its ${tagsIn(node).toLocaleString('en')} ${tagsIn(node) === 1 ? 'tag' : 'tags'} from every card in ${scope}? The cards stay.`, 'Remove folder', () => apply(path, "", { folder: true, name: node.name }));
        else confirmIn('tagEdit', `Remove the tag “${path}” from every card in ${scope}? The cards stay.`, 'Remove tag', () => apply(path, '', { exact: true }));
      }
    } });
  }
  document.querySelectorAll('#sheet .tag-list li').forEach(li => {
    const tag = li.dataset.tag;
    li.querySelector('[data-tag-rename]').addEventListener('click', () => renameForm(`Rename “${esc(tag)}” to`, tag, to => apply(tag, to)));
    li.querySelector('[data-tag-remove]').addEventListener('click', () =>
      confirmIn('tagEdit', `Remove the tag “${tag}” from every card in ${scope}? The cards stay.`, 'Remove tag', () => apply(tag, '')));
  });
}

// "Link cloze cards": look for older cards that belong together (cloze.js planLinks), show what it found, and only
// link them when asked. Linking changes nothing but the cards' note fields: schedules and history are not touched.
function wireLinkTool(cards, { scope, refresh }) {
  $('linkFind').addEventListener('click', () => {
    const { notes, skipped } = planLinks(cards);
    const linked = notes.reduce((n, x) => n + x.members.length, 0);
    const unclear = skipped ? `<p class="note">${plural(skipped, 'group')} of cards looked unclear (the blanks overlap), so ${skipped === 1 ? 'it was' : 'they were'} left alone.</p>` : '';
    if (!notes.length) { $('linkOut').innerHTML = `<div class="link-preview"><p>Nothing to link in ${esc(scope)}.</p>${unclear}</div>`; return; }
    $('linkOut').innerHTML = `<div class="link-preview">
      <p><b>${plural(notes.length, 'note')}</b> from <b>${plural(linked, 'card')}</b>.</p>
      <ul class="link-eg">${notes.slice(0, 3).map(n => `<li>${renderCloze(n.noteText, 0, 'all')} <span class="muted">(${plural(n.members.length, 'card')})</span></li>`).join('')}</ul>
      ${notes.length > 3 ? `<p class="note">…and ${plural(notes.length - 3, 'more note')}.</p>` : ''}${unclear}
      <div class="sheet-actions"><button class="btn ghost" type="button" id="linkNo">Cancel</button><button class="btn primary" type="button" id="linkGo">Link ${plural(linked, 'card')}</button></div></div>`;
    $('linkNo').addEventListener('click', () => { $('linkOut').innerHTML = ''; });
    $('linkGo').addEventListener('click', async () => {
      $('linkGo').disabled = true;
      // The cards are read again, so a change made since the preview (a tag, a suspend, a deleted card) is kept.
      // A card that was deleted, edited or linked in the meantime is left out.
      const nowCards = new Map((await db.getAll('cards')).map(c => [c.id, c]));
      const changed = notes.flatMap(n => {
        const noteId = db.newId();
        return n.members.flatMap(({ card, cloze }) => {
          const fresh = nowCards.get(card.id);
          if (!fresh || fresh.noteId || fresh.front !== card.front || fresh.back !== card.back) return [];
          return [{ ...fresh, noteId, cloze, noteText: n.noteText, ...clozeCard(n.noteText, cloze) }];
        });
      });
      // A note whose cards would be too large to sync stays as separate cards.
      if (!changed.length) { toast('Nothing was linked: those cards changed since the preview.'); await refresh(); closeSheet(); return; }
      const bigNotes = new Set(splitTooBig(changed).big.map(c => c.noteId));
      const fits = changed.filter(c => !bigNotes.has(c.noteId));
      if (fits.length) await db.saveCards(fits);
      const left = tooLargeNote(changed.length - fits.length, 'unlinked');
      toast(fits.length ? `Linked ${plural(fits.length, 'card')} into ${plural(new Set(fits.map(c => c.noteId)).size, 'note')}${left ? `. ${left}` : ''}` : `${left}.`);
      await refresh();
      closeSheet();
    });
    $('linkGo').scrollIntoView({ block: 'nearest' });
  });
}

// ---------- adding one card ----------
// prefill (optional): { front, back, onAdded } opens a Basic card with that text; it saves only on Add, then closes and runs onAdded.
export function openAddCard({ decks, deckId, refresh, prefill = null }) {
  if (!decks.length) { toast('Make a deck first'); return; }
  const target = deckId || decks[0].id;
  // A deck with subdecks asks which one (starting with the deck itself).
  const choices = deckChoices(decks, deckId ? subtreeIds(decks, deckId) : null);
  const kind = prefill ? 'basic' : lastKind();
  openSheet(`
    <h2 id="sheetTitle">${prefill ? 'Add a comparison card' : 'Add a card'}</h2>
    <form id="acForm" class="sheet-in ac-form" style="padding:0">
      ${choices.length < 2 ? '' : `<label class="field"><span>Deck</span><select id="acDeck" class="select">${choices.map(d => `<option value="${esc(d.id)}" ${d.id === target ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>`}
      ${noteKinds('ac', kind)}
      <div class="kind-body">
        <div id="acBasic" ${kind !== 'basic' ? 'hidden' : ''}>
          ${basicFields('ac', { frontPh: 'e.g. Mitosis', backPh: 'e.g. Division into two identical cells' })}
          ${reverseSwitchHTML('ac')}
        </div>
        <div id="acCloze" ${kind === 'cloze' ? '' : 'hidden'}>${clozeFields('ac')}</div>
        ${occlusionFields('ac', null, '', { hidden: kind !== 'occlusion' })}
      </div>
      <label class="field"><span>Tags (optional, separated by spaces or commas)</span><input id="acTags" autocomplete="off"></label>
      <p class="err" id="acErr" role="alert" hidden></p>
      <div class="sheet-actions">
        <p class="ac-why" id="acWhy" aria-live="polite"></p>
        <button class="btn ghost" type="button" id="acDone">Close</button>
        <button class="btn primary" type="submit" aria-disabled="true" aria-describedby="acWhy">Add card</button>
      </div>
    </form>`, { side: true });
  (kind === 'occlusion' ? $('acOccChoose') : $(kind === 'cloze' ? 'acText' : 'acFront')).focus();
  if (prefill) { setCardText('acFront', prefill.front || ''); setCardText('acBack', prefill.back || ''); $('acBack').focus(); }
  $('acDone').addEventListener('click', askClose);        // Close with a typed card not added asks "Discard changes?" (as do ×, Back and Esc)
  wireRevSwitch('ac', $('acForm'));
  let typed = formSnapshot($('acForm'), { textOnly: true });
  guardSheet(() => !!$('acForm') && formSnapshot($('acForm'), { textOnly: true }) !== typed);
  const updateAdd = watchAdd('ac');           // Add stays aria-disabled, with the reason beside it, until the card can be saved
  let adding = false;          // a second tap on Add while the first is saving must not add the cards twice
  $('acForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (adding) return;
    const deck = $('acDeck')?.value || target, tags = parseTags($('acTags').value);
    const kindNow = readKind('ac');
    // What to save, or the message to show (Ctrl+Enter can submit a form whose button is disabled).
    let save, count = 1, pairAdded = false;
    if (kindNow === 'occlusion') {
      const note = readOcclusion('ac');
      const plan = note.image ? planOcclusionSave([], note) : { error: 'Choose a picture first.' };
      if (plan.error) { showErr('acErr', plan.error); return; }
      const big = savedTooBigNote(plan.add, { tags, noteExtra: readCardText('acOccExtra').trim() });
      if (big) { showErr('acErr', big); return; }
      count = plan.add.length;
      save = () => db.saveNote(plan, { deckId: deck, noteId: db.newId(), tags, noteExtra: readCardText('acOccExtra').trim() });
    } else if (kindNow === 'cloze') {
      const text = readCardText('acText').trim();
      const plan = planNoteSave([], text);
      if (plan.error) { showErr('acErr', plan.error); return; }
      if (!plan.add.length) { showErr('acErr', 'Add at least one blank: select a word, then press New blank.'); return; }
      const big = savedTooBigNote(plan.add, { tags, noteExtra: readCardText('acExtra').trim() });
      if (big) { showErr('acErr', big); return; }
      count = plan.add.length;
      save = () => db.saveNote(plan, { deckId: deck, noteId: db.newId(), tags, noteExtra: readCardText('acExtra').trim() });
    } else {
      const front = readCardText('acFront').trim(), back = readBack('ac').trim(), hook = readCardText('acHook').trim();
      const frontImage = readCardImage('acFront'), backImage = readCardImage('acBack');
      const frontSounds = readCardSounds('acFront'), backSounds = readCardSounds('acBack');
      if (!(front || frontImage || frontSounds.length) || !(back || backImage || backSounds.length)) { showErr('acErr', 'A card needs a front and a back (text or a picture, or a sound).', front || frontImage || frontSounds.length ? 'acBack' : 'acFront'); return; }
      const why = stepsProblem('ac');
      if (why) { showErr('acErr', why); return; }
      const card = { id: db.newId(), deckId: deck, front, back, ...(frontImage ? { frontImage } : {}), ...(backImage ? { backImage } : {}), ...(frontSounds.length ? { frontSounds } : {}), ...(backSounds.length ? { backSounds } : {}), created: Date.now() };
      const big = savedTooBigNote([card], { tags, noteExtra: hook });
      if (big) { showErr('acErr', big); return; }
      if ($('acRevOn').checked && !stepsOn('ac') && canReverse(card)) {
        // Both directions: a card and its reverse card, saved together as one note (reverse.js).
        count = 2; pairAdded = true;
        save = () => db.saveNote({ add: [card, reverseOf(card, db.newId())] }, { deckId: deck, noteId: db.newId(), tags, noteExtra: hook });
      } else save = () => db.saveCards([{ ...card, ...(hook ? { noteExtra: hook } : {}), tags }]);
    }
    adding = true;
    try {
      await save();
    } catch (err) {
      console.error(err);
      showErr('acErr', "Couldn't save the cards. Try again.");
      return;
    } finally { adding = false; }
    if (prefill) { closeSheet(); toast('Comparison card added'); refresh(); prefill.onAdded?.(); return; }
    // Stay open for the next card, like Anki.
    $('acErr').hidden = true;
    if (kindNow === 'occlusion') { resetOcclusion('ac'); $('acOccChoose').focus(); }
    else if (kindNow === 'cloze') { setCardText('acText', ''); setCardText('acExtra', ''); $('acText').focus(); }
    else { clearBasic('ac'); setCardSounds('acFront', []); setCardSounds('acBack', []); $('acFront').focus(); }
    updateAdd();
    typed = formSnapshot($('acForm'), { textOnly: true });      // what is left (the tags stay for the next card) is not unsaved work
    toast(kindNow === 'basic' && !pairAdded ? 'Card added' : `Added ${plural(count, 'card')}`);
    refresh();
  });
  $('acForm').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('acForm').requestSubmit(); } });
}

// ---------- shared pieces ----------
function flagButtons(current) {
  return `<div class="flags" role="group" aria-labelledby="flagLbl">
    <button type="button" class="flagbtn" data-flag="0" aria-pressed="${current === 0}">None</button>
    ${FLAGS.map(f => `<button type="button" class="flagbtn" data-flag="${f.id}" aria-pressed="${current === f.id}"><i style="background:${f.color}"></i>${f.name}</button>`).join('')}
  </div>`;
}
function wireFlags(fn) {
  document.querySelectorAll('#sheet [data-flag]').forEach(b => b.addEventListener('click', () => fn(+b.dataset.flag)));
}
function moveRow(decks, currentId) {
  return `<div class="row-form"><select id="ceMove" class="select" aria-label="Deck">${deckChoices(decks).map(d => `<option value="${esc(d.id)}" ${d.id === currentId ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select>
    <button class="btn ghost small" type="button" id="ceMoveBtn">Move</button></div>`;
}
function wireMove(fn) {
  $('ceMoveBtn').addEventListener('click', () => fn($('ceMove').value));
}
function dueRow() {
  return `<div class="row-form due-row"><input id="ceDue" type="number" inputmode="numeric" min="0" max="3650" value="1" aria-label="Days from today"><span>days from today</span>
    <button class="btn ghost small" type="button" id="ceDueBtn">Set</button></div>`;
}
function wireDue(fn) {
  $('ceDueBtn').addEventListener('click', () => {
    const days = Number($('ceDue').value);
    if (!Number.isInteger(days) || days < 0 || days > 3650) { toast('Use a whole number of days, 0 or more'); return; }
    fn(days);
  });
}
// A schedule moved to `days` from today (0 = due now). The card keeps what FSRS knows about it.
function dueIn(state, days, now = Date.now()) {
  return { ...state, due: days === 0 ? now : daysAgoStart(-days, now), scheduledDays: days };
}
// Ask "are you sure?" inside the panel instead of a browser pop-up.
function confirmIn(boxId, text, yes, onYes) {
  $(boxId).innerHTML = `<div class="confirm"><p>${esc(text)}</p><div class="sheet-actions">
    <button class="btn ghost" type="button" id="cfNo">Cancel</button><button class="btn danger solid" type="button" id="cfYes">${esc(yes)}</button></div></div>`;
  $('cfNo').addEventListener('click', () => { $(boxId).innerHTML = ''; });
  $('cfYes').addEventListener('click', onYes);
  $('cfYes').scrollIntoView({ block: 'nearest' });
}
