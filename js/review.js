// The Review tab: daily spaced-repetition review.
//   1. Setup: choose decks, see how many cards are due, start.
//   2. Session: see the front, flip (tap or Space) or type the answer, rate Again / Hard / Good / Easy.
//   3. Finish: cards reviewed, accuracy, time spent and what's due tomorrow.

import * as db from './db.js';
import { dayStart, dayEnd } from './days.js';
import { buildQueue, takeNext, addWaiting, newStudiedToday, formatInterval, NEW, LEARNING, RELEARNING } from './queue.js';
import { RATINGS, Rating, previewIntervals, rate } from './srs.js';
import { canType, checkAnswer } from './match.js';
import { $, esc, plural } from './ui.js';

// The session in progress. Kept while you visit other tabs, so you can come back to it.
let R = null;
// Per-card time counted toward "time spent", so leaving the phone on one card doesn't inflate it.
const MAX_CARD_MS = 2 * 60 * 1000;

// ---------- loading ----------
async function loadAll() {
  const [settings, decks, cards, states, logs] = await Promise.all([
    db.getSettings(), db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getLogsSince(dayStart())
  ]);
  decks.sort((a, b) => a.created - b.created);
  // New cards come in deck order, then in the order they were added.
  const order = new Map(decks.map((d, i) => [d.id, i]));
  cards.sort((a, b) => order.get(a.deckId) - order.get(b.deckId) || a.created - b.created);
  const newLeft = Math.max(0, settings.newPerDay - newStudiedToday(logs));
  return { settings, decks, cards, statesById: new Map(states.map(s => [s.cardId, s])), newLeft };
}

// How many cards a set of decks has for today.
function countFor(data, deckIds) {
  const ids = new Set(deckIds);
  const cards = data.cards.filter(c => ids.has(c.deckId));
  const { queue, waiting } = buildQueue(cards, data.statesById, data.newLeft);
  const due = queue.filter(q => q.kind !== 'new').length + waiting.length;
  const fresh = queue.filter(q => q.kind === 'new').length;
  return { cards, due, fresh, total: due + fresh };
}

// ---------- 1. setup ----------
export async function renderReview(el, deckId) {
  // Coming back to a session that's still going: carry on where you were.
  if (R?.active && R.day === dayStart() && (!deckId || R.deckId === deckId)) return renderSession(el);

  const data = await loadAll();
  const allIds = data.decks.map(d => d.id);
  let chosen = deckId ? [deckId] : data.settings.reviewDecks.filter(id => allIds.includes(id));
  let typing = data.settings.reviewTyping;

  const draw = () => {
    const ids = chosen.length ? chosen : allIds;
    const c = countFor(data, ids);
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    el.innerHTML = `
      <div class="screen-head"><div><span class="eyebrow mono">${esc(today.toUpperCase())}</span><h1>Review</h1></div></div>
      <div class="summary">
        <div><div class="v">${c.due}</div><div class="l">Due</div></div>
        <div><div class="v">${c.fresh}</div><div class="l">New today</div></div>
        <div><div class="v">${c.total}</div><div class="l">Total</div></div>
      </div>
      ${data.decks.length ? `
      <section class="section">
        <h2>Decks</h2>
        <div class="chips" id="deckChips">
          <button type="button" class="tchip" data-all aria-pressed="${!chosen.length}">All decks</button>
          ${data.decks.map(d => {
            const dc = countFor(data, [d.id]);
            return `<button type="button" class="tchip" data-deck="${esc(d.id)}" aria-pressed="${chosen.includes(d.id)}">
              <i class="dot" style="background:${esc(d.color)}"></i>${esc(d.name)} <small class="mono">${dc.due}·${dc.fresh}</small></button>`;
          }).join('')}
        </div>
        <p class="note">Numbers show due · new for each deck. You get up to ${data.settings.newPerDay} new cards a day (change it in Settings).</p>
      </section>
      <section class="section">
        <h2>Answer by</h2>
        <div class="chips" id="modeChips">
          <button type="button" class="tchip" data-typing="0" aria-pressed="${!typing}">Flipping the card</button>
          <button type="button" class="tchip" data-typing="1" aria-pressed="${typing}">Typing the answer</button>
        </div>
        <p class="note">Typing is used for answers of 40 characters or less. Longer ones are flipped.</p>
      </section>` : ''}
      ${c.total
        ? `<button class="btn primary wide" type="button" id="startBtn">Start review · ${plural(c.total, 'card')}</button>
           <p class="hint mono">Space to flip · 1–4 to rate · Enter for Good</p>`
        : emptyMessage(data, c)}`;

    $('startBtn')?.addEventListener('click', () => start(el, data, c.cards, typing, deckId));
    el.querySelector('[data-all]')?.addEventListener('click', () => { chosen = []; save(); draw(); });
    el.querySelectorAll('[data-deck]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.deck;
      chosen = chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id];
      save(); draw();
    }));
    el.querySelectorAll('[data-typing]').forEach(b => b.addEventListener('click', () => {
      typing = b.dataset.typing === '1';
      db.setSetting('reviewTyping', typing);
      draw();
    }));
  };
  // Opening Review from one deck doesn't change your saved deck choice.
  const save = () => { if (!deckId) db.setSetting('reviewDecks', chosen); };
  draw();
}

function emptyMessage(data, c) {
  if (!data.cards.length) {
    return `<div class="empty"><b>No cards yet.</b><br>Add some to a deck first.<br><a class="btn primary" href="#/import">Import cards</a></div>`;
  }
  // When does the next card in these decks come due?
  const ids = new Set(c.cards.map(x => x.id));
  const next = Math.min(...[...data.statesById.values()].filter(s => ids.has(s.cardId) && s.state !== NEW).map(s => s.due));
  const when = Number.isFinite(next) ? `The next card is due in <b>${formatInterval(next - Date.now())}</b>.` : '';
  return `<div class="empty"><b>All caught up.</b><br>Nothing is due right now. ${when}</div>`;
}

// ---------- 2. session ----------
function start(el, data, cards, typing, deckId) {
  const { queue, waiting } = buildQueue(cards, data.statesById, data.newLeft);
  R = {
    active: true, day: dayStart(), deckId, typing,
    retention: data.settings.targetRetention,
    deckNames: new Map(data.decks.map(d => [d.id, d.name])),
    deckIds: [...new Set(cards.map(c => c.deckId))],
    statesById: data.statesById,
    queue, waiting,
    current: null, flipped: false, typed: null, suggest: null,
    shownAt: 0, answerMs: 0, busy: false,
    stats: { reviewed: 0, again: 0, spent: 0, started: Date.now() },
    undo: []
  };
  nextCard(el);
}

function nextCard(el) {
  R.current = takeNext(R.queue, R.waiting);
  R.flipped = false; R.typed = null; R.suggest = null;
  R.shownAt = Date.now(); R.answerMs = 0;
  if (!R.current) return finish(el);
  renderSession(el);
}

// Cards left, split like Anki: new · learning · review. The current card's kind is underlined.
function countsHTML() {
  const all = [...R.queue, ...R.waiting];
  const n = k => all.filter(x => x.kind === k).length + (R.current?.kind === k ? 1 : 0);
  const cls = k => (R.current?.kind === k ? ' now' : '');
  return `<span class="c-new${cls('new')}" title="New">${n('new')}</span>
    <span class="c-learn${cls('learn')}" title="Learning">${n('learn')}</span>
    <span class="c-rev${cls('review')}" title="Review">${n('review')}</span>`;
}

function renderSession(el) {
  if (!R.current) return finish(el);
  const { card } = R.current;
  const typeThis = R.typing && canType(card.back);
  const size = card.front.length > 120 ? ' xlong' : card.front.length > 50 ? ' long' : '';

  el.innerHTML = `
    <div class="rv-head">
      <div class="rv-counts mono" aria-label="Cards left: new, learning, review">${countsHTML()}</div>
      <button class="link" type="button" id="undoBtn" ${R.undo.length ? '' : 'disabled'}>Undo</button>
      <button class="link" type="button" id="endBtn">End</button>
    </div>
    <article class="flash${R.flipped ? ' flipped' : ''}" id="flash" ${R.flipped || typeThis ? '' : 'role="button" tabindex="0" aria-label="Show answer"'}>
      <span class="flash-deck">${esc(R.deckNames.get(card.deckId) || '')}</span>
      <div class="flash-front${size}">${esc(card.front)}</div>
      <div class="flash-ans" ${R.flipped ? '' : 'hidden'}>
        ${R.typed ? typedResultHTML() : ''}
        <div class="flash-back">${esc(card.back)}</div>
      </div>
      ${!R.flipped && !typeThis ? '<p class="flash-hint">Tap to show the answer</p>' : ''}
    </article>
    ${typeThis && !R.flipped ? `
      <form class="typeform" id="typeForm" autocomplete="off">
        <input id="typeIn" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the answer" aria-label="Your answer">
        <button class="btn primary" type="submit">Check</button>
      </form>` : ''}
    ${R.typing && !typeThis && !R.flipped ? '<p class="note center">Long answer: say it in your head, then flip.</p>' : ''}
    <div class="ratebar" id="ratebar">${R.flipped ? rateButtonsHTML() : `<button class="btn ${typeThis ? 'ghost' : 'primary'} wide" type="button" id="showBtn">${typeThis ? "I don't know" : 'Show answer'}</button>`}</div>`;

  $('undoBtn').addEventListener('click', () => undo(el));
  $('endBtn').addEventListener('click', () => finish(el));
  $('showBtn')?.addEventListener('click', () => flip(el));
  if (!R.flipped && !typeThis) $('flash').addEventListener('click', () => flip(el));
  $('typeForm')?.addEventListener('submit', e => { e.preventDefault(); submitTyped(el); });
  $('ratebar').querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => answer(el, +b.dataset.rate)));
  if (typeThis && !R.flipped) $('typeIn').focus();
}

function rateButtonsHTML() {
  const ivl = previewIntervals(R.statesById.get(R.current.card.id), R.retention);
  return `<div class="rates">${RATINGS.map(({ rating, label, key }) => `
    <button type="button" class="rate r${rating}${R.suggest === rating ? ' suggested' : ''}" data-rate="${rating}" aria-keyshortcuts="${key}">
      <b>${label}</b><span class="mono">${formatInterval(ivl[rating])}</span></button>`).join('')}</div>`;
}

function typedResultHTML() {
  const { value, result } = R.typed;
  if (result.correct) return `<p class="typed ok">✓ ${result.exact ? 'Correct' : 'Correct, with a small typo'}${result.exact ? '' : `: <span class="given">${esc(value)}</span>`}</p>`;
  return `<p class="typed no">✗ ${value.trim() ? `Not quite. You typed <span class="given">${esc(value)}</span>` : 'No answer'}</p>`;
}

function flip(el) {
  if (R.flipped) return;
  R.flipped = true;
  R.answerMs = Date.now() - R.shownAt;
  // "I don't know" while typing counts as a miss.
  if (R.typing && canType(R.current.card.back) && !R.typed) R.suggest = Rating.Again;
  renderSession(el);
  $('ratebar').querySelector('.rate')?.scrollIntoView({ block: 'nearest' });
}

function submitTyped(el) {
  const value = $('typeIn').value;
  if (!value.trim()) { $('typeIn').focus(); return; }
  const result = checkAnswer(value, R.current.card.back);
  R.typed = { value, result };
  R.suggest = result.correct ? Rating.Good : Rating.Again;
  $('typeIn').blur();
  flip(el);
}

async function answer(el, rating) {
  if (!R.flipped || R.busy) return;
  R.busy = true;
  const item = R.current, id = item.card.id;
  const prev = R.statesById.get(id) || null;
  const now = Date.now();
  const next = rate(id, prev, rating, R.retention, now);
  const log = {
    cardId: id, timestamp: now, source: 'review',
    mode: R.typed ? 'typing' : 'flip',
    correct: rating !== Rating.Again,
    ms: R.answerMs || now - R.shownAt,
    rating,
    state: prev ? prev.state : NEW          // the card's state before this review (useful for stats and FSRS tuning later)
  };
  try {
    const logId = await db.saveReview(next, log);
    R.statesById.set(id, next);
    // Still learning and due again today (in a few minutes)? It comes back this session.
    const requeued = (next.state === LEARNING || next.state === RELEARNING) && next.due <= dayEnd(now);
    if (requeued) addWaiting(R.waiting, { card: item.card, kind: 'learn', due: next.due });
    const spent = Math.min(now - R.shownAt, MAX_CARD_MS);
    R.undo.push({ item, prev, logId, requeued, again: rating === Rating.Again, spent });
    R.stats.reviewed++; R.stats.spent += spent;
    if (rating === Rating.Again) R.stats.again++;
    nextCard(el);
  } finally {
    R.busy = false;
  }
}

// Take back the last rating: restore the card's old schedule and show it again.
async function undo(el) {
  const u = R.undo.pop();
  if (!u || R.busy) return;
  R.busy = true;
  try {
    const id = u.item.card.id;
    await db.undoReview(id, u.prev, u.logId);
    if (u.prev) R.statesById.set(id, u.prev); else R.statesById.delete(id);
    if (u.requeued) {
      const i = R.waiting.findIndex(w => w.card.id === id);
      if (i >= 0) R.waiting.splice(i, 1);
    }
    if (R.current) R.queue.unshift(R.current);
    R.stats.reviewed--; R.stats.spent -= u.spent;
    if (u.again) R.stats.again--;
    R.active = true;
    R.current = u.item; R.flipped = false; R.typed = null; R.suggest = null;
    R.shownAt = Date.now(); R.answerMs = 0;
    renderSession(el);
  } finally {
    R.busy = false;
  }
}

// ---------- 3. finish ----------
async function finish(el) {
  R.active = false;
  const { reviewed, again, spent } = R.stats;
  // Reviews due by the end of tomorrow in the decks you just studied.
  const decks = new Set(R.deckIds);
  const cards = (await db.getAll('cards')).filter(c => decks.has(c.deckId));
  const ids = new Set(cards.map(c => c.id));
  const tomorrowEnd = dayEnd(Date.now(), 1);
  const dueTomorrow = (await db.getAll('cardStates')).filter(s => ids.has(s.cardId) && s.state !== NEW && s.due <= tomorrowEnd).length;
  const acc = reviewed ? Math.round((reviewed - again) / reviewed * 100) : 0;
  const mins = Math.floor(spent / 60000), secs = Math.round((spent % 60000) / 1000);

  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">${R.current ? 'SESSION ENDED' : 'DONE FOR NOW'}</span><h1>${reviewed ? 'Nice work' : 'Review'}</h1></div></div>
    <div class="stats4">
      <div><div class="v">${reviewed}</div><div class="l">Cards reviewed</div></div>
      <div><div class="v">${acc}%</div><div class="l">Accuracy</div></div>
      <div><div class="v">${mins}:${String(secs).padStart(2, '0')}</div><div class="l">Time spent</div></div>
      <div><div class="v">${dueTomorrow}</div><div class="l">Due tomorrow</div></div>
    </div>
    <p class="note">${R.current ? 'Cards you didn’t get to stay due. ' : ''}Accuracy counts every rating except Again.</p>
    <div class="res-actions">
      <a class="btn primary" href="#/decks">Back to decks</a>
      <button class="btn ghost" type="button" id="againBtn">Review screen</button>
      ${R.undo.length ? '<button class="btn ghost" type="button" id="undoLast">Undo last</button>' : ''}
    </div>`;
  $('againBtn').addEventListener('click', () => { R = null; renderReview(el); });
  $('undoLast')?.addEventListener('click', () => undo(el));
}

// ---------- stop iPhone double-tap zoom ----------
// Rating redraws the screen, so two quick taps (card, then a rating button) land on different
// elements and Safari can treat them as a double-tap and zoom. If a second tap in the review area
// comes within 350ms of the first, cancel the browser's handling (which cancels the zoom) and press
// the button ourselves.
let lastTap = 0;
document.addEventListener('touchend', e => {
  const zone = e.target.closest?.('.flash, .ratebar, .rv-head');
  if (zone && e.timeStamp - lastTap < 350 && e.cancelable) {
    e.preventDefault();
    e.target.closest('button, [role="button"]')?.click();
  }
  lastTap = zone ? e.timeStamp : 0;
}, { passive: false });

// ---------- keyboard ----------
// Space or Enter flips. 1–4 rate. After flipping, Space or Enter picks the suggested button (Good unless typing said otherwise).
document.addEventListener('keydown', e => {
  if (!R?.active || !document.getElementById('flash') || document.getElementById('sheet')?.open) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const inInput = e.target.matches('input, textarea, select');
  if (!R.flipped) {
    if (!inInput && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip($('screen')); }
    return;
  }
  if (!inInput && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); answer($('screen'), +e.key); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer($('screen'), R.suggest || Rating.Good); }
});
