// Review: the spaced-repetition session. (Choosing what to study happens on Today: js/today.js.)
//   1. Starting: from Today (all decks, one deck, or Custom study) or straight from a deck's page.
//   2. Session: see the front, flip (tap or Space) or type the answer, rate Again / Hard / Good / Easy.
//   3. Finish: cards reviewed, accuracy, time spent, streak and what's due tomorrow.

import * as db from './db.js';
import { dayStart, dayEnd } from './days.js';
import { buildQueue, takeNext, addWaiting, formatInterval, NEW, LEARNING, RELEARNING } from './queue.js';
import { RATINGS, Rating, previewIntervals, rate, examGain } from './srs.js';
import { canType, checkAnswer } from './match.js';
import { formatHTML, plainText } from './format.js';
import { imgHTML } from './media.js';
import { speak, stopSpeaking, canSpeak } from './speech.js';
import { deckSchedulerOptions } from './sched-settings.js';
import { loadByDay } from './balance.js';
import { examOptions, examSchedule } from './exam.js';
import { loadAll, countFor, withSubdecks, nextDueText, customQueue, takeLaunch, loadStreak, scopeKey, live } from './study-data.js';
import { isHidden, isNewLeechCounted, markLeech, buryUntil } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { deckPath, effectiveDeck } from './deck-tree.js';
import { $, esc, plural, toast, onControl, setFocusMode, icon, SPEAKER_ICON } from './ui.js';

// The session in progress. Kept while you visit other tabs, so you can come back to it.
let R = null;
// A computer with a mouse (vs a touchscreen): changes a hint's wording.
const MOUSE = matchMedia('(hover: hover) and (pointer: fine)');
// Per-card time counted toward "time spent", so leaving the phone on one card doesn't inflate it.
const MAX_CARD_MS = 2 * 60 * 1000;

// ---------- 1. starting ----------
// Today (js/today.js) decides what to study and hands it over with setLaunch(); this screen starts it.
// Exam prep and the other Custom study sessions come the same way (a launch with a `kind`).

export async function renderReview(el, deckId) {
  // Coming back to a session that's still going: carry on where you were.
  // (Unless Play changed some schedules meanwhile: then start fresh so no card is graded twice.)
  const launch = takeLaunch();         // Today may be starting something new: then don't resume the old session
  if (!launch && R?.active && R.day === dayStart() && (!deckId || R.deckId === deckId) && R.version === db.scheduleVersion()) return renderSession(el);

  const data = await loadAll();
  if (!el.isConnected) return;                 // you already moved to another screen
  const typing = data.settings.reviewTyping;

  // From Today (or a deck's page): its decks, or one of Custom study's sessions.
  if (launch) {
    const allIds = data.decks.map(d => d.id);
    const chosen = launch.deckIds.filter(id => allIds.includes(id));
    const c = countFor(data, chosen.length ? chosen : allIds);
    const custom = launch.kind ? customQueue(launch.kind, data, c.cards, launch.days) : null;
    if (custom && !custom.queue.length) {      // e.g. exam prep when every card was seen in the last 3 days
      toast(launch.kind === 'prep' ? 'You have seen every card in this deck in the last 3 days' : 'Nothing to review there');
      location.replace(launch.kind === 'prep' && launch.deckId ? `#/deck/${encodeURIComponent(launch.deckId)}` : '#/today');
      return;
    }
    return start(el, data, c.cards, typing, launch.deckId, custom, scopeKey(launch.deckIds, launch.kind, launch.days));
  }
  // No deck and nothing started: the home screen is Today.
  if (!deckId) { location.replace('#/today'); return; }

  // From a deck's page (or a reload): straight into its cards (no setup screen).
  const c = countFor(data, [deckId]);
  if (c.total) return start(el, data, c.cards, typing, deckId, null, scopeKey([deckId]));
  const name = data.decks.find(d => d.id === deckId)?.name || 'This deck';
  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">REVIEW</span><h1>${esc(name)}</h1></div></div>
    <div class="empty"><b>All caught up.</b><br>Nothing is due in this deck right now. ${nextDueText(data, c.cards)}</div>
    <div class="res-actions">
      <a class="btn primary" href="#/today">Back to Today</a>
      <a class="btn ghost" href="#/deck/${esc(deckId)}">Open deck</a>
    </div>`;
}

// ---------- 2. session ----------
// custom: optional { queue, waiting, label } for a Custom study session instead of today's cards.
function start(el, data, cards, typing, deckId, custom = null, scope = '') {
  // Decks with an exam: the final pass brings cards forward, and the reviews that add most on exam day come first.
  const now = Date.now();
  // The plan (caps) is Today's, made for the whole exam; only the order is this session's.
  const exam = custom ? null : examSchedule(data.decks, cards, data.statesById, now, (card, st, examStart) =>
    examGain(st, examStart, now, deckSchedulerOptions(data.settings, effectiveDeck(data.decks, card.deckId))), data.exam.caps);
  const { queue, waiting } = custom || buildQueue(cards, data.statesById, data.newLeft, now, data.reviewLeft, exam);
  R = {
    active: true, day: dayStart(), deckId, scope, typing, custom: custom?.label || null,
    settings: data.settings,                      // retention, steps, max interval, fuzz: per deck via schedFor
    // Reviews already due on each day, to even them out (and keep easy days light): balance.js.
    balance: { load: loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays },
    leech: { threshold: data.settings.leechThreshold, action: data.settings.leechAction },
    decks: data.decks,
    deckNames: new Map(data.decks.map(d => [d.id, deckPath(data.decks, d.id)])),
    // Each deck with the settings it inherits from the decks it's inside (study options, exam, read aloud).
    effective: new Map(data.decks.map(d => [d.id, effectiveDeck(data.decks, d.id)])),
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

// The scheduling options for a card: its deck's settings (or the overall ones), its deck's exam limits,
// and evening out the reviews.
const schedFor = (card, now = Date.now()) => {
  const deck = deckOf(card);
  return { ...examOptions(deckSchedulerOptions(R.settings, deck), deck, now), balance: R.balance };
};

const deckOf = card => R.effective.get(card.deckId);
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
  renderSession(el, true);
}

// Cards left, split like Anki: new · learning · review. The current card's kind is underlined.
function countsHTML() {
  const all = [...R.queue, ...R.waiting];
  const n = k => all.filter(x => x.kind === k).length + (R.current?.kind === k ? 1 : 0);
  const cls = k => (R.current?.kind === k ? ' now' : '');
  // The word in front of each number (New, Lrn, Due) is drawn by the CSS from data-label, so the
  // text inside each span stays just the number.
  return `<span class="c-new${cls('new')}" data-label="New">${n('new')}</span>
    <span class="c-learn${cls('learn')}" data-label="Lrn">${n('learn')}</span>
    <span class="c-rev${cls('review')}" data-label="Due">${n('review')}</span>`;
}

// The face that is turned away is hidden from screen readers and can't be focused or tabbed to (inert).
const HIDDEN = 'aria-hidden="true" inert';

// Draw the card on screen. Both faces are in the page from the start: the front, and the back (the
// question again, small, with the answer), so flip() only has to turn the card over.
//   enter: a new card is coming in, so it rises into place
function renderSession(el, enter = false) {
  if (!el.isConnected) return;       // you already moved to another screen: don't draw (or hide the tab bar) there
  R.el = el;
  if (!R.current) return finish(el);
  const { card } = R.current;
  // Formatting (bold, lists…) is shown on the card; typed answers are checked against the plain text.
  const typeThis = R.typing && canType(plainText(card.back));
  const size = plainText(card.front).length > 120 ? ' xlong' : plainText(card.front).length > 50 ? ' long' : '';
  const deckLabel = `<span class="flash-deck">${esc(R.deckNames.get(card.deckId) || '')}${R.custom ? ` · ${esc(R.custom)}` : ''}</span>`;
  const front = `${imgHTML(card.frontImage)}${formatHTML(card.front)}`;

  el.innerHTML = `
    <div class="rv-head">
      <div class="rv-counts mono" role="group" aria-label="Cards left: new, learning, due">${countsHTML()}</div>
      <button class="link" type="button" id="undoBtn" ${R.undo.length ? '' : 'disabled'}>Undo</button>
      ${canSpeak() ? `<button class="link more" type="button" id="speakBtn" aria-label="Read aloud" title="Read aloud (R)" aria-keyshortcuts="R">${SPEAKER_ICON}</button>` : ''}
      <button class="link more" type="button" id="moreBtn" aria-label="Card actions: edit, flag, suspend, bury and more">${icon('more')}</button>
      <button class="link" type="button" id="endBtn">End</button>
    </div>
    <article class="flash rv-card${R.flipped ? ' flipped' : ''}${enter ? ' enter' : ''}" id="flash" ${R.flipped || typeThis ? '' : 'tabindex="0"'}>
      <div class="rv-turn">
        <div class="rv-face rv-front" ${R.flipped ? HIDDEN : ''}>
          ${deckLabel}
          <div class="flash-front${size}">${front}</div>
          ${typeThis ? '' : `<p class="flash-hint">${MOUSE.matches ? 'Click or press Space to show the answer' : 'Tap to show the answer'}</p>`}
        </div>
        <div class="rv-face rv-back" tabindex="-1" ${R.flipped ? '' : HIDDEN}>
          ${deckLabel}
          <div class="flash-recap">${front}</div>
          <div class="flash-ans">
            <div class="rv-typed">${R.typed ? typedResultHTML() : ''}</div>
            <div class="flash-back">${imgHTML(card.backImage)}${formatHTML(card.back)}</div>
          </div>
        </div>
      </div>
    </article>
    ${typeThis && !R.flipped ? `
      <form class="typeform" id="typeForm" autocomplete="off">
        <input id="typeIn" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the answer" aria-label="Your answer">
        <button class="btn primary" type="submit">Check</button>
      </form>` : ''}
    ${R.typing && !typeThis && !R.flipped ? '<p class="note center" id="longNote">Long answer: say it in your head, then flip.</p>' : ''}
    <div class="ratebar" id="ratebar">${R.flipped ? rateButtonsHTML() : showButtonHTML(typeThis)}</div>
    <p class="key-line" aria-hidden="true">Space to flip · 1–4 rate</p>`;
  setFocusMode(true);               // only once the round has drawn, so a failed draw can't leave the tabs hidden

  $('undoBtn').addEventListener('click', () => undo(el));
  $('endBtn').addEventListener('click', () => finish(el));
  $('moreBtn').addEventListener('click', () => openCardMenu());
  $('speakBtn')?.addEventListener('click', () => readAloud());
  autoSpeak(card);
  wireRatebar(el);
  $('flash').addEventListener('click', () => { if (!R.flipped && !typeThis) flip(el); });
  $('typeForm')?.addEventListener('submit', e => { e.preventDefault(); submitTyped(el); });
  // Keep focus on the card (the page was just redrawn, so it would drop to the page itself).
  if (typeThis && !R.flipped) $('typeIn').focus();
  else if (R.flipped) $('flash').querySelector('.rv-back').focus({ preventScroll: true });
  else $('flash').focus({ preventScroll: true });
  publishLive();
}

const showButtonHTML = typeThis =>
  `<button class="btn ${typeThis ? 'ghost' : 'primary'} wide" type="button" id="showBtn">${typeThis ? "I don't know" : 'Show answer'}${typeThis ? '' : ' <kbd class="key-hint" aria-hidden="true">Space</kbd>'}</button>`;

// The buttons under the card: Show answer, or the four ratings.
function wireRatebar(el) {
  $('showBtn')?.addEventListener('click', () => flip(el));
  $('ratebar').querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => answer(el, +b.dataset.rate)));
}

// Decks set to read aloud: the front when a card appears, the back when it's flipped (once each).
function autoSpeak(card) {
  const key = `${card.id}:${R.flipped}`;
  if (deckOf(card)?.ttsAuto && R.spoken !== key) { R.spoken = key; readAloud(); }
}

// Tell Today whether a session is in progress, so it can offer to resume it.
function publishLive() {
  live.resume = R?.active
    ? { left: R.queue.length + R.waiting.length + (R.current ? 1 : 0), deckId: R.deckId, scope: R.scope, day: R.day, version: R.version }
    : null;
}

function rateButtonsHTML() {
  const ivl = previewIntervals(R.statesById.get(R.current.card.id), schedFor(R.current.card));
  return `<div class="rates">${RATINGS.map(({ rating, label, key }) => `
    <button type="button" class="rate r${rating}${R.suggest === rating ? ' suggested' : ''}" data-rate="${rating}" aria-keyshortcuts="${key}">
      <b>${label}</b><span class="mono">${formatInterval(ivl[rating])}</span><kbd class="key-hint" aria-hidden="true">${key}</kbd></button>`).join('')}</div>`;
}

function typedResultHTML() {
  const { value, result } = R.typed;
  if (result.correct) return `<p class="typed ok">${icon('check')} ${result.exact ? 'Correct' : 'Correct, with a small typo'}${result.exact ? '' : `: <span class="given">${esc(value)}</span>`}</p>`;
  return `<p class="typed no">${icon('x')} ${value.trim() ? `Not quite. You typed <span class="given">${esc(value)}</span>` : 'No answer'}</p>`;
}

// Turn the card over. Only the parts that change are touched (the card stays in the page, so the CSS
// turn can play), and nothing waits for it: 1–4 work the moment this returns.
function flip(el) {
  if (R.flipped) return;
  R.flipped = true;
  R.answerMs = Date.now() - R.shownAt;
  // "I don't know" while typing counts as a miss.
  if (R.typing && canType(plainText(R.current.card.back)) && !R.typed) R.suggest = Rating.Again;
  const flash = $('flash');
  flash.querySelector('.rv-typed').innerHTML = R.typed ? typedResultHTML() : '';
  flash.classList.add('flipped');
  ['role', 'tabindex', 'aria-label'].forEach(a => flash.removeAttribute(a));
  const front = flash.querySelector('.rv-front'), back = flash.querySelector('.rv-back');
  front.setAttribute('aria-hidden', 'true'); front.inert = true;
  back.removeAttribute('aria-hidden'); back.inert = false;
  $('typeForm')?.remove();
  $('longNote')?.remove();
  $('ratebar').innerHTML = rateButtonsHTML();
  wireRatebar(el);
  // The button that was pressed is gone, so move focus to the answer: screen readers read it out, and the
  // keyboard stays where it was (1–4 and Space still rate).
  back.focus({ preventScroll: true });
  autoSpeak(R.current.card);
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
    if (next.lapses > (prev?.lapses || 0) && isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(id), R.leech.threshold)) {
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
    renderSession(el, true);
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
  publishLive();
  if (el.isConnected) setFocusMode(false);      // a late finish must not end focus mode on another screen (e.g. a Play round)
  const { reviewed, again, spent } = R.stats;
  // Reviews due by the end of tomorrow in the decks you just studied.
  const decks = new Set(R.deckIds);
  const cards = (await db.getAll('cards')).filter(c => decks.has(c.deckId));
  const ids = new Set(cards.map(c => c.id));
  const tomorrowEnd = dayEnd(Date.now(), 1);
  const dueTomorrow = (await db.getAll('cardStates')).filter(s => ids.has(s.cardId) && s.state !== NEW && s.due <= tomorrowEnd).length;
  const streak = await loadStreak();
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
    <section class="finish-next" aria-label="What's next">
      <p class="streak ${streak.studiedToday ? 'kept' : ''}">${icon('flame')}<b class="mono">${streak.days}</b> day streak
        <span>${streak.studiedToday ? 'Kept for today' : streak.days ? 'Study today to keep it' : 'Study today to start one'}</span></p>
      <p class="fn-line">${icon('calendar')} <span>${dueTomorrow ? `<b>${plural(dueTomorrow, 'card')}</b> due tomorrow.` : 'Nothing due tomorrow.'}</span></p>
      <p class="fn-line">${icon('bolt')} <span>Lock it in with a quick Play round. Right answers on due cards count toward your schedule.</span></p>
      <a class="btn ghost" href="#/play">Play a round</a>
    </section>
    <div class="res-actions">
      <button class="btn primary" type="button" id="againBtn">Back to Today</button>
      <a class="btn ghost" href="#/decks">Decks</a>
      ${R.undo.length ? '<button class="btn ghost" type="button" id="undoLast">Undo last</button>' : ''}
    </div>`;
  $('againBtn').addEventListener('click', () => { R = null; publishLive(); location.hash = '#/today'; });
  $('undoLast')?.addEventListener('click', () => undo(el));
}

// ---------- keyboard ----------
// Space or Enter flips. 1–4 rate. After flipping, Space or Enter picks the suggested button (Good unless typing said otherwise).
// Like Anki: E edits, I shows card info, - buries, @ suspends, R reads the card aloud.
document.addEventListener('keydown', e => {
  if (!R?.active || !document.getElementById('flash') || document.getElementById('sheet')?.open) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const inInput = e.target.matches('input, textarea, select');
  const onButton = onControl(e, 'flash');   // Enter or Space on a focused button should press that button, not flip or rate
  if (!inInput) {
    const k = e.key.toLowerCase();
    if (k === 'e' || k === 'i') { e.preventDefault(); openCardMenu(k === 'i'); return; }
    if (e.key === '-' || e.key === '@') { e.preventDefault(); quick(e.key === '-' ? 'bury' : 'suspend'); return; }
    if (k === 'r') { e.preventDefault(); readAloud(); return; }
  }
  if (!R.flipped) {
    if (!onButton && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(R.el); }
    return;
  }
  if (!inInput && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); answer(R.el, +e.key); }
  else if (!onButton && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); answer(R.el, R.suggest || Rating.Good); }
});
