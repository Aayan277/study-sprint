// The card list (browser): every card in a deck (or in all decks), with search, filters and sorting,
// and everything you can do to a card: edit, add, suspend, bury, flag, move, reset, set due date,
// delete and card info. Tap a card for its panel, or tap Select to act on several at once.
// Statuses, search and sorting live in browse-logic.js.

import * as db from './db.js';
import { browseCards, cardStatus, isSuspended, isBuried, buryUntil, parseTags, FLAGS, FILTERS, FILTER_GROUPS, SORTS, replaceInCards, tagCounts, renameTag } from './browse-logic.js';
import { daysAgoStart } from './stats-calc.js';
import { formatInterval } from './queue.js';
import { watchAdd, readCardText, setCardText, readCardImage, noteKinds, clozeFields, readKind, lastKind, occlusionFields, readOcclusion, resetOcclusion, basicFields, readBack, stepsProblem, clearBasic } from './card-editor.js';
import { planNoteSave, removalText, planLinks, clozeCard, renderCloze } from './cloze.js';
import { planOcclusionSave, occRemovalText, hasMasks, groupIndex } from './occlusion.js';
import { plainText, mathHTML } from './format.js';
import { ancestors, subtreeIds, deckPath, deckChoices } from './deck-tree.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon } from './ui.js';

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
  $('back').addEventListener('click', () => { location.hash = '#/decks'; });
  await mountBrowser($('browser'), { deckId: null, filter });
}

// ---------- the list ----------
// Draws the card list into `box`. deckId = null means all decks; a deck's list includes its subdecks.
// onChange runs after anything changes (the deck page uses it to refresh its counts).
export async function mountBrowser(box, { deckId, onChange = () => {}, filter }) {
  const B = { deckId, selecting: false, selected: new Set(), shown: PAGE, ...memory };
  if (filter && FILTERS.some(([k]) => k === filter)) B.filter = filter;      // a link to a filter (#/browse/leech) starts on it
  let decks, cards, statesById, inside;

  const load = async () => {
    const [d, c, s] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates')]);
    decks = d.sort((a, b) => a.created - b.created);
    inside = deckId ? subtreeIds(decks, deckId) : null;      // this deck and its subdecks
    cards = inside ? c.filter(x => inside.has(x.deckId)) : c;
    statesById = new Map(s.map(x => [x.cardId, x]));
  };
  await load();

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
      <span id="brSel" class="mono"></span>
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
        <button type="button" class="crow-btn" ${B.selecting ? `role="checkbox" aria-checked="${sel}"` : ''}>
          ${B.selecting ? '<span class="tick" aria-hidden="true"></span>' : ''}
          <span class="crow-main"><span class="f">${Number(card.cloze) > 0 ? `<span class="ckind" title="Cloze card, blank ${Number(card.cloze)}">c${Number(card.cloze)}</span> ` : ''}${occBadge(card)}${card.frontImage || card.backImage ? '<span class="pic-mark" title="Has a picture" aria-label="Has a picture">▣</span> ' : ''}${mathHTML(plainText(card.front), { inline: true })}</span><span class="b">${mathHTML(plainText(card.back), { inline: true })}</span>
            ${where(card) ? `<span class="d">${esc(where(card))}</span>` : ''}</span>
          <span class="crow-meta"><span class="st st-${st.key}">${esc(st.label)}</span>
            ${flag ? `<i class="flagdot" style="background:${flag.color}" title="${flag.name} flag" aria-label="${flag.name} flag"></i>` : ''}</span>
        </button></li>`;
    }).join('') : `<li class="empty">${cards.length ? 'No cards match.' : 'No cards yet. Tap + Add card, or import some.'}</li>`;
    $('brMore').hidden = list.length <= B.shown;
    $('brBulk').hidden = !B.selecting;
    $('brSel').textContent = `${B.selected.size} selected`;
    $('brSelect').textContent = B.selecting ? 'Cancel' : 'Select';
    // Says what it will do: select everything shown, or clear if that's already selected.
    $('brAll').textContent = list.length && list.every(x => B.selected.has(x.card.id)) ? 'Clear' : 'Select all';
  };

  // Something changed: reload from the database and redraw.
  const refresh = async () => { await load(); draw(); onChange(); };

  const remember = () => Object.assign(memory, { query: B.query, filter: B.filter, sort: B.sort });
  let typing = 0;
  $('brQuery').addEventListener('input', e => { clearTimeout(typing); typing = setTimeout(() => { B.query = e.target.value; B.shown = PAGE; remember(); draw(); }, 150); });
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
    if (B.selecting) { B.selected.has(id) ? B.selected.delete(id) : B.selected.add(id); draw(); return; }
    openCardPanel(cards.find(c => c.id === id), { decks, statesById, refresh });
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
export async function openCardPanel(card, ctx) {
  if (!card) return;
  if (ctx.mode === 'actions') return openCardActions(card, ctx);
  if (ctx.mode === 'edit') return openCardEdit(card, ctx);
  const { decks, statesById, showInfo = false } = ctx;
  const state = statesById.get(card.id);
  const studied = state && state.state !== 0;
  const logs = await db.getCardLogs(card.id);
  const maxN = await noteMaxN(card);
  const now = Date.now();
  const status = cardStatus(card, state, now);
  // In a side panel (wide screens), highlight the card it's showing.
  document.querySelectorAll('.crow').forEach(r => r.classList.toggle('sel', r.dataset.id === card.id));

  openSheet(`
    <h2 id="sheetTitle">Card <span class="st st-${status.key}">${esc(status.label)}</span></h2>
    <form id="ceForm" class="sheet-in" style="padding:0">
      ${cardFieldsHTML(card, maxN)}
      <div class="sheet-actions"><button class="btn primary" type="submit">Save changes</button></div>
    </form>

    <div class="act-grid">
      <button class="btn ghost small" type="button" data-act="suspend">${isSuspended(card) ? 'Unsuspend' : 'Suspend'}</button>
      <button class="btn ghost small" type="button" data-act="bury">${isBuried(card, now) ? 'Unbury' : 'Bury until tomorrow'}</button>
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
        ${logs.slice(-30).reverse().map(l => `<tr><td>${shortDate(l.timestamp)}</td><td>${{ play: 'Play', anki: 'Anki' }[l.source] || 'Review'}</td>
          <td class="${l.correct ? 'ok' : 'no'}">${RATING[l.rating] || (l.correct ? 'Right' : 'Wrong')}</td><td class="mono">${l.ms ? (l.ms / 1000).toFixed(1) + 's' : ''}</td></tr>`).join('')}
      </tbody></table>${logs.length > 30 ? '<p class="note">Showing the last 30.</p>' : ''}` : '<p class="note">No answers yet.</p>'}
    </details>`, { side: true });

  const { save, again } = cardOps(card, ctx);
  wireCardForm(card, ctx, 'Saved');
  document.querySelectorAll('#sheet [data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'suspend') toggleSuspend(card, save);
    if (act === 'bury') toggleBury(card, save);
    if (act === 'reset') confirmIn('ceConfirm', 'Reset this card to new? Its schedule starts over (its answer history is kept).', 'Reset', () => db.clearStates([card.id]).then(() => again('Reset to new', 'reset')));
    if (act === 'delete') confirmIn('ceConfirm', isClozeCard(card) ? 'Delete this card and its history? The note’s other cards stay (edit the note to take the blank out of its text). This can’t be undone.'
      : hasMasks(card) ? 'Delete this card and its history? The picture’s other cards stay (take the box out when you edit the picture). This can’t be undone.' : 'Delete this card and its history? This can’t be undone.', 'Delete card', () => db.deleteCards([card.id]).then(() => again('Card deleted', 'delete')));
  }));
  wireFlags(f => save({ flag: f }, f ? `${FLAGS.find(x => x.id === f).name} flag` : 'Flag removed', 'flag'));
  wireMove(deckId => save({ deckId }, `Moved to ${deckPath(decks, deckId)}`, 'move'));
  showMixedWith(card);
  if (studied) wireDue(days => db.putStates([dueIn(state, days)]).then(() => again(days ? `Due in ${plural(days, 'day')}` : 'Due today', 'due')));
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
      if (id) (await import('./compare-sheet.js')).openCompare(card, cardsById.get(id), { onDismiss: () => {} });
    });
  } catch (err) { console.warn('mixed up with:', err); }     // the panel is fine without it
}

// The short sheet for a card in Review or Play: the few things you do while studying, and More for the rest.
async function openCardActions(card, ctx) {
  const state = ctx.statesById.get(card.id);
  const now = Date.now();
  const status = cardStatus(card, state, now);
  openSheet(`
    <h2 id="sheetTitle">Card <span class="st st-${status.key}">${esc(status.label)}</span></h2>
    <p class="act-front">${mathHTML(plainText(card.front), { inline: true })}</p>
    <div class="act-list">
      <button type="button" class="act-row" data-go="edit" aria-keyshortcuts="E">${icon('edit')}<span>Edit card</span><kbd aria-hidden="true">E</kbd></button>
      <div class="act-row act-flags" role="group" aria-labelledby="flagLbl"><span class="act-fl" id="flagLbl">Flag</span>
        ${FLAGS.map(f => `<button type="button" class="act-flag" data-flag="${f.id}" style="--c:${f.color}" aria-pressed="${card.flag === f.id}" aria-label="${f.name} flag"></button>`).join('')}</div>
      <button type="button" class="act-row" data-act="bury" aria-keyshortcuts="-">${icon('moon')}<span>${isBuried(card, now) ? 'Unbury' : 'Bury until tomorrow'}</span><kbd aria-hidden="true">-</kbd></button>
      <button type="button" class="act-row" data-act="suspend" aria-keyshortcuts="@">${icon('pause')}<span>${isSuspended(card) ? 'Unsuspend' : 'Suspend'}</span><kbd aria-hidden="true">@</kbd></button>
      <button type="button" class="act-row" data-go="more">${icon('more')}<span>More<small>Move, due date, reset, delete, card info</small></span>${icon('chevron')}</button>
    </div>`, { side: true });
  const { save } = cardOps(card, ctx);
  const sheet = $('sheet');
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
  if (e.target.closest?.('input, textarea, select')) return;
  const pick = { e: '[data-go="edit"]', E: '[data-go="edit"]', '-': '[data-act="bury"]', '@': '[data-act="suspend"]' }[e.key];
  if (pick) { e.preventDefault(); sheet.querySelector(pick)?.click(); }
});

// The short editor: Front, Back and Tags (with the formatting buttons and pictures), Cancel and Save always in view.
async function openCardEdit(card, ctx) {
  const maxN = await noteMaxN(card);
  openSheet(`
    <h2 id="sheetTitle">Edit card</h2>
    <form id="ceForm" class="sheet-in" style="padding:0">
      ${cardFieldsHTML(card, maxN)}
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="ceCancel">Cancel</button>
        <button class="btn primary" type="submit">Save <kbd aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl+↵'}</kbd></button>
      </div>
    </form>`, { side: true });
  $('ceCancel').addEventListener('click', closeSheet);
  wireCardForm(card, ctx, 'Card saved');
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
const cardFieldsHTML = (card, maxN = 0) => `
      ${isClozeCard(card) ? clozeFields('ce', card.noteText, card.noteExtra || '') : hasMasks(card) ? occlusionFields('ce', card, '', { maxN }) : `
      ${basicFields('ce', { front: card.front, back: card.back, frontImage: card.frontImage, backImage: card.backImage, hook: card.noteExtra || '' })}`}
      <label class="field"><span>Tags (separated by commas)</span><input id="ceTags" value="${esc((card.tags || []).join(', '))}" autocomplete="off"></label>
      <div id="ceFormConfirm"></div>
      <p class="err" id="ceErr" hidden></p>`;
const showErr = (id, text) => { $(id).textContent = text; $(id).hidden = false; };
function wireCardForm(card, ctx, msg) {
  const ops = cardOps(card, ctx);
  $('ceForm').addEventListener('submit', e => {
    e.preventDefault();
    if (isClozeCard(card)) return saveClozeNote(card, ops, msg);
    if (hasMasks(card)) return saveOcclusionNote(card, ops, msg);
    const front = readCardText('ceFront').trim(), back = readBack('ce').trim();
    const frontImage = readCardImage('ceFront'), backImage = readCardImage('ceBack');
    // Each side needs something on it: text, a picture, or both.
    if (!(front || frontImage) || !(back || backImage)) { showErr('ceErr', 'A card needs a front and a back (text or a picture).'); return; }
    const why = stepsProblem('ce');
    if (why) { showErr('ceErr', why); return; }
    ops.save({ front, back, frontImage, backImage, noteExtra: readCardText('ceHook').trim(), tags: parseTags($('ceTags').value) }, msg, 'edit');
  });
  // Ctrl/⌘+Enter saves from inside a box.
  $('ceForm').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('ceForm').requestSubmit(); } });
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
    $('ceErr').hidden = true;
    if (plan.remove.some(c => !confirmed.has(c.id))) return ask(plan);
    await db.saveNote(plan, { deckId: card.deckId, noteId: card.noteId, tags: parseTags($('ceTags').value), noteExtra: readCardText('ceExtra').trim() });
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
    $('ceErr').hidden = true;
    if (plan.remove.some(c => !confirmed.has(c.id))) return ask(plan);
    await db.saveNote(plan, { deckId: card.deckId, noteId: card.noteId, tags: parseTags($('ceTags').value), noteExtra: readCardText('ceOccExtra').trim() });
    return ops.again(msg, 'edit');
  };
  const ask = plan => confirmIn('ceFormConfirm', occRemovalText(plan), 'Remove and save', () => guarded(() => go(new Set(plan.remove.map(c => c.id)))));
  return guarded(() => go(new Set()));
}
const toggleSuspend = (card, save) => save({ suspended: !isSuspended(card) }, isSuspended(card) ? 'Unsuspended' : 'Suspended', isSuspended(card) ? 'unsuspend' : 'suspend');
const toggleBury = (card, save) => save({ buriedUntil: isBuried(card) ? 0 : buryUntil() }, isBuried(card) ? 'Unburied' : 'Buried until tomorrow', isBuried(card) ? 'unbury' : 'bury');

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
      <button class="btn ghost small" type="button" data-act="reset" ${studied.length ? '' : 'disabled'}>Reset to new</button>
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
    if (act === 'reset') confirmIn('ceConfirm', `Reset ${plural(studied.length, 'card')} to new? Their schedules start over (history is kept).`, 'Reset', () => db.clearStates(studied.map(c => c.id)).then(() => done(`Reset ${plural(studied.length, 'card')}`)));
    if (act === 'delete') confirmIn('ceConfirm', `Delete ${plural(n, 'card')} and their history? This can’t be undone.`, `Delete ${plural(n, 'card')}`, () => db.deleteCards(selected.map(c => c.id)).then(() => { clear(); return done(`Deleted ${plural(n, 'card')}`); }));
  }));
  // Find and replace: shows how many cards would change as you type.
  const frChanges = () => replaceInCards(selected, { find: $('frFind').value, replace: $('frWith').value,
    field: document.querySelector('#sheet [name=frIn]:checked').value, matchCase: $('frCase').checked });
  const frCount = () => {
    const n2 = $('frFind').value ? frChanges().length : 0;
    $('frCount').textContent = !$('frFind').value ? 'Type what to find.' : n2 ? `Changes ${plural(n2, 'card')}.` : 'No matches in these cards.';
    $('frGo').disabled = !n2;
  };
  $('frForm').addEventListener('input', frCount);
  $('frForm').addEventListener('submit', async e => {
    e.preventDefault();
    const changed = frChanges();
    if (!changed.length) return;
    await db.saveCards(changed);
    done(`Replaced in ${plural(changed.length, 'card')}`);
  });
  wireFlags(f => update({ flag: f }, f ? `Flagged ${plural(n, 'card')} ${FLAGS.find(x => x.id === f).name.toLowerCase()}` : `Removed flags from ${plural(n, 'card')}`));
  wireMove(deckId => update({ deckId }, `Moved ${plural(n, 'card')} to ${deckPath(decks, deckId)}`));
  if (studied.length) wireDue(days => db.putStates(studied.map(c => dueIn(statesById.get(c.id), days))).then(() => done(`${plural(studied.length, 'card')} due ${days ? `in ${plural(days, 'day')}` : 'today'}`)));
}

// ---------- tools ----------
// The Tools sheet: tags (rename or remove one everywhere in the list's cards, merging with an existing tag is
// fine) and "Link cloze cards" (older imports: turn separate fill-in-the-blank cards into notes).
function openTools(cards, { scope, refresh }) {
  const tags = tagCounts(cards);
  openSheet(`
    <h2 id="sheetTitle">Tools</h2>
    <h3 class="tool-h">Tags in ${esc(scope)}</h3>
    ${tags.length ? `<ul class="tag-list">${tags.map(({ tag, count }) => `
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
  const apply = async (from, to) => {
    const changed = renameTag(cards, from, to);
    await db.saveCards(changed);
    toast(to ? `Renamed “${from}” on ${plural(changed.length, 'card')}` : `Removed “${from}” from ${plural(changed.length, 'card')}`);
    await refresh();
    closeSheet();
  };
  document.querySelectorAll('#sheet .tag-list li').forEach(li => {
    const tag = li.dataset.tag;
    li.querySelector('[data-tag-rename]').addEventListener('click', () => {
      $('tagEdit').innerHTML = `<form class="confirm" id="tagForm"><label class="field"><span>Rename “${esc(tag)}” to</span>
        <input id="tagNew" value="${esc(tag)}" autocomplete="off" autocapitalize="off"></label>
        <div class="sheet-actions"><button class="btn ghost" type="button" id="tagNo">Cancel</button><button class="btn primary" type="submit">Rename</button></div></form>`;
      $('tagNew').select();
      $('tagNo').addEventListener('click', () => { $('tagEdit').innerHTML = ''; });
      $('tagForm').addEventListener('submit', e => { e.preventDefault(); const to = $('tagNew').value.trim(); if (to && to.toLowerCase() !== tag) apply(tag, to); });
    });
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
      await db.saveCards(changed);
      toast(`Linked ${plural(linked, 'card')} into ${plural(notes.length, 'note')}`);
      await refresh();
      closeSheet();
    });
    $('linkGo').scrollIntoView({ block: 'nearest' });
  });
}

// ---------- adding one card ----------
export function openAddCard({ decks, deckId, refresh }) {
  if (!decks.length) { toast('Make a deck first'); return; }
  const target = deckId || decks[0].id;
  // A deck with subdecks asks which one (starting with the deck itself).
  const choices = deckChoices(decks, deckId ? subtreeIds(decks, deckId) : null);
  const kind = lastKind();
  openSheet(`
    <h2 id="sheetTitle">Add a card</h2>
    <form id="acForm" class="sheet-in ac-form" style="padding:0">
      ${choices.length < 2 ? '' : `<label class="field"><span>Deck</span><select id="acDeck" class="select">${choices.map(d => `<option value="${esc(d.id)}" ${d.id === target ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>`}
      ${noteKinds('ac', kind)}
      <div class="kind-body">
        <div id="acBasic" ${kind !== 'basic' ? 'hidden' : ''}>
          ${basicFields('ac', { frontPh: 'e.g. Mitosis', backPh: 'e.g. Division into two identical cells' })}
        </div>
        <div id="acCloze" ${kind === 'cloze' ? '' : 'hidden'}>${clozeFields('ac')}</div>
        ${occlusionFields('ac', null, '', { hidden: kind !== 'occlusion' })}
      </div>
      <label class="field"><span>Tags (optional, separated by commas)</span><input id="acTags" autocomplete="off"></label>
      <p class="err" id="acErr" hidden></p>
      <div class="sheet-actions">
        <p class="ac-why" id="acWhy" aria-live="polite"></p>
        <button class="btn ghost" type="button" id="acDone">Close</button>
        <button class="btn primary" type="submit" aria-disabled="true" aria-describedby="acWhy">Add card</button>
      </div>
    </form>`, { side: true });
  (kind === 'occlusion' ? $('acOccChoose') : $(kind === 'cloze' ? 'acText' : 'acFront')).focus();
  $('acDone').addEventListener('click', closeSheet);
  const updateAdd = watchAdd('ac');           // Add stays aria-disabled, with the reason beside it, until the card can be saved
  let adding = false;          // a second tap on Add while the first is saving must not add the cards twice
  $('acForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (adding) return;
    const deck = $('acDeck')?.value || target, tags = parseTags($('acTags').value);
    const kindNow = readKind('ac');
    // What to save, or the message to show (Ctrl+Enter can submit a form whose button is disabled).
    let save, count = 1;
    if (kindNow === 'occlusion') {
      const note = readOcclusion('ac');
      const plan = note.image ? planOcclusionSave([], note) : { error: 'Choose a picture first.' };
      if (plan.error) { showErr('acErr', plan.error); return; }
      count = plan.add.length;
      save = () => db.saveNote(plan, { deckId: deck, noteId: db.newId(), tags, noteExtra: readCardText('acOccExtra').trim() });
    } else if (kindNow === 'cloze') {
      const text = readCardText('acText').trim();
      const plan = planNoteSave([], text);
      if (plan.error) { showErr('acErr', plan.error); return; }
      if (!plan.add.length) { showErr('acErr', 'Add at least one blank: select a word, then press New blank.'); return; }
      count = plan.add.length;
      save = () => db.saveNote(plan, { deckId: deck, noteId: db.newId(), tags, noteExtra: readCardText('acExtra').trim() });
    } else {
      const front = readCardText('acFront').trim(), back = readBack('ac').trim(), hook = readCardText('acHook').trim();
      const frontImage = readCardImage('acFront'), backImage = readCardImage('acBack');
      if (!(front || frontImage) || !(back || backImage)) { showErr('acErr', 'A card needs a front and a back (text or a picture).'); return; }
      const why = stepsProblem('ac');
      if (why) { showErr('acErr', why); return; }
      save = () => db.saveCards([{ id: db.newId(), deckId: deck, front, back, frontImage, backImage, ...(hook ? { noteExtra: hook } : {}), tags, created: Date.now() }]);
    }
    adding = true;
    try {
      await save();
    } catch (err) {
      console.error(err);
      showErr('acErr', "Couldn't save the cards. Try again.");
      return;
    } finally { adding = false; }
    // Stay open for the next card, like Anki.
    $('acErr').hidden = true;
    if (kindNow === 'occlusion') { resetOcclusion('ac'); $('acOccChoose').focus(); }
    else if (kindNow === 'cloze') { setCardText('acText', ''); setCardText('acExtra', ''); $('acText').focus(); }
    else { clearBasic('ac'); $('acFront').focus(); }
    updateAdd();
    toast(kindNow === 'basic' ? 'Card added' : `Added ${plural(count, 'card')}`);
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
