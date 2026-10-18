// FSRS-7 in the app: the glue between a saved card state and the FSRS-7 scheduler (fsrs7-sched.js). Used by srs.js when the
// setting `fsrsVersion` is 7. No library is loaded: the maths is in fsrs7-model.js (checked against ts-fsrs 6 beta by tests).
// Design, data migration and sync: docs/design/fsrs7-plan.md.
//
// What is saved on a card state (cardStates) when FSRS-7 has scheduled it:
//   fsrs7: { stability, stabilityFast, difficulty, at }   the FSRS-7 memory, and `at` = the lastReview it belongs to
// The FSRS-6 fields (stability, difficulty) stay on the card and are moved on by every FSRS-7 review as well, so switching back to FSRS-6 finds a
// card whose FSRS-6 memory is up to date. The shared fields (due, state, reps, lapses, lastReview, learningSteps, scheduledDays) are whatever the
// scheduler that did the last review decided.
// `fsrs7.at === lastReview` is the test that the FSRS-7 memory is current. A review in FSRS-6 mode, or by an older app version, writes a state
// without it (or leaves it behind with an older `at`); the next FSRS-7 review then rebuilds it (below).

import { W7_DEFAULT, clipWeights7, nextState7, savedMemory, seedMemory, memoryFor, rebuilt, clearRebuilt } from './fsrs7-model.js';
import { plan7, NEW } from './fsrs7-sched.js';
import { rowKind } from './fsrs-data.js';

const DAY = 86400000;

export { savedMemory, seedMemory, memoryFor, clearRebuilt };

// ---------- rebuilding a card's FSRS-7 memory ----------
// 1. Replay (best): run the card's review log through FSRS-7 from the first answer. Needs a log that starts at "new" and ends at the card's
//    lastReview. Rows are the same ones the optimizer trains on (fsrs-data.js rowKind): real reviews, imported Anki history and Play answers
//    that changed the schedule. A "reset to new" row (state 0 after earlier rows) restarts the history.
// 2. Seed (when there is no usable log, e.g. an import without history): seedMemory in fsrs7-model.js.
// TODO(ignoreBefore): a separate branch adds the synced setting `ignoreBefore` (the optimizer and the health check leave out reviews before a
// date). When it has merged, treat it here as a start boundary: if this card's history crosses it, return null so the card is seeded from FSRS-6.
export function replayRows(w, rows, lastReview) {
  const all = [...rows].sort((a, b) => a.timestamp - b.timestamp || (a.id ?? 0) - (b.id ?? 0));
  const kept = all.filter(rowKind);
  for (let i = kept.length - 1; i > 0; i--) if (kept[i].state === 0) { kept.splice(0, i); break; }
  // The history must start at "new": state 0, or no state at all and nothing of any kind before it (fsrs-data.js buildHistories, rule 4).
  if (!kept.length || (kept[0].state !== 0 && !(kept[0].state === undefined && all[0] === kept[0]))) return null;
  if (Math.abs(kept[kept.length - 1].timestamp - lastReview) > 60000) return null;           // the log and the card disagree: it is incomplete
  let mem = null;
  for (let i = 0; i < kept.length; i++) mem = nextState7(w, mem, i ? (kept[i].timestamp - kept[i - 1].timestamp) / DAY : 0, kept[i].rating);
  return mem;
}
// Get cards ready for FSRS-7 (call before rating or previewing them): rebuilds, by replay, the memory of every state that has no current
// one. getLogs(cardId) → Promise<rows> (db.getCardLogs). Cheap when nothing is needed (the usual case after the first review of a card).
export async function prepare7(states, getLogs, w = W7_DEFAULT) {
  for (const st of states) {
    if (!st || st.state === NEW || savedMemory(st)) continue;
    const r = rebuilt.get(st.cardId);
    if (r && r.at === st.lastReview) continue;
    let memory = null;
    try { memory = replayRows(w, await getLogs(st.cardId), st.lastReview); } catch (err) { console.error(err); }
    rebuilt.set(st.cardId, { at: st.lastReview, memory: memory ?? seedMemory(st, w), replayed: !!memory });
  }
}
// Was the memory of this card rebuilt from its log (true), seeded from FSRS-6 (false), or not needed / not prepared (undefined)? For tests.
export const wasReplayed = st => rebuilt.get(st.cardId)?.replayed;

// ---------- rating ----------
const weightsOf = opts => (opts.w7 ? clipWeights7(opts.w7) : W7_DEFAULT);
const cfgOf = (opts, w) => ({ w, retention: opts.retention, learningSteps: opts.learningSteps, relearningSteps: opts.relearningSteps, maxInterval: opts.maxInterval, fuzz: !!opts.fuzz });
const cardOf = (cardId, st, w) => ({
  cardId, state: st?.state ?? NEW, learningStep: st?.learningSteps ?? 0, reps: st?.reps ?? 0, lapses: st?.lapses ?? 0,
  lastReview: st?.lastReview ?? null, memory: memoryFor(st, w)
});

// The outcome of a rating in the shape srs.js works with (the library's card: snake_case, `due` a Date), plus fsrs7 (the new memory).
// advance6(rating) → { stability, difficulty } | null: the FSRS-6 memory after this rating, so the FSRS-6 fields move on too.
function libraryCard(o, st, now, advance6) {
  const six = advance6 ? advance6() : null;
  return {
    due: new Date(o.due), stability: six?.stability ?? st?.stability ?? o.memory.stability, difficulty: six?.difficulty ?? st?.difficulty ?? o.memory.difficulty,
    elapsed_days: st?.lastReview ? Math.max(0, Math.floor((now - st.lastReview) / DAY)) : 0, scheduled_days: o.scheduledDays,
    learning_steps: o.learningStep, reps: o.reps, lapses: o.lapses, state: o.state, last_review: new Date(now),
    fsrs7: { ...o.memory, at: now }
  };
}

// Rate a card with FSRS-7. opts: the scheduler options (srs.js) with fsrsVersion 7; advance6(rating) is srs.js's FSRS-6 step.
export function rate7(cardId, st, rating, opts, now, advance6) {
  const w = weightsOf(opts);
  const o = plan7(cardOf(cardId, st, w), cfgOf(opts, w), now)(rating);
  return libraryCard(o, st, now, advance6 && (() => advance6(rating)));
}

// All four buttons at once (for the interval labels and the exam gain): { 1: card, 2: card, 3: card, 4: card }.
export function preview7(cardId, st, opts, now, advance6 = null) {
  const w = weightsOf(opts);
  const outcome = plan7(cardOf(cardId, st, w), cfgOf(opts, w), now);
  const out = {};
  for (const g of [1, 2, 3, 4]) out[g] = libraryCard(outcome(g), st, now, advance6 && (() => advance6(g)));
  return out;
}
