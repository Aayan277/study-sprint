// Which review-log rows the FSRS optimizer may learn from, and how they are turned into per-card histories.
// Pure functions (no database), tested by tests/fsrs-data.test.js. Design: docs/design/fsrs-optimizer-plan.md, section 3.
//
// The rules, in short:
//   1. Real reviews are rows with source 'review' (rated in Review) or 'anki' (imported history), with a rating of 1 to 4.
//      These are the only rows that are ever scored (a prediction is checked against them).
//   2. A Play answer that changed the schedule (source 'play', applied === true) is replayed, so the card's memory
//      state and the gap to its next real review are right, but it is never scored and does not count.
//      PLAY_POLICY 'truncate' instead cuts the card's history at its first such row.
//   3. Any other Play row, and any unknown source, is ignored. A new kind of answer gets its own `source` and has to be
//      added to the lists below on purpose.
//   4. A card's history must start at "new" (its first row has state 0, or has no state and nothing came before it).
//      Otherwise the start is unknown and the card is skipped, as Anki does.
//   5. Gaps are counted in study days (the 4am rollover from days.js), so two answers on the same day have a gap of 0.

import { dayStart } from './days.js';

export const MIN_REVIEWS = 400;               // the optimizer unlocks at this many reviews that count
export const PLAY_POLICY = 'replay';          // 'replay' | 'truncate' (owner decision Q1: replay)
export const TRAIN_SOURCES = ['review', 'anki'];

const DAY = 86400000;
const validCard = id => (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id));
const validRating = r => Number.isInteger(r) && r >= 1 && r <= 4;

// What a row is for: 'train' (scored), 'replay' (updates the memory state only) or null (ignored).
export function rowKind(row) {
  if (!row || typeof row !== 'object' || !validCard(row.cardId) || !Number.isFinite(row.timestamp) || !validRating(row.rating)) return null;
  if (TRAIN_SOURCES.includes(row.source)) return 'train';
  if (row.source === 'play' && row.applied === true) return 'replay';
  return null;
}

// Whole study days from time a to time b (both in ms). Rounded, so a daylight-saving night (23 or 25 hours) still counts as one day.
export const deltaDays = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY);

// Build the histories the fit works on.
//   rows    review-log rows (any order, any junk)
//   playPolicy  'replay' (default) or 'truncate'
// Returns { cards, reviews, cardsUsed, longTerm, skipped }:
//   cards      [{ cardId, day0, deltas: Int32Array, ratings: Uint8Array, scored: Uint8Array }], one per usable card, in card order of first appearance.
//              deltas[i] = study days since the previous row (0 for the first), scored[i] = 1 for a real review, 0 for a replayed Play answer.
//              day0 = the study-day number of the first row (days since 1970, for splitting by time).
//   reviews    the number of real reviews on usable cards (this is what must reach MIN_REVIEWS)
//   cardsUsed  usable cards with at least one real review
//   longTerm   real reviews that follow an earlier row on a later day (the ones that get a prediction)
//   skipped    cards left out because their history doesn't start at "new"
export function buildHistories(rows, { playPolicy = PLAY_POLICY } = {}) {
  const byCard = new Map();
  let order = 0;
  for (const row of rows || []) {
    if (!row || typeof row !== 'object' || !validCard(row.cardId) || !Number.isFinite(row.timestamp)) continue;
    let list = byCard.get(row.cardId);
    if (!list) byCard.set(row.cardId, list = []);
    list.push({ row, order: order++ });
  }
  const cards = [];
  let reviews = 0, cardsUsed = 0, longTerm = 0, skipped = 0;
  for (const [cardId, list] of byCard) {
    list.sort((a, b) => a.row.timestamp - b.row.timestamp || (a.row.id ?? 0) - (b.row.id ?? 0) || a.order - b.order);
    let kept = [];
    for (const { row } of list) {
      const kind = rowKind(row);
      if (!kind) continue;
      if (kind === 'replay' && playPolicy === 'truncate') break;
      kept.push({ row, kind });
    }
    if (!kept.length) continue;
    // The history must start at "new": state 0, or no state at all and no row of any kind before it.
    const first = kept[0].row;
    const startsNew = first.state === 0 || (first.state === undefined && list[0].row === first);
    if (!startsNew) { if (kept.some(k => k.kind === 'train')) skipped++; continue; }
    if (!kept.some(k => k.kind === 'train')) continue;
    const n = kept.length;
    const deltas = new Int32Array(n), ratings = new Uint8Array(n), scored = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const { row, kind } = kept[i];
      ratings[i] = row.rating;
      scored[i] = kind === 'train' ? 1 : 0;
      if (i > 0) deltas[i] = deltaDays(kept[i - 1].row.timestamp, row.timestamp);
      if (scored[i]) { reviews++; if (i > 0 && deltas[i] > 0) longTerm++; }
    }
    cardsUsed++;
    cards.push({ cardId, day0: Math.round(dayStart(first.timestamp) / DAY), deltas, ratings, scored });
  }
  return { cards, reviews, cardsUsed, longTerm, skipped };
}

// How many reviews count towards the unlock (MIN_REVIEWS).
export const countEligible = (rows, opts) => buildHistories(rows, opts).reviews;
