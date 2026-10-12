// The Decks tab: list of decks, one deck's cards, and the create / edit / delete sheet.

import * as db from './db.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon, ring, foldOpen, saveFold } from './ui.js';
import { loadAll, countFor } from './study-data.js';
import { startStudy } from './today.js';
import { dayEnd } from './days.js';
import { STARTER_DECKS, starterCards } from './jlpt.js';
import { isHidden } from './browse-logic.js';
import { mountBrowser } from './browse.js';
import { examInfo, countdown, badgeClass } from './exam.js';
import { commitDeck, examDateError, openExamSheet } from './exam-sheet.js';
import { SPEECH_LANGS } from './speech.js';
import { SCHED_DEFAULTS, parseSteps, parseMaxInterval, formatSteps } from './sched-settings.js';
import { ancestors, chainMap, subtreeIds, deckPath, treeOrder, canNest, effectiveDeck, deckChoices, deckTreeRows } from './deck-tree.js';

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

// Load every deck with its counts, in tree order (each deck followed by its subdecks). A deck's counts
// include its subdecks. Reads all cards once, which is fast even for a few thousand.
async function loadDecks() {
  const [decks, cards, states] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates')]);
  const statesById = new Map(states.map(s => [s.cardId, s]));
  const byDeck = new Map(decks.map(d => [d.id, []]));
  const chains = chainMap(decks);
  for (const c of cards) for (const id of chains.get(c.deckId) || []) byDeck.get(id).push(c);
  decks.sort((a, b) => a.created - b.created);
  return treeOrder(decks).map(({ deck, depth }) => ({ deck, depth, cards: byDeck.get(deck.id), stats: summarize(byDeck.get(deck.id), statesById) }));
}

// Subdecks inside a deck's tile or page: one row each, indented by depth. Folded ones are remembered
// on this device.
const FOLD_KEY = 'study-sprint-folded';
const folded = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY)) || []); } catch { return new Set(); } };
function setFolded(id, isFolded) {
  const f = folded();
  isFolded ? f.add(id) : f.delete(id);
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...f])); } catch { /* private mode: just not remembered */ }
}
// `today` (from loadAll) makes the numbers today's: the same ones Today and "Study N" use, with the daily limits applied.
function subdeckRows(items, baseDepth, today = null) {
  return items.map(({ deck, depth, stats }) => {
    const c = today ? countFor(today, [deck.id]) : { due: stats.due, fresh: stats.new };
    return `
    <button class="subdeck" type="button" data-open="${esc(deck.id)}" style="--depth:${depth - baseDepth - 1};--deck:${esc(deck.color)}">
      <span class="sd-name">${esc(deck.name)}</span>
      <span class="sd-counts"><span class="due"><b>${c.due}</b> due</span> <span><b>${c.fresh}</b> new</span></span>
    </button>`; }).join('');
}
// The items inside `id` (everything after it in tree order that's deeper).
function inside(list, id) {
  const i = list.findIndex(x => x.deck.id === id);
  const out = [];
  for (let j = i + 1; j < list.length && list[j].depth > list[i].depth; j++) out.push(list[j]);
  return out;
}
function subdeckBox(list, item, open, today) {
  const kids = inside(list, item.deck.id);
  if (!kids.length) return '';
  return `<details class="subdecks" data-fold="${esc(item.deck.id)}" ${open ? 'open' : ''}>
      <summary>${plural(kids.filter(k => k.depth === item.depth + 1).length, 'subdeck')}</summary>
      ${subdeckRows(kids, item.depth, today)}
    </details>`;
}

// The thin colored bar showing New / Learning / Young / Mature.
function masteryBar(s) {
  if (!s.total) return '<div class="mbar" aria-hidden="true"></div>';
  const seg = k => s[k] ? `<span class="lv-${k}" style="width:${(s[k] / s.total * 100).toFixed(2)}%"></span>` : '';
  const label = `${s.mature} mature, ${s.young} young, ${s.learning} learning, ${s.new} new`;
  return `<div class="mbar" role="img" aria-label="${label}">${seg('mature')}${seg('young')}${seg('learning')}${seg('new')}</div>`;
}

// ---------- the deck list ----------
// Two layouts, chosen by Settings → Appearance → "Compact deck list" (on by default, this device only):
//   compact  a search box and a sort (Due first / Exam / A–Z) above the tiles, subdecks folded under their course
//            (the open ones are remembered), and a small round play button instead of a full-width Study button
//   classic  the earlier layout: a summary strip, every subdeck showing, and "Study N" buttons
const SORTS = [['due', 'Due first'], ['exam', 'Exam'], ['az', 'A–Z']];
const SORT_KEY = 'study-sprint-decks-sort';
const savedSort = () => { try { const v = localStorage.getItem(SORT_KEY); return SORTS.some(x => x[0] === v) ? v : 'due'; } catch { return 'due'; } };

// showStarters: open the Starter decks section (the Import screen's "Ready-made decks" link does this).
export async function renderLibrary(el, showStarters = false) {
  const [list, today] = await Promise.all([loadDecks(), loadAll()]);
  const compact = today.settings.compactDecks !== false;
  const top = list.filter(x => x.depth === 0);            // counts already include subdecks
  const sum = k => top.reduce((n, x) => n + x.stats[k], 0);
  const todayAll = countFor(today, top.map(x => x.deck.id));      // today's numbers: daily limits applied
  const fold = folded();
  // Starter decks you haven't added yet.
  const added = new Set(list.map(x => x.deck.starter).filter(Boolean));
  const starters = STARTER_DECKS.filter(s => !added.has(s.key)).map(s => ({ ...s, count: starterCards(s.level).length }));
  const view = { query: '', sort: savedSort() };

  // One deck's tile. `q` is the search text (compact only): a course that matches only through a subdeck shows just those subdecks.
  const tile = (item, q = '', first = false) => {
    const { deck, stats } = item; const c = countFor(today, [deck.id]), go = c.total; const mastered = stats.total ? (stats.young + stats.mature) / stats.total : 0;
    return `
      <article class="deck" style="--deck:${esc(deck.color)}">
        <button class="deck-open" type="button" data-open="${esc(deck.id)}">
          ${deck.course ? `<span class="deck-code">${esc(deck.course)}</span>` : ''}
          <span class="deck-name">${esc(deck.name)}</span>
          ${examInfo(deck) ? `<span class="${badgeClass(examInfo(deck))}">${esc(countdown(examInfo(deck)))}</span>` : ''}
          <span class="deck-counts">
            <span><b>${stats.total}</b> ${stats.total === 1 ? 'card' : 'cards'}</span>
            <span class="due${c.due ? "" : " zero"}"><b>${c.due}</b> due</span>
            <span><b>${c.fresh}</b> new</span>
          </span>
        </button>
        <span class="deck-ring" title="${Math.round(mastered * 100)}% of cards are young or mature">${ring(mastered, 40, 4, `<small class="mono">${Math.round(mastered * 100)}</small>`)}<span class="sr-only">${Math.round(mastered * 100)}% mastered</span></span>
        <button class="icon-btn" type="button" data-edit="${esc(deck.id)}" aria-label="Edit ${esc(deck.name)}">${icon('more')}</button>
        <div class="deck-act">
          ${compact
            ? (go ? `<button class="deck-go${first ? ' lead' : ''}" type="button" data-study="${esc(deck.id)}" aria-label="Study ${esc(deck.name)}: ${plural(go, 'card')}" title="Study ${plural(go, 'card')}">${icon('play')}</button>`
                  : `<span class="deck-go done" role="img" aria-label="Done for today" title="Done for today">${icon('check')}</span>`)
            : (go ? `<button class="btn primary small" type="button" data-study="${esc(deck.id)}" aria-label="Study ${esc(deck.name)}: ${plural(go, 'card')}">${icon('play')} Study ${go}</button>`
                  : `<span class="deck-done">${icon('check')} Done for today</span>`)}
        </div>
        ${compact ? compactSubdecks(item, q) : subdeckBox(list, item, !fold.has(deck.id), today)}
      </article>`;
  };
  // Compact: the subdecks start folded under their course, and what you open is remembered on this device.
  const compactSubdecks = (item, q) => {
    let kids = inside(list, item.deck.id);
    if (!kids.length) return '';
    const direct = kids.filter(k => k.depth === item.depth + 1).length;
    const selfHit = !q || matches(item, q);
    if (!selfHit) kids = kids.filter(k => matches(k, q));
    const open = q ? true : foldOpen('deck-' + item.deck.id);
    return `<details class="subdecks" data-xfold="${esc(item.deck.id)}" ${q ? 'data-forced' : ''} ${open ? 'open' : ''}>
      <summary>${icon('layers')}<span>${plural(direct, 'subdeck')}${kids.length > direct ? ` · ${kids.length} in all` : ''}</span>${icon('chevron', 'sub-chev')}</summary>
      ${subdeckRows(kids, item.depth, today)}
    </details>`;
  };
  const matches = (item, q) => `${item.deck.name} ${item.deck.course || ''}`.toLowerCase().includes(q);
  // The courses to show, in the chosen order (the numbers are today's: the same ones Today and the play button use).
  const shown = () => {
    const q = view.query.trim().toLowerCase();
    const due = x => countFor(today, [x.deck.id]).due;
    const tot = x => countFor(today, [x.deck.id]).total;
    const days = x => examInfo(x.deck)?.daysLeft ?? Infinity;
    const by = {
      due: (a, b) => due(b) - due(a) || tot(b) - tot(a),
      exam: (a, b) => days(a) - days(b) || due(b) - due(a),
      az: (a, b) => a.deck.name.localeCompare(b.deck.name, undefined, { sensitivity: 'base', numeric: true })
    }[view.sort];
    const rows = top.filter(x => !q || matches(x, q) || inside(list, x.deck.id).some(k => matches(k, q)));
    return { q, rows: compact ? rows.map((x, i) => [x, i]).sort((a, b) => by(a[0], b[0]) || a[1] - b[1]).map(a => a[0]) : rows };
  };

  el.innerHTML = `
    <div class="screen-head">
      <div><span class="eyebrow mono">LIBRARY</span><h1>Decks</h1></div>
      <div class="head-actions">
        <a class="btn ghost small" href="#/import">Import</a>
        <button class="btn primary small" type="button" id="newDeck">+ New deck</button>
      </div>
    </div>
    ${compact ? (list.length ? `<div class="deck-tools">
      <label class="deck-search">${icon('search')}<input id="deckSearch" type="search" placeholder="Search ${plural(list.length, 'deck')}" aria-label="Search decks" autocomplete="off"></label>
      <div class="deck-sort" role="group" aria-label="Sort decks">${SORTS.map(([k, l]) => `<button type="button" data-sort="${k}" aria-pressed="${k === view.sort}">${l}</button>`).join('')}</div>
    </div>` : '') : `<div class="dsum" aria-label="All decks">
      <span><b class="mono">${todayAll.due}</b> due today</span>
      <span><b class="mono">${todayAll.fresh}</b> new today</span>
      <span><b class="mono">${sum('total')}</b> cards</span>
      <a class="link" href="#/today">Today ${icon('chevron')}</a>
    </div>`}
    ${list.length ? `<div class="decks${compact ? ' compact' : ''}" id="deckGrid"></div><p class="note" id="deckNone" hidden></p>`
    : `<div class="empty"><b>No decks yet.</b><br>Make one to start adding cards.<br><button class="btn primary" type="button" id="newDeck2">+ New deck</button></div>`}
    ${list.length ? '<p class="browse-all"><a href="#/browse">Browse all cards →</a></p>' : ''}
    ${starters.length ? `
    <details class="starters" id="startersBox" ${showStarters ? 'open' : ''}>
      <summary>Starter decks</summary>
      <p class="note">Optional ready-made decks. Add one if it's useful to you.</p>
      ${starters.map(s => `
        <div class="starter">
          <div><b>${esc(s.name)}</b><span class="muted small"> · ${s.count} kanji with meanings and readings</span></div>
          <button class="btn ghost small" type="button" data-starter="${esc(s.key)}">Add</button>
        </div>`).join('')}
    </details>` : ''}
  `;

  // The tiles are drawn from the search text and the sort, so both just redraw this part.
  const grid = $('deckGrid');
  const drawGrid = () => {
    if (!grid) return;
    const { q, rows } = shown();
    const firstDue = view.sort === 'due' ? rows.find(x => countFor(today, [x.deck.id]).total) : null;
    grid.innerHTML = rows.map(x => tile(x, q, x === firstDue)).join('');
    $('deckNone').hidden = rows.length > 0;
    $('deckNone').textContent = rows.length ? '' : `No decks match “${view.query.trim()}”.`;
  };
  drawGrid();
  $('deckSearch')?.addEventListener('input', e => { view.query = e.target.value; drawGrid(); });
  el.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    view.sort = b.dataset.sort;
    try { localStorage.setItem(SORT_KEY, view.sort); } catch { /* not remembered: fine */ }
    el.querySelectorAll('[data-sort]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    drawGrid();
  }));
  // One listener for all the tiles, so redrawing them needs no re-wiring.
  grid?.addEventListener('click', e => {
    const open = e.target.closest('[data-open]'), study = e.target.closest('[data-study]'), edit = e.target.closest('[data-edit]');
    if (open) location.hash = `#/deck/${open.dataset.open}`;
    else if (study) startStudy({ deckIds: [study.dataset.study], deckId: study.dataset.study });
    else if (edit) openDeckEditor(list.find(x => x.deck.id === edit.dataset.edit).deck, () => renderLibrary(el));
  });
  // 'toggle' doesn't bubble, so it is caught on the way down. A fold the search opened is not remembered.
  grid?.addEventListener('toggle', e => {
    const d = e.target;
    if (d.dataset.fold) setFolded(d.dataset.fold, !d.open);
    else if (d.dataset.xfold && !('forced' in d.dataset)) saveFold('deck-' + d.dataset.xfold, d.open);
  }, true);

  const create = () => openDeckEditor(null, () => renderLibrary(el));
  $('newDeck').addEventListener('click', create);
  $('newDeck2')?.addEventListener('click', create);
  if (showStarters) $('startersBox')?.scrollIntoView({ block: 'center' });
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
    renderLibrary(el, true);          // the section stays open, in case the other one is wanted too
  }));
}

// ---------- one deck and its cards ----------
export async function renderDeck(el, deckId) {
  const list = await loadDecks();
  const item = list.find(x => x.deck.id === deckId);
  if (!item) { location.hash = '#/decks'; return; }
  const { deck, cards, stats: s } = item;
  const decks = list.map(x => x.deck);
  const parents = ancestors(decks, deckId).slice(1).reverse();      // top level first
  const parent = parents.at(-1);
  const exam = examInfo(effectiveDeck(decks, deckId));
  const kids = inside(list, deckId);

  el.innerHTML = `
    <button class="back" type="button" id="back">‹ ${parent ? esc(parent.name) : 'Decks'}</button>
    <div class="screen-head">
      <div>${parents.length ? `<span class="eyebrow crumbs">${parents.map(p => `<a href="#/deck/${esc(p.id)}">${esc(p.name)}</a>`).join(' › ')}</span>`
        : deck.course ? `<span class="eyebrow mono">${esc(deck.course)}</span>` : ''}<h1>${esc(deck.name)}</h1>
        ${exam ? `<p class="exam-line"><span class="${badgeClass(exam)}">${esc(countdown(exam))}</span> Every card is scheduled to come back before then. <button class="link" type="button" id="prepBtn" style="padding:0 2px;min-height:0">Exam prep</button></p>`
          : `<p class="exam-line"><button class="exam-chip" type="button" id="addExam">${icon('calendar')} Add exam date</button></p>`}</div>
      <div class="head-actions">
        <button class="btn ghost small" type="button" id="editDeck">Edit</button>
        <button class="btn ghost small" type="button" id="addSub">+ Subdeck</button>
        <a class="btn ghost small" href="#/import/${esc(deck.id)}">Import</a>
        ${cards.length ? '<button class="btn ghost small" type="button" id="exportDeck">Export</button>' : ''}
        ${s.total ? `<a class="btn primary small" id="reviewBtn" href="#/review/${esc(deck.id)}">Review</a>` : ''}
      </div>
    </div>
    <div class="card section deck-summary" style="--deck:${esc(deck.color)}" ${cards.length ? '' : 'hidden'}>${summaryHTML(s)}</div>
    ${kids.length ? `<section class="card section subdecks-page"><h2 class="mhead">Subdecks</h2>${subdeckRows(kids, item.depth)}
      <p class="note" style="margin:8px 0 0">Everything below includes the subdecks' cards too.</p></section>` : ''}
    <section id="browser"></section>
    <aside class="deck-tree" aria-label="Decks">
      <div class="dt-head"><b>Decks</b><button class="btn primary small" type="button" id="dtNew">+ New</button></div>
      <label class="deck-search dt-search">${icon('search')}<input id="dtQ" type="search" placeholder="Search decks" aria-label="Search decks" autocomplete="off"></label>
      <nav id="dtNav" aria-label="Deck tree"></nav>
      <a class="dt-all" href="#/decks">All decks ${icon('chevron')}</a>
    </aside>
    <aside class="dock-empty" aria-label="Card editor"><p><b>Pick a card</b>Its editor opens here, beside the list.</p></aside>
  `;
  drawDeckTree(list, deckId);
  $('back').addEventListener('click', () => { location.hash = parent ? `#/deck/${parent.id}` : '#/decks'; });
  el.querySelectorAll('.subdecks-page [data-open]').forEach(b => b.addEventListener('click', () => { location.hash = `#/deck/${b.dataset.open}`; }));
  $('addSub').addEventListener('click', () => openDeckEditor(null, saved => { location.hash = `#/deck/${saved.id}`; }, { parentId: deckId }));
  $('exportDeck')?.addEventListener('click', () => openExport(deck, decks, cards));
  $('reviewBtn')?.addEventListener('click', e => { e.preventDefault(); startStudy({ deckIds: [deck.id], deckId: deck.id }); });
  $('prepBtn')?.addEventListener('click', () => startStudy({ deckIds: [deck.id], deckId: deck.id, kind: 'prep' }));
  $('addExam')?.addEventListener('click', () => openExamSheet(deck.id, () => renderDeck(el, deckId)));
  $('editDeck').addEventListener('click', () => openDeckEditor(deck, saved => {
    if (saved === 'deleted') location.hash = parent ? `#/deck/${parent.id}` : '#/decks'; else renderDeck(el, deckId);
  }));
  // The card list: search, filter, sort, edit, suspend and more. Its changes update the counts above.
  await mountBrowser($('browser'), { deckId, onChange: () => refreshCounts(el, deckId) });
}

// On a wide screen (1200px and up) a deck's page has three columns: this tree of decks on the left, the deck in the
// middle, and the card editor docked on the right (the card panel, see openSheet's `side`). Below 1200px the tree is
// hidden by the CSS and nothing changes. The deck you are in is highlighted; its courses are open and the rest folded
// (what you open is remembered on this device); typing in the search box shows only matching decks.
function drawDeckTree(list, currentId) {
  const decks = list.map(x => x.deck);
  const size = new Map(list.map(x => [x.deck.id, x.stats.total]));
  const here = new Set(ancestors(decks, currentId).map(d => d.id));          // the deck and the decks it is inside
  const hasKids = new Set(decks.map(d => d.parentId).filter(Boolean));
  const isOpen = id => foldOpen('tree-' + id, here.has(id));
  const draw = () => {
    const q = $('dtQ').value;
    let skipBelow = Infinity;                      // rows deeper than this belong to a folded deck
    $('dtNav').innerHTML = deckTreeRows(decks, q).map(r => {
      if (!q.trim()) { if (r.depth > skipBelow) return ''; skipBelow = Infinity; }
      const kids = hasKids.has(r.id) && !q.trim();
      const open = kids && isOpen(r.id);
      if (kids && !open) skipBelow = r.depth;
      const deck = decks.find(d => d.id === r.id);
      return `<div class="dt-row${r.id === currentId ? ' cur' : ''}${r.context ? ' ctx' : ''}" style="--depth:${r.depth};--deck:${esc(deck.color)}">
        ${kids ? `<button type="button" class="dt-tw" data-tw="${esc(r.id)}" aria-expanded="${open}" aria-label="${open ? 'Fold' : 'Open'} ${esc(r.name)}">${icon('chevron')}</button>` : '<span class="dt-tw"></span>'}
        <a class="dt-node" href="#/deck/${esc(r.id)}" ${r.id === currentId ? 'aria-current="page"' : ''}><i class="dot" aria-hidden="true"></i><span class="dt-name">${esc(r.name)}</span><span class="dt-n mono">${size.get(r.id) || 0}</span></a></div>`;
    }).join('') || `<p class="note">No decks match.</p>`;
  };
  draw();
  $('dtQ').addEventListener('input', draw);
  $('dtNav').addEventListener('click', e => {
    const tw = e.target.closest('[data-tw]'); if (!tw) return;
    saveFold('tree-' + tw.dataset.tw, tw.getAttribute('aria-expanded') !== 'true');
    draw();
  });
  $('dtNew').addEventListener('click', () => openDeckEditor(null, saved => { location.hash = `#/deck/${saved.id}`; }));
  $('dtNav').querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}

// Redraw the counts card at the top of a deck page after the card list changes something.
async function refreshCounts(el, deckId) {
  const box = el.querySelector('.deck-summary');
  if (!box) return;
  const item = (await loadDecks()).find(x => x.deck.id === deckId);
  if (item) { box.innerHTML = summaryHTML(item.stats); box.hidden = !item.stats.total; }
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

// ---------- export ----------
// Save a deck's cards (and its subdecks') as a spreadsheet (CSV) or an Anki deck. Progress isn't included
// (cards start as new). Subdecks stay subdecks in Anki ("Psych 101::Unit 1").
async function openExport(deck, decks, deckCards) {
  // Each card's deck, named from the exported deck down: "Unit 1::Lecture 3" when exporting Unit 1.
  const nameOf = id => { const chain = ancestors(decks, id); return chain.slice(0, chain.findIndex(d => d.id === deck.id) + 1).reverse().map(d => d.name).join('::'); };
  const cards = deckCards.map(c => ({ ...c, deckName: nameOf(c.deckId) })).sort((a, b) => a.created - b.created);
  openSheet(`
    <h2 id="sheetTitle">Export “${esc(deck.name)}”</h2>
    <p style="margin:0">${plural(cards.length, 'card')}, with their tags. Your progress stays in Study Sprint (in Anki they start as new cards).${cards.some(c => c.frontImage || c.backImage) ? ' Pictures go in the Anki deck (a spreadsheet can only hold text).' : ''}</p>
    <div class="export-opts">
      <button class="btn ghost export-opt" type="button" id="exCsv"><b>Spreadsheet (.csv)</b><span>Opens in Excel, Google Sheets or Numbers. Can be imported into Quizlet, or back into Study Sprint.</span></button>
      <button class="btn ghost export-opt" type="button" id="exApkg"><b>Anki deck (.apkg)</b><span>For Anki on a computer, AnkiDroid or AnkiMobile: File → Import.</span></button>
    </div>
    <p class="err" id="exErr" hidden></p>`);
  const ex = await import('./export.js');
  $('exCsv').addEventListener('click', () => {
    ex.download(new Blob([ex.toCSV(cards)], { type: 'text/csv;charset=utf-8' }), ex.fileName(deck.name, 'csv'));
    closeSheet();
    toast(`Exported ${plural(cards.length, 'card')} as a spreadsheet`);
  });
  $('exApkg').addEventListener('click', async () => {
    const btn = $('exApkg');
    btn.disabled = true;
    btn.querySelector('b').textContent = 'Making the Anki deck…';
    try {
      ex.download(await ex.makeApkg(deck, cards), ex.fileName(deck.name, 'apkg'));
      closeSheet();
      toast(`Exported ${plural(cards.length, 'card')} as an Anki deck`);
    } catch (err) {
      console.error(err);
      $('exErr').textContent = navigator.onLine ? "Couldn't make the Anki deck. Try again." : 'Making an Anki deck needs an internet connection the first time.';
      $('exErr').hidden = false;
      btn.disabled = false;
      btn.querySelector('b').textContent = 'Anki deck (.apkg)';
    }
  });
}

// ---------- a deck's study options (Edit deck) ----------
// Limits for this deck, and (optionally) its own scheduling settings instead of the overall ones in Settings.
//   deck.newPerDay / deck.reviewPerDay   null = only the overall limits apply
//   deck.options                         null = use the overall settings; otherwise
//                                        { targetRetention, learningSteps, relearningSteps, maxInterval }
function studyOptionsHTML(deck) {
  const own = !!deck.options, o = deck.options || {};
  const num = v => (Number.isFinite(v) ? v : '');
  return `<details class="card-info" id="deckOpts" ${own || Number.isFinite(deck.newPerDay) || Number.isFinite(deck.reviewPerDay) ? 'open' : ''}>
      <summary>Study options for this deck</summary>
      <div class="deck-opts">
        <label class="field"><span>New cards per day</span>
          <input id="deckNew" type="number" inputmode="numeric" min="0" max="999" placeholder="No limit of its own" value="${num(deck.newPerDay)}"></label>
        <label class="field"><span>Reviews per day</span>
          <input id="deckRev" type="number" inputmode="numeric" min="1" max="9999" placeholder="No limit of its own" value="${num(deck.reviewPerDay)}"></label>
        <p class="note" style="margin:0">Blank = only the overall limits in Settings apply. They still cap the total.</p>
        <label class="adv-row switch-row" style="border:0;padding:0"><span><b>Use my overall settings</b>
          <span>Retention, steps and maximum interval from Settings (a subdeck uses the deck it's inside). Turn off to give this deck its own.</span></span>
          <input id="deckOwnOff" type="checkbox" class="switch" ${own ? '' : 'checked'}></label>
        <div id="deckOwn" ${own ? '' : 'hidden'}>
          <label class="field"><span>Target retention: <b id="deckRetOut">${Math.round((o.targetRetention ?? 0.9) * 100)}%</b></span>
            <input id="deckRet" type="range" min="80" max="97" step="1" value="${Math.round((o.targetRetention ?? 0.9) * 100)}"></label>
          <label class="field"><span>Learning steps</span><input id="deckLs" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(o.learningSteps ?? '')}" placeholder="${SCHED_DEFAULTS.learningSteps}"></label>
          <label class="field"><span>Relearning steps</span><input id="deckRs" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(o.relearningSteps ?? '')}" placeholder="${SCHED_DEFAULTS.relearningSteps}"></label>
          <label class="field"><span>Maximum interval (days)</span><input id="deckMax" type="number" inputmode="numeric" min="1" max="36500" value="${num(o.maxInterval)}" placeholder="36500"></label>
        </div>
      </div>
    </details>`;
}
function wireStudyOptions() {
  $('deckRet').addEventListener('input', e => { $('deckRetOut').textContent = `${e.target.value}%`; });
  $('deckOwnOff').addEventListener('change', async e => {
    $('deckOwn').hidden = e.target.checked;
    if (e.target.checked || $('deckLs').value || $('deckRs').value) return;
    // Starting your own: begin from the current overall settings.
    const s = await db.getSettings();
    $('deckRet').value = Math.round(s.targetRetention * 100); $('deckRetOut').textContent = `${$('deckRet').value}%`;
    $('deckLs').value = s.learningSteps; $('deckRs').value = s.relearningSteps; $('deckMax').value = s.maxInterval;
  });
}
// { reviewPerDay, options } from the form, or { error }.
function readStudyOptions() {
  const rev = $('deckRev').value.trim();
  const reviewPerDay = rev ? Math.max(1, Math.min(9999, Math.round(Number(rev) || 1))) : null;
  if ($('deckOwnOff').checked) return { reviewPerDay, options: null };
  const ls = parseSteps($('deckLs').value || SCHED_DEFAULTS.learningSteps), rs = parseSteps($('deckRs').value || SCHED_DEFAULTS.relearningSteps);
  if (ls.error) return { error: `Learning steps: ${ls.error}` };
  if (rs.error) return { error: `Relearning steps: ${rs.error}` };
  const mi = parseMaxInterval($('deckMax').value || 36500);
  if (mi.error) return { error: `Maximum interval: ${mi.error}` };
  return { reviewPerDay, options: {
    targetRetention: +$('deckRet').value / 100,
    learningSteps: formatSteps(ls.steps), relearningSteps: formatSteps(rs.steps), maxInterval: mi.days
  } };
}

// ---------- create / rename / recolor / move / delete ----------
// deck = null means "make a new deck" (parentId: inside that deck). onDone is called after any change.
export async function openDeckEditor(deck, onDone, { parentId = '' } = {}) {
  const isNew = !deck;
  const decks = (await db.getDecks()).sort((a, b) => a.created - b.created);
  const parentNow = isNew ? parentId : deck.parentId || '';
  let color = deck?.color || decks.find(d => d.id === parentNow)?.color || DECK_COLORS[Math.floor(Math.random() * DECK_COLORS.length)];
  // Where it can go: top level, or inside any deck that isn't this one or inside it.
  const places = deckChoices(decks).filter(c => isNew || canNest(decks, deck.id, c.id));
  // What a subdeck gets when it doesn't set its own (from the deck it's inside).
  const inherited = () => effectiveDeck(decks, $('deckParent').value);

  const sheet = openSheet(`
    <h2 id="sheetTitle">${isNew ? 'New deck' : 'Edit deck'}</h2>
    <form id="deckForm" class="sheet-in" style="padding:0" novalidate>
      <label class="field"><span>Name</span>
        <input id="deckName" maxlength="80" required placeholder="e.g. Cell Biology" value="${esc(deck?.name || '')}"></label>
      <label class="field"><span>Course code (optional)</span>
        <input id="deckCourse" maxlength="20" placeholder="e.g. BIOL 201" value="${esc(deck?.course || '')}" autocapitalize="characters"></label>
      <label class="field"><span>Exam date (optional)</span>
        <input id="deckExam" type="date" value="${esc(deck?.examDate || '')}">
        <small class="note" style="margin:4px 0 0">Until then, every card in this deck (and its subdecks) comes back before the exam, reviews get a bit stricter in the last two weeks, and Exam prep goes over what you haven't seen lately. Clear it to turn this off.${parentNow && effectiveDeck(decks, parentNow).examDate ? ` Blank = the date of the deck it's inside (${esc(effectiveDeck(decks, parentNow).examDate)}).` : ''}</small></label>
      ${places.length ? `<label class="field"><span>Inside</span>
        <select id="deckParent" class="select"><option value="">Nothing (a top-level deck)</option>${places.map(c => `<option value="${esc(c.id)}" ${c.id === parentNow ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>` : '<input type="hidden" id="deckParent" value="">'}
      <div class="field"><span id="colorLabel">Color</span>
        <div class="swatches" role="group" aria-labelledby="colorLabel">
          ${DECK_COLORS.map(c => `<button type="button" class="swatch" style="--c:${c}" data-color="${c}" aria-pressed="${c === color}" aria-label="Color ${c}"></button>`).join('')}
        </div></div>
      ${isNew ? '' : studyOptionsHTML(deck)}
      ${isNew ? '' : `<label class="field"><span>Read aloud in</span>
        <select id="deckTts" class="select">${SPEECH_LANGS.map(([code, name]) => `<option value="${code}" ${(deck.ttsLang || '') === code ? 'selected' : ''}>${esc(code || !parentNow ? name : 'Same as the deck it’s inside')}</option>`).join('')}</select></label>
      <label class="adv-row switch-row" style="border:0;padding:0"><span><b>Read cards aloud automatically</b>
        <span>In Review: the front when it appears, the back when you flip. (The speaker button or R reads it any time.)</span></span>
        <input id="deckTtsAuto" type="checkbox" class="switch" ${effectiveDeck(decks, deck.id).ttsAuto ? 'checked' : ''}></label>`}
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
  if (!isNew) wireStudyOptions(deck);

  $('deckForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('deckName').value.trim();
    if (!name) { $('deckErr').textContent = 'Give the deck a name.'; $('deckErr').hidden = false; $('deckName').focus(); return; }
    // A date that was already saved is left alone; a new one is checked (blank clears it).
    const newExam = $('deckExam').value;
    const examProblem = newExam !== (deck?.examDate || '') ? examDateError(newExam) : '';
    if (examProblem) { $('deckErr').textContent = examProblem; $('deckErr').hidden = false; $('deckExam').focus(); return; }
    const course = $('deckCourse').value.trim();
    const parentId = $('deckParent').value;
    // Read aloud automatically: a subdeck only stores it when it differs from the deck it's inside.
    const auto = !!$('deckTtsAuto')?.checked;
    const ttsAuto = parentId && auto === inherited()?.ttsAuto ? null : auto;
    // This deck's own new-card limit: blank = none (only the overall limit applies).
    const raw = $('deckNew')?.value.trim();
    const newPerDay = raw ? Math.max(0, Math.min(999, Math.round(Number(raw) || 0))) : null;
    let options = null;
    if (!isNew) {
      const read = readStudyOptions();
      if (read.error) { $('deckErr').textContent = read.error; $('deckErr').hidden = false; $('deckOpts').open = true; return; }
      options = read;
    }
    const saved = isNew
      ? { id: db.newId(), name, course, color, parentId, created: Date.now(), ...($('deckExam').value ? { examDate: $('deckExam').value } : {}) }
      : { ...deck, name, course, color, parentId, newPerDay, reviewPerDay: options.reviewPerDay, options: options.options,
        examDate: $('deckExam')?.value || null, ttsLang: $('deckTts')?.value || '', ttsAuto };
    // A new exam date (its own, or from the deck it's moved into) brings forward the cards scheduled after it: see
    // commitDeck in exam-sheet.js, which the short "Add exam date" sheet uses too. (A new deck has no cards to move yet.)
    const { moved } = await commitDeck(saved, decks, { isNew });
    closeSheet();
    toast(isNew ? `Created “${name}”` : moved ? `Deck saved. ${plural(moved, 'card')} brought forward to before the exam` : 'Deck saved');
    onDone(saved);
  });

  // Deleting is a two-step, in-page confirmation. A deck with subdecks asks what happens to them:
  // delete them too, or move them up a level (into the deck this one is inside, or the top level).
  $('deckDelete')?.addEventListener('click', async () => {
    const tree = [...subtreeIds(decks, deck.id)];
    const subs = tree.length - 1, kids = decks.filter(x => x.parentId === deck.id).length;
    const all = await db.getAll('cards');
    const own = all.filter(c => c.deckId === deck.id).length, total = all.filter(c => tree.includes(c.deckId)).length;
    const up = deck.parentId ? `into “${esc(decks.find(d => d.id === deck.parentId)?.name || '')}”` : 'to the top level';
    $('dangerZone').innerHTML = `
      <div class="confirm" role="alertdialog" aria-labelledby="delMsg">
        <p id="delMsg"><b>Delete “${esc(deck.name)}”?</b><br>${subs
          ? `It has ${plural(subs, 'subdeck')}. Deleting everything removes ${plural(total, 'card')} and all their review history; keeping the subdecks removes this deck's own ${plural(own, 'card')} and moves ${kids === 1 ? 'its subdeck' : `its ${kids} subdecks`} ${up}.`
          : `This removes ${plural(own, 'card')} and all their review history.`} It can't be undone.</p>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" id="delNo">Keep it</button>
          ${subs ? '<button class="btn danger" type="button" id="delKeep">Delete, keep subdecks</button>' : ''}
          <button class="btn danger solid" type="button" id="delYes">${subs ? 'Delete everything' : 'Delete deck'}</button>
        </div>
      </div>`;
    $('delNo').focus();
    $('delNo').addEventListener('click', () => { closeSheet(); openDeckEditor(deck, onDone); });
    const done = () => { closeSheet(); toast(`Deleted “${deck.name}”`); onDone('deleted'); };
    $('delYes').addEventListener('click', async () => {
      for (const id of tree) await db.deleteDeck(id);
      done();
    });
    $('delKeep')?.addEventListener('click', async () => {
      for (const d of decks.filter(x => x.parentId === deck.id)) await db.saveDeck({ ...d, parentId: deck.parentId || '' });
      await db.deleteDeck(deck.id);
      done();
    });
  });
}
