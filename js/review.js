// Review: the spaced-repetition session. (Choosing what to study happens on Today: js/today.js.)
//   1. Starting: from Today (all decks, one deck, or Custom study) or straight from a deck's page.
//   2. Session: see the front, flip (tap or Space) or type the answer, rate Again / Hard / Good / Easy.
//   3. Finish: cards reviewed, accuracy, time spent, streak and what's due tomorrow.

import * as db from './db.js';
import { dayStart, dayEnd } from './days.js';
import { buildQueue, takeNext, addWaiting, formatInterval, formatIntervalLong, NEW, LEARNING, RELEARNING } from './queue.js';
import { singleKeysOn, stripKeys } from './shortcuts.js';
import { RATINGS, Rating, previewIntervals, rate, examGain, prepare7 } from './srs.js';
import { checkTyped } from './match.js';
import { typeFacts, answerMode } from './type-in.js';
import { withAccepted, canAccept, addAccepted } from './accept.js';
import { diffAgainstBack, diffHTML, hasMarks } from './answer-diff.js';
import { formatHTML, mathHTML, answerText, answerTargets, shortDeckPath, answerSize } from './format.js';
import { cardMediaHTML, warmCards } from './media.js';
import { noteFieldsHTML } from './note-fields.js';
import { playSounds, stopSound, hasSounds, autoplayBlocked } from './audio.js';
import { renderCloze, hasBlank, clozeFull } from './cloze.js';
import { hasMasks, occlusionHTML, occLabel, occSpeech } from './occlusion.js';
import { noteSession } from './install.js';
import { speak, stopSpeaking, canSpeak, stepsSpeech, elementsSpeech } from './speech.js';
import { parseStructured, suggestRating } from './steps.js';
import { maskMath } from './math.js';
import { mountScratch } from './scratchpad.js';
import { deckSchedulerOptions, personalW20, usesFsrs7 } from './sched-settings.js';
import { loadByDay } from './balance.js';
import { examOptions, examSchedule } from './exam.js';
import { loadAll, countFor, withSubdecks, nextDueText, customQueue, takeLaunch, loadStreak, scopeKey, live } from './study-data.js';
import { isHidden, isNewLeechCounted, markLeech, buryUntil } from './browse-logic.js';
import { openCardPanel } from './browse.js';
import { deckPath, effectiveDeck } from './deck-tree.js';
import { drawSidebar } from './sidebar.js';
import { refreshBadge } from './badge.js';
import { $, esc, plural, toast, onControl, keepFocusOnPress, setFocusMode, openSheet, closeSheet, icon, SPEAKER_ICON, streakHTML, foldOpen, saveFold } from './ui.js';
import * as fx from './fx.js';
import { go as navGo, replace as navReplace, holdBack, releaseBack } from './nav.js';

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
    const custom = launch.kind ? customQueue(launch.kind, data, c.cards, launch.days, launch.cardIds, { includeSuspended: launch.includeSuspended, spread: launch.spread, label: launch.label }) : null;
    if (custom && !custom.queue.length) {      // e.g. exam prep when every card was seen in the last 3 days
      toast(launch.kind === 'prep' ? 'You have seen every card in this deck in the last 3 days' : 'Nothing to review there');
      navReplace(launch.kind === 'prep' && launch.deckId ? `#/deck/${encodeURIComponent(launch.deckId)}` : '#/today');
      return;
    }
    return start(el, data, c.cards, typing, launch.deckId, custom, scopeKey(launch.deckIds, launch.kind, launch.days, launch.cardIds));
  }
  // No deck and nothing started: the home screen is Today.
  if (!deckId) { navReplace('#/today'); return; }

  // From a deck's page (or a reload): straight into its cards (no setup screen).
  const c = countFor(data, [deckId]);
  if (c.total) return start(el, data, c.cards, typing, deckId, null, scopeKey([deckId]));
  const deck = data.decks.find(d => d.id === deckId);
  if (!deck) {
    el.innerHTML = `
      <div class="screen-head"><div><h1>Deck not found</h1></div></div>
      <div class="empty"><b>That deck isn’t here any more.</b><br>It may have been deleted, or the link is wrong.</div>
      <div class="res-actions">
        <a class="btn primary" href="#/decks">Open Decks</a>
        <a class="btn ghost" href="#/today">Back to Today</a>
      </div>`;
    return;
  }
  // A deck with no cards at all (suspended and buried ones count) is not "caught up": it has nothing to study yet.
  const inDeck = withSubdecks(data, [deckId]);
  const anyCards = [...data.deckOf.values()].some(d => inDeck.has(d));
  if (!anyCards) {
    el.innerHTML = `
      <div class="screen-head"><div><h1>${esc(deck.name)}</h1></div></div>
      <div class="empty"><b>No cards yet.</b><br>Add some cards to start studying this deck.</div>
      <div class="res-actions">
        <a class="btn primary" href="#/import/${encodeURIComponent(deckId)}">+ Add cards</a>
        <a class="btn ghost" href="#/today">Back to Today</a>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="screen-head"><div><h1>${esc(deck.name)}</h1></div></div>
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
    examGain(st, examStart, now, deckSchedulerOptions(data.settings, effectiveDeck(data.decks, card.deckId))), data.exam.caps, undefined, personalW20(data.settings));
  const { queue, waiting } = custom || buildQueue(cards, data.statesById, data.newLeft, now, data.reviewLeft, exam, data.answered, data.rescue);
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
    gloss: hasTerms(data.settings),             // does the glossary have terms to underline? (glossary-view.js is only loaded then)
    shownAt: 0, answerMs: 0, busy: false,
    stats: { reviewed: 0, again: 0, spent: 0, started: Date.now() },
    undo: [],
    answered: new Set(), leeches: [],      // cards answered and leeches caught this session (for the finish screen), kept in step with Undo
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
// A step-by-step card: its back has "Step 1: ... Step 2: ..." lines (steps.js). An elements card has "Element 1: ..." lines and
// is shown the same way (its steps are the elements, kind 'elements', no final answer). → { kind, intro, steps, final } or null.
const stepsOf = card => (hasBlank(card) || hasMasks(card) ? null : parseStructured(card.back, { mask: maskMath }));
const stepsLeft = () => { const sp = R?.flipped && R.current && stepsOf(R.current.card); return sp ? sp.steps.length - R.stepShown : 0; };
// How is this card asked? The card's own setting (typeIn), else its deck's, else the Today switch (R.typing): see type-in.js.
// A step or elements card, a box with no label, and a back with nothing to type are flipped; so is an answer too long to type.
const modeOf = card => answerMode(card, typeFacts(card), !!deckOf(card)?.typeAnswers, R.typing);
const typesAnswer = card => modeOf(card).type;
const FLIP_NOTE = { structured: 'Elements card: recall them in your head, then flip.', nolabel: 'No label on this box: say it in your head, then flip.', long: 'Long answer: say it in your head, then flip.' };
// Read the side showing (the back once flipped) in the deck's language.
// A side with sounds plays them (one after another) instead of reading the text out; any other side is read out.
function readAloud() {
  if (!R?.current) return;
  const { card } = R.current;
  const side = R.flipped ? 'back' : 'front';
  if (hasSounds(card, side)) { playSide(card, side); return; }
  stopSound();
  // A cloze card says "blank" for the hidden part, and the whole sentence once flipped. A picture says which part is hidden.
  const sp = stepsOf(card);
  const text = sp ? (R.flipped ? (sp.kind === 'elements' ? elementsSpeech : stepsSpeech)(sp, R.stepShown) : card.front) : hasMasks(card) ? occSpeech(card, R.flipped) : hasBlank(card) ? (R.flipped ? clozeFull(card.noteText) : card.front.replace(/(?<!\\)\[[^\]]*\]/, 'blank')) : (R.flipped ? card.back : card.front);
  speak(text, deckOf(card)?.ttsLang || '');
}

function playSide(card, side) {
  stopSpeaking();
  playSounds(card[side + 'Sounds'], { onBlocked: () => autoplayBlocked($('flash')?.querySelector('.rv-face:not([inert])') || document) });
}

function nextCard(el) {
  stopSpeaking();
  stopSound();
  R.current = takeNext(R.queue, R.waiting);
  R.flipped = false; R.typed = null; R.suggest = null; R.stepShown = 0; R.elMissed = new Set();
  R.shownAt = Date.now(); R.answerMs = 0;
  if (!R.current) return finish(el);
  // FSRS-7 (beta): get this card's FSRS-7 memory ready (rebuilt from its history the first time), while you read the question.
  R.prep = null;
  if (usesFsrs7(R.settings)) {
    const p = prepare7([R.statesById.get(R.current.card.id)], db.getCardLogs).catch(err => console.error(err));
    R.prep = { id: R.current.card.id, done: false, p };
    p.then(() => { if (R?.prep?.p === p) R.prep.done = true; });
  }
  renderSession(el, true);
  warmCards([...R.queue.slice(0, 3), ...R.waiting.slice(0, 1)].map(x => x.card));      // the next cards' pictures and sounds, if this device lacks them
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
  holdBack('session', askEnd);        // Back (an edge swipe) asks before leaving a running session
  const { card } = R.current;
  const sp = stepsOf(card);
  R.stepShown = sp ? Math.min(R.stepShown || 0, sp.steps.length) : 0;      // (an edit can change the number of steps)
  R.elMissed = new Set([...(R.elMissed || [])].filter(i => sp && i < R.stepShown));
  // The drawing stays when the same card is drawn again (an edit from the menu), and goes with the next card.
  const kept = pad && padKey === R.shownAt && pad.hasInk() ? pad.canvas : null;
  destroyPad();
  // Formatting (bold, lists…) is shown on the card; typed answers are checked against the plain text.
  const mode = modeOf(card);
  const typeThis = mode.type;
  const occ = hasMasks(card);
  const frontLen = occ ? 0 : answerText(card.front).length;          // measured as words, not as LaTeX
  const size = frontLen > 120 ? ' xlong' : frontLen > 50 ? ' long' : '';
  const fullPath = R.deckNames.get(card.deckId) || '';
  const deckLabel = `<span class="flash-deck" title="${esc(fullPath)}">${esc(shortDeckPath(fullPath))}${R.custom ? ` · ${esc(R.custom)}` : ''}</span>`;
  // A cloze card shows its note's text with the blank hidden; its back is the same text with the answer marked, and
  // the note's Extra under it. Everything goes through renderCloze/formatHTML, so nothing in the text can inject HTML.
  const cloze = hasBlank(card);
  // An image-occlusion card shows its picture with every box hidden and the highlighted one to name; the back uncovers that
  // box, with its label, and a button shows the whole picture. (occlusion.js builds the HTML, escaping the text.)
  const label = occ ? occLabel(card.occlusion.masks, card.occlusion.n) : '';
  const backSize = occ || sp ? '' : answerSize(answerText(cloze ? card.noteText : card.back));          // a long answer is smaller and left-aligned
  const front = occ
    ? `${card.occlusion.header ? `<p class="occ-head">${mathHTML(card.occlusion.header)}</p>` : ''}${occlusionHTML(card, 'front')}`
    : cardMediaHTML(card, 'front', cloze ? renderCloze(card.noteText, card.cloze, 'front') : formatHTML(card.front));
  const answerHTML = occ
    ? `${occlusionHTML(card, 'back')}<p class="occ-label${label ? '' : ' none'}">${label ? mathHTML(label) : 'Hidden area'}</p>
       <button type="button" class="occ-peek" aria-pressed="false" aria-keyshortcuts="M">Show whole picture <kbd class="key-hint" aria-hidden="true">M</kbd></button>`
    : cloze
      ? cardMediaHTML(card, 'back', renderCloze(card.noteText, card.cloze, 'back'))
      : sp
        ? cardMediaHTML(card, 'back', stepsHTML(sp))
        : cardMediaHTML(card, 'back', formatHTML(card.back));
  if (occ) import('./occlusion-view.js').catch(err => console.error(err));      // the zoom viewer, loaded the first time a picture card shows

  // The shortcut line under the card (desktop). In the answer box the single keys type letters, so it says how to get to them.
  // Z is undo (on a picture card Z zooms the picture instead).
  const keyLine = keyLineFor(sp, occ);

  // The page heading is for screen readers only; it sits beside the bar, not in it, so the bar holds just its buttons.
  const head = `
    <h1 class="sr-only">Review</h1>
    <div class="rv-head">
      <div class="rv-counts mono" role="group" aria-label="Cards left: new, learning, due">${countsHTML()}</div>
      ${R.undo.length ? `<button class="link" type="button" id="undoBtn" aria-label="Undo" title="Undo the last answer">${icon('undo')}</button>` : ''}
      <button class="link" type="button" id="scratchBtn" aria-pressed="${scratchPref()}" aria-keyshortcuts="D" aria-label="Scratchpad${singleKeysOn() ? ' (D)' : ''}" title="Scratchpad${singleKeysOn() ? ' (D)' : ''}">${PEN_ICON}</button>
      <button class="link more" type="button" id="moreBtn" aria-label="Card actions: edit, flag, suspend, bury and more">${icon('more')}</button>
      <button class="link" type="button" id="endBtn">End</button>
    </div>`;
  const body = `
    <article class="flash rv-card${R.flipped ? ' flipped' : ''}${enter ? ' enter' : ''}" id="flash" ${R.flipped ? '' : `aria-labelledby="rvQ"${typeThis ? '' : ' aria-describedby="rvHint"'}`} ${R.flipped || typeThis ? '' : 'tabindex="0"'}>
      ${canSpeak() || hasSounds(card, 'front') || hasSounds(card, 'back')
        ? `<button class="rv-speak" type="button" id="speakBtn" aria-label="${hasSounds(card, 'front') || hasSounds(card, 'back') ? 'Play the sound or read aloud' : 'Read aloud'}" title="${hasSounds(card, 'front') || hasSounds(card, 'back') ? 'Play the sound or read aloud (R)' : 'Read aloud (R)'}" aria-keyshortcuts="R">${SPEAKER_ICON}</button>` : ''}
      <div class="rv-turn">
        <div class="rv-face rv-front" ${R.flipped ? HIDDEN : ''}>
          <h2 class="sr-only">Question</h2>
          ${deckLabel}
          <div class="flash-front${size}" id="rvQ">${front}</div>
          ${typeThis ? '' : '<span class="sr-only" id="rvHint">Press Space or Enter to show the answer</span>'}
          ${sp?.kind === 'elements' ? `<p class="el-count">${sp.steps.length} elements</p>` : ''}
          ${typeThis ? '' : `<p class="flash-hint">${MOUSE.matches ? 'Click or press Space to show the answer' : 'Tap to show the answer'}</p>`}
        </div>
        <div class="rv-face rv-back" tabindex="-1" role="region" aria-label="Answer" ${R.flipped ? '' : HIDDEN}>
          ${deckLabel}
          ${cloze || occ ? '' : `<div class="flash-recap${backSize || sp ? ' small' : ''}">${front}</div>`}
          <div class="flash-ans">
            <div class="rv-typed">${R.typed ? typedResultHTML() : ''}</div>
            <div class="flash-back${cloze ? ' cloze-full' : ''}${occ ? ' occ-back' : ''}${sp ? ' steps-back' : ''}${backSize}">${answerHTML}</div>
            ${card.noteExtra ? `<p class="flash-extra"${sp && R.stepShown < sp.steps.length ? ' hidden' : ''}>${formatHTML(card.noteExtra)}</p>` : ''}
            ${card.noteFields?.length ? `<div class="flash-fields"${sp && R.stepShown < sp.steps.length ? ' hidden' : ''}>${noteFieldsHTML(card.noteFields, name => foldOpen('field:' + name.toLowerCase()), formatHTML)}</div>` : ''}
          </div>
        </div>
      </div>
    </article>
    ${typeThis && !R.flipped ? `
      <form class="typeform" id="typeForm" autocomplete="off">
        <input id="typeIn" type="text" maxlength="500" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type the answer" aria-label="Your answer">
        <button class="btn primary" type="submit">Check</button>
      </form>` : ''}
    ${mode.wanted && FLIP_NOTE[mode.why] && !R.flipped && (!sp || sp.kind === 'elements') ? `<p class="note center" id="longNote">${FLIP_NOTE[mode.why]}</p>` : ''}
    <div class="ratebar" id="ratebar">${R.flipped ? backBarHTML() : showButtonHTML(typeThis)}</div>
    <p class="key-line" id="keyLine" aria-hidden="true" data-normal="${esc(keyLine)}">${esc(typeThis && !R.flipped ? typingKeys() : keyLine)}</p>`;
  drawSessionPage(el, stripKeys(head), stripKeys(body));
  glossHook();
  setFocusMode(true);               // only once the round has drawn, so a failed draw can't leave the tabs hidden

  $('undoBtn')?.addEventListener('click', () => undo(el));
  $('endBtn').addEventListener('click', () => finish(el));
  $('moreBtn').addEventListener('click', () => openCardMenu('actions'));
  $('scratchBtn').addEventListener('click', toggleScratch);
  keepFocusOnPress($('flash'), '.el-tick');      // a tap on Got it / Missed must leave Space free to reveal and rate
  keepFocusOnPress($('scratchBtn').parentElement, '#scratchBtn');      // a mouse click on the pen must leave Space free to flip the card
  $('speakBtn')?.addEventListener('click', e => { e.stopPropagation(); readAloud(); });      // (the card flips on a click: not this one)
  autoSpeak(card);
  wireRatebar(el);
  mountPad(kept);
  $('flash').addEventListener('pointerdown', () => { selAtPress = selectedNow(); }, true);
  $('flash').addEventListener('click', e => {
    if (e.target.closest('.scratch, .scratch-tools')) return;      // drawing (or choosing a tool) is not a tap on the card
    if (selectionEndedHere()) return;      // a click that ends selecting some words is not a tap to flip
    const zoom = e.target.closest('.occ-zoom');
    if (zoom) { import('./occlusion-view.js').then(v => v.zoomFrom(zoom)); return; }      // (once the viewer is loaded it handles this click first)
    if (e.target.closest('.occ-peek')) return;
    if (e.target.closest('[data-accept-typed]')) { acceptTyped(el); return; }
    if (e.target.closest('.gl-term, .gl-pop')) return;      // a tap on an underlined term opens its definition; it never flips the card
    const tick = e.target.closest('[data-tick]');
    if (tick) { toggleMissed(el, +tick.dataset.tick); return; }
    if (e.detail > 1) return;      // a double-click (to select a word) is not a tap to flip
    if (!R.flipped && !typeThis) flip(el);
  });
  $('flash').querySelector('.occ-peek')?.addEventListener('click', e => togglePeek(e.currentTarget));
  // A note field's fold stays open (or shut) the next time, for that field name, on this device. (toggle doesn't bubble: listen while it goes down.)
  $('flash').addEventListener('toggle', e => { const d = e.target.closest?.('.note-field'); if (d) saveFold('field:' + d.dataset.field, d.open); }, true);
  $('typeForm')?.addEventListener('submit', e => { e.preventDefault(); submitTyped(el); });
  // Keep focus on the card (the page was just redrawn, so it would drop to the page itself).
  if (typeThis && !R.flipped) {
    $('typeIn').focus();
    // The shortcut keys work again once the cursor leaves the box.
    $('typeIn').addEventListener('focus', () => { $('keyLine').textContent = typingKeys(); });
    $('typeIn').addEventListener('blur', () => { $('keyLine').textContent = $('keyLine').dataset.normal; });
  }
  else if (R.flipped) $('flash').querySelector('.rv-back').focus({ preventScroll: true });
  else $('flash').focus({ preventScroll: true });
  publishLive();
}

// Did this click end selecting some words of the card? (Then it must not flip the card.) A selection that was already there when
// the press began is old: tapping the card again just flips it (and drops the old selection).
let selAtPress = '';
const selectedNow = () => { const sel = getSelection?.(); return sel && !sel.isCollapsed && $('flash')?.contains(sel.anchorNode) ? String(sel).trim() : ''; };
function selectionEndedHere() {
  const now = selectedNow();
  if (!now) return false;
  if (now === selAtPress) { getSelection().removeAllRanges(); return false; }
  return true;
}

// Your own glossary (item 12): the terms on the card get a dotted underline and a definition popover. The module is only loaded
// when the glossary has terms (the module itself checks Settings → Appearance → "Glossary underlines", this device, each time).
const hasTerms = settings => Object.keys(settings || {}).some(k => k.startsWith('gloss:') && settings[k]);
function glossHook() {
  if (!R?.gloss || !R.current) return;
  const id = R.current.card.id;
  import('./glossary-view.js').then(v => (R?.current?.card.id === id ? v.underlineCard($('flash'), R.current.card) : null)).catch(err => console.error(err));
}
addEventListener('glossary-changed', () => { if (R) R.gloss = true; });      // the first term, added mid-session, counts from the next card

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

const showButtonHTML = typeThis => stripKeys(
  `<button class="btn ${typeThis ? 'ghost' : 'primary'} wide" type="button" id="showBtn">${typeThis ? "I don't know" : 'Show answer'}${typeThis ? '' : ' <kbd class="key-hint" aria-hidden="true">Space</kbd>'}</button>`);

// The buttons under the card: Show answer, or the four ratings.
function wireRatebar(el) {
  $('showBtn')?.addEventListener('click', () => flip(el));
  $('stepBtn')?.addEventListener('click', () => revealStep(el));
  $('stepAllBtn')?.addEventListener('click', () => revealStep(el, true));
  $('ratebar').querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => answer(el, +b.dataset.rate)));
}

// Decks set to read aloud: the front when a card appears, the back when it's flipped (once each).
// A side with sounds plays them instead (unless the deck has "Play sounds automatically" off, which also leaves that side quiet).
function autoSpeak(card) {
  const key = `${card.id}:${R.flipped}`;
  if (R.spoken === key) return;
  const side = R.flipped ? 'back' : 'front';
  if (hasSounds(card, side)) {
    if (deckOf(card)?.soundAuto !== false) { R.spoken = key; playSide(card, side); }
    return;
  }
  if (deckOf(card)?.ttsAuto) { R.spoken = key; readAloud(); }
}

// Tell Today whether a session is in progress, so it can offer to resume it.
function publishLive() {
  live.resume = R?.active
    ? { left: R.queue.length + R.waiting.length + (R.current ? 1 : 0), deckId: R.deckId, scope: R.scope, day: R.day, version: R.version }
    : null;
}

function rateButtonsHTML() {
  const ivl = previewIntervals(R.statesById.get(R.current.card.id), schedFor(R.current.card), Date.now(), R.current.card.id);
  return `<div class="rates">${RATINGS.map(({ rating, label, key }) => `
    <button type="button" class="rate r${rating}${R.suggest === rating ? ' suggested' : ''}" data-rate="${rating}" aria-keyshortcuts="${key}" aria-label="${label}, next review in ${formatIntervalLong(ivl[rating])}${R.suggest === rating ? ', suggested' : ''}">
      <b>${label}</b><span class="mono">${formatInterval(ivl[rating])}</span>${R.suggest === rating && stepsOf(R.current.card)?.kind === 'elements' ? '<small class="sug-l">Suggested</small>' : ''}<kbd class="key-hint" aria-hidden="true">${key}</kbd></button>`).join('')}</div>`;
}

function typedResultHTML() {
  const { value, result, target } = R.typed;
  // A wrong or inexact answer shows which letters differ (the diff has the "You typed" row, so the line doesn't repeat it).
  let diff = !result.exact && value.trim() ? diffAgainstBack(value, target) : null;
  if (diff && (diff.tooDifferent || (result.correct && !hasMarks(diff)))) diff = null;     // too different: just "You typed X"
  // One corrected line (the card shows the answer itself); a "Closest answer" row only when the back has several answers.
  const shown = diff ? diffHTML(diff, { answerRow: false, closest: !!diff.alternate }) : '';
  if (result.correct) return `<p class="typed ok">${icon('check')} ${result.exact ? 'Correct' : 'Correct, with a small typo'}${result.exact || diff ? '' : `: <span class="given">${esc(value)}</span>`}</p>${shown}`;
  // "Accept my answer from now on" adds the typed text to the card's accepted answers (accept.js). You still pick the rating yourself.
  const accept = canAccept(R.current.card, value) ? '<p class="typed-accept"><button type="button" class="link" data-accept-typed>Accept my answer from now on</button></p>' : '';
  return `<p class="typed no">${icon('x')} ${value.trim() ? `Not quite.${diff ? '' : ` You typed <span class="given">${esc(value)}</span>`}` : 'No answer'}</p>${shown}${accept}`;
}

// Accept the typed text from now on: the card keeps it, and this answer counts as right (Good is suggested; the rating stays yours).
async function acceptTyped(el) {
  if (!R?.typed || !R.flipped || R.busy) return;
  const fresh = await db.get('cards', R.current.card.id);
  if (!fresh) { toast('That card changed; nothing to fix.'); return; }
  const saved = addAccepted(fresh, R.typed.value);
  if (saved === fresh) { toast('That answer is already accepted.'); return; }
  await db.saveCards([saved]);
  R.current.card = { ...R.current.card, acceptAnswers: saved.acceptAnswers };
  R.typed = { ...R.typed, result: { ...R.typed.result, correct: true, exact: true } };
  R.suggest = Rating.Good;
  $('flash').querySelector('.rv-typed').innerHTML = typedResultHTML();
  $('ratebar').innerHTML = backBarHTML();
  wireRatebar(el);
  $('flash').querySelector('.rv-back')?.focus({ preventScroll: true });
  toast('Accepted for this card');
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
  ['role', 'tabindex', 'aria-label', 'aria-labelledby', 'aria-describedby'].forEach(a => flash.removeAttribute(a));
  const front = flash.querySelector('.rv-front'), back = flash.querySelector('.rv-back');
  front.setAttribute('aria-hidden', 'true'); front.inert = true;
  back.removeAttribute('aria-hidden'); back.inert = false;
  $('typeForm')?.remove();
  $('longNote')?.remove();
  $('ratebar').innerHTML = backBarHTML();
  wireRatebar(el);
  // FSRS-7 and the card's memory is still being rebuilt: draw the buttons again with the right intervals when it is ready.
  if (R.prep && !R.prep.done) {
    const prep = R.prep;
    prep.p.then(() => { if (R?.prep === prep && R.flipped && R.current?.card.id === prep.id && $('ratebar')?.querySelector('.rate')) { $('ratebar').innerHTML = backBarHTML(); wireRatebar(el); } });
  }
  // The button that was pressed is gone, so move focus to the answer: screen readers read it out, and the
  // keyboard stays where it was (1–4 and Space still rate).
  back.focus({ preventScroll: true });
  autoSpeak(R.current.card);
  ($('ratebar').querySelector('.rate') || $('stepBtn'))?.scrollIntoView({ block: 'nearest' });
}

// ---------- step-by-step cards (B5) ----------
// The back of a "Step 1: ... Step 2: ..." card is a list with every step hidden. After the flip the bar under the card
// reveals one step at a time (Space, Enter, → or the button), A shows them all, and the rating buttons come once every step
// is on screen (1–4 rate at any time). Each revealed step takes the focus (no live region: the focus move is what is read out); the last one moves it to the final answer.
function stepsHTML(sp) {
  const shown = R.stepShown, all = shown >= sp.steps.length, el = sp.kind === 'elements';
  // An elements card adds a "Got it / Missed" toggle to each element (the rating is suggested from them, see backBarHTML).
  return `${sp.intro ? `<div class="steps-intro">${formatHTML(sp.intro)}</div>` : ''}
    <ol class="steps${el ? ' elements' : ''}" id="steps" aria-label="${el ? 'Elements' : 'Steps'}">${sp.steps.map((t, i) => `<li class="step" tabindex="-1" ${i < shown ? '' : 'hidden'}><div class="step-body">${formatHTML(t)}</div>${el ? tickHTML(i) : ''}</li>`).join('')}</ol>
    ${sp.final ? `<div class="steps-final" tabindex="-1" ${all ? '' : 'hidden'}><b class="steps-final-l">Answer</b><div>${formatHTML(sp.final)}</div></div>` : ''}`;
}
const tickHTML = i => stripKeys(tickRaw(i));
const tickRaw = i => {
  const missed = R.elMissed.has(i);
  return `<button type="button" class="el-tick" aria-pressed="${!missed}" data-tick="${i}" aria-keyshortcuts="X" aria-label="Element ${i + 1}: ${missed ? 'missed' : 'got it'}. Press to change.">${missed ? '✗ Missed' : '✓ Got it'}</button>`;
};
// The shortcut line under the card. On a step-by-step card, once the last step is on screen Space no longer does anything: it says "1–4 to rate".
const keyLineFor = (sp, occ) => !singleKeysOn() ? '' : `${sp && R.flipped && R.stepShown >= sp.steps.length ? '1–4 to rate' : 'Space to flip · 1–4 rate'} · D scratchpad${R.undo.length && !occ ? ' · Z undo' : ''}${sp?.kind === 'elements' ? ' · X marks a miss' : ''}`;
// What sits under a flipped card: the step buttons while steps are hidden, otherwise the four ratings.
// Elements cards: once every element is on screen, "You got 3 of 4. Suggested: Hard." sits above the ratings (suggestRating, steps.js).
function backBarHTML() { return stripKeys(backBarRaw()); }
function backBarRaw() {
  const sp = stepsOf(R.current.card);
  if (sp?.kind === 'elements' && R.stepShown >= sp.steps.length) {
    const n = sp.steps.length, missed = R.elMissed.size, rating = suggestRating(n, missed);
    R.suggest = rating;
    const word = RATINGS.find(r => r.rating === rating)?.label || '';
    return `<p class="step-try el-sum" id="elSum">You got ${n - missed} of ${n}. Suggested: ${word}.</p>${rateButtonsHTML()}`;
  }
  if (!sp || R.stepShown >= sp.steps.length) return rateButtonsHTML();
  const n = R.stepShown + 1, m = sp.steps.length, noun = sp.kind === 'elements' ? 'element' : 'step';
  return `<p class="step-try" id="stepTry">${noun === 'element' ? `Recall element ${n} of ${m}, then reveal.` : `Try step ${n} yourself, then reveal.`}</p>
    <div class="step-actions">
      <button class="btn primary wide" type="button" id="stepBtn" aria-keyshortcuts="Space Enter ArrowRight">Reveal ${noun} ${n} of ${m} <kbd class="key-hint" aria-hidden="true">Space</kbd></button>
      <button class="btn ghost wide" type="button" id="stepAllBtn" aria-keyshortcuts="A">Show all <kbd class="key-hint" aria-hidden="true">A</kbd></button>
    </div>`;
}
// An element's "Got it / Missed" toggle (a tap on it, or X for the latest revealed element).
function toggleMissed(el, i) {
  const sp = R?.flipped && R.current && stepsOf(R.current.card);
  if (!sp || sp.kind !== 'elements' || !(i >= 0 && i < R.stepShown)) return;
  if (R.elMissed.has(i)) R.elMissed.delete(i); else R.elMissed.add(i);
  const b = $('flash').querySelector(`[data-tick="${i}"]`);
  if (b) { const had = document.activeElement === b; b.outerHTML = tickHTML(i); if (had) $('flash').querySelector(`[data-tick="${i}"]`)?.focus(); }
  if (R.stepShown >= sp.steps.length) { $('ratebar').innerHTML = backBarHTML(); wireRatebar(el); }
}
function revealStep(el, all = false) {
  const sp = R?.flipped && R.current && stepsOf(R.current.card);
  if (!sp || R.stepShown >= sp.steps.length) return;
  const from = R.stepShown;
  R.stepShown = all ? sp.steps.length : from + 1;
  const flash = $('flash'), items = [...flash.querySelectorAll('#steps > li')];
  items.forEach((li, i) => { li.hidden = i >= R.stepShown; });
  if (R.stepShown >= sp.steps.length) flash.querySelectorAll('.steps-final, .flash-extra, .flash-fields').forEach(x => { x.hidden = false; });
  $('ratebar').innerHTML = backBarHTML();
  wireRatebar(el);
  const kl = $('keyLine');
  if (kl) { kl.dataset.normal = keyLineFor(sp, false); kl.textContent = kl.dataset.normal; }
  const final = flash.querySelector('.steps-final');
  if (!all && final && R.stepShown >= sp.steps.length) final.focus();         // the last step also shows the final answer: read that
  else items[from]?.focus();                    // the step just revealed (the first of them, for Show all)
}

// ---------- scratchpad (B4) ----------
// A scribble icon (not a pencil: that would look like Edit) in the top bar (or D) draws over the card with a pen, finger or mouse (scratchpad.js). On or off is remembered
// on this device. The drawing is never saved: a new card starts clean, a flip keeps it, leaving Review throws it away.
const SCRATCH_KEY = 'study-sprint-scratch';
const PEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 13.5c2-6.5 4.5-7.5 5-3.5s2 5.5 4 .5 3.5-7 5-2 1.5 3 2.5 2.5"/><path d="M4 19.5h16"/></svg>';
const scratchPref = () => { try { return localStorage.getItem(SCRATCH_KEY) === '1'; } catch { return false; } };
const setScratchPref = on => { try { localStorage.setItem(SCRATCH_KEY, on ? '1' : '0'); } catch { /* fine: it just isn't remembered */ } };
let pad = null, padKey = 0, zoomWatch = null;
function destroyPad() {
  pad?.destroy(); pad = null;
  zoomWatch?.disconnect(); zoomWatch = null;
}
function mountPad(kept) {
  const card = $('flash');
  if (!card) return;
  padKey = R.shownAt;
  pad = mountScratch(card, {
    onChange: on => {
      setScratchPref(on);
      $('scratchBtn')?.setAttribute('aria-pressed', String(on));
      card.classList.toggle('scratching', on);
    }
  });
  if (kept) pad.restore(kept);
  // Hidden while the zoom viewer is open (it is a dialog added to the page).
  const mine = pad;
  const hideForZoom = () => {
    const v = document.querySelector('dialog.occ-view') ? 'hidden' : '';
    mine.canvas.style.visibility = v; mine.tools.style.visibility = v;
  };
  zoomWatch = new MutationObserver(hideForZoom);
  zoomWatch.observe(document.body, { childList: true });
  if (scratchPref()) pad.on();
}
function toggleScratch() {
  if (!pad) return;
  if (pad.isOn()) pad.off(); else pad.on();
}
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/review')) destroyPad(); });

// "Show whole picture": uncovers every box of the picture on the back (the CSS does it, from the figure's .peek class).
function togglePeek(button) {
  const on = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(on));
  button.closest('.rv-back')?.querySelector('.occ')?.classList.toggle('peek', on);
}

function submitTyped(el) {
  const value = $('typeIn').value;
  if (!value.trim()) { $('typeIn').focus(); return; }
  // Either the answer as words or the text as written is right (typing the LaTeX works, and so does the literal text).
  const { target, ...result } = checkTyped(value, withAccepted(answerTargets(R.current.card.back), R.current.card));
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
  if (usesFsrs7(R.settings)) await prepare7([prev], db.getCardLogs);       // (nearly always done already, see nextCard)
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
    const inStep = R.version === db.scheduleVersion();       // (a change that landed earlier, e.g. new weights from sync, must not be absorbed below)
    const saving = db.saveReview(next, log);
    // Rating feedback plays alongside the save and nothing waits for it: the next card is drawn the moment the save is done.
    fx.rated(rating, $('flash'), el.querySelector(`.rate[data-rate="${rating}"]`));
    const logId = await saving;
    if (inStep) R.version = db.scheduleVersion();
    R.statesById.set(id, next);
    // Still learning and due again today (in a few minutes)? It comes back this session.
    const requeued = (next.state === LEARNING || next.state === RELEARNING) && next.due <= dayEnd(now);
    if (requeued) addWaiting(R.waiting, { card: item.card, kind: 'learn', due: next.due });
    // Forgotten too many times? It becomes a leech: tagged, and suspended unless Settings says tag only.
    let cardBefore = null, leeched = false;
    if (next.lapses > (prev?.lapses || 0) && isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(id), R.leech.threshold)) {
      cardBefore = item.card;
      const leech = markLeech(item.card, R.leech.action);
      const inStep2 = R.version === db.scheduleVersion();
      await db.saveCards([leech]);
      if (inStep2) R.version = db.scheduleVersion();
      if (leech.suspended) dropFromSession(id); else replaceInSession(leech);
      leeched = true;
      toast(leech.suspended ? 'Leech: suspended. You can fix it at the end of the session.' : 'Leech: tagged “leech”. You can fix it at the end of the session.');
    }
    const spent = Math.min(now - R.shownAt, MAX_CARD_MS);
    R.undo.push({ item, prev, logId, requeued, again: rating === Rating.Again, spent, cardBefore, leeched });
    R.answered.add(id);
    if (leeched) R.leeches.push(id);
    R.stats.reviewed++; R.stats.spent += spent;
    if (rating === Rating.Again) R.stats.again++;
    nextCard(el);
  } finally {
    R.busy = false;
  }
}

// Take back the last rating: restore the card's old schedule and show it again.
async function undo(el) {
  if (R.busy || !R.undo.length) return;      // (check busy first: a second tap while the first undo is saving must not drop an entry)
  const u = R.undo.pop();
  R.busy = true;
  try {
    const id = u.item.card.id;
    const inStep = R.version === db.scheduleVersion();
    await db.undoReview(id, u.prev, u.logId);
    if (u.cardBefore) { await db.saveCards([u.cardBefore]); u.item = { ...u.item, card: u.cardBefore }; }   // un-leech it
    if (inStep) R.version = db.scheduleVersion();
    if (u.prev) R.statesById.set(id, u.prev); else R.statesById.delete(id);
    if (u.requeued) {
      const i = R.waiting.findIndex(w => w.card.id === id);
      if (i >= 0) R.waiting.splice(i, 1);
    }
    if (R.current) R.queue.unshift(R.current);
    R.stats.reviewed--; R.stats.spent -= u.spent;
    if (!R.undo.some(x => x.item.card.id === id)) R.answered.delete(id);      // (a card answered twice stays answered until both are undone)
    if (u.leeched) { const i = R.leeches.lastIndexOf(id); if (i >= 0) R.leeches.splice(i, 1); }
    if (u.again) R.stats.again--;
    R.active = true;
    stopSound();
    R.current = u.item; R.flipped = false; R.typed = null; R.suggest = null; R.stepShown = 0; R.elMissed = new Set();
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
  const inStep = R.version === db.scheduleVersion();     // if something else already changed the schedule, the panel's own change must not hide that
  openCardPanel(card, {
    decks: R.decks, statesById: R.statesById, mode: mode === 'info' ? 'full' : mode, showInfo: mode === 'info', closeAfter: BACK_TO_CARD,
    onAction: async (act, fresh) => {
      if (inStep) R.version = db.scheduleVersion();
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
  const inStep = R.version === db.scheduleVersion();
  await db.saveCards([act === 'bury' ? { ...card, buriedUntil: buryUntil() } : { ...card, suspended: true }]);
  if (inStep) R.version = db.scheduleVersion();
  toast(act === 'bury' ? 'Buried until tomorrow' : 'Suspended');
  dropFromSession(card.id);
  nextCard(R.el);
}

// ---------- 3. finish ----------
// The back gesture during a session: ask, and keep going unless they say End. (Answers are saved either way.)
function askEnd() {
  if (!R?.active || document.getElementById('sheet')?.open) return;
  openSheet(`
    <h2 id="sheetTitle">End this session?</h2>
    <p>Your answers so far are saved. The cards you haven't done stay due.</p>
    <div class="sheet-actions">
      <button class="btn ghost" type="button" id="keepOn">Keep going</button>
      <button class="btn primary" type="button" id="endNow">End session</button>
    </div>`);
  $('keepOn').addEventListener('click', closeSheet);
  $('endNow').addEventListener('click', () => { closeSheet(); if (R?.active && R.el?.isConnected) finish(R.el); });
}

async function finish(el) {
  closeSheet();                 // a card panel or a question that was open belongs to the session that just ended
  releaseBack('session');
  destroyPad();
  stopSound();
  R.active = false;
  publishLive();
  if (el.isConnected) setFocusMode(false);      // a late finish must not end focus mode on another screen (e.g. a Play round)
  if (el.isConnected) drawSidebar();            // the sidebar's counts and ring, now the round is done
  refreshBadge();                               // and the number on the app icon (badge.js)
  const { reviewed, again, spent } = R.stats;
  const cardsDone = R.answered.size;          // distinct cards: a card answered twice (Again, then Good) is one card, two answers
  const endedEarly = !!R.current;
  // What "Keep going" would start: exactly Today's Start session (the decks chosen on Today, otherwise all of them).
  const data = await loadAll();
  const allIds = data.decks.map(d => d.id);
  // A session started from a deck (or Today's one chosen deck) keeps going in that deck and its subdecks, not in all decks.
  const chosen = allIds.includes(R.deckId) ? [R.deckId] : data.settings.reviewDecks.filter(id => allIds.includes(id));
  const scope = chosen.length ? chosen : allIds;
  const rest = countFor(data, scope);
  // Reviews due by the end of tomorrow (already studied, not suspended or buried), in the same decks.
  const inScope = withSubdecks(data, scope), tomorrowEnd = dayEnd(Date.now(), 1);
  const dueTomorrow = data.cards.filter(c => {
    const st = data.statesById.get(c.id);
    return inScope.has(c.deckId) && st && st.state !== NEW && st.due <= tomorrowEnd;
  }).length;
  const streak = await loadStreak(null, { settings: R.settings });
  // You may have switched to another screen while that loaded: don't draw over it.
  if (!R || !location.hash.startsWith('#/review')) return;
  if (reviewed) noteSession();            // a finished session: Today may now offer to install the app (install.js)
  const acc = reviewed ? Math.round((reviewed - again) / reviewed * 100) : 0;
  const mins = Math.floor(spent / 60000), secs = Math.round((spent % 60000) / 1000);
  const title = endedEarly ? 'Session ended' : reviewed && !rest.total ? 'Nice work' : 'Session done';

  el.innerHTML = `
    <div class="screen-head"><div><span class="eyebrow mono">${endedEarly ? 'ENDED EARLY' : 'DONE FOR NOW'}</span><h1>${title}</h1></div></div>
    <div class="stats4">
      <div><div class="v">${cardsDone}</div><div class="l">Cards reviewed</div></div>
      <div><div class="v">${acc}%</div><div class="l">Accuracy</div></div>
      <div><div class="v">${mins}:${String(secs).padStart(2, '0')}</div><div class="l">Time spent</div></div>
      <div><div class="v">${dueTomorrow}</div><div class="l">Due tomorrow</div></div>
    </div>
    <p class="note">${endedEarly ? 'Cards you didn’t get to stay due. ' : ''}${reviewed > cardsDone ? `${plural(reviewed, 'answer')} on ${plural(cardsDone, 'card')}. ` : ''}Accuracy counts every rating except Again.</p>
    <div class="res-actions">
      ${rest.total
        ? `<button class="btn primary" type="button" id="keepBtn" aria-label="Keep going: ${plural(rest.total, 'card')}">Keep going · ${plural(rest.total, 'card')}</button>
           <button class="btn ghost" type="button" id="againBtn">Back to Today</button>`
        : '<button class="btn primary" type="button" id="againBtn">Back to Today</button>'}
    </div>
    <p class="fin-links"><a class="link" href="#/decks">Decks</a>${R.undo.length ? '<span aria-hidden="true">·</span><button class="link" type="button" id="undoLast">Undo last</button>' : ''}</p>
    <div id="finishMore" class="finish-more" hidden></div>
    <section class="finish-next" aria-label="What's next">
      ${streakHTML(streak)}
    </section>`;
  $('againBtn').addEventListener('click', () => { R = null; publishLive(); navGo('#/today'); });
  $('keepBtn')?.addEventListener('click', async () => {
    R = null; publishLive();
    const { startStudy } = await import('./today.js');
    const before = location.hash;
    await startStudy({ deckIds: chosen });
    // Today's Start with one deck goes to #/review/<deck>: the address we are already on, so nothing would redraw. Do it here.
    if (location.hash === before && el.isConnected) renderReview(el, chosen.length === 1 ? chosen[0] : undefined);
  });
  $('undoLast')?.addEventListener('click', () => undo(el));
  const slot = $('finishMore'), cardIds = [...R.answered], leechIds = [...R.leeches];
  slot.dataset.answered = cardIds.length; slot.dataset.leeches = leechIds.length;
  import('./finish-extras.js').then(m => m.drawFinishExtras(slot, { source: 'review', cardIds, leechIds })).catch(err => console.error(err));
  fx.finished(el, { complete: !R.current, reviewed });
}

const typingKeys = () => singleKeysOn() ? 'Enter to check · Esc to leave the box for shortcuts' : 'Enter to check';
// ---------- keyboard ----------
// Space or Enter flips. 1–4 rate. After flipping, Space or Enter picks the suggested button (Good unless typing said otherwise).
// Like Anki: E edits, I shows card info, - buries, @ suspends, R reads the card aloud.
document.addEventListener('keydown', e => {
  if (!R?.active || !document.getElementById('flash') || document.getElementById('sheet')?.open) return;
  if (document.querySelector('dialog.occ-view[open], dialog.occ-ed[open]')) return;      // the zoom viewer and the box editor have their own keys
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('.gl-pop')) return;      // a glossary popover has its own keys (Escape, Space and Enter close it)
  const inInput = e.target.matches('input, textarea, select');
  if (e.key === 'Escape' && e.target.id === 'typeIn') { e.preventDefault(); e.target.blur(); return; }      // out of the answer box: the single keys work again
  const onButton = onControl(e, 'flash');   // Enter or Space on a focused button should press that button, not flip or rate
  // Settings → Study → Single-key shortcuts (WCAG 2.1.4): off, the letter and number keys do nothing, and Space / Enter only act on the card itself.
  const keys = singleKeysOn(), cardKeys = keys || !!e.target.closest?.('#flash');
  if (!inInput && keys) {
    const k = e.key.toLowerCase();
    if (k === 'e' || k === 'i') { e.preventDefault(); openCardMenu(k === 'i' ? 'info' : 'edit'); return; }
    if (e.key === '-' || e.key === '@') { e.preventDefault(); quick(e.key === '-' ? 'bury' : 'suspend'); return; }
    if (k === 'r') { e.preventDefault(); readAloud(); return; }
    if (k === 'd') { e.preventDefault(); toggleScratch(); return; }
    if (k === 'a' && stepsLeft()) { e.preventDefault(); revealStep(R.el, true); return; }
    if (k === 'x' && R.flipped && R.stepShown && stepsOf(R.current.card)?.kind === 'elements') { e.preventDefault(); toggleMissed(R.el, R.stepShown - 1); return; }
    // Image occlusion: Z zooms the picture, M shows the whole picture (on the back).
    const face = $('flash').querySelector('.rv-face:not([inert])');
    if (k === 'z' && !face?.querySelector('.occ-zoom')) { e.preventDefault(); undo(R.el); return; }
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
    if (!onButton && cardKeys && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(R.el); }
    return;
  }
  if (stepsLeft() && !inInput && (((!onButton && cardKeys) && (e.key === ' ' || e.key === 'Enter')) || e.key === 'ArrowRight')) { e.preventDefault(); revealStep(R.el); return; }
  if (!inInput && keys && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); answer(R.el, +e.key); }
  else if (!onButton && cardKeys && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    // A step-by-step card: Space only reveals (the last step shows the final answer). Rating it is 1–4 or a rating button, so a Space
    // pressed to see the final answer (or held down) can't rate the card by accident.
    if (stepsOf(R.current.card)?.kind !== 'elements' && stepsOf(R.current.card)) return;      // (an elements card suggests its rating, so Space takes that)
    answer(R.el, R.suggest || Rating.Good);
  }
});
