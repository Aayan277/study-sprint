// The card list (browser): every card in a deck (or in all decks), with search, filters and sorting,
// and everything you can do to a card: edit, add, suspend, bury, flag, move, reset, set due date,
// delete and card info. Tap a card for its panel, or tap Select to act on several at once.
// Statuses, search and sorting live in browse-logic.js.

import * as db from './db.js';
import { browseCards, cardStatus, isSuspended, isBuried, buryUntil, parseTags, FLAGS, FILTERS, SORTS } from './browse-logic.js';
import { daysAgoStart } from './stats-calc.js';
import { formatInterval } from './queue.js';
import { cardTextField, readCardText, setCardText, readCardImage, setCardImage } from './card-editor.js';
import { plainText } from './format.js';
import { $, esc, plural, toast, openSheet, closeSheet } from './ui.js';

const PAGE = 150;          // rows drawn at a time; "Show more" adds another page
const RATING = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const shortDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Remembered while the app is open, so going into a card and back keeps your search.
const memory = { query: '', filter: 'all', sort: 'added-old' };   // oldest first = the order you added them

// ---------- the "All cards" screen (#/browse) ----------
export async function renderBrowseAll(el) {
  el.innerHTML = `
    <button class="back" type="button" id="back">‹ Decks</button>
    <div class="screen-head"><div><span class="eyebrow mono">BROWSE</span><h1>All cards</h1></div></div>
    <section id="browser"></section>`;
  $('back').addEventListener('click', () => { location.hash = '#/decks'; });
  await mountBrowser($('browser'), { deckId: null });
}

// ---------- the list ----------
// Draws the card list into `box`. deckId = null means all decks. onChange runs after anything changes
// (the deck page uses it to refresh its counts).
export async function mountBrowser(box, { deckId, onChange = () => {} }) {
  const B = { deckId, selecting: false, selected: new Set(), shown: PAGE, ...memory };
  let decks, cards, statesById, deckById;

  const load = async () => {
    const [d, c, s] = await Promise.all([db.getDecks(), deckId ? db.getCardsInDeck(deckId) : db.getAll('cards'), db.getAll('cardStates')]);
    decks = d.sort((a, b) => a.created - b.created);
    deckById = new Map(decks.map(x => [x.id, x]));
    cards = c;
    statesById = new Map(s.map(x => [x.cardId, x]));
  };
  await load();

  box.innerHTML = `
    <div class="mhead br-head">
      <h2>Cards <span class="count mono" id="brTotal"></span></h2>
      <div class="head-actions">
        <button class="btn ghost small" type="button" id="brSelect">Select</button>
        <button class="btn primary small" type="button" id="brAdd">+ Add card</button>
      </div>
    </div>
    <div class="br-controls">
      <input type="search" id="brQuery" placeholder="Search cards" aria-label="Search cards" value="${esc(B.query)}" autocomplete="off">
      <select id="brFilter" aria-label="Show">${FILTERS.map(([k, l]) => `<option value="${k}" ${k === B.filter ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="brSort" aria-label="Sort by">${SORTS.map(([k, l]) => `<option value="${k}" ${k === B.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <p class="note br-count" id="brCount" aria-live="polite"></p>
    <ul class="crows" id="brList"></ul>
    <button class="btn ghost small" type="button" id="brMore" hidden>Show more</button>
    <div class="bulkbar" id="brBulk" hidden>
      <span id="brSel" class="mono"></span>
      <button class="btn ghost small" type="button" id="brAll">Select all</button>
      <button class="btn primary small" type="button" id="brActions">Actions…</button>
    </div>`;

  const draw = () => {
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
          <span class="crow-main"><span class="f">${card.frontImage || card.backImage ? '<span class="pic-mark" title="Has a picture" aria-label="Has a picture">▣</span> ' : ''}${esc(plainText(card.front))}</span><span class="b">${esc(plainText(card.back))}</span>
            ${deckId ? '' : `<span class="d">${esc(deckById.get(card.deckId)?.name || '')}</span>`}</span>
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
  $('brActions').addEventListener('click', () => {
    if (!B.selected.size) { toast('Select some cards first'); return; }
    openBulkActions(cards.filter(c => B.selected.has(c.id)), { decks, statesById, refresh, clear: () => { B.selected.clear(); } });
  });
  draw();
}

// ---------- one card's panel ----------
// ctx: { decks, statesById, refresh, onAction, closeAfter, showInfo }
//   onAction(act, freshCard, freshState)  optional: told about each change (used by Review and Play)
//   closeAfter  actions that close the panel instead of reopening it (e.g. Review skips a suspended card)
//   showInfo    open the "Card info" section straight away
export async function openCardPanel(card, ctx) {
  if (!card) return;
  const { decks, statesById, refresh = async () => {}, onAction, closeAfter = [], showInfo = false } = ctx;
  const state = statesById.get(card.id);
  const studied = state && state.state !== 0;
  const logs = await db.getCardLogs(card.id);
  const now = Date.now();
  const status = cardStatus(card, state, now);
  // In a side panel (wide screens), highlight the card it's showing.
  document.querySelectorAll('.crow').forEach(r => r.classList.toggle('sel', r.dataset.id === card.id));

  openSheet(`
    <h2 id="sheetTitle">Card <span class="st st-${status.key}">${esc(status.label)}</span></h2>
    <form id="ceForm" class="sheet-in" style="padding:0">
      ${cardTextField('ceFront', 'Front', card.front, { rows: 2, image: card.frontImage })}
      ${cardTextField('ceBack', 'Back', card.back, { rows: 3, image: card.backImage })}
      <label class="field"><span>Tags (separated by commas)</span><input id="ceTags" value="${esc((card.tags || []).join(', '))}" autocomplete="off"></label>
      <p class="err" id="ceErr" hidden></p>
      <button class="btn primary" type="submit">Save changes</button>
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

    <details class="card-info" ${showInfo ? 'open' : ''}>
      <summary>Card info</summary>
      <dl class="info-grid">
        <dt>Added</dt><dd>${card.created > 1e12 ? shortDate(card.created) : '–'}</dd>
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
    </details>
    <button class="btn ghost" type="button" id="ceClose">Close</button>`, { side: true });

  const again = async (msg, act) => {      // after a change: refresh the list, tell the caller, reopen with fresh data
    if (msg) toast(msg);
    await refresh();
    const fresh = (await db.get('cards', card.id));
    const st = await db.get('cardStates', card.id);
    if (st) statesById.set(card.id, st); else statesById.delete(card.id);
    if (onAction) await onAction(act, fresh, st);
    if (fresh && !closeAfter.includes(act)) openCardPanel(fresh, { ...ctx, showInfo: false }); else closeSheet();
  };
  const save = (changes, msg, act) => db.saveCards([{ ...card, ...changes }]).then(() => again(msg, act));

  $('ceClose').addEventListener('click', closeSheet);
  $('ceForm').addEventListener('submit', e => {
    e.preventDefault();
    const front = readCardText('ceFront').trim(), back = readCardText('ceBack').trim();
    const frontImage = readCardImage('ceFront'), backImage = readCardImage('ceBack');
    // Each side needs something on it: text, a picture, or both.
    if (!(front || frontImage) || !(back || backImage)) { $('ceErr').textContent = 'A card needs a front and a back (text or a picture).'; $('ceErr').hidden = false; return; }
    save({ front, back, frontImage, backImage, tags: parseTags($('ceTags').value) }, 'Saved', 'edit');
  });
  document.querySelectorAll('#sheet [data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'suspend') save({ suspended: !isSuspended(card) }, isSuspended(card) ? 'Unsuspended' : 'Suspended', isSuspended(card) ? 'unsuspend' : 'suspend');
    if (act === 'bury') save({ buriedUntil: isBuried(card) ? 0 : buryUntil() }, isBuried(card) ? 'Unburied' : 'Buried until tomorrow', isBuried(card) ? 'unbury' : 'bury');
    if (act === 'reset') confirmIn('ceConfirm', 'Reset this card to new? Its schedule starts over (its answer history is kept).', 'Reset', () => db.clearStates([card.id]).then(() => again('Reset to new', 'reset')));
    if (act === 'delete') confirmIn('ceConfirm', 'Delete this card and its history? This can’t be undone.', 'Delete card', () => db.deleteCards([card.id]).then(() => again('Card deleted', 'delete')));
  }));
  wireFlags(f => save({ flag: f }, f ? `${FLAGS.find(x => x.id === f).name} flag` : 'Flag removed', 'flag'));
  wireMove(deckId => save({ deckId }, `Moved to ${decks.find(d => d.id === deckId).name}`, 'move'));
  if (studied) wireDue(days => db.putStates([dueIn(state, days)]).then(() => again(days ? `Due in ${plural(days, 'day')}` : 'Due today', 'due')));
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
      <button class="btn ghost small" type="button" data-act="reset" ${studied.length ? '' : 'disabled'}>Reset to new</button>
      <button class="btn danger small" type="button" data-act="delete">Delete…</button>
    </div>
    <div id="ceConfirm"></div>
    <div class="field"><span>Flag</span>${flagButtons(-1)}</div>
    <div class="field"><span>Move to deck</span>${moveRow(decks, null)}</div>
    <div class="field"><span>Set due date</span>${studied.length ? dueRow() + (studied.length < n ? `<p class="note">Applies to the ${studied.length} you've studied. New cards are skipped.</p>` : '') : '<p class="note" style="margin:0">None of these have been reviewed yet.</p>'}</div>
    <button class="btn ghost" type="button" id="ceClose">Close</button>`, { side: true });
  const done = async msg => { toast(msg); closeSheet(); await refresh(); };
  const update = (changes, msg) => db.saveCards(selected.map(c => ({ ...c, ...changes }))).then(() => done(msg));
  $('ceClose').addEventListener('click', closeSheet);
  document.querySelectorAll('#sheet [data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'suspend') update({ suspended: true }, `Suspended ${plural(n, 'card')}`);
    if (act === 'unsuspend') update({ suspended: false }, `Unsuspended ${plural(n, 'card')}`);
    if (act === 'bury') update({ buriedUntil: buryUntil() }, `Buried ${plural(n, 'card')} until tomorrow`);
    if (act === 'unbury') update({ buriedUntil: 0 }, `Unburied ${plural(n, 'card')}`);
    if (act === 'reset') confirmIn('ceConfirm', `Reset ${plural(studied.length, 'card')} to new? Their schedules start over (history is kept).`, 'Reset', () => db.clearStates(studied.map(c => c.id)).then(() => done(`Reset ${plural(studied.length, 'card')}`)));
    if (act === 'delete') confirmIn('ceConfirm', `Delete ${plural(n, 'card')} and their history? This can’t be undone.`, `Delete ${plural(n, 'card')}`, () => db.deleteCards(selected.map(c => c.id)).then(() => { clear(); return done(`Deleted ${plural(n, 'card')}`); }));
  }));
  wireFlags(f => update({ flag: f }, f ? `Flagged ${plural(n, 'card')} ${FLAGS.find(x => x.id === f).name.toLowerCase()}` : `Removed flags from ${plural(n, 'card')}`));
  wireMove(deckId => update({ deckId }, `Moved ${plural(n, 'card')} to ${decks.find(d => d.id === deckId).name}`));
  if (studied.length) wireDue(days => db.putStates(studied.map(c => dueIn(statesById.get(c.id), days))).then(() => done(`${plural(studied.length, 'card')} due ${days ? `in ${plural(days, 'day')}` : 'today'}`)));
}

// ---------- adding one card ----------
export function openAddCard({ decks, deckId, refresh }) {
  if (!decks.length) { toast('Make a deck first'); return; }
  const target = deckId || decks[0].id;
  openSheet(`
    <h2 id="sheetTitle">Add a card</h2>
    <form id="acForm" class="sheet-in" style="padding:0">
      ${deckId ? '' : `<label class="field"><span>Deck</span><select id="acDeck" class="select">${decks.map(d => `<option value="${esc(d.id)}" ${d.id === target ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>`}
      ${cardTextField('acFront', 'Front', '', { rows: 2, placeholder: 'e.g. Mitosis' })}
      ${cardTextField('acBack', 'Back', '', { rows: 3, placeholder: 'e.g. Division into two identical cells' })}
      <label class="field"><span>Tags (optional, separated by commas)</span><input id="acTags" autocomplete="off"></label>
      <p class="err" id="acErr" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="acDone">Done</button>
        <button class="btn primary" type="submit">Add card</button>
      </div>
    </form>`, { side: true });
  $('acFront').focus();
  $('acDone').addEventListener('click', closeSheet);
  $('acForm').addEventListener('submit', async e => {
    e.preventDefault();
    const front = readCardText('acFront').trim(), back = readCardText('acBack').trim();
    const frontImage = readCardImage('acFront'), backImage = readCardImage('acBack');
    if (!(front || frontImage) || !(back || backImage)) { $('acErr').textContent = 'A card needs a front and a back (text or a picture).'; $('acErr').hidden = false; return; }
    await db.saveCards([{ id: db.newId(), deckId: deckId || $('acDeck').value, front, back, frontImage, backImage, tags: parseTags($('acTags').value), created: Date.now() }]);
    // Stay open for the next card, like Anki.
    setCardText('acFront', ''); setCardText('acBack', ''); setCardImage('acFront', null); setCardImage('acBack', null); $('acErr').hidden = true;
    $('acFront').focus();
    toast('Card added');
    refresh();
  });
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
  return `<div class="row-form"><select id="ceMove" class="select" aria-label="Deck">${decks.map(d => `<option value="${esc(d.id)}" ${d.id === currentId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
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
