// The Review tab: daily spaced-repetition review.
//   1. Setup: choose decks, see how many cards are due, start.
//   2. Session: see the front, flip (tap or Space) or type the answer, rate Again / Hard / Good / Easy.
//   3. Finish: cards reviewed, accuracy, time spent and what's due tomorrow.

import * as db from './db.js';
import { dayStart, dayEnd } from './days.js';
import { buildQueue, takeNext, addWaiting, newLimits, extraNewToday, aheadQueue, forgottenQueue, formatInterval, NEW, LEARNING, RELEARNING } from './queue.js';
import { RATINGS, Rating, previewIntervals, rate } from './srs.js';
import { canType, checkAnswer } from './match.js';
import { formatHTML, plainText } from './format.js';
import { imgHTML } from './media.js';
import { speak, stopSpeaking, canSpeak } from './speech.js';
import { schedulerOptions } from './sched-settings.js';
import { examOptions, examInfo, examPrepQueue, countdown } from './exam.js';
import { isHidden, isNewLeech, markLeech, buryUntil } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { $, esc, plural, toast, openSheet, closeSheet } from './ui.js';

// The session in progress. Kept while you visit other tabs, so you can come back to it.
let R = null;
// A computer with a mouse (vs a touchscreen): changes a hint's wording.
const MOUSE = matchMedia('(hover: hover) and (pointer: fine)');
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
  // Suspended cards, and cards buried until tomorrow, sit out of Review.
  const now = Date.now();
  const hiddenCount = cards.filter(c => isHidden(c, now)).length;
  const visible = cards.filter(c => !isHidden(c, now));
  // New cards left today: the overall limit, each deck's own limit, plus any extra added with Custom study.
  const extra = extraNewToday(settings.extraNew, now);
  const newLeft = newLimits({ perDay: settings.newPerDay, decks, logs, deckOf: new Map(cards.map(c => [c.id, c.deckId])), extra, now });
  return { settings, decks, cards: visible, hiddenCount, logs, extra, statesById: new Map(states.map(s => [s.cardId, s])), newLeft };
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
// Exam prep for one deck (from its page): open Review straight into the session.
let prepFor = null;
export function examPrep(deckId) {
  prepFor = deckId;
  location.hash = `#/review/${encodeURIComponent(deckId)}`;
}

export async function renderReview(el, deckId) {
  // Coming back to a session that's still going: carry on where you were.
  // (Unless Play changed some schedules meanwhile: then start fresh so no card is graded twice.)
  if (R?.active && R.day === dayStart() && (!deckId || R.deckId === deckId) && R.version === db.scheduleVersion()) return renderSession(el);

  const data = await loadAll();
  if (prepFor && prepFor === deckId) {
    prepFor = null;
    const cards = data.cards.filter(c => c.deckId === deckId);
    const prep = examPrepQueue(cards, data.statesById);
    if (prep.queue.length) return start(el, data, cards, data.settings.reviewTyping, deckId, { ...prep, label: 'Exam prep' });
  }
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
        <p class="note">Numbers show due · new for each deck. You get up to ${data.settings.newPerDay}${data.extra ? ` + ${data.extra} extra` : ''} new cards a day (change it in Settings, or for one deck with its Edit button).</p>
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
           <p class="hint mono">Space to flip · 1–4 to rate · Enter for Good · E edit · I info · - bury · @ suspend · R read aloud</p>`
        : emptyMessage(data, c)}
      ${data.decks.length ? '<button class="btn ghost wide custom-btn" type="button" id="customBtn">Custom study…</button>' : ''}`;

    $('startBtn')?.addEventListener('click', () => start(el, data, c.cards, typing, deckId));
    $('customBtn')?.addEventListener('click', () => openCustomStudy(el, data, c.cards, typing, deckId));
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
  if (!data.cards.length && !data.hiddenCount) {
    return `<div class="empty"><b>No cards yet.</b><br>Add some to a deck first.<br><a class="btn primary" href="#/import">Import cards</a></div>`;
  }
  // When does the next card in these decks come due?
  const ids = new Set(c.cards.map(x => x.id));
  const next = Math.min(...[...data.statesById.values()].filter(s => ids.has(s.cardId) && s.state !== NEW).map(s => s.due));
  const when = Number.isFinite(next) ? `The next card is due in <b>${formatInterval(next - Date.now())}</b>.` : '';
  const hidden = data.hiddenCount ? `<br><span class="muted">${plural(data.hiddenCount, 'card')} ${data.hiddenCount === 1 ? 'is' : 'are'} suspended or buried.</span>` : '';
  return `<div class="empty"><b>All caught up.</b><br>Nothing is due right now. ${when}${hidden}</div>`;
}

// ---------- custom study ----------
// Extra study beyond today's cards, for the decks chosen on the setup screen (like Anki's Custom study).
//   cards  the cards in those decks (suspended and buried ones already left out)
function openCustomStudy(el, data, cards, typing, deckId) {
  const forgot = forgottenQueue(cards, data.statesById, data.logs);
  const isNew = c => { const st = data.statesById.get(c.id); return !st || st.state === NEW; };
  const newAvail = cards.filter(isNew).length;
  let days = 3, extra = 10;
  // Decks here with an exam coming up, and their exam prep session.
  const exams = data.decks.map(deck => ({ deck, info: examInfo(deck) })).filter(e => e.info && cards.some(c => c.deckId === e.deck.id));
  const prep = examPrepQueue(cards.filter(c => exams.some(e => e.deck.id === c.deckId)), data.statesById);

  openSheet(`
    <h2 id="sheetTitle">Custom study</h2>
    <p class="note" style="margin-top:0">For the decks chosen on the Review screen.</p>
    <div class="cs-opt">
      <b>More new cards today</b>
      <p>Raises today's new card limit (each deck's own limit too). It goes back to normal tomorrow. ${plural(newAvail, 'new card')} available.</p>
      <div class="cs-row">
        <div class="stepper">
          <button type="button" class="icon-btn" id="csMinus" aria-label="Fewer">−</button>
          <input id="csNew" type="number" inputmode="numeric" min="1" max="999" value="${extra}" aria-label="Extra new cards">
          <button type="button" class="icon-btn" id="csPlus" aria-label="More">+</button>
        </div>
        <button class="btn primary small" type="button" id="csNewBtn" ${newAvail ? '' : 'disabled'}>Add</button>
      </div>
    </div>
    <div class="cs-opt">
      <b id="csAheadLbl">Review ahead</b>
      <p>Study cards that aren't due yet, for example before an exam. Each one is rescheduled from today.</p>
      <div class="chips" role="group" aria-labelledby="csAheadLbl">
        ${[[1, 'Tomorrow'], [3, '3 days'], [7, '1 week'], [14, '2 weeks']].map(([d, l]) =>
          `<button type="button" class="tchip" data-days="${d}" aria-pressed="${d === days}">${l}</button>`).join('')}
      </div>
      <button class="btn primary small" type="button" id="csAheadBtn"></button>
    </div>
    ${exams.length ? `<div class="cs-opt">
      <b>Exam prep</b>
      <p>${esc(exams.map(e => `${e.deck.name}: ${countdown(e.info).toLowerCase()}`).join(' · '))}. Go over every card you haven't seen in the last 3 days, weakest first, then any you haven't started.</p>
      <button class="btn primary small" type="button" id="csPrepBtn" ${prep.queue.length ? '' : 'disabled'}>${prep.queue.length ? `Review ${plural(prep.queue.length, 'card')}` : 'All seen recently'}</button>
    </div>` : ''}
    <div class="cs-opt">
      <b>Cards I forgot today</b>
      <p>Go over every card you pressed Again on, or got wrong in Play, today.</p>
      <button class="btn primary small" type="button" id="csForgotBtn" ${forgot.queue.length ? '' : 'disabled'}>${forgot.queue.length ? `Review ${plural(forgot.queue.length, 'card')}` : 'None today'}</button>
    </div>
    <button class="btn ghost" type="button" id="csClose">Close</button>`);

  const drawAhead = () => {
    const n = aheadQueue(cards, data.statesById, days).queue.length;
    $('csAheadBtn').textContent = n ? `Review ${plural(n, 'card')}` : 'Nothing due then';
    $('csAheadBtn').disabled = !n;
  };
  drawAhead();
  document.querySelectorAll('#sheet [data-days]').forEach(b => b.addEventListener('click', () => {
    days = +b.dataset.days;
    document.querySelectorAll('#sheet [data-days]').forEach(x => x.setAttribute('aria-pressed', x === b));
    drawAhead();
  }));
  const setExtra = v => { extra = Math.max(1, Math.min(999, Math.round(Number(v) || 1))); $('csNew').value = extra; };
  $('csNew').addEventListener('change', e => setExtra(e.target.value));
  $('csMinus').addEventListener('click', () => setExtra(extra - 5));
  $('csPlus').addEventListener('click', () => setExtra(extra + 5));
  $('csNewBtn').addEventListener('click', async () => {
    setExtra($('csNew').value);
    const n = extraNewToday(data.settings.extraNew) + extra;       // adds to any extras from earlier today
    await db.setSetting('extraNew', { day: dayStart(), n });
    closeSheet();
    toast(`${plural(extra, 'extra new card')} for today`);
    if (R && !R.active) R = null;
    renderReview(el, deckId);
  });
  $('csAheadBtn').addEventListener('click', () => {
    closeSheet();
    start(el, data, cards, typing, deckId, { ...aheadQueue(cards, data.statesById, days), label: 'Review ahead' });
  });
  $('csPrepBtn')?.addEventListener('click', () => {
    closeSheet();
    start(el, data, cards, typing, deckId, { ...prep, label: 'Exam prep' });
  });
  $('csForgotBtn').addEventListener('click', () => {
    closeSheet();
    start(el, data, cards, typing, deckId, { ...forgot, label: 'Forgotten today' });
  });
  $('csClose').addEventListener('click', closeSheet);
}

// ---------- 2. session ----------
// custom: optional { queue, waiting, label } for a Custom study session instead of today's cards.
function start(el, data, cards, typing, deckId, custom = null) {
  const { queue, waiting } = custom || buildQueue(cards, data.statesById, data.newLeft);
  R = {
    active: true, day: dayStart(), deckId, typing, custom: custom?.label || null,
    sched: schedulerOptions(data.settings),     // retention, learning steps, max interval, fuzz
    leech: { threshold: data.settings.leechThreshold, action: data.settings.leechAction },
    decks: data.decks,
    deckNames: new Map(data.decks.map(d => [d.id, d.name])),
    deckIds: [...new Set(cards.map(c => c.deckId))],
    statesById: data.statesById,
    queue, waiting,
    current: null, flipped: false, typed: null, suggest: null,
    shownAt: 0, answerMs: 0, busy: false,
    stats: { reviewed: 0, again: 0, spent: 0, started: Date.now() },
    undo: [],
    version: db.scheduleVersion()
  };
  nextCard(el);
}

// The scheduling options for a card: the normal ones, plus its deck's exam limits (exam.js).
const schedFor = (card, now = Date.now()) => examOptions(R.sched, R.decks.find(d => d.id === card.deckId), now);

const deckOf = card => R.decks.find(d => d.id === card.deckId);
// Read the side showing (the back once flipped) in the deck's language.
function readAloud() {
  if (!R?.current) return;
  const { card } = R.current;
  speak(R.flipped ? card.back : card.front, deckOf(card)?.ttsLang || '');
}

function nextCard(el) {
  stopSpeaking();
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
  R.el = el;
  if (!R.current) return finish(el);
  const { card } = R.current;
  // Formatting (bold, lists…) is shown on the card; typed answers are checked against the plain text.
  const typeThis = R.typing && canType(plainText(card.back));
  const size = plainText(card.front).length > 120 ? ' xlong' : plainText(card.front).length > 50 ? ' long' : '';

  el.innerHTML = `
    <div class="rv-head">
      <div class="rv-counts mono" aria-label="Cards left: new, learning, review">${countsHTML()}</div>
      <button class="link" type="button" id="undoBtn" ${R.undo.length ? '' : 'disabled'}>Undo</button>
      ${canSpeak() ? '<button class="link more" type="button" id="speakBtn" aria-label="Read aloud" title="Read aloud (R)" aria-keyshortcuts="R">🔊</button>' : ''}
      <button class="link more" type="button" id="moreBtn" aria-label="Card actions: edit, flag, suspend, bury and more">⋯</button>
      <button class="link" type="button" id="endBtn">End</button>
    </div>
    <article class="flash${R.flipped ? ' flipped' : ''}" id="flash" ${R.flipped || typeThis ? '' : 'role="button" tabindex="0" aria-label="Show answer"'}>
      <span class="flash-deck">${esc(R.deckNames.get(card.deckId) || '')}${R.custom ? ` · ${esc(R.custom)}` : ''}</span>
      <div class="flash-front${size}">${imgHTML(card.frontImage)}${formatHTML(card.front)}</div>
      <div class="flash-ans" ${R.flipped ? '' : 'hidden'}>
        ${R.typed ? typedResultHTML() : ''}
        <div class="flash-back">${imgHTML(card.backImage)}${formatHTML(card.back)}</div>
      </div>
      ${!R.flipped && !typeThis ? `<p class="flash-hint">${MOUSE.matches ? 'Click or press Space to show the answer' : 'Tap to show the answer'}</p>` : ''}
    </article>
    ${typeThis && !R.flipped ? `
      <form class="typeform" id="typeForm" autocomplete="off">
        <input id="typeIn" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the answer" aria-label="Your answer">
        <button class="btn primary" type="submit">Check</button>
      </form>` : ''}
    ${R.typing && !typeThis && !R.flipped ? '<p class="note center">Long answer: say it in your head, then flip.</p>' : ''}
    <div class="ratebar" id="ratebar">${R.flipped ? rateButtonsHTML() : `<button class="btn ${typeThis ? 'ghost' : 'primary'} wide" type="button" id="showBtn">${typeThis ? "I don't know" : 'Show answer'}${typeThis ? '' : ' <kbd class="key-hint" aria-hidden="true">Space</kbd>'}</button>`}</div>`;

  $('undoBtn').addEventListener('click', () => undo(el));
  $('endBtn').addEventListener('click', () => finish(el));
  $('moreBtn').addEventListener('click', () => openCardMenu());
  $('speakBtn')?.addEventListener('click', () => readAloud());
  // Decks set to read aloud: the front when a card appears, the back when it's flipped (once each).
  const key = `${card.id}:${R.flipped}`;
  if (deckOf(card)?.ttsAuto && R.spoken !== key) { R.spoken = key; readAloud(); }
  $('showBtn')?.addEventListener('click', () => flip(el));
  if (!R.flipped && !typeThis) $('flash').addEventListener('click', () => flip(el));
  $('typeForm')?.addEventListener('submit', e => { e.preventDefault(); submitTyped(el); });
  $('ratebar').querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => answer(el, +b.dataset.rate)));
  if (typeThis && !R.flipped) $('typeIn').focus();
}

function rateButtonsHTML() {
  const ivl = previewIntervals(R.statesById.get(R.current.card.id), schedFor(R.current.card));
  return `<div class="rates">${RATINGS.map(({ rating, label, key }) => `
    <button type="button" class="rate r${rating}${R.suggest === rating ? ' suggested' : ''}" data-rate="${rating}" aria-keyshortcuts="${key}">
      <b>${label}</b><span class="mono">${formatInterval(ivl[rating])}</span><kbd class="key-hint" aria-hidden="true">${key}</kbd></button>`).join('')}</div>`;
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
  if (R.typing && canType(plainText(R.current.card.back)) && !R.typed) R.suggest = Rating.Again;
  renderSession(el);
  $('ratebar').querySelector('.rate')?.scrollIntoView({ block: 'nearest' });
}

function submitTyped(el) {
  const value = $('typeIn').value;
  if (!value.trim()) { $('typeIn').focus(); return; }
  const result = checkAnswer(value, plainText(R.current.card.back));
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
  const next = rate(id, prev, rating, schedFor(item.card, now), now);
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
    R.version = db.scheduleVersion();
    R.statesById.set(id, next);
    // Still learning and due again today (in a few minutes)? It comes back this session.
    const requeued = (next.state === LEARNING || next.state === RELEARNING) && next.due <= dayEnd(now);
    if (requeued) addWaiting(R.waiting, { card: item.card, kind: 'learn', due: next.due });
    // Forgotten too many times? It becomes a leech: tagged, and suspended unless Settings says tag only.
    let cardBefore = null;
    if (isNewLeech(prev?.lapses || 0, next.lapses, R.leech.threshold)) {
      cardBefore = item.card;
      const leech = markLeech(item.card, R.leech.action);
      await db.saveCards([leech]);
      R.version = db.scheduleVersion();
      if (leech.suspended) dropFromSession(id); else replaceInSession(leech);
      toast(leech.suspended ? 'Leech: you keep forgetting this card, so it’s been suspended' : 'Leech: you keep forgetting this card (tagged “leech”)');
    }
    const spent = Math.min(now - R.shownAt, MAX_CARD_MS);
    R.undo.push({ item, prev, logId, requeued, again: rating === Rating.Again, spent, cardBefore });
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
    if (u.cardBefore) { await db.saveCards([u.cardBefore]); u.item = { ...u.item, card: u.cardBefore }; }   // un-leech it
    R.version = db.scheduleVersion();
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

// ---------- card actions during a session ----------
// Take a card out of this session (it was suspended, buried, deleted, reset or given a new due date).
function dropFromSession(id) {
  R.queue = R.queue.filter(q => q.card.id !== id);
  R.waiting = R.waiting.filter(q => q.card.id !== id);
  R.undo = R.undo.filter(u => u.item.card.id !== id);     // its old ratings can't be undone any more
}
// Swap in a card's new version (it was edited, flagged or moved) wherever the session holds it.
function replaceInSession(card) {
  const swap = q => (q.card.id === card.id ? { ...q, card } : q);
  R.queue = R.queue.map(swap);
  R.waiting = R.waiting.map(swap);
  if (R.current?.card.id === card.id) R.current = { ...R.current, card };
}

// The ⋯ button (and E / I keys): the same card panel as the card list.
const LEAVES = ['suspend', 'bury', 'delete', 'reset', 'due'];
function openCardMenu(showInfo = false) {
  if (!R?.current) return;
  openCardPanel(R.current.card, {
    decks: R.decks, statesById: R.statesById, showInfo, closeAfter: LEAVES,
    onAction: (act, fresh) => {
      R.version = db.scheduleVersion();
      if (LEAVES.includes(act) || !fresh) { dropFromSession(R.current.card.id); nextCard(R.el); }
      else { replaceInSession(fresh); renderSession(R.el); }
    }
  });
}

// Quick keys: bury (-) or suspend (@) the card on screen without opening the panel.
async function quick(act) {
  if (!R?.current || R.busy) return;
  const { card } = R.current;
  await db.saveCards([act === 'bury' ? { ...card, buriedUntil: buryUntil() } : { ...card, suspended: true }]);
  R.version = db.scheduleVersion();
  toast(act === 'bury' ? 'Buried until tomorrow' : 'Suspended');
  dropFromSession(card.id);
  nextCard(R.el);
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
  // You may have switched to another screen while that loaded: don't draw over it.
  if (!location.hash.startsWith('#/review')) return;
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

// ---------- keyboard ----------
// Space or Enter flips. 1–4 rate. After flipping, Space or Enter picks the suggested button (Good unless typing said otherwise).
// Like Anki: E edits, I shows card info, - buries, @ suspends, R reads the card aloud.
document.addEventListener('keydown', e => {
  if (!R?.active || !document.getElementById('flash') || document.getElementById('sheet')?.open) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const inInput = e.target.matches('input, textarea, select');
  if (!inInput) {
    const k = e.key.toLowerCase();
    if (k === 'e' || k === 'i') { e.preventDefault(); openCardMenu(k === 'i'); return; }
    if (e.key === '-' || e.key === '@') { e.preventDefault(); quick(e.key === '-' ? 'bury' : 'suspend'); return; }
    if (k === 'r') { e.preventDefault(); readAloud(); return; }
  }
  if (!R.flipped) {
    if (!inInput && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(R.el); }
    return;
  }
  if (!inInput && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); answer(R.el, +e.key); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(R.el, R.suggest || Rating.Good); }
});
