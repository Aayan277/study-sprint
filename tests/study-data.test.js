// Tests for js/study-data.js (what Today counts). Run with: node tests/study-data.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rescueState, rescueClearAt, clearDismissals, RESCUE_DISMISS, countFor, deckCounts, hasReviewLimit, todayRing, typicalCardMs, DEFAULT_CARD_MS, scopeKey } from '../js/study-data.js';
import { buildQueue, splitCards, newLimits, reviewLimits } from '../js/queue.js';
import { chainMap } from '../js/deck-tree.js';
import { dayStart } from '../js/days.js';

const DAY = 86400000;
const now = Date.now();
const decks = [{ id: 'a', name: 'A', created: 1 }, { id: 'a1', name: 'A1', parentId: 'a', created: 2 }, { id: 'b', name: 'B', created: 3 }];
const cards = [];
const statesById = new Map();
for (let i = 0; i < 60; i++) {
  const c = { id: 'c' + i, deckId: ['a', 'a1', 'b'][i % 3], front: 'f' + i, back: 'b' + i, created: i };
  cards.push(c);
  if (i % 2) statesById.set(c.id, { cardId: c.id, state: i % 7 === 0 ? 1 : 2, due: now + (i % 5 - 2) * DAY / 3 });
}
const chains = chainMap(decks);
const deckOf = new Map(cards.map(c => [c.id, c.deckId]));
const data = {
  decks, cards, statesById, deckOf, logs: [], chains,
  newLeft: newLimits({ perDay: 7, decks, logs: [], deckOf, chains }),
  reviewLeft: reviewLimits({ perDay: 9, decks, logs: [], deckOf, chains }),
};
data.split = splitCards(cards, statesById, now); data.splitAt = Date.now();

test('counting a deck from the pre-sorted lists gives the same numbers as building its queue', () => {
  for (const ids of [['a'], ['a1'], ['b'], ['a', 'b'], ['a', 'a1', 'b']]) {
    const inside = new Set(ids.flatMap(id => id === 'a' ? ['a', 'a1'] : [id]));
    const q = buildQueue(cards.filter(c => inside.has(c.deckId)), statesById, data.newLeft, Date.now(), data.reviewLeft);
    const got = countFor(data, ids);
    assert.equal(got.fresh, q.queue.filter(x => x.kind === 'new').length, ids.join());
    assert.equal(got.due, q.queue.filter(x => x.kind !== 'new').length + q.waiting.length, ids.join());
    assert.equal(got.cards.length, cards.filter(c => inside.has(c.deckId)).length);
  }
});

test('time per card comes from the gaps between reviews in a session', () => {
  assert.equal(typicalCardMs([], now), DEFAULT_CARD_MS);
  const at = i => now - 1000000 + i;
  // ten reviews, 20 seconds apart, but only 3 seconds to turn each card over
  const logs = Array.from({ length: 10 }, (_, i) => ({ source: 'review', timestamp: at(i * 20000), ms: 3000 }));
  assert.equal(typicalCardMs(logs, now), 20000);
  // a long pause (a break) is not counted
  const withBreak = [...logs, { source: 'review', timestamp: at(10 * 20000 + 600000), ms: 1 }, { source: 'review', timestamp: at(10 * 20000 + 600000 + 100000), ms: 1 }];
  assert.equal(typicalCardMs(withBreak, now), 20000);
  // a minute or more between answers is not "a card": no gap counts, so the 8-second default stays
  const slow = Array.from({ length: 8 }, (_, i) => ({ source: 'review', timestamp: at(i * 100000), ms: 1 }));
  assert.equal(typicalCardMs(slow, now), DEFAULT_CARD_MS);
  const breaks = Array.from({ length: 8 }, (_, i) => ({ source: 'review', timestamp: at(i * 300000), ms: 1 }));
  assert.equal(typicalCardMs(breaks, now), DEFAULT_CARD_MS);
  assert.equal(typicalCardMs(logs.map(l => ({ ...l, source: 'play' })), now), DEFAULT_CARD_MS);
  assert.equal(typicalCardMs(logs.map(l => ({ ...l, source: 'anki' })), now), DEFAULT_CARD_MS);
});

// A deterministic wobble so the "real" logs below are not perfectly regular.
const wobble = i => ((i * 7919) % 11) / 10;          // 0 .. 1
const session = (start, n, base, spread) => Array.from({ length: n }, (_, i) => ({ source: 'review', timestamp: start += Math.round(base + wobble(i) * spread), ms: 4000 }));

test('time per card on realistic logs: 5 to 15 seconds a card, sessions hours apart', () => {
  const HOUR = 3600000;
  const logs = [];
  for (let d = 1; d <= 20; d++) {
    logs.push(...session(now - d * DAY, 25, 5000, 10000));            // a morning session
    logs.push(...session(now - d * DAY + 9 * HOUR, 25, 5000, 10000)); // an evening one, 9 hours later
  }
  const ms = typicalCardMs(logs, now);
  assert.ok(ms >= 7000 && ms <= 13000, `got ${ms}`);
  // 76 cards is then a quarter of an hour at most, not 76 minutes
  assert.ok(76 * ms / 60000 < 16);
});

test('time per card ignores Play rounds, imported Anki history and a few slow cards', () => {
  const HOUR = 3600000;
  const real = [];
  for (let d = 1; d <= 10; d++) real.push(...session(now - d * DAY, 30, 6000, 8000));
  const base = typicalCardMs(real, now);
  // imported Anki history with made-up times (70 seconds a card, thousands of rows) and a Play round, 2 seconds an answer
  const anki = Array.from({ length: 3000 }, (_, i) => ({ source: 'anki', timestamp: now - 30 * DAY + i * 70000, ms: 0 }));
  const play = Array.from({ length: 200 }, (_, i) => ({ source: 'play', timestamp: now - 3 * DAY + i * 2000, ms: 500 }));
  assert.equal(typicalCardMs([...real, ...anki, ...play], now), base);
  // a few cards that took a minute and a half (looked something up) are not counted
  const withLookups = [...real, ...Array.from({ length: 6 }, (_, i) => ({ source: 'review', timestamp: now - 12 * HOUR + i * 90000, ms: 1 }))];
  assert.equal(typicalCardMs(withLookups, now), base);
});

test('time per card follows recent habits when there are enough recent reviews', () => {
  const old = session(now - 50 * DAY, 100, 30000, 8000);             // 50 days ago: slow, 30 to 38 seconds a card
  const recent = session(now - 2 * DAY, 60, 6000, 4000);            // lately: 6 to 10 seconds
  const ms = typicalCardMs([...old, ...recent], now);
  assert.ok(ms >= 6000 && ms <= 10000, `got ${ms}`);
  // with only a few recent reviews, the older history is still used
  const fewRecent = typicalCardMs([...old, ...session(now - DAY, 4, 6000, 0)], now);
  assert.ok(fewRecent >= 30000, `got ${fewRecent}`);
});

test('review ahead by 3 days and by 7 days are different sessions', () => {
  assert.notEqual(scopeKey(['a'], 'ahead', 3), scopeKey(['a'], 'ahead', 7));
  assert.equal(scopeKey(['b', 'a'], 'ahead', 7), scopeKey(['a', 'b'], 'ahead', 7));
  assert.equal(scopeKey(['a']), scopeKey(['a'], null, 3));      // days left out means the usual 3
});

test('Today counts a cloze note once, the same as the Review queue, and exam prep keeps every sibling', async () => {
  const { customQueue } = await import('../js/study-data.js');
  const { answeredNotes } = await import('../js/queue.js');
  const cl = [1, 2, 3].map(n => ({ id: 'k' + n, deckId: 'b', front: 'f', back: 'b', noteId: 'N', cloze: n, created: 1000 + n }));
  const plain = { id: 'p', deckId: 'b', front: 'p', back: 'p', created: 1 };
  const all = [plain, ...cl];
  const st = new Map(all.map(c => [c.id, { cardId: c.id, state: 2, due: now - DAY, lastReview: now - 5 * DAY }]));
  const d = { ...data, cards: all, statesById: st, logs: [], answered: new Map(), deckOf: new Map(all.map(c => [c.id, 'b'])) };
  d.split = splitCards(all, st, now); d.splitAt = Date.now();
  d.exam = { caps: new Map(), gain: new Map() };
  const c = countFor(d, ['b']);
  const { queue } = buildQueue(all, st, d.newLeft, now, d.reviewLeft, null, d.answered);
  assert.equal(c.due, 2);                      // the plain card and one sibling
  assert.equal(queue.length, c.due);
  // one sibling answered today: the other two stay out, the answered one is not due any more
  st.set('k1', { cardId: 'k1', state: 2, due: now + 4 * DAY, lastReview: now - 1000 });
  d.answered = answeredNotes([{ cardId: 'k1', timestamp: now - 1000, source: 'review' }], all, now);
  d.split = splitCards(all, st, now); d.splitAt = Date.now();
  assert.equal(countFor(d, ['b']).due, 1);
  // exam prep: every sibling due for a look, whatever Review shows
  const ymd = new Date(now + 5 * DAY);
  const examDate = `${ymd.getFullYear()}-${String(ymd.getMonth() + 1).padStart(2, '0')}-${String(ymd.getDate()).padStart(2, '0')}`;
  const deckExam = { ...d, decks: d.decks.map(x => (x.id === 'b' ? { ...x, examDate } : x)) };
  const prep = customQueue('prep', deckExam, all, 3);
  assert.deepEqual(prep.queue.map(x => x.card.id).filter(id => id.startsWith('k')).sort(), ['k2', 'k3']);
});

test('review ahead leaves out siblings of a card that is still due today', async () => {
  const { customQueue } = await import('../js/study-data.js');
  const cl = [1, 2, 3].map(n => ({ id: 'k' + n, deckId: 'b', front: 'f', back: 'b', noteId: 'N', cloze: n, created: n }));
  const st = new Map(cl.map(c => [c.id, { cardId: c.id, state: 2, due: now + 2 * DAY, lastReview: now - DAY }]));
  const d = { ...data, cards: cl, statesById: st, logs: [], answered: new Map(), exam: { caps: new Map(), gain: new Map() } };
  d.split = splitCards(cl, st, now);
  assert.equal(customQueue('ahead', d, cl, 3).queue.length, 1);          // nothing due today: one of the three
  st.set('k1', { cardId: 'k1', state: 2, due: now - DAY, lastReview: now - 5 * DAY });
  d.split = splitCards(cl, st, now);                                      // k1 is due today and will be in Review
  assert.equal(customQueue('ahead', d, cl, 3).queue.length, 0);
});

test('countFor passes the catch-up plan on: the backlog is capped and new cards pause', () => {
  const cs = [], st = new Map();
  for (let i = 0; i < 50; i++) { cs.push({ id: 'o' + i, deckId: 'b', created: i }); st.set('o' + i, { cardId: 'o' + i, state: 2, due: now - 8 * DAY - i }); }
  cs.push({ id: 'n1', deckId: 'b', created: 99 });
  const base = { ...data, cards: cs, statesById: st, split: splitCards(cs, st, now), splitAt: Date.now(), rescue: null,
    newLeft: newLimits({ perDay: 5, decks, logs: [], deckOf: new Map(cs.map(c => [c.id, 'b'])), chains }), reviewLeft: { total: Infinity, byDeck: new Map(), chains } };
  assert.deepEqual([countFor(base, ['b']).due, countFor(base, ['b']).fresh], [50, 1]);
  const rescue = { cutoff: now - DAY, allow: 10, k: 1, days: 5, remaining: 50, pauseNew: true, exempt: new Set() };
  const got = countFor({ ...base, rescue }, ['b']);
  assert.deepEqual([got.due, got.fresh], [10, 0]);
});

// ---------- Round 2 A2: "Due" means what Review will show today ----------
// A small world: parent P with kids K1 and K2, and an unrelated deck Q. Every card in review state, overdue.
const world = ({ reviewPerDay = Infinity, suspended = [], cloze = false, examCap = false } = {}) => {
  const ds = [{ id: 'P', name: 'P', created: 1 }, { id: 'K1', name: 'K1', parentId: 'P', created: 2 }, { id: 'K2', name: 'K2', parentId: 'P', created: 3 }, { id: 'Q', name: 'Q', created: 4 }];
  const cs = [], st = new Map();
  const add = (id, deckId, extra = {}) => { cs.push({ id, deckId, created: cs.length, ...extra }); st.set(id, { cardId: id, state: 2, due: now - DAY - cs.length, lastReview: now - 5 * DAY }); };
  for (let i = 0; i < 4; i++) add('p' + i, 'P');
  for (let i = 0; i < 3; i++) add('a' + i, 'K1');
  if (cloze) for (let n = 1; n <= 3; n++) add('z' + n, 'K2', { noteId: 'N', cloze: n }); else for (let i = 0; i < 2; i++) add('b' + i, 'K2');
  for (let i = 0; i < 5; i++) add('q' + i, 'Q');
  const visible = cs.filter(c => !suspended.includes(c.id));
  const ch = chainMap(ds), dOf = new Map(cs.map(c => [c.id, c.deckId]));
  const d = { decks: ds, cards: visible, statesById: st, deckOf: dOf, logs: [], answered: new Map(), chains: ch, rescue: null,
    newLeft: newLimits({ perDay: 20, decks: ds, logs: [], deckOf: dOf, chains: ch }),
    reviewLeft: reviewLimits({ perDay: reviewPerDay, decks: ds, logs: [], deckOf: dOf, chains: ch }),
    exam: { caps: new Map(), gain: new Map() } };
  if (examCap) st.set('a0', { ...st.get('a0'), due: now + 30 * DAY });
  if (examCap) d.exam = { caps: new Map([['a0', now - DAY]]), gain: new Map() };
  d.split = splitCards(visible, st, now, d.exam); d.splitAt = Date.now();
  return d;
};

test('deckCounts without limits: a parent is its own cards plus its subdecks, and nothing is held back', () => {
  const d = world();
  const [p, k1, k2] = [['P'], ['K1'], ['K2']].map(ids => deckCounts(d, ids));
  assert.equal(p.due, 9);
  assert.equal(p.due, 4 + k1.due + k2.due);
  assert.deepEqual([p.scheduled, p.heldByLimit, p.heldBySiblings], [9, 0, 0]);
  assert.equal(p.total, p.due + p.fresh);
});

test('deckCounts: a daily review limit holds cards back and says how many', () => {
  const d = world({ reviewPerDay: 6 });
  const all = deckCounts(d, ['P', 'Q']);
  assert.equal(all.due, 6);
  assert.equal(all.heldByLimit, 8);
  assert.equal(all.heldBySiblings, 0);
  assert.equal(all.scheduled, 14);
  // the parent alone gets the first 6 of its 9 (most overdue first); the rest wait
  const p = deckCounts(d, ['P']);
  assert.deepEqual([p.due, p.heldByLimit], [6, 3]);
});

test('deckCounts: cloze siblings wait until tomorrow and are counted as held by siblings, not by the limit', () => {
  const d = world({ cloze: true });
  const k2 = deckCounts(d, ['K2']);
  assert.deepEqual([k2.due, k2.scheduled, k2.heldBySiblings, k2.heldByLimit], [1, 3, 2, 0]);
});

test('deckCounts: suspended cards are not counted, and a card an exam pulled in counts as due', () => {
  const s = deckCounts(world({ suspended: ['a0', 'a1'] }), ['K1']);
  assert.deepEqual([s.due, s.scheduled], [1, 1]);
  const e = world({ examCap: true });
  assert.equal(deckCounts(e, ['K1']).due, 3);           // a0 is saved as due in 30 days, but the exam plan wants it today
});

test('countFor keeps giving the same due/fresh/total as deckCounts, plus the cards', () => {
  const d = world({ reviewPerDay: 5 });
  const a = countFor(d, ['P']), b = deckCounts(d, ['P']);
  assert.deepEqual([a.due, a.fresh, a.total, a.heldByLimit], [b.due, b.fresh, b.total, b.heldByLimit]);
  assert.equal(a.cards.length, 9);
});

// ---------- Batch 1 review ----------
test('deckCounts: heldByRescue is 0 without a plan; with one it is what the plan holds back, apart from the limit', () => {
  const none = deckCounts(world(), ['P']);
  assert.equal(none.heldByRescue, 0);
  const d = world();
  const rescue = { cutoff: now, allow: 2, k: 1, days: 5, remaining: 9, pauseNew: false, exempt: new Set() };
  const got = deckCounts({ ...d, rescue }, ['P']);
  assert.equal(got.due, 2);
  assert.equal(got.heldByRescue, 7);
  assert.equal(got.heldByLimit, 0);
  assert.equal(got.heldBySiblings, 0);
  const lim = deckCounts({ ...world({ reviewPerDay: 6 }), rescue }, ['P']);
  assert.deepEqual([lim.due, lim.heldByRescue, lim.heldByLimit], [2, 4, 3]);
});

test('deckCounts: the no-limit queue is worked out once however often the held numbers are read', () => {
  const c = deckCounts(world({ reviewPerDay: 6 }), ['P']);
  assert.deepEqual([c.heldByLimit, c.heldBySiblings, c.heldByLimit], [3, 0, 3]);
});

test('hasReviewLimit looks at review limits only (newPerDay is always set)', () => {
  assert.equal(hasReviewLimit({ settings: { reviewLimit: Infinity, newPerDay: 20 }, decks: [{ newPerDay: 5 }] }), false);
  assert.equal(hasReviewLimit({ settings: { reviewLimit: 100 }, decks: [] }), true);
  assert.equal(hasReviewLimit({ settings: {}, decks: [{ reviewPerDay: 10 }] }), true);
});

// ---------- rescueState: what Today shows for "back from a break" ----------
const RNOW = new Date(2026, 9, 14, 12).getTime();
const rescueData = (overdue, { saved = null, rescue = null, history = [] } = {}) => {
  const cs = [], st = new Map();
  for (let i = 0; i < overdue; i++) { cs.push({ id: 'r' + i, deckId: 'a' }); st.set('r' + i, { cardId: 'r' + i, state: 2, due: RNOW - 10 * DAY }); }
  return { settings: { rescue: saved }, rescue, cards: cs, statesById: st, exempt: new Set(), history };
};
const studied = (daysAgo, n) => Array.from({ length: n }, (_, i) => ({ source: 'review', timestamp: RNOW - daysAgo * DAY + i * 1000 }));
test('rescueState: offers 3 days for 150 overdue cards, using 20 a day when there is too little history', () => {
  const s = rescueState(rescueData(150), RNOW);
  assert.equal(s.offer.n, 3); assert.equal(s.offer.backlog, 150); assert.equal(s.offer.perDay, 50); assert.equal(s.typical, 20);
  assert.equal(s.active, false); assert.equal(s.finished, false);
});
test('rescueState: your usual day is the median of the last 14 study days (today left out)', () => {
  const history = [...studied(12, 30), ...studied(13, 30), ...studied(14, 50), ...studied(0, 500)];
  const s = rescueState(rescueData(150, { history }), RNOW);
  assert.equal(s.typical, 30); assert.equal(s.offer.typical, 30);
  assert.equal(rescueState(rescueData(50, { history }), RNOW).offer, null);       // 50 < 2 x 30: not a pile-up
});
test('rescueState: no offer for a small pile, after dismissing today, or while a plan runs', () => {
  assert.equal(rescueState(rescueData(29), RNOW).offer, null);
  assert.equal(rescueState(rescueData(150), RNOW, dayStart(RNOW)).offer, null);
  assert.ok(rescueState(rescueData(150), RNOW, dayStart(RNOW) - DAY).offer);            // dismissed yesterday: offered again
  const plan = { start: dayStart(RNOW), days: 3, backlog: 150, pauseNew: true };
  const s = rescueState(rescueData(150, { saved: plan, rescue: { k: 1, days: 3, remaining: 150 } }), RNOW);
  assert.equal(s.active, true); assert.equal(s.offer, null);
});
test('rescueState: a plan that is over (days up, or nothing left) is finished, so Today clears it', () => {
  const plan = { start: dayStart(RNOW) - 3 * DAY, days: 3, backlog: 150, pauseNew: true };        // day 4
  assert.equal(rescueState(rescueData(40, { saved: plan }), RNOW).finished, true);
  const fresh = { ...plan, start: dayStart(RNOW) - DAY };                                       // day 2 but nothing overdue left (data.rescue null)
  assert.equal(rescueState(rescueData(0, { saved: fresh }), RNOW).finished, true);
  assert.equal(rescueState(rescueData(40, { saved: fresh, rescue: { k: 2 } }), RNOW).finished, false);
  assert.equal(rescueState(rescueData(40, { saved: { ...plan, start: dayStart(RNOW) + DAY } }), RNOW).finished, false);   // not started yet: kept
});

// ---------- review fixes (v4.8.1) ----------
import { decide, rowFromSetting } from '../js/sync-merge.js';
test('rescue auto-clear race: a stale device clearing a finished plan never beats a newer plan from another device', () => {
  const old = { start: 1, days: 3, backlog: 100, pauseNew: true, at: 1_000 };
  const newer = { start: 9, days: 3, backlog: 80, pauseNew: true, at: 5_000 };
  assert.equal(rescueClearAt(old), 1_000);
  assert.equal(rescueClearAt(null), 0);
  assert.equal(rescueClearAt({ days: 3 }), 0);                       // a plan without a time still loses to anything newer
  // The clear is stamped with the old plan's time, so device B (holding the newer plan) skips it ...
  assert.equal(decide(rowFromSetting('rescue', null, rescueClearAt(old)), newer.at), 'skip');
  // ... where a clear stamped "now" (the old behaviour) would have wiped it.
  assert.equal(decide(rowFromSetting('rescue', null, 9_000), newer.at), 'put');
  // And a device still holding the old plan does take the clear from a newer one.
  assert.equal(decide(rowFromSetting('rescue', null, 7_000), old.at), 'put');
});

test('hasReviewLimit: a running catch-up plan counts (each deck row can show up to its allow)', () => {
  assert.equal(hasReviewLimit({ settings: { reviewLimit: Infinity }, decks: [], rescue: null }), false);
  assert.equal(hasReviewLimit({ settings: { reviewLimit: Infinity }, decks: [], rescue: { allow: 5 } }), true);
});

test('deckCounts: heldNewByRescue is the new cards the plan\'s pause holds back (0 when it does not pause)', () => {
  const d = world();
  d.cards.push({ id: 'n1', deckId: 'P', created: 99 }, { id: 'n2', deckId: 'P', created: 100 });
  d.split = splitCards(d.cards, d.statesById, now, d.exam);
  const rescue = { cutoff: now, allow: 9, k: 1, days: 5, remaining: 9, pauseNew: true, exempt: new Set() };
  assert.equal(deckCounts({ ...d, rescue: null }, ['P']).heldNewByRescue, 0);
  const paused = deckCounts({ ...d, rescue }, ['P']);
  assert.deepEqual([paused.fresh, paused.heldNewByRescue], [0, 2]);
  assert.equal(deckCounts({ ...d, rescue: { ...rescue, pauseNew: false } }, ['P']).heldNewByRescue, 0);
});

test('clearDismissals (Reset this device) forgets the mix-up and catch-up dismissals only', () => {
  const kept = new Map([['study-sprint-mix-dismissed', '{}'], [RESCUE_DISMISS, '123'], ['study-sprint-scratch', '1']]);
  clearDismissals({ removeItem: k => kept.delete(k) });
  assert.deepEqual([...kept.keys()], ['study-sprint-scratch']);
  assert.doesNotThrow(() => clearDismissals({ removeItem() { throw new Error('blocked'); } }));
});

// ---------- the Today ring (v4.10): done out of today's work ----------
// A small world: deck d has 3 new cards, 2 reviews due, 1 review due in 5 days.
const ringWorld = ({ logs = [], newPerDay = 20, newCards = 3, learn = [] } = {}) => {
  const ds = [{ id: 'd', name: 'D', created: 1 }];
  const cs = [], st = new Map();
  for (let i = 0; i < newCards; i++) cs.push({ id: 'n' + i, deckId: 'd', front: 'f', back: 'b', created: i });
  for (const [id, due] of [['r0', now - 1000], ['r1', now - 2000], ['r2', now + 5 * DAY]]) { cs.push({ id, deckId: 'd', front: 'f', back: 'b', created: 10 }); st.set(id, { cardId: id, state: 2, due }); }
  for (const [id, due] of learn) { cs.push({ id, deckId: 'd', front: 'f', back: 'b', created: 11 }); st.set(id, { cardId: id, state: 1, due }); }
  const dOf = new Map(cs.map(c => [c.id, c.deckId]));
  const ch = chainMap(ds);
  const d = { decks: ds, cards: cs, allCards: cs, statesById: st, deckOf: dOf, logs, chains: ch, answered: new Map(), rescue: null,
    newLeft: newLimits({ perDay: newPerDay, decks: ds, logs, deckOf: dOf, chains: ch }),
    reviewLeft: reviewLimits({ perDay: null, decks: ds, logs, deckOf: dOf, chains: ch }) };
  d.split = splitCards(cs, st, now); d.splitAt = Date.now();
  return d;
};
const ringOf = (d, ids = []) => todayRing(d, ids, countFor(d, ids.length ? ids : ['d']), now);

test('ring: work left reads done out of reviews due + new cards, and the total holds as cards are finished', () => {
  const r = ringOf(ringWorld());
  assert.deepEqual([r.state, r.done, r.left, r.total, r.of], ['todo', 0, 5, 5, 5]);       // 2 reviews + 3 new
  assert.equal(r.frac, 0);
  // two cards finished (a review and a new card): they are no longer in the queue, so done 2 of the same 5
  const logs = [{ cardId: 'r0', source: 'review', timestamp: now }, { cardId: 'n0', source: 'review', timestamp: now, state: 0 }];
  const d = ringWorld({ logs }); d.statesById.set('r0', { cardId: 'r0', state: 2, due: now + 4 * DAY }); d.statesById.set('n0', { cardId: 'n0', state: 2, due: now + DAY });
  d.cards = d.cards; d.split = splitCards(d.cards, d.statesById, now);
  d.newLeft = newLimits({ perDay: 20, decks: d.decks, logs, deckOf: d.deckOf, chains: d.chains });
  const r2 = ringOf(d);
  assert.deepEqual([r2.state, r2.done, r2.left, r2.total], ['todo', 2, 3, 5]);
  assert.equal(r2.frac, 0.4);
});

test('ring: the new-cards-per-day limit caps the work', () => {
  const r = ringOf(ringWorld({ newPerDay: 1 }));
  assert.deepEqual([r.left, r.total], [3, 3]);          // 2 reviews + 1 of the 3 new cards
});

test('ring: a card in its learning steps counts once (to go while it is due today, done only after)', () => {
  const logs = [{ cardId: 'L', source: 'review', timestamp: now, state: 0 }];
  const soon = ringOf(ringWorld({ logs, newCards: 0, learn: [['L', now + 600000]] }));     // back in 10 minutes: still to do
  assert.deepEqual([soon.done, soon.left, soon.total], [0, 3, 3]);
  const later = ringOf(ringWorld({ logs, newCards: 0, learn: [['L', now + 3 * DAY]] }));    // graduated far ahead: done
  assert.deepEqual([later.done, later.left, later.total], [1, 2, 3]);
  // answered twice (Again, then Good) is still one card
  const twice = ringOf(ringWorld({ logs: [...logs, { ...logs[0], timestamp: now + 1 }], newCards: 0, learn: [['L', now + 3 * DAY]] }));
  assert.equal(twice.done, 1);
});

test('ring: all done, and nothing due at all (never 0/0, drawn full)', () => {
  const logs = [{ cardId: 'r0', source: 'review', timestamp: now }];
  const d = ringWorld({ logs, newCards: 0 }); d.statesById.set('r0', { cardId: 'r0', state: 2, due: now + DAY }); d.statesById.set('r1', { cardId: 'r1', state: 2, due: now + DAY });
  d.split = splitCards(d.cards, d.statesById, now);
  const done = ringOf(d);
  assert.deepEqual([done.state, done.done, done.left, done.frac, done.allLearned], ['done', 1, 0, 1, true]);
  const none = ringWorld({ newCards: 0 }); none.statesById.set('r0', { cardId: 'r0', state: 2, due: now + DAY }); none.statesById.set('r1', { cardId: 'r1', state: 2, due: now + DAY });
  none.split = splitCards(none.cards, none.statesById, now);
  const n = ringOf(none);
  assert.deepEqual([n.state, n.done, n.total, n.frac, n.n, n.of], ['nothing', 0, 0, 1, 1, 1]);      // shown as 1/1 full, never 0/0
});

test('ring: "All cards learned" only when no deck has an unseen new card', () => {
  assert.equal(ringOf(ringWorld()).allLearned, false);
  assert.equal(ringOf(ringWorld({ newCards: 0 })).allLearned, true);
  // new cards held back by the daily limit are still unseen
  assert.equal(ringOf(ringWorld({ newPerDay: 0 })).allLearned, false);
  // an empty set of cards is not "learned"
  assert.equal(ringOf({ ...ringWorld({ newCards: 0 }), cards: [], split: { reviews: [], waiting: [], fresh: [] } }).allLearned, false);
});

test('ring: counts Review answers and Play answers that changed the schedule, not practice or imports, and honours the deck choice', () => {
  const rows = [
    { cardId: 'r0', source: 'review' }, { cardId: 'r1', source: 'play', applied: true },
    { cardId: 'n0', source: 'play', applied: false }, { cardId: 'n1', source: 'anki' }, { cardId: 'r2', source: 'play' }
  ].map(l => ({ ...l, timestamp: now }));
  const d = ringWorld({ logs: rows });
  const r = ringOf(d);
  assert.equal(r.done, 2);                                // r0 (review) and r1 (applied Play); not the logged-only Play, Anki or unmarked rows
  assert.equal(ringOf(d, ['d']).done, 2);
  assert.equal(ringOf(d, ['elsewhere']).done, 0);         // another deck's work is not this deck's
});
