// Tests for where learning cards go in a session (settings.learnOrder): queue.js queueFrom/takeNext, and the setting's sync/backup handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, takeNext, addWaiting, cleanLearnOrder, LEARN_ORDERS, LEARN_ORDER_DEFAULT, NEW, LEARNING, RELEARNING, REVIEW } from '../js/queue.js';
import { acceptSetting, SYNCED_SETTINGS } from '../js/sync-data.js';
import { restoredSettings, DEFAULT_SETTINGS } from '../js/db.js';

const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const card = (id, deckId = 'd') => ({ id, deckId, front: id, back: id });
const ids = q => q.map(x => x.card.id);

// r1..r4 reviews (most overdue first), L1 learning due 5 min ago, L2 relearning due in 5 min (inside the 20-minute look-ahead),
// L3 a one-day step that came due this morning, n1..n3 new cards.
function world() {
  const cards = ['r1', 'r2', 'r3', 'r4', 'L1', 'L2', 'L3', 'n1', 'n2', 'n3'].map(id => card(id));
  const states = new Map([
    ['r1', { state: REVIEW, due: NOW - 4 * DAY }], ['r2', { state: REVIEW, due: NOW - 3 * DAY }],
    ['r3', { state: REVIEW, due: NOW - 2 * DAY }], ['r4', { state: REVIEW, due: NOW - 1 * DAY }],
    ['L1', { state: LEARNING, due: NOW - 5 * MIN }], ['L2', { state: RELEARNING, due: NOW + 5 * MIN }],
    ['L3', { state: LEARNING, due: NOW - 5 * HOUR }]
  ]);
  return { cards, states };
}
const build = (order, newLimit = 3, reviewLimit = Infinity, cardsAndStates = world()) =>
  buildQueue(cardsAndStates.cards, cardsAndStates.states, newLimit, NOW, reviewLimit, null, undefined, null, order);

test('the default is mixed, and anything unknown means mixed', () => {
  assert.equal(LEARN_ORDER_DEFAULT, 'mixed');
  assert.deepEqual(LEARN_ORDERS, ['before', 'mixed', 'after']);
  for (const bad of [undefined, null, '', 'Before', 'later', 1, {}]) assert.equal(cleanLearnOrder(bad), 'mixed');
  for (const ok of LEARN_ORDERS) assert.equal(cleanLearnOrder(ok), ok);
  assert.equal(DEFAULT_SETTINGS.learnOrder, 'mixed');
});

test('mixed gives exactly the queue the app built before the setting existed', () => {
  const w = world();
  const old = buildQueue(w.cards, w.states, 3, NOW, Infinity, null, undefined, null);        // no setting passed at all
  assert.deepEqual(ids(build('mixed').queue), ids(old.queue));
  // reviews and learning cards by due time, new cards spread through them (checked against js/queue.js of v4.57)
  assert.deepEqual(ids(old.queue), ['r1', 'r2', 'r3', 'n1', 'r4', 'L3', 'n2', 'L1', 'L2', 'n3']);
});

test('before: learning cards first (by due time), then reviews with the new cards spread through them', () => {
  assert.deepEqual(ids(build('before').queue), ['L3', 'L1', 'L2', 'r1', 'r2', 'n1', 'r3', 'n2', 'r4', 'n3']);
});

test('after: reviews with the new cards spread through them, then the learning cards', () => {
  assert.deepEqual(ids(build('after').queue), ['r1', 'r2', 'n1', 'r3', 'n2', 'r4', 'n3', 'L3', 'L1', 'L2']);
});

test('all three modes hold the same cards, and the same waiting list', () => {
  const sets = LEARN_ORDERS.map(o => build(o)).map(b => [[...ids(b.queue)].sort().join(), b.waiting.length, b.newAvailable]);
  assert.deepEqual(sets[0], sets[1]);
  assert.deepEqual(sets[1], sets[2]);
});

test('learning cards due later today wait, in every mode', () => {
  const w = world();
  w.cards.push(card('LL')); w.states.set('LL', { state: LEARNING, due: NOW + 2 * HOUR });
  for (const o of LEARN_ORDERS) {
    const b = build(o, 3, Infinity, w);
    assert.deepEqual(b.waiting.map(x => x.card.id), ['LL']);
    assert.ok(!ids(b.queue).includes('LL'));
  }
});

test('a review limit holds back reviews only, never learning cards, and the same reviews in every mode', () => {
  for (const o of LEARN_ORDERS) {
    const q = ids(build(o, 3, 2).queue);
    assert.deepEqual(q.filter(x => x.startsWith('r')), ['r1', 'r2']);             // the 2 most overdue
    assert.deepEqual(q.filter(x => x.startsWith('L')).sort(), ['L1', 'L2', 'L3']);
  }
  assert.deepEqual(ids(build('before', 3, 0).queue), ['L3', 'L1', 'L2', 'n1', 'n2', 'n3']);
  assert.deepEqual(ids(build('after', 3, 0).queue), ['n1', 'n2', 'n3', 'L3', 'L1', 'L2']);
  // a per-deck limit
  const perDeck = { total: Infinity, byDeck: new Map([['d', 1]]) };
  assert.deepEqual(ids(build('after', 0, perDeck).queue), ['r1', 'L3', 'L1', 'L2']);
});

test('the new-card limit works the same in every mode', () => {
  for (const o of LEARN_ORDERS) {
    assert.equal(ids(build(o, 2).queue).filter(x => x.startsWith('n')).length, 2);
    assert.equal(ids(build(o, 0).queue).filter(x => x.startsWith('n')).length, 0);
    assert.equal(build(o, 0).newAvailable, 3);
  }
});

test('with no learning cards, all three modes agree', () => {
  const cards = ['r1', 'r2', 'r3', 'n1', 'n2'].map(id => card(id));
  const states = new Map([['r1', { state: REVIEW, due: NOW - 3 * DAY }], ['r2', { state: REVIEW, due: NOW - 2 * DAY }], ['r3', { state: REVIEW, due: NOW - DAY }]]);
  const out = LEARN_ORDERS.map(o => ids(buildQueue(cards, states, 2, NOW, Infinity, null, undefined, null, o).queue));
  assert.deepEqual(out[0], out[1]);
  assert.deepEqual(out[1], out[2]);
  assert.deepEqual(out[0], ['r1', 'r2', 'n1', 'r3', 'n2']);
});

test('with only learning cards, or nothing at all, nothing breaks', () => {
  const cards = [card('L1'), card('L2')];
  const states = new Map([['L1', { state: LEARNING, due: NOW - MIN }], ['L2', { state: LEARNING, due: NOW - 2 * MIN }]]);
  for (const o of LEARN_ORDERS) {
    assert.deepEqual(ids(buildQueue(cards, states, 5, NOW, Infinity, null, undefined, null, o).queue), ['L2', 'L1']);
    assert.deepEqual(buildQueue([], new Map(), 5, NOW, Infinity, null, undefined, null, o).queue, []);
  }
});

test('an unknown setting value behaves as mixed', () => {
  assert.deepEqual(ids(build('nonsense').queue), ids(build('mixed').queue));
});

test('cloze siblings are held back before the order is applied (a learning card keeps its note)', () => {
  const a = { ...card('a'), noteId: 'N' }, b = { ...card('b'), noteId: 'N' };
  const states = new Map([['a', { state: REVIEW, due: NOW - DAY }], ['b', { state: LEARNING, due: NOW - MIN }]]);
  for (const o of LEARN_ORDERS) assert.deepEqual(ids(buildQueue([a, b], states, 5, NOW, Infinity, null, undefined, null, o).queue), ['b']);
});

// ---- inside a session: cards you press Again on come back through takeNext ----
const drain = (queue, waiting, order, now) => { const out = []; for (let c; (c = takeNext(queue, waiting, now, order));) out.push(c.card.id); return out; };

test('takeNext: mixed and before show a waiting card as soon as its time has come (as before)', () => {
  for (const o of ['mixed', 'before']) {
    const queue = [{ card: card('r'), kind: 'review' }];
    const waiting = [];
    addWaiting(waiting, { card: card('again'), kind: 'learn', due: NOW - MIN });
    assert.deepEqual(drain(queue, waiting, o, NOW), ['again', 'r']);
  }
  // no setting passed: same as mixed
  const queue = [{ card: card('r'), kind: 'review' }], waiting = [{ card: card('again'), kind: 'learn', due: NOW - MIN }];
  assert.equal(takeNext(queue, waiting, NOW).card.id, 'again');
});

test('takeNext: after keeps a due waiting card until the reviews and new cards are done', () => {
  const queue = [{ card: card('r'), kind: 'review' }, { card: card('n'), kind: 'new' }, { card: card('L'), kind: 'learn' }];
  const waiting = [{ card: card('again'), kind: 'learn', due: NOW - MIN }];
  assert.deepEqual(drain(queue, waiting, 'after', NOW), ['r', 'n', 'again', 'L']);
});

test('takeNext: after with an empty queue still shows the waiting cards (due or early)', () => {
  const waiting = [{ card: card('a'), kind: 'learn', due: NOW - MIN }, { card: card('b'), kind: 'learn', due: NOW + 10 * MIN }];
  assert.deepEqual(drain([], waiting, 'after', NOW), ['a', 'b']);
});

// ---- the setting itself ----
test('learnOrder syncs like the other study settings: newest wins, junk is ignored', () => {
  assert.ok(SYNCED_SETTINGS.includes('learnOrder'));
  for (const v of LEARN_ORDERS) assert.deepEqual(acceptSetting('learnOrder', v), { ok: true, value: v });
  for (const bad of [null, undefined, '', 'Before', 'sometimes', 3, ['after']]) assert.deepEqual(acceptSetting('learnOrder', bad), { ok: false });
});

test('learnOrder in a backup: a good value is restored, junk is left out (not stored as mixed)', () => {
  const kept = Object.fromEntries(restoredSettings({ learnOrder: 'after', newPerDay: 5 }));
  assert.equal(kept.learnOrder, 'after');
  assert.ok(!('learnOrder' in Object.fromEntries(restoredSettings({ learnOrder: 'junk' }))));
});
