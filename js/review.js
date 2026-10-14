// Review: the spaced-repetition session. (Choosing what to study happens on Today: js/today.js.)
//   1. Starting: from Today (all decks, one deck, or Custom study) or straight from a deck's page.
//   2. Session: see the front, flip (tap or Space) or type the answer, rate Again / Hard / Good / Easy.
//   3. Finish: cards reviewed, accuracy, time spent, streak and what's due tomorrow.

import * as db from './db.js';
import { dayStart, dayEnd } from './days.js';
import { buildQueue, takeNext, addWaiting, formatInterval, NEW, LEARNING, RELEARNING } from './queue.js';
import { RATINGS, Rating, previewIntervals, rate, examGain } from './srs.js';
import { canType, checkAnswer } from './match.js';
import { diffAgainstBack, diffHTML, hasMarks } from './answer-diff.js';
import { formatHTML, plainText, shortDeckPath, answerSize } from './format.js';
import { imgHTML } from './media.js';
import { renderCloze, hasBlank, clozeFull } from './cloze.js';
import { hasMasks, occlusionHTML, occLabel, occSpeech } from './occlusion.js';
import { noteSession } from './install.js';
import { speak, stopSpeaking, canSpeak } from './speech.js';
import { deckSchedulerOptions } from './sched-settings.js';
import { loadByDay } from './balance.js';
import { examOptions, examSchedule } from './exam.js';
import { loadAll, countFor, withSubdecks, nextDueText, customQueue, takeLaunch, loadStreak, scopeKey, live } from './study-data.js';
import { isHidden, isNewLeechCounted, markLeech, buryUntil } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { deckPath, effectiveDeck } from './deck-tree.js';
import { drawSidebar } from './sidebar.js';
import { $, esc, plural, toast, onControl, setFocusMode, icon, SPEAKER_ICON } from './ui.js';
import * as fx from './fx.js';

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
  const { queue, waiting } = custom || buildQueue(cards, data.statesById, data.newLeft, now, data.reviewLeft, exam, data.answered);
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
// Is this card answered by typing? Typing must be on and the answer short; a box of an image-occlusion picture needs a
// label to type (without one you flip, saying it in your head).
const typesAnswer = card => {
  if (!R.typing) return false;
  const label = hasMasks(card) ? occLabel(card.occlusion.masks, card.occlusion.n) : null;
  return label !== null ? !!label && canType(label) : canType(plainText(card.back));
};
// Read the side showing (the back once flipped) in the deck's language.
function readAloud() {
  if (!R?.current) return;
  const { card } = R.current;
  // A cloze card says "blank" for the hidden part, and the whole sentence once flipped. A picture says which part is hidden.
  const text = hasMasks(card) ? occSpeech(card, R.flipped) : hasBlank(card) ? (R.flipped ? clozeFull(card.noteText) : card.front.replace(/\[[^\]]*\]/, 'blank')) : (R.flipped ? card.back : card.front);
  speak(text, deckOf(card)?.ttsLang || '');
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
  // The word in front of each number (New, Learn, Due) is drawn by the CSS from data-label, so the
  // text inside each span stays just the number.
  return `<span class="c-new${cls('new')}" data-label="New">${n('new')}</span>
    <span class="c-learn${cls('learn')}" data-label="Learn" data-short="Lrn">${n('learn')}</span>
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
  const typeThis = typesAnswer(card);
  const occ = hasMasks(card);
  const size = occ ? '' : plainText(card.front).length > 120 ? ' xlong' : plainText(card.front).length > 50 ? ' long' : '';
  const fullPath = R.deckNames.get(card.deckId) || '';
  const deckLabel = `<span class="flash-deck" title="${esc(fullPath)}">${esc(shortDeckPath(fullPath))}${R.custom ? ` · ${esc(R.custom)}` : ''}</span>`;
  // A cloze card shows its note's text with the blank hidden; its back is the same text with the answer marked, and
  // the note's Extra under it. Everything goes through renderCloze/formatHTML, so nothing in the text can inject HTML.
  const cloze = hasBlank(card);
  // An image-occlusion card shows its picture with every box hidden and the highlighted one to name; the back uncovers that
  // box, with its label, and a button shows the whole picture. (occlusion.js builds the HTML, escaping the text.)
  const label = occ ? occLabel(card.occlusion.masks, card.occlusion.n) : '';
  const backSize = occ ? '' : answerSize(plainText(cloze ? card.noteText : card.back));          // a long answer is smaller and left-aligned
  const front = occ
    ? `${card.occlusion.header ? `<p class="occ-head">${esc(card.occlusion.header)}</p>` : ''}${occlusionHTML(card, 'front')}`
    : `${imgHTML(card.frontImage)}${cloze ? renderCloze(card.noteText, card.cloze, 'front') : formatHTML(card.front)}`;
  const answerHTML = occ
    ? `${occlusionHTML(card, 'back')}<p class="occ-label${label ? '' : ' none'}">${label ? esc(label) : 'No label'}</p>
       <button type="button" class="occ-peek" aria-pressed="false" aria-keyshortcuts="M">Show whole picture <kbd class="key-hint" aria-hidden="true">M</kbd></button>`
    : cloze
      ? `${imgHTML(card.backImage)}${renderCloze(card.noteText, card.cloze, 'back')}`
      : `${imgHTML(card.backImage)}${formatHTML(card.back)}`;
  if (occ) import('./occlusion-view.js').catch(err => console.error(err));      // the zoom viewer, loaded the first time a picture card shows

  const head = `
    <div class="rv-head">
      <div class="rv-counts mono" role="group" aria-label="Cards left: new, learning, due">${countsHTML()}</div>
      <button class="link" type="button" id="undoBtn" aria-label="Undo" title="Undo the last answer" ${R.undo.length ? '' : 'disabled'}>${icon('undo')}</button>
      ${canSpeak() ? `<button class="link more" type="button" id="speakBtn" aria-label="Read aloud" title="Read aloud (R)" aria-keyshortcuts="R">${SPEAKER_ICON}</button>` : ''}
      <button class="link more" type="button" id="moreBtn" aria-label="Card actions: edit, flag, suspend, bury and more">${icon('more')}</button>
      <button class="link" type="button" id="endBtn">End</button>
    </div>`;
  const body = `
    <article class="flash rv-card${R.flipped ? ' flipped' : ''}${enter ? ' enter' : ''}" id="flash" ${R.flipped || typeThis ? '' : 'tabindex="0"'}>
      <div class="rv-turn">
        <div class="rv-face rv-front" ${R.flipped ? HIDDEN : ''}>
          ${deckLabel}
          <div class="flash-front${size}">${front}</div>
          ${typeThis ? '' : `<p class="flash-hint">${MOUSE.matches ? 'Click or press Space to show the answer' : 'Tap to show the answer'}</p>`}
        </div>
        <div class="rv-face rv-back" tabindex="-1" ${R.flipped ? '' : HIDDEN}>
          ${deckLabel}
          ${cloze || occ ? '' : `<div class="flash-recap${backSize ? ' small' : ''}">${front}</div>`}
          <div class="flash-ans">
            <div class="rv-typed">${R.typed ? typedResultHTML() : ''}</div>
            <div class="flash-back${cloze ? ' cloze-full' : ''}${occ ? ' occ-back' : ''}${backSize}">${answerHTML}</div>
            ${(cloze || occ) && card.noteExtra ? `<p class="flash-extra">${formatHTML(card.noteExtra)}</p>` : ''}
          </div>
        </div>
      </div>
    </article>
    ${typeThis && !R.flipped ? `
      <form class="typeform" id="typeForm" autocomplete="off">
        <input id="typeIn" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the answer" aria-label="Your answer">
        <button class="btn primary" type="submit">Check</button>
      </form>` : ''}
    ${R.typing && !typeThis && !R.flipped ? `<p class="note center" id="longNote">${occ && !label ? 'No label on this box: say it in your head, then flip.' : 'Long answer: say it in your head, then flip.'}</p>` : ''}
    <div class="ratebar" id="ratebar">${R.flipped ? rateButtonsHTML() : showButtonHTML(typeThis)}</div>
    <p class="key-line" aria-hidden="true">Space to flip · 1–4 rate</p>`;
  drawSessionPage(el, head, body);
  setFocusMode(true);               // only once the round has drawn, so a failed draw can't leave the tabs hidden

  $('undoBtn').addEventListener('click', () => undo(el));
  $('endBtn').addEventListener('click', () => finish(el));
  $('moreBtn').addEventListener('click', () => openCardMenu('actions'));
  $('speakBtn')?.addEventListener('click', () => readAloud());
  autoSpeak(card);
  wireRatebar(el);
  $('flash').addEventListener('click', e => {
    const zoom = e.target.closest('.occ-zoom');
    if (zoom) { import('./occlusion-view.js').then(v => v.zoomFrom(zoom)); return; }      // (once the viewer is loaded it handles this click first)
    if (e.target.closest('.occ-peek')) return;
    if (!R.flipped && !typeThis) flip(el);
  });
  $('flash').querySelector('.occ-peek')?.addEventListener('click', e => togglePeek(e.currentTarget));
  $('typeForm')?.addEventListener('submit', e => { e.preventDefault(); submitTyped(el); });
  // Keep focus on the card (the page was just redrawn, so it would drop to the page itself).
  if (typeThis && !R.flipped) $('typeIn').focus();
  else if (R.flipped) $('flash').querySelector('.rv-back').focus({ preventScroll: true });
  else $('flash').focus({ preventScroll: true });
  publishLive();
}

// Draws the header and the card, around the progress bar. The bar is NOT redrawn with them: it stays in the page
// from card to card, so its fill slides to the new value instead of starting again from empty.
function drawSessionPage(el, head, body) {
  const bar = el.querySelector(':scope > .rv-prog');
  const left = R.queue.length + R.waiting.length + (R.current ? 1 : 0);   // relearning cards waiting for their turn count too
  const done = R.stats.reviewed, total = done + left;
  if (!bar) el.innerHTML = `${head}<div class="rv-prog" id="rvProg" role="progressbar" aria-label="Session progress" aria-valuemin="0"><i></i></div>${body}`;
  else {
    [...el.children].forEach(c => { if (c !== bar) c.remove(); });
    bar.insertAdjacentHTML('beforebegin', head);
    bar.insertAdjacentHTML('afterend', body);
  }
  const prog = el.querySelector(':scope > .rv-prog');
  prog.setAttribute('aria-valuemax', total);
  prog.setAttribute('aria-valuenow', done);
  prog.setAttribute('aria-valuetext', `${done} of ${total} cards done`);
  prog.firstElementChild.style.width = `${total ? (done / total * 100).toFixed(1) : 0}%`;
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
  const { value, result, target } = R.typed;
  // A wrong or inexact answer shows which letters differ (the diff has the "You typed" row, so the line doesn't repeat it).
  let diff = !result.exact && value.trim() ? diffAgainstBack(value, target) : null;
  if (diff && result.correct && !hasMarks(diff)) diff = null;
  const shown = diff ? diffHTML(diff) : '';
  if (result.correct) return `<p class="typed ok">${icon('check')} ${result.exact ? 'Correct' : 'Correct, with a small typo'}${result.exact || diff ? '' : `: <span class="given">${esc(value)}</span>`}</p>${shown}`;
  return `<p class="typed no">${icon('x')} ${value.trim() ? `Not quite.${diff ? '' : ` You typed <span class="given">${esc(value)}</span>`}` : 'No answer'}</p>${shown}`;
}

// Turn the card over. Only the parts that change are touched (the card stays in the page, so the CSS
// turn can play), and nothing waits for it: 1–4 work the moment this returns.
function flip(el) {
  if (R.flipped) return;
  R.flipped = true;
  R.answerMs = Date.now() - R.shownAt;
  // "I don't know" while typing counts as a miss.
  if (typesAnswer(R.current.card) && !R.typed) R.suggest = Rating.Again;
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

// "Show whole picture": uncovers every box of the picture on the back (the CSS does it, from the figure's .peek class).
function togglePeek(button) {
  const on = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(on));
  button.closest('.rv-back')?.querySelector('.occ')?.classList.toggle('peek', on);
}

function submitTyped(el) {
  const value = $('typeIn').value;
  if (!value.trim()) { $('typeIn').focus(); return; }
  const target = plainText(R.current.card.back);
  const result = checkAnswer(value, target);
  R.typed = { value, result, target };
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
    const saving = db.saveReview(next, log);
    // Rating feedback plays alongside the save and nothing waits for it: the next card is drawn the moment the save is done.
    fx.rated(rating, $('flash'), el.querySelector(`.rate[data-rate="${rating}"]`));
    const logId = await saving;
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
  // Undo brings these cards back, so they must carry the edit too (or Undo would show the old text, and editing from it would save it again).
  // cardBefore is the card as it was before it became a leech: it keeps that, but gets the new content.
  R.undo = R.undo.map(u => {
    if (u.item.card.id !== card.id) return u;
    const before = u.cardBefore && { ...card, tags: (card.tags || []).filter(t => (u.cardBefore.tags || []).includes(t) || t !== 'leech'), suspended: u.cardBefore.suspended, buriedUntil: u.cardBefore.buriedUntil };
    return { ...u, item: { ...u.item, card }, cardBefore: before || u.cardBefore };
  });
}

// A cloze note was edited: swap in the new version of each of its cards the session holds, and take out the ones
// that no longer exist (a removed blank), so they can't be rated.
async function refreshNoteInSession(noteId) {
  const sibs = (await db.getAll('cards')).filter(c => c.noteId === noteId);
  const alive = new Set(sibs.map(c => c.id));
  const held = [...R.queue, ...R.waiting, ...R.undo.map(u => u.item)].filter(q => q.card.noteId === noteId);
  for (const q of held) if (!alive.has(q.card.id)) dropFromSession(q.card.id);
  for (const c of sibs) replaceInSession(c);
}

// The ⋯ button opens a short sheet of card actions (Edit, Flag, Bury, Suspend, More). E opens the editor straight
// away and I the full panel with the card's info (browse.js openCardPanel; More in the short sheet opens that panel too).
// Whatever you change, the sheet closes and you are back at the same card.
const LEAVES = ['suspend', 'bury', 'delete', 'reset', 'due'];
const BACK_TO_CARD = [...LEAVES, 'edit', 'flag', 'move', 'unsuspend', 'unbury'];
async function openCardMenu(mode = 'actions') {
  if (!R?.current) return;
  // The saved copy of the card, in case it was changed since it was drawn (the same way Play does it).
  const id = R.current.card.id;
  const card = (await db.get('cards', id)) || R.current.card;
  if (R.current?.card.id !== id) return;                 // the card moved on while that loaded
  openCardPanel(card, {
    decks: R.decks, statesById: R.statesById, mode: mode === 'info' ? 'full' : mode, showInfo: mode === 'info', closeAfter: BACK_TO_CARD,
    onAction: async (act, fresh) => {
      R.version = db.scheduleVersion();
      // Editing a cloze note changes all its cards (and may delete some): bring the session in line first.
      if (act === 'edit' && card.noteId) await refreshNoteInSession(card.noteId);
      if (!R?.current) return;
      if (LEAVES.includes(act) || !fresh) { dropFromSession(R.current.card.id); nextCard(R.el); }
      else {
        // Redrawing the card must not wipe an answer half typed in the box.
        const typed = $('typeIn')?.value;
        replaceInSession(fresh); renderSession(R.el);
        if (typed && $('typeIn')) $('typeIn').value = typed;
      }
    }
  });
}
// When the sheet closes, focus goes back onto the card (the button it was opened from was redrawn).
document.getElementById('sheet')?.addEventListener('close', () => {
  const sheet = document.getElementById('sheet');
  if (sheet.open || !R?.active || !location.hash.startsWith('#/review')) return;
  const card = document.getElementById('flash');
  (card?.querySelector('.rv-back:not([inert])') || card)?.focus({ preventScroll: true });
});

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
  if (el.isConnected) drawSidebar();            // the sidebar's counts and ring, now the round is done
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
  if (reviewed) noteSession();            // a finished session: Today may now offer to install the app (install.js)
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
  fx.finished(el, { complete: !R.current, reviewed });
}

// ---------- keyboard ----------
// Space or Enter flips. 1–4 rate. After flipping, Space or Enter picks the suggested button (Good unless typing said otherwise).
// Like Anki: E edits, I shows card info, - buries, @ suspends, R reads the card aloud.
document.addEventListener('keydown', e => {
  if (!R?.active || !document.getElementById('flash') || document.getElementById('sheet')?.open) return;
  if (document.querySelector('dialog.occ-view[open], dialog.occ-ed[open]')) return;      // the zoom viewer and the box editor have their own keys
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const inInput = e.target.matches('input, textarea, select');
  const onButton = onControl(e, 'flash');   // Enter or Space on a focused button should press that button, not flip or rate
  if (!inInput) {
    const k = e.key.toLowerCase();
    if (k === 'e' || k === 'i') { e.preventDefault(); openCardMenu(k === 'i' ? 'info' : 'edit'); return; }
    if (e.key === '-' || e.key === '@') { e.preventDefault(); quick(e.key === '-' ? 'bury' : 'suspend'); return; }
    if (k === 'r') { e.preventDefault(); readAloud(); return; }
    // Image occlusion: Z zooms the picture, M shows the whole picture (on the back).
    const face = $('flash').querySelector('.rv-face:not([inert])');
    if (k === 'z' && face?.querySelector('.occ-zoom')) {
      e.preventDefault();
      // Opened with the key: focus goes back to the card (not the Zoom button), so Space still flips it afterwards.
      const back = R.flipped ? $('flash').querySelector('.rv-back') : $('flash');
      import('./occlusion-view.js').then(v => v.zoomFrom(face.querySelector('.occ-zoom'), back));
      return;
    }
    if (k === 'm' && face?.querySelector('.occ-peek')) { e.preventDefault(); togglePeek(face.querySelector('.occ-peek')); return; }
  }
  if (!R.flipped) {
    if (!onButton && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(R.el); }
    return;
  }
  if (!inInput && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); answer(R.el, +e.key); }
  else if (!onButton && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); answer(R.el, R.suggest || Rating.Good); }
});
