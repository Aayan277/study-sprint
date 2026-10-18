// The Decks tab: list of decks, one deck's cards, and the create / edit / delete sheet.

import * as db from './db.js';
import { $, esc, plural, toast, openSheet, closeSheet, icon, ring, foldOpen, saveFold, showFieldError, clearFieldError } from './ui.js';
import { loadAll, countFor, hasReviewLimit } from './study-data.js';
import { startStudy } from './today.js';
import { dayEnd } from './days.js';
import { STARTER_DECKS, starterCards } from './jlpt.js';
import { isHidden } from './browse-logic.js';
import { mountBrowser } from './browse.js';
import { examInfo, countdown, badgeClass, MOCK_DAYS } from './exam.js';
import { drawSidebar } from './sidebar.js';
import { emptyStartHTML, wireEmptyStart } from './empty-state.js';
import { commitDeck, examDateError, openExamSheet } from './exam-sheet.js';
import { SPEECH_LANGS } from './speech.js';
import { leftOutNote, fetchMissingFor } from './lazy-media.js';
import { SCHED_DEFAULTS, parseSteps, parseMaxInterval, formatSteps } from './sched-settings.js';
import { ancestors, chainMap, subtreeIds, deckPath, treeOrder, canNest, effectiveDeck, deckChoices, deckTreeRows } from './deck-tree.js';
import { go as navGo, up } from './nav.js';

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
// include its subdecks. Uses the cards loadAll() read, so nothing is read twice.
// Takes what loadAll() already read (its decks, every card and every state), so a page reads the database once.
function loadDecks(data) {
  const decks = [...data.decks], cards = data.allCards, statesById = data.statesById;
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
function subdeckRows(items, baseDepth, today = null, count = null) {
  return items.map(({ deck, depth, stats }) => {
    const c = count ? count(deck.id) : today ? countFor(today, [deck.id]) : { due: stats.due, fresh: stats.new };
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
function subdeckBox(list, item, open, today, count = null) {
  const kids = inside(list, item.deck.id);
  if (!kids.length) return '';
  return `<details class="subdecks" data-fold="${esc(item.deck.id)}" ${open ? 'open' : ''}>
      <summary>${plural(kids.filter(k => k.depth === item.depth + 1).length, 'subdeck')}</summary>
      ${subdeckRows(kids, item.depth, today, count)}
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
  const today = await loadAll(), list = loadDecks(today);
  const compact = today.settings.compactDecks !== false;
  const leeches = today.allCards.filter(c => (c.tags || []).includes('leech')).length;      // cards you keep forgetting, waiting for a fix
  const top = list.filter(x => x.depth === 0);            // counts already include subdecks
  const sum = k => top.reduce((n, x) => n + x.stats[k], 0);
  const todayAll = countFor(today, top.map(x => x.deck.id));      // today's numbers: daily limits applied
  const fold = folded();
  // Each deck's numbers are worked out once per render (the queues are not cheap), then reused by the tiles, the sort and the search.
  const countsMemo = new Map();
  const cnt = id => { let c = countsMemo.get(id); if (!c) countsMemo.set(id, c = countFor(today, [id])); return c; };
  // Starter decks you haven't added yet.
  const added = new Set(list.map(x => x.deck.starter).filter(Boolean));
  const starters = STARTER_DECKS.filter(s => !added.has(s.key)).map(s => ({ ...s, count: starterCards(s.level).length }));
  const view = { query: '', sort: savedSort() };

  // One deck's tile. `q` is the search text (compact only): a course that matches only through a subdeck shows just those subdecks.
  const tile = (item, q = '', first = false) => {
    const { deck, stats } = item; const c = cnt(deck.id), go = c.total; const mastered = stats.total ? (stats.young + stats.mature) / stats.total : 0;
    return `
      <article class="deck" style="--deck:${esc(deck.color)}">
        <button class="deck-open" type="button" data-open="${esc(deck.id)}">
          ${deck.course ? `<span class="deck-code">${esc(deck.course)}</span>` : ''}
          <span class="deck-name">${esc(deck.name)}</span>
          ${examInfo(deck) ? `<span class="${badgeClass(examInfo(deck))}">${esc(countdown(examInfo(deck)))}</span>` : ''}
          <span class="deck-counts">
            ${stats.total ? `<span><b>${stats.total}</b> ${stats.total === 1 ? 'card' : 'cards'}</span>
            <span class="due${c.due ? "" : " zero"}"><b>${c.due}</b> due</span>
            <span><b>${c.fresh}</b> new</span>` : '<span>No cards yet</span>'}
          </span>
        </button>
        ${stats.total ? `<span class="deck-ring" title="${Math.round(mastered * 100)}% of cards are young or mature">${ring(mastered, 44, 4, `<span class="mono">${Math.round(mastered * 100)}<small>%</small></span>`)}<span class="dr-cap">mastered</span></span>` : ''}
        <button class="icon-btn" type="button" data-edit="${esc(deck.id)}" aria-label="Edit ${esc(deck.name)}">${icon('more')}</button>
        <div class="deck-act">
          ${!stats.total ? `<a class="${compact ? 'deck-go add' : 'btn ghost small'}" href="#/import/${esc(deck.id)}">+ Add cards</a>`
          : compact
            ? (go ? `<button class="deck-go${first ? ' lead' : ''}" type="button" data-study="${esc(deck.id)}" aria-label="Study ${esc(deck.name)}: ${plural(go, 'card')}" title="Study ${plural(go, 'card')}">${icon('play')}</button>`
                  : `<span class="deck-go done" role="img" aria-label="Done for today" title="Done for today">${icon('check')}</span>`)
            : (go ? `<button class="btn primary small" type="button" data-study="${esc(deck.id)}" aria-label="Study ${esc(deck.name)}: ${plural(go, 'card')}">${icon('play')} Study ${go}</button>`
                  : `<span class="deck-done">${icon('check')} Done for today</span>`)}
        </div>
        ${compact ? compactSubdecks(item, q) : subdeckBox(list, item, !fold.has(deck.id), today, cnt)}
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
      ${subdeckRows(kids, item.depth, today, cnt)}
    </details>`;
  };
  const matches = (item, q) => `${item.deck.name} ${item.deck.course || ''}`.toLowerCase().includes(q);
  // The courses to show, in the chosen order (the numbers are today's: the same ones Today and the play button use).
  const shown = () => {
    const q = view.query.trim().toLowerCase();
    const due = x => cnt(x.deck.id).due;
    const tot = x => cnt(x.deck.id).total;
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
      <div><h1>Decks</h1></div>
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
    : emptyStartHTML()}
    ${list.length ? `<p class="browse-all"><a href="#/browse">Browse all cards →</a>${leeches ? ` <span aria-hidden="true">·</span> <a href="#/browse/leech" id="leechLink">${plural(leeches, 'card')} to fix</a>` : ''}</p>` : ''}
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
    const firstDue = view.sort === 'due' ? rows.find(x => cnt(x.deck.id).total) : null;
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
    if (open) navGo(`#/deck/${open.dataset.open}`);
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
  wireEmptyStart(el);
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
  const today = await loadAll(), list = loadDecks(today);
  const item = list.find(x => x.deck.id === deckId);
  if (!item) { navGo('#/decks'); return; }
  const { deck, cards, stats: s } = item;
  const counts = countFor(today, [deckId]);              // what Review shows today: the same number as Today and the sidebar
  const decks = list.map(x => x.deck);
  const parents = ancestors(decks, deckId).slice(1).reverse();      // top level first
  const parent = parents.at(-1);
  const exam = examInfo(effectiveDeck(decks, deckId));
  const kids = inside(list, deckId);
  // Exam within two weeks: Exam prep is the main button and Review steps back.
  const soon = !!exam && exam.daysLeft <= 14;
  const shared = sharedLimitNote(today, deck, kids, item.depth, counts);

  el.innerHTML = `
    <button class="back" type="button" id="back">‹ <span class="back-t">${parent ? esc(parent.name) : 'Decks'}</span></button>
    <div class="screen-head">
      <div>${parents.length ? `<span class="eyebrow crumbs">${parents.map(p => `<a href="#/deck/${esc(p.id)}">${esc(p.name)}</a>`).join(' › ')}</span>`
        : deck.course ? `<span class="eyebrow mono">${esc(deck.course)}</span>` : ''}<h1>${esc(deck.name)}</h1>
        ${exam ? `<p class="exam-line"><span class="${badgeClass(exam)}">${esc(countdown(exam))}</span> Every card is scheduled to come back before then.${soon ? '' : ' <button class="link" type="button" id="prepBtn" style="padding:0 2px;min-height:0">Exam prep</button>'}${exam.daysLeft <= MOCK_DAYS && s.total ? ' <button class="link" type="button" id="mockBtn" style="padding:0 2px;min-height:0">Take a mock exam</button>' : ''}</p>`
          : `<p class="exam-line"><button class="exam-chip" type="button" id="addExam">${icon('calendar')} Add exam date</button></p>`}</div>
      <div class="head-actions">
        ${soon ? '<button class="btn primary small" type="button" id="prepBtn">Exam prep</button>' : ''}
        ${s.total ? `<a class="btn ${soon ? 'ghost' : 'primary'} small" id="reviewBtn" href="#/review/${esc(deck.id)}">Review</a>` : ''}
        ${s.total ? '<button class="btn ghost small" type="button" id="testBtn">Practice test</button>' : ''}
        <a class="btn ghost small" href="#/import/${esc(deck.id)}">Import</a>
        <div class="more-wrap">
          <button class="icon-btn more-btn" type="button" id="deckMore" aria-haspopup="menu" aria-expanded="false" aria-controls="deckMenu" aria-label="More for ${esc(deck.name)}">${icon('more')}</button>
          <div class="more-menu" id="deckMenu" role="menu" aria-label="${esc(deck.name)}" hidden>
            <button type="button" role="menuitem" tabindex="-1" id="editDeck">${icon('edit')} Edit deck</button>
            <button type="button" role="menuitem" tabindex="-1" id="addSub">${icon('plus')} Add subdeck</button>
            ${cards.length ? `<button type="button" role="menuitem" tabindex="-1" id="exportDeck">${icon('download')} Export</button>` : ''}
            ${cards.length ? `<button type="button" role="menuitem" tabindex="-1" id="shareDeck">${icon('share')} Share</button>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div class="card section deck-summary" style="--deck:${esc(deck.color)}" ${cards.length ? '' : 'hidden'}>${summaryHTML(s, counts)}</div>
    ${kids.length ? `<section class="card section subdecks-page"><h2 class="mhead">Subdecks</h2>${subdeckRows(kids, item.depth, today)}
      <p class="note" style="margin:8px 0 0">${shared ? `${esc(shared)} ` : ''}Card counts below include the subdecks' cards too.</p></section>` : ''}
    <section id="browser"></section>
    <aside class="deck-tree" aria-label="Decks">
      <div class="dt-head"><b>Decks</b><button class="btn primary small" type="button" id="dtNew">+ New</button></div>
      <label class="deck-search dt-search">${icon('search')}<input id="dtQ" type="search" placeholder="Search decks" aria-label="Search decks" autocomplete="off"></label>
      <nav id="dtNav" aria-label="Deck tree"></nav>
      <a class="dt-all" href="#/decks">All decks ${icon('chevron')}</a>
    </aside>
  `;
  drawDeckTree(list, deckId, today);
  wireDeckMenu(el);
  $('back').addEventListener('click', () => { up(parent ? `#/deck/${parent.id}` : '#/decks'); });
  el.querySelectorAll('.subdecks-page [data-open]').forEach(b => b.addEventListener('click', () => { navGo(`#/deck/${b.dataset.open}`); }));
  $('addSub').addEventListener('click', () => openDeckEditor(null, saved => { navGo(`#/deck/${saved.id}`); }, { parentId: deckId }));
  $('exportDeck')?.addEventListener('click', () => openExport(deck, decks, cards));
  $('shareDeck')?.addEventListener('click', async () => { (await import('./share-deck.js')).openShareDeck(deck, decks, cards); });
  $('reviewBtn')?.addEventListener('click', e => { e.preventDefault(); startStudy({ deckIds: [deck.id], deckId: deck.id }); });
  $('prepBtn')?.addEventListener('click', () => startStudy({ deckIds: [deck.id], deckId: deck.id, kind: 'prep' }));
  $('addExam')?.addEventListener('click', () => openExamSheet(deck.id, () => renderDeck(el, deckId)));
  // A calm mock exam on this deck and its subdecks (js/mock-exam-sheet.js loads when first needed).
  $('testBtn')?.addEventListener('click', async () => (await import('./mock-exam-sheet.js')).openTestSheet(deck.id));
  $('mockBtn')?.addEventListener('click', async () => (await import('./mock-exam-sheet.js')).openTestSheet(deck.id, { mock: true }));
  $('editDeck').addEventListener('click', () => openDeckEditor(deck, saved => {
    if (saved === 'deleted') navGo(parent ? `#/deck/${parent.id}` : '#/decks'); else renderDeck(el, deckId);
  }));
  // The card list: search, filter, sort, edit, suspend and more. Its changes update the counts above.
  await mountBrowser($('browser'), { deckId, data: today, onChange: () => refreshCounts(el, deckId) });
}

// "Daily limits are shared, so the subdecks can add up to more than Course's 20 due." (or '' when they don't).
// The subdecks are counted one by one, each against the same shared limits, so they can add up to more than the parent shows.
// With no limits at all that can't happen, and if it does the numbers are wrong: say so in the console (dev builds).
function sharedLimitNote(today, deck, kids, depth, counts) {
  const direct = kids.filter(k => k.depth === depth + 1).map(k => countFor(today, [k.deck.id]));
  if (!direct.length) return '';
  const sumDue = direct.reduce((n, c) => n + c.due, 0), sumNew = direct.reduce((n, c) => n + c.fresh, 0);
  // Only a review limit can make the subdecks' due add up to more than the deck (newPerDay is always set, so it says nothing).
  if (!hasReviewLimit(today) && (sumDue > counts.due) && /^(localhost|127\.)/.test(location.hostname)) console.warn(`Deck counts: the subdecks of "${deck.name}" add up to more than the deck`, { sumDue, sumNew, counts });
  const [n, word] = sumDue > counts.due ? [counts.due, 'due'] : sumNew > counts.fresh ? [counts.fresh, 'new'] : [0, ''];
  return word ? `Daily limits are shared, so the subdecks can add up to more than ${deck.name}'s ${n} ${word}.` : '';
}

// The ⋯ menu in a deck page's header: Edit, Add subdeck and Export. Opens under the button; Esc, a click outside or
// choosing an item closes it (Esc puts focus back on the button); the arrow keys move between the items.
function wireDeckMenu(el) {
  const btn = $('deckMore'), menu = $('deckMenu');
  if (!btn || !menu) return;
  const items = () => [...menu.querySelectorAll('[role=menuitem]')];
  const close = (focus = false) => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus(); };
  const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); items()[0]?.focus(); };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  // Capture: close (and put focus on the ⋯ button) before the item's own handler runs, so a sheet it opens remembers the button.
  menu.addEventListener('click', () => close(true), true);
  menu.addEventListener('keydown', e => {
    const list = items(), i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Tab') close();
  });
  const outside = e => {
    if (!menu.isConnected) { stopOutside?.(); return; }
    if (!menu.hidden && !e.target.closest('.more-wrap')) close();
  };
  stopOutside?.();                                   // a re-render replaced the last menu: drop its listener
  document.addEventListener('pointerdown', outside, true);
  stopOutside = () => { document.removeEventListener('pointerdown', outside, true); stopOutside = null; };
}
let stopOutside = null;

// On a wide screen (1200px and up) a deck's page has three columns: this tree of decks on the left, the deck in the
// middle, and the card editor docked on the right (the card panel, see openSheet's `side`). Below 1200px the tree is
// hidden by the CSS and nothing changes. The deck you are in is highlighted; its courses are open and the rest folded
// (what you open is remembered on this device); typing in the search box shows only matching decks.
function drawDeckTree(list, currentId, today) {
  const decks = list.map(x => x.deck);
  const size = new Map(list.map(x => [x.deck.id, x.stats.total]));
  const dues = new Map();                                            // a search keystroke redraws every row: count each deck once
  const dueOf = id => { let n = dues.get(id); if (n === undefined) dues.set(id, n = countFor(today, [id]).due); return n; };   // what Review shows today; the card count is in the tooltip
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
        <a class="dt-node" href="#/deck/${esc(r.id)}" title="${esc(r.name)}: ${plural(size.get(r.id) || 0, 'card')}" ${r.id === currentId ? 'aria-current="page"' : ''}><i class="dot" aria-hidden="true"></i><span class="dt-name">${esc(r.name)}</span>${(due => due ? `<span class="dt-n mono" role="img" aria-label="${due} due">${due}</span>` : '')(dueOf(r.id))}</a></div>`;
    }).join('') || `<p class="note">No decks match.</p>`;
  };
  draw();
  $('dtQ').addEventListener('input', draw);
  $('dtNav').addEventListener('click', e => {
    const tw = e.target.closest('[data-tw]'); if (!tw) return;
    saveFold('tree-' + tw.dataset.tw, tw.getAttribute('aria-expanded') !== 'true');
    draw();
  });
  $('dtNew').addEventListener('click', () => openDeckEditor(null, saved => { navGo(`#/deck/${saved.id}`); }));
  $('dtNav').querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}

// Redraw the counts card at the top of a deck page after the card list changes something.
async function refreshCounts(el, deckId) {
  const box = el.querySelector('.deck-summary');
  if (!box) return;
  const today = await loadAll(), list = loadDecks(today);
  const item = list.find(x => x.deck.id === deckId);
  if (item && box.isConnected) { box.innerHTML = summaryHTML(item.stats, countFor(today, [deckId])); box.hidden = !item.stats.total; }
}

// c = countFor() for the deck: "13 due today · 5 new today · 23 cards", and what waits until tomorrow, if anything.
function summaryHTML(s, c) {
  const held = c.heldByLimit + c.heldBySiblings + c.heldByRescue;
  const why = [c.heldBySiblings ? 'one card per note a day' : '', c.heldByLimit ? 'daily limit' : '', c.heldByRescue ? 'catch-up plan' : ''].filter(Boolean).join(', ');
  return `
      <div class="deck-counts" style="margin-top:0">
        <span class="due${c.due ? '' : ' zero'}"><b>${c.due}</b> due today</span>
        <span><b>${c.fresh}</b> new today</span>
        <span><b>${s.total}</b> ${s.total === 1 ? 'card' : 'cards'}</span>
        ${s.hidden ? `<span><b>${s.hidden}</b> suspended or buried</span>` : ''}
      </div>
      ${held > 0 ? `<p class="held-note">${held} wait${held === 1 ? 's' : ''} until tomorrow <span>(${why})</span></p>` : ''}
      ${c.heldNewByRescue > 0 ? '<p class="held-note">New cards paused <span>(catch-up plan)</span></p>' : ''}
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
  // Loaded before the sheet opens: a button that is on screen must already work (a tap before the import finished did nothing).
  const ex = await import('./export.js');
  const cards = ex.cardsForExport(deck, decks, deckCards);
  openSheet(`
    <h2 id="sheetTitle">Export “${esc(deck.name)}”</h2>
    <p style="margin:0">${plural(cards.length, 'card')}, with their tags. Your progress stays in Study Sprint (in Anki they start as new cards).${(() => {
      const pics = cards.some(c => c.frontImage || c.backImage), snds = cards.some(c => c.frontSounds?.length || c.backSounds?.length);
      return pics || snds ? ` ${pics && snds ? 'Pictures and sounds go' : pics ? 'Pictures go' : 'Sounds go'} in the Anki deck (a spreadsheet can only hold text).` : '';
    })()}</p>
    ${cards.some(c => c.occlusion) ? '<p class="note">Image-occlusion cards need Anki 23.10+ (AnkiDroid 2.17+). In a spreadsheet they\'re text only.</p>' : ''}
    <div class="export-opts">
      <button class="btn ghost export-opt" type="button" id="exCsv"><b>Spreadsheet (.csv)</b><span>Opens in Excel, Google Sheets or Numbers. Can be imported into Quizlet, or back into Study Sprint (cloze cards stay one note; image occlusion cards come back as plain cards, so use .apkg for those).</span></button>
      <button class="btn ghost export-opt" type="button" id="exApkg"><b>Anki deck (.apkg)</b><span>For Anki on a computer, AnkiDroid or AnkiMobile: File → Import.</span></button>
    </div>
    <p class="err" id="exErr" role="alert" hidden></p>`);
  $('exCsv').addEventListener('click', () => {
    ex.download(new Blob([ex.toCSV(cards)], { type: 'text/csv;charset=utf-8' }), ex.fileName(deck.name, 'csv'));
    closeSheet();
    const rows = ex.csvRowCount(cards);      // (a card with its reverse card is one row)
    toast(`Exported ${plural(rows, 'row')} as a spreadsheet`);
  });
  $('exApkg').addEventListener('click', async () => {
    const btn = $('exApkg');
    btn.disabled = true;
    try {
      // Pictures and sounds this device hasn't downloaded yet (they load when a card needs them) belong in the file: fetch them
      // first. What can't be fetched is said, and a second tap makes the deck without it.
      if (btn.dataset.armed !== '1') {
        const r = await fetchMissingFor(cards, (n, t) => { btn.querySelector('b').textContent = n ? `Downloading pictures and sounds: ${n} of ${t}…` : 'Downloading pictures and sounds first…'; });
        if (r.n) {
          btn.dataset.armed = '1';
          showFieldError(null, $('exErr'), leftOutNote(r.n, r.reason, r.gone) + ' Tap the button again to make the deck without them.');
          btn.disabled = false;
          btn.querySelector('b').textContent = 'Make it without them';
          return;
        }
      }
      btn.querySelector('b').textContent = 'Making the Anki deck…';
      clearFieldError(null, $('exErr'));
      ex.download(await ex.makeApkg(deck, cards), ex.fileName(deck.name, 'apkg'));
      closeSheet();
      toast(`Exported ${plural(cards.length, 'card')} as an Anki deck`);
    } catch (err) {
      console.error(err);
      showFieldError(null, $('exErr'), navigator.onLine ? "Couldn't make the Anki deck. Try again." : 'Making an Anki deck needs an internet connection the first time.');
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
            <input id="deckRet" type="range" min="75" max="97" step="1" value="${Math.round((o.targetRetention ?? 0.9) * 100)}"></label>
          <div><button class="btn ghost small" type="button" id="deckRetHelp" aria-expanded="false" aria-controls="deckRetPanel">Help me choose</button></div>
          <div id="deckRetPanel" class="rc-inline" hidden></div>
          <label class="field"><span>Learning steps</span><input id="deckLs" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(o.learningSteps ?? '')}" placeholder="${SCHED_DEFAULTS.learningSteps}"></label>
          <label class="field"><span>Relearning steps</span><input id="deckRs" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(o.relearningSteps ?? '')}" placeholder="${SCHED_DEFAULTS.relearningSteps}"></label>
          <label class="field"><span>Maximum interval (days)</span><input id="deckMax" type="number" inputmode="numeric" min="1" max="36500" value="${num(o.maxInterval)}" placeholder="36500"></label>
        </div>
      </div>
    </details>`;
}
function wireStudyOptions(deck) {
  $('deckRet').addEventListener('input', e => { $('deckRetOut').textContent = `${e.target.value}%`; });
  // "Help me choose": the estimate opens inside the editor (a second sheet would replace it and lose what you typed).
  let helper = null;
  $('sheet').addEventListener('close', () => helper?.stop(), { once: true });          // the work stops when the editor closes
  $('deckRetHelp').addEventListener('click', async () => {
    const panel = $('deckRetPanel'), btn = $('deckRetHelp');
    if (!panel.hidden) { helper?.stop(); panel.hidden = true; panel.replaceChildren(); btn.setAttribute('aria-expanded', 'false'); return; }
    panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    try {
      const { mountRetentionHelper } = await import('./retention-sheet.js');
      helper = mountRetentionHelper(panel, {
        deckId: deck?.id || '',
        current: () => +$('deckRet').value,
        onPick: pct => { $('deckRet').value = pct; $('deckRetOut').textContent = `${pct}%`; }
      });
    } catch (err) { console.error(err); panel.textContent = "Couldn't open that. Check your connection and try again."; }
  });
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
  if (ls.error) return { error: `Learning steps: ${ls.error}`, field: 'deckLs' };
  if (rs.error) return { error: `Relearning steps: ${rs.error}`, field: 'deckRs' };
  const mi = parseMaxInterval($('deckMax').value || 36500);
  if (mi.error) return { error: `Maximum interval: ${mi.error}`, field: 'deckMax' };
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
        <input id="deckTtsAuto" type="checkbox" class="switch" ${effectiveDeck(decks, deck.id).ttsAuto ? 'checked' : ''}></label>
      <label class="adv-row switch-row" style="border:0;padding:0"><span><b>Play sounds automatically</b>
        <span>In Review: the front's sounds when a card appears, the back's when you flip.</span></span>
        <input id="deckSoundAuto" type="checkbox" class="switch" ${effectiveDeck(decks, deck.id).soundAuto ? 'checked' : ''}></label>`}
      <p class="err" id="deckErr" role="alert" hidden></p>
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

  let saving = false;
  $('deckForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('deckName').value.trim();
    for (const f of ['deckName', 'deckExam', 'deckLs', 'deckRs', 'deckMax']) if ($(f)) clearFieldError($(f), $('deckErr'));
    if (!name) { showFieldError($('deckName'), $('deckErr'), 'Give the deck a name.'); return; }
    // A date that was already saved is left alone; a new one is checked (blank clears it).
    const newExam = $('deckExam').value;
    const examProblem = newExam !== (deck?.examDate || '') ? examDateError(newExam) : '';
    if (examProblem) { showFieldError($('deckExam'), $('deckErr'), examProblem); return; }
    const course = $('deckCourse').value.trim();
    const parentId = $('deckParent').value;
    // Read aloud automatically: a subdeck only stores it when it differs from the deck it's inside.
    const auto = !!$('deckTtsAuto')?.checked;
    const ttsAuto = parentId && auto === inherited()?.ttsAuto ? null : auto;
    const soundOn = !!$('deckSoundAuto')?.checked;
    const soundAuto = soundOn === (parentId ? inherited()?.soundAuto : true) ? null : soundOn;      // (nothing stored = the default, on)
    // This deck's own new-card limit: blank = none (only the overall limit applies).
    const raw = $('deckNew')?.value.trim();
    const newPerDay = raw ? Math.max(0, Math.min(999, Math.round(Number(raw) || 0))) : null;
    let options = null;
    if (!isNew) {
      const read = readStudyOptions();
      if (read.error) { $('deckOpts').open = true; showFieldError($(read.field), $('deckErr'), read.error); return; }
      options = read;
    }
    if (saving) return;                // a double-click or a second Enter: the first save is already running
    saving = true;
    const saved = isNew
      ? { id: db.newId(), name, course, color, parentId, created: Date.now(), ...($('deckExam').value ? { examDate: $('deckExam').value } : {}) }
      : { ...deck, name, course, color, parentId, newPerDay, reviewPerDay: options.reviewPerDay, options: options.options,
        examDate: $('deckExam')?.value || null, ttsLang: $('deckTts')?.value || '', ttsAuto, soundAuto };
    // A new exam date (its own, or from the deck it's moved into) brings forward the cards scheduled after it: see
    // commitDeck in exam-sheet.js, which the short "Add exam date" sheet uses too. (A new deck has no cards to move yet.)
    let moved;
    try { ({ moved } = await commitDeck(saved, decks, { isNew })); } catch (err) { saving = false; throw err; }
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
    const done = () => { closeSheet(); toast(`Deleted “${deck.name}”`); drawSidebar(); onDone('deleted'); };
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
