// Saving a practice answer as a review: the one code path Play (play.js) and the Practice test (mock-exam.js) share.
// Nothing here decides whether to save: the caller does (Play: the setting "Count Play answers as reviews"; the test: its own
// "Count answers as reviews" switch). Once it does, an answer is written to the review log and, when the auto-grading rules allow
// it (autograde.js), to the card's schedule. The log row's source says where it came from: 'play' or 'test'.

import * as db from './db.js';
import { autoRating, scheduleDecision, applies, appliedRating, speedKey, playLogRow } from './autograde.js';
import { deckSchedulerOptions, usesFsrs7 } from './sched-settings.js';
import { loadByDay } from './balance.js';
import { examOptions, examInfo } from './exam.js';
import { newRoomFor, takeNewFor, giveBackNewFor } from './queue.js';
import { effectiveDeck } from './deck-tree.js';
import { isNewLeechCounted, markLeech } from './browse-logic.js';
import { plural } from './ui.js';

// Cards whose schedule a practice answer already changed today (at most one change per card per day, whichever of Play or a test).
export const practicedToday = logs => new Set(logs.filter(l => (l.source === 'play' || l.source === 'test') && l.applied).map(l => l.cardId));

// Save one answer.
//   data   what the screen loaded: settings, decks, statesById, examCaps, playedToday, newLeft, speed (a Map, or none)
//   entry  { card, ok, ms, limitMs, chars, given (null = ran out of time), mixedWith, overridden }; this function adds
//          prev, logId, applied, rating and decision to it
//   o      { source: 'play' | 'test', qtype, fmt, hard, untimed, afterApply(card, prev, next, log) -> whatever it changed (kept as entry.leeched) }
export async function savePracticeAnswer(data, entry, { source = 'play', qtype, fmt, hard = false, untimed = false, logOnly = false, afterApply } = {}) {
  const id = entry.card.id;
  const now = Date.now();
  const chars = entry.chars ?? 0;
  let rating = autoRating({ ok: entry.ok, ms: entry.ms, limitMs: entry.limitMs, typing: qtype === 'typing',
    speed: data.speed?.get(speedKey(qtype, hard)), chars, untimed });
  const prev = data.statesById.get(id);
  // A new card in a deck with an exam coming up (its own or a parent's) is started by practice: this answer is its
  // first review. That uses up one of today's new cards. Over the deck's new-card limit (overall, the deck's own
  // and its parents'), it's only logged and starts in Review as before.
  const examDeck = !!examInfo(effectiveDeck(data.decks, entry.card.deckId), now);
  const newRoom = newRoomFor(data.newLeft, entry.card.deckId);
  const cap = data.examCaps.get(id);
  const dueState = prev && cap !== undefined ? { ...prev, due: Math.min(prev.due, cap) } : prev;
  // Out of time (not a wrong answer) with Survival's timer at under 3 seconds is logged only.
  let decision = scheduleDecision({ state: dueState, rating, alreadyToday: data.playedToday.has(id), now, examDeck, newRoom,
    timedOut: entry.given === null, limitMs: entry.limitMs, fmt });
  if (logOnly) decision = 'logged';      // e.g. true or false: a coin flip says too little about memory, so the answer is only written to the log
  rating = appliedRating({ decision, rating, mc: qtype !== 'typing', overridden: !!entry.overridden });
  if (decision === 'first') takeNewFor(data.newLeft, entry.card.deckId);
  const log = playLogRow({ cardId: id, now, qtype, fmt, hard, ok: entry.ok, ms: entry.ms, rating, chars,
    prevState: prev ? prev.state : 0, decision, mixedWith: entry.mixedWith, overridden: entry.overridden, untimed, source });
  entry.prev = prev;                      // kept with the log row's id, so "I was right" can take this answer back (see play.js rerecord)
  if (applies(decision)) {
    let next = null;
    try {
      const { rate, prepare7 } = await import('./srs.js');     // the FSRS library, loaded on demand
      if (usesFsrs7(data.settings)) await prepare7([prev], db.getCardLogs);     // FSRS-7 (beta): the card's memory, rebuilt from its history the first time
      const deck = effectiveDeck(data.decks, entry.card.deckId);     // with what it inherits from its parent decks
      // The deck's own settings (or the overall ones), its exam limits, and evening out the reviews.
      data.balance ||= { load: loadByDay([...data.statesById.values()]), easyDays: data.settings.easyDays };
      next = rate(id, prev, rating, { ...examOptions(deckSchedulerOptions(data.settings, deck), deck, now), balance: data.balance }, now);
    } catch (err) {
      // Scheduling library not available (e.g. offline before it was ever downloaded): keep the answer for stats.
      console.error(err);
      if (decision === 'first') { giveBackNewFor(data.newLeft, entry.card.deckId); decision = 'new'; }    // not started: slot back
      else decision = 'not-due';
      log.reason = decision;
      entry.logId = await db.addLog(log);
    }
    // Saving is outside the try, so an error after the review is saved can't add the same answer a second time.
    if (next) {
      log.applied = true;
      entry.logId = await db.saveReview(next, log);
      entry.applied = true;
      data.statesById.set(id, next);
      data.playedToday.add(id);
      entry.leeched = await afterApply?.(entry.card, prev, next, log);       // what it changed, so "I was right" can undo a leech
    }
  } else {
    entry.logId = await db.addLog(log);
  }
  entry.rating = rating;
  entry.decision = decision;
}

// Forgotten too many times? Same as Review: tag it "leech", and suspend it unless Settings says tag only.
// Saves the card and returns { leech (the card as saved), before (as it was) }, or null when it is not a leech (yet).
export async function markLeechIfDue(settings, card, prev, next, log) {
  // A miss on a card that wasn't due still brings it back, but doesn't count toward the leech limit.
  if (log.reason === 'again' || next.lapses <= (prev?.lapses || 0)) return null;
  if (!isNewLeechCounted(prev?.lapses || 0, next.lapses, await db.getCardLogs(card.id), settings.leechThreshold)) return null;
  const before = (await db.get('cards', card.id)) || card;
  const leech = markLeech(before, settings.leechAction);
  await db.saveCards([leech]);
  return { leech, before };
}

// One line for the results screen saying how the saved answers changed the review schedule (entries have a `decision`, see above).
export function scheduleSummaryHTML(entries) {
  const count = d => new Set(entries.filter(l => l.decision === d).map(l => l.card.id)).size;
  const guesses = count('logged');
  const graded = count('due'), sentBack = count('again'), started = count('first'), fresh = count('new'), over = count('new-limit');
  const parts = [];
  if (graded) parts.push(`<b>${plural(graded, 'due card')}</b> graded`);
  if (sentBack) parts.push(`<b>${plural(sentBack, 'missed card')}</b> brought back`);
  // New cards in a deck with an exam are started by practice (autograde.js).
  if (started) parts.push(`<b>${plural(started, 'new card')}</b> started (exam deck)`);
  const text = parts.length
    ? `Schedule updated: ${parts.join(', ')}.`
    : 'No cards were due: schedule unchanged.';
  const extra = (fresh ? ` ${plural(fresh, 'new card')} ${fresh === 1 ? 'starts' : 'start'} in Review.` : '')
    + (over ? ` ${plural(over, 'new card')} over today’s new-card limit ${over === 1 ? 'starts' : 'start'} in Review.` : '');
  const tf = guesses ? ` ${plural(guesses, 'true or false answer')} ${guesses === 1 ? 'was' : 'were'} only logged.` : '';
  return `<p class="sched-note">${text}${extra}${tf}</p>`;
}
