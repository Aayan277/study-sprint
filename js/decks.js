// The Decks tab: list of decks, one deck's cards, and the create / edit / delete sheet.

import * as db from './db.js';
import { $, esc, plural, toast, openSheet, closeSheet } from './ui.js';
import { dayEnd } from './days.js';
import { STARTER_DECKS, starterCards } from './jlpt.js';
import { isHidden } from './browse-logic.js';
import { mountBrowser } from './browse.js';

// Colors a deck can have. Mid-tones, so they read on both light and dark themes.
export const DECK_COLORS = ['#E5484D', '#F76B15', '#E2A336', '#46A758', '#12A594', '#3E63DD', '#8E4EC6', '#D6409F'];

// FSRS card states (the same numbers the ts-fsrs library uses, added in Milestone 3).
const NEW = 0, LEARNING = 1, REVIEW = 2, RELEARNING = 3;

// Which mastery level a card is at, from its schedule. No schedule yet means it's new.
//   learning: still in short learning steps, or relearning after forgetting
//   young:    in regular review, remembered for less than 21 days
//   mature:   remembered for 21 days or more
export function cardLevel(state) {
  if (!state || state.state === NEW) return 'new';
  if (state.state === LEARNING || state.state === RELEARNING) return 'learning';
  return state.stability >= 21 ? 'mature' : 'young';
}


// Count cards, due cards, new cards and mastery levels for one deck.
function summarize(cards, statesById) {
  const s = { total: cards.length, due: 0, new: 0, learning: 0, young: 0, mature: 0, hidden: 0 };
  const cutoff = dayEnd();   // a study day ends at 4am, like Anki
  const now = Date.now();
  for (const c of cards) {
    const st = statesById.get(c.id);
    const lvl = cardLevel(st);
    s[lvl]++;
    // Suspended and buried cards don't count as due (Review skips them).
    if (isHidden(c, now)) s.hidden++;
    else if (lvl !== 'new' && st.due <= cutoff) s.due++;
  }
  return s;
}

// Load every deck with its counts. Reads all cards once, which is fast even for a few thousand.
async function loadDecks() {
  const [decks, cards, states] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates')]);
  const statesById = new Map(states.map(s => [s.cardId, s]));
  const byDeck = new Map(decks.map(d => [d.id, []]));
  for (const c of cards) byDeck.get(c.deckId)?.push(c);
  decks.sort((a, b) => a.created - b.created);
  return decks.map(d => ({ deck: d, cards: byDeck.get(d.id), stats: summarize(byDeck.get(d.id), statesById) }));
}

// The thin colored bar showing New / Learning / Young / Mature.
function masteryBar(s) {
  if (!s.total) return '<div class="mbar" aria-hidden="true"></div>';
  const seg = k => s[k] ? `<span class="lv-${k}" style="width:${(s[k] / s.total * 100).toFixed(2)}%"></span>` : '';
  const label = `${s.mature} mature, ${s.young} young, ${s.learning} learning, ${s.new} new`;
  return `<div class="mbar" role="img" aria-label="${label}">${seg('mature')}${seg('young')}${seg('learning')}${seg('new')}</div>`;
}

// ---------- the deck list ----------
export async function renderLibrary(el) {
  const list = await loadDecks();
  const sum = k => list.reduce((n, x) => n + x.stats[k], 0);
  // Starter decks you haven't added yet.
  const added = new Set(list.map(x => x.deck.starter).filter(Boolean));
  const starters = STARTER_DECKS.filter(s => !added.has(s.key)).map(s => ({ ...s, count: starterCards(s.level).length }));

  el.innerHTML = `
    <div class="screen-head">
      <div><span class="eyebrow mono">LIBRARY</span><h1>Decks</h1></div>
      <div class="head-actions">
        <a class="btn ghost small" href="#/import">Import</a>
        <button class="btn primary small" type="button" id="newDeck">+ New deck</button>
      </div>
    </div>
    <div class="summary">
      <div><div class="v">${sum('due')}</div><div class="l">Due today</div></div>
      <div><div class="v">${sum('new')}</div><div class="l">New</div></div>
      <div><div class="v">${sum('total')}</div><div class="l">Cards</div></div>
    </div>
    ${list.length ? `<div class="decks">${list.map(({ deck, stats }) => `
      <article class="deck" style="--deck:${esc(deck.color)}">
        <button class="deck-open" type="button" data-open="${esc(deck.id)}">
          ${deck.course ? `<span class="deck-code">${esc(deck.course)}</span>` : ''}
          <span class="deck-name">${esc(deck.name)}</span>
          <span class="deck-counts">
            <span><b>${stats.total}</b> ${stats.total === 1 ? 'card' : 'cards'}</span>
            <span class="due"><b>${stats.due}</b> due</span>
            <span><b>${stats.new}</b> new</span>
          </span>
        </button>
        <button class="icon-btn" type="button" data-edit="${esc(deck.id)}" aria-label="Edit ${esc(deck.name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>
        </button>
        ${masteryBar(stats)}
      </article>`).join('')}</div>`
    : `<div class="empty"><b>No decks yet.</b><br>Make one to start adding cards.<br><button class="btn primary" type="button" id="newDeck2">+ New deck</button></div>`}
    ${list.length ? '<p class="browse-all"><a href="#/browse">Browse all cards →</a></p>' : ''}
    ${starters.length ? `
    <section class="starters" aria-labelledby="startTitle">
      <h2 id="startTitle">Starter decks</h2>
      <p class="note">Optional ready-made decks. Add one if it's useful to you.</p>
      ${starters.map(s => `
        <div class="starter">
          <div><b>${esc(s.name)}</b><span class="muted small"> · ${s.count} kanji with meanings and readings</span></div>
          <button class="btn ghost small" type="button" data-starter="${esc(s.key)}">Add</button>
        </div>`).join('')}
    </section>` : ''}
  `;

  const create = () => openDeckEditor(null, () => renderLibrary(el));
  $('newDeck').addEventListener('click', create);
  $('newDeck2')?.addEventListener('click', create);
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = `#/deck/${b.dataset.open}`; }));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const item = list.find(x => x.deck.id === b.dataset.edit);
    openDeckEditor(item.deck, () => renderLibrary(el), item.stats.total);
  }));
  el.querySelectorAll('[data-starter]').forEach(b => b.addEventListener('click', async () => {
    const s = STARTER_DECKS.find(x => x.key === b.dataset.starter);
    b.disabled = true;
    // Fixed ids, so the same starter deck added on two devices is one deck once they sync.
    const deckId = `starter-${s.key}`, now = Date.now();
    // `starter` remembers which starter deck this is, so it isn't offered again.
    await db.addDeckWithCards(
      { id: deckId, name: s.name, course: s.course, color: s.color, created: now, starter: s.key },
      starterCards(s.level).map((c, i) => ({ id: `${deckId}-${i}`, deckId, ...c, created: now + i }))
    );
    toast(`Added ${s.name}`);
    renderLibrary(el);
  }));
}

// ---------- one deck and its cards ----------
export async function renderDeck(el, deckId) {
  const deck = await db.getDeck(deckId);
  if (!deck) { location.hash = '#/decks'; return; }
  const [cards, states] = await Promise.all([db.getCardsInDeck(deckId), db.getAll('cardStates')]);
  const s = summarize(cards, new Map(states.map(x => [x.cardId, x])));
  cards.sort((a, b) => a.created - b.created);

  el.innerHTML = `
    <button class="back" type="button" id="back">‹ Decks</button>
    <div class="screen-head">
      <div>${deck.course ? `<span class="eyebrow mono">${esc(deck.course)}</span>` : ''}<h1>${esc(deck.name)}</h1></div>
      <div class="head-actions">
        <button class="btn ghost small" type="button" id="editDeck">Edit</button>
        <a class="btn ghost small" href="#/import/${esc(deck.id)}">Import</a>
        ${s.total ? `<a class="btn primary small" href="#/review/${esc(deck.id)}">Review</a>` : ''}
      </div>
    </div>
    <div class="card section deck-summary" style="border-left:6px solid ${esc(deck.color)}">${summaryHTML(s)}</div>
    <section id="browser"></section>
    ${cards.length ? '' : `<div class="empty"><b>This deck is empty.</b><br>Add cards one at a time with + Add card, or paste notes, upload a CSV or Excel file, or load a Google Sheet.<br><a class="btn primary" href="#/import/${esc(deck.id)}">Import cards</a></div>`}
  `;
  $('back').addEventListener('click', () => { location.hash = '#/decks'; });
  $('editDeck').addEventListener('click', () => openDeckEditor(deck, saved => {
    if (saved === 'deleted') location.hash = '#/decks'; else renderDeck(el, deckId);
  }, s.total));
  // The card list: search, filter, sort, edit, suspend and more. Its changes update the counts above.
  await mountBrowser($('browser'), { deckId, onChange: () => refreshCounts(el, deckId) });
}

// Redraw the counts card at the top of a deck page after the card list changes something.
async function refreshCounts(el, deckId) {
  const box = el.querySelector('.deck-summary');
  if (!box) return;
  const [cards, states] = await Promise.all([db.getCardsInDeck(deckId), db.getAll('cardStates')]);
  const s = summarize(cards, new Map(states.map(x => [x.cardId, x])));
  box.innerHTML = summaryHTML(s);
}

function summaryHTML(s) {
  return `
      <div class="deck-counts" style="margin-top:0">
        <span><b>${s.total}</b> ${s.total === 1 ? 'card' : 'cards'}</span>
        <span class="due"><b>${s.due}</b> due today</span>
        <span><b>${s.new}</b> new</span>
        ${s.hidden ? `<span><b>${s.hidden}</b> suspended or buried</span>` : ''}
      </div>
      <div style="margin-top:10px">${masteryBar(s)}</div>
      <div class="legend">
        <span><i class="sw lv-new"></i>New <b>${s.new}</b></span>
        <span><i class="sw lv-learning"></i>Learning <b>${s.learning}</b></span>
        <span><i class="sw lv-young"></i>Young <b>${s.young}</b></span>
        <span><i class="sw lv-mature"></i>Mature <b>${s.mature}</b></span>
      </div>`;
}

// ---------- create / rename / recolor / delete ----------
// deck = null means "make a new deck". onDone is called after any change.
export function openDeckEditor(deck, onDone, cardCount = 0) {
  const isNew = !deck;
  let color = deck?.color || DECK_COLORS[Math.floor(Math.random() * DECK_COLORS.length)];

  const sheet = openSheet(`
    <h2 id="sheetTitle">${isNew ? 'New deck' : 'Edit deck'}</h2>
    <form id="deckForm" class="sheet-in" style="padding:0" novalidate>
      <label class="field"><span>Name</span>
        <input id="deckName" maxlength="80" required placeholder="e.g. Cell Biology" value="${esc(deck?.name || '')}"></label>
      <label class="field"><span>Course code (optional)</span>
        <input id="deckCourse" maxlength="20" placeholder="e.g. BIOL 201" value="${esc(deck?.course || '')}" autocapitalize="characters"></label>
      <div class="field"><span id="colorLabel">Color</span>
        <div class="swatches" role="group" aria-labelledby="colorLabel">
          ${DECK_COLORS.map(c => `<button type="button" class="swatch" style="--c:${c}" data-color="${c}" aria-pressed="${c === color}" aria-label="Color ${c}"></button>`).join('')}
        </div></div>
      ${isNew ? '' : `<label class="field"><span>New cards per day for this deck (optional)</span>
        <input id="deckNew" type="number" inputmode="numeric" min="0" max="999" placeholder="No limit of its own" value="${Number.isFinite(deck.newPerDay) ? deck.newPerDay : ''}">
        <small class="note" style="margin:4px 0 0">Leave blank to use only the overall limit in Settings. The overall limit still applies on top.</small></label>`}
      <p class="err" id="deckErr" hidden></p>
      <div class="sheet-actions">
        <button class="btn ghost" type="button" id="deckCancel">Cancel</button>
        <button class="btn primary" type="submit">${isNew ? 'Create deck' : 'Save'}</button>
      </div>
    </form>
    ${isNew ? '' : `<div class="sheet-danger" id="dangerZone">
      <button class="btn danger small" type="button" id="deckDelete">Delete deck…</button>
    </div>`}
  `);
  sheet.setAttribute('aria-labelledby', 'sheetTitle');
  // On phones, opening the keyboard straight away hides half the sheet, so only autofocus on new decks.
  if (isNew) $('deckName').focus();

  sheet.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
    color = b.dataset.color;
    sheet.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('deckCancel').addEventListener('click', closeSheet);

  $('deckForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('deckName').value.trim();
    if (!name) { $('deckErr').textContent = 'Give the deck a name.'; $('deckErr').hidden = false; $('deckName').focus(); return; }
    const course = $('deckCourse').value.trim();
    // This deck's own new-card limit: blank = none (only the overall limit applies).
    const raw = $('deckNew')?.value.trim();
    const newPerDay = raw ? Math.max(0, Math.min(999, Math.round(Number(raw) || 0))) : null;
    const saved = isNew
      ? { id: db.newId(), name, course, color, created: Date.now() }
      : { ...deck, name, course, color, newPerDay };
    await db.saveDeck(saved);
    closeSheet();
    toast(isNew ? `Created “${name}”` : 'Deck saved');
    onDone(saved);
  });

  // Deleting is a two-step, in-page confirmation.
  $('deckDelete')?.addEventListener('click', () => {
    $('dangerZone').innerHTML = `
      <div class="confirm" role="alertdialog" aria-labelledby="delMsg">
        <p id="delMsg"><b>Delete “${esc(deck.name)}”?</b><br>This removes ${plural(cardCount, 'card')} and all their review history. It can't be undone.</p>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" id="delNo">Keep it</button>
          <button class="btn danger solid" type="button" id="delYes">Delete deck</button>
        </div>
      </div>`;
    $('delNo').focus();
    $('delNo').addEventListener('click', () => { closeSheet(); openDeckEditor(deck, onDone, cardCount); });
    $('delYes').addEventListener('click', async () => {
      await db.deleteDeck(deck.id);
      closeSheet();
      toast(`Deleted “${deck.name}”`);
      onDone('deleted');
    });
  });
}
