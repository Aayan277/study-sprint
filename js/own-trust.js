// Own model, "trust test" (opt-in experiment): which cards are in it, which arm each card is in, and the results table.
// Pure functions; no DOM, no storage, no network. The rule itself (when Own's gap is used) is in js/own-plan.js and srs.js.
// Explanation for the owner: js/help.js ("own-trust-test").
import { fnv1a } from './own-rows.js';
import { dayStart } from './days.js';
import { cleanFsrsVersion } from './sched-settings.js';
import { examInfo } from './exam.js';

export const TRUST_RETENTION = 0.9;
export const TRUST_SALT = 'own-trust|';
const DAY_MS = 86400000;

// The arm of a card: 'trust' (the trust rule) when its stable hash is even, else 'fsrs' (plain FSRS-6). Same card, same arm, on every device.
export const trustArm = cardId => (fnv1a(TRUST_SALT + cardId) % 2 === 0 ? 'trust' : 'fsrs');

// Is FSRS-6 the scheduler, the desired retention 90%, and no exam coming up for the deck? settings: the saved settings; deck: the card's deck with what it inherits
// (or null for the overall settings). Only such cards can be in the test.
export function trustEligible(settings, deck, now = Date.now()) {
  if (cleanFsrsVersion(settings?.fsrsVersion) !== 6) return false;
  if (examInfo(deck, now)) return false;                 // a deck with an exam coming up raises retention and limits due dates: left out, so results are not mixed
  const r = (deck?.options ? { ...settings, ...deck.options } : settings || {}).targetRetention ?? 0.9;
  return Number.isFinite(r) && Math.abs(r - TRUST_RETENTION) < 1e-9;
}

// The arm a card is in right now: null when the test is off, or the card's deck is not FSRS-6 at 90%.
//   cfg: { on } (the test's switch)
export const trustArmFor = (cfg, settings, deck, cardId) => (cfg && cfg.on === true && trustEligible(settings, deck) ? trustArm(cardId) : null);

// Can the switch be turned on? FSRS-6 and 90% in the overall settings or in at least one deck.
export function trustAvailable(settings, decks = []) {
  if (cleanFsrsVersion(settings?.fsrsVersion) !== 6) return false;
  return trustEligible(settings, null) || decks.some(d => d && d.options && trustEligible(settings, d));
}

const emptyArm = () => ({ cards: 0, reviews: 0, scheduled: 0, passed: 0, passRate: null, perCardWeek: null });

// The results table, from the review log rows saved while the test ran (each carries `arm`, and `due` for a card that was already scheduled).
//   logs: review-log rows; cfg: { since, until } (ms; until null while the test runs); now: ms
// -> { days (running, 1 decimal), trust: arm, fsrs: arm }, each arm { cards (with a review), reviews, scheduled (Review-state cards answered on or after
// their due day), passed (of those, rating above Again), passRate (0..1 or null), perCardWeek (reviews per card per week or null) }
export function trustResults(logs, cfg, now = Date.now()) {
  const since = cfg?.since, end = Number.isFinite(cfg?.until) ? cfg.until : now;
  const out = { days: 0, trust: emptyArm(), fsrs: emptyArm() };
  if (!Number.isFinite(since)) return out;
  const span = Math.max(0, end - since);
  out.days = Math.round(span / DAY_MS * 10) / 10;
  const cards = { trust: new Set(), fsrs: new Set() };
  for (const l of logs || []) {
    const a = l && out[l.arm] && (l.arm === 'trust' || l.arm === 'fsrs') ? out[l.arm] : null;
    if (!a || l.source !== 'review' || !(l.timestamp >= since && l.timestamp < end)) continue;
    cards[l.arm].add(l.cardId);
    a.reviews++;
    if (l.state === 2 && Number.isFinite(l.due) && l.timestamp >= dayStart(l.due)) { a.scheduled++; if (l.rating > 1) a.passed++; }
  }
  const weeks = Math.max(span, DAY_MS) / (7 * DAY_MS);          // (a first day counts as a whole day, so the number is not wild)
  for (const k of ['trust', 'fsrs']) {
    const a = out[k];
    a.cards = cards[k].size;
    a.passRate = a.scheduled ? a.passed / a.scheduled : null;
    a.perCardWeek = a.cards ? a.reviews / a.cards / weeks : null;
  }
  return out;
}
