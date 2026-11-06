// From a learner ({ logs, cards, decks }) to the rows the features read.
// modelRows() (js/rwkv-features.js) does the work. On top of it we carry over the few things only some sources know:
//   log.day, log.gapSec   overrides for data without a wall clock (see js/own-features.js)
//   log.msUnknown         the answer time is missing: use the neutral 8000 ms (feature 16 = 0) instead of 0 ms
//   log.scored === false  the row updates the memory but is not part of the score (earlier lives of a reset card, cards whose start is unknown)
// and add row.dDays: whole days since this card's previous row (undefined on its first row). 'long' rows have dDays > 0, 'same' rows 0.
import { modelRows } from '../../../js/own-features.js';

export function rowsOf(learner) {
  const rows = modelRows(learner.logs, learner.cards, learner.decks);
  const by = new Map(learner.logs.map(l => [l.id, l]));
  const lastDay = new Map();
  for (const r of rows) {
    const l = by.get(r.logId);
    if (l) {
      if (Number.isFinite(l.day)) r.day = l.day;
      if (Number.isFinite(l.gapSec)) r.gapSec = l.gapSec;
      if (l.msUnknown === true) r.ms = 8000;
      if (l.scored === false) r.scored = false;
    }
    const prev = lastDay.get(r.cardKey);
    if (prev !== undefined) r.dDays = Math.max(0, r.day - prev);
    lastDay.set(r.cardKey, r.day);
  }
  return rows;
}
