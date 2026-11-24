// Recently deleted: the rules (js/trash-logic.js), checked one by one. The database side is tests/trash-db.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntry, restoreRow, restoreStamp, expired, daysLeft, deckFate, fixParent, hasPartner, cardsTitle, deckPath, mediaOf, PART_ROWS, KEEP_DAYS, DAY } from '../js/trash-logic.js';

const entry = { id: 'e1', settledAt: 1000, deletedAt: 1000 };

test('rule 1: a row that exists here now is left alone', () => {
  assert.equal(restoreRow({ live: { id: 'c1' }, entry }), 'live');
});
test('rule 2: a newer delete marker keeps the row away; none, or this device\'s own delete, restores it', () => {
  assert.equal(restoreRow({ tomb: { deletedAt: 1001 }, entry }), 'newer');
  assert.equal(restoreRow({ tomb: { deletedAt: 1000 }, entry }), 'put');
  assert.equal(restoreRow({ tomb: { deletedAt: 900 }, entry }), 'put');
  assert.equal(restoreRow({ entry }), 'put');
});
test('rule 3: a schedule or review comes back only with its card', () => {
  assert.equal(restoreRow({ entry, needsCard: false }), 'no-card');
  assert.equal(restoreRow({ entry, needsCard: true }), 'put');
  // a card that came back by sync without its history: the history still comes back
  assert.equal(restoreRow({ entry, needsCard: true, tomb: { deletedAt: 800 } }), 'put');
});
test('a card without a deck is not restored', () => {
  assert.equal(restoreRow({ entry, needsDeck: false }), 'no-deck');
  assert.equal(restoreRow({ entry, needsDeck: true }), 'put');
});
test('rule 4: a row the delete only changed goes back only if nobody changed it since', () => {
  assert.equal(restoreRow({ kind: 'before', live: { updatedAt: 1000 }, entry }), 'put');
  assert.equal(restoreRow({ kind: 'before', live: { updatedAt: 500 }, entry }), 'put');
  assert.equal(restoreRow({ kind: 'before', live: { updatedAt: 1001 }, entry }), 'newer');
  assert.equal(restoreRow({ kind: 'before', live: undefined, entry }), 'no-card');
});
test('rule 5: the restore time is later than the delete marker, also when the clock went back', () => {
  assert.equal(restoreStamp(5000, { deletedAt: 1000 }), 5000);
  assert.equal(restoreStamp(500, { deletedAt: 1000 }), 1001);
  assert.equal(restoreStamp(500, { deletedAt: 500 }), 501);
  assert.equal(restoreStamp(500, undefined), 500);
});

test('30 days: the boundary, and a clock-trouble date', () => {
  const now = 100 * DAY;
  const e = (id, deletedAt) => ({ id, deletedAt });
  const gone = expired([e('fresh', now - 29 * DAY), e('edge', now - KEEP_DAYS * DAY), e('old', now - 31 * DAY), e('future', now + 2 * DAY), e('tomorrow', now + DAY), e('bad', NaN)], now);
  assert.deepEqual(gone.sort(), ['bad', 'edge', 'future', 'old']);
  assert.equal(daysLeft(e('x', now - 28 * DAY), now), 2);
  assert.equal(daysLeft(e('x', now), now), 30);
  assert.equal(daysLeft(e('x', now - 40 * DAY), now), 0);
});

test('a deck entry is cut into pieces of 2,000 rows, in the order they must come back', () => {
  const cards = Array.from({ length: 2500 }, (_, i) => ({ id: 'c' + i, deckId: 'd1' }));
  const reviewLog = Array.from({ length: 4100 }, (_, i) => ({ id: i + 1, uid: 'u' + i, cardId: 'c' + (i % 2500) }));
  const snap = { decks: [{ id: 'd1', name: 'Bio' }], cards, cardStates: cards.map(c => ({ cardId: c.id })), reviewLog };
  const { entry: e, parts } = buildEntry(snap, { id: 'x', kind: 'deck', title: 'Bio', now: 5, deckId: 'd1' });
  const size = p => p.gone.decks.length + p.gone.cards.length + p.gone.cardStates.length + p.gone.reviewLog.length;
  const total = parts.reduce((n, p) => n + size(p), 0);
  assert.equal(total, 1 + 2500 + 2500 + 4100);
  assert.equal(parts.length, Math.ceil(total / PART_ROWS));
  assert.equal(e.parts, parts.length);
  for (const p of parts) assert.ok(size(p) <= PART_ROWS);
  assert.equal(parts[0].gone.decks.length, 1);                               // decks first
  assert.ok(parts.at(-1).gone.reviewLog.length > 0);                         // reviews last
  assert.deepEqual(parts.flatMap(p => p.gone.reviewLog.map(r => r.id)), reviewLog.map(r => r.id));   // order kept
  assert.deepEqual(e.counts, { cards: 2500, reviews: 4100 });
  assert.deepEqual(e.deckIds, ['d1']);
  assert.equal(e.settledAt, 5);
  assert.equal(e.deletedAt, 5);
});
test('rows that were only changed are kept apart, in the first piece', () => {
  const snap = { decks: [], cards: [{ id: 'a', deckId: 'd' }], cardStates: [], reviewLog: [] };
  const { parts } = buildEntry(snap, { id: 'x', kind: 'cards', title: 't', before: { cards: [{ id: 'partner', noteId: 'n' }], decks: [{ id: 'sub', parentId: 'top' }] } });
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].before.cards.map(c => c.id), ['partner']);
  assert.deepEqual(parts[0].before.decks.map(c => c.id), ['sub']);
  assert.deepEqual(parts[0].gone.cards.map(c => c.id), ['a']);
});
test('an entry with nothing in it still has one (empty) piece', () => {
  const { parts, entry: e } = buildEntry({ decks: [], cards: [], cardStates: [], reviewLog: [] }, { id: 'x', kind: 'cards', title: 't' });
  assert.equal(parts.length, 1); assert.equal(e.parts, 1);
});
test('the pictures and sounds of the deleted cards are listed', () => {
  const cards = [{ id: 'a', frontImage: 'p1', backSounds: ['s1', 's2'] }, { id: 'b', backImage: 'p2', frontSounds: ['s1'] }, { id: 'c' }];
  assert.deepEqual([...mediaOf(cards)].sort(), ['p1', 'p2', 's1', 's2']);
  const { entry: e } = buildEntry({ decks: [], cards, cardStates: [], reviewLog: [] }, { id: 'x', kind: 'cards', title: 't' });
  assert.deepEqual([...e.mediaIds].sort(), ['p1', 'p2', 's1', 's2']);
  // a picture only a partner card (changed, not deleted) uses is not kept
  const { entry: e2 } = buildEntry({ decks: [], cards: [{ id: 'z' }], cardStates: [], reviewLog: [] }, { id: 'y', kind: 'cards', title: 't', before: { cards: [{ id: 'q', frontImage: 'p9' }] } });
  assert.deepEqual(e2.mediaIds, []);
});

test('titles: one card, many cards, a deck path', () => {
  const decks = [{ id: 'bio', name: 'Biology' }, { id: 'u1', name: 'Unit 1', parentId: 'bio' }];
  const pathOf = id => deckPath(decks, id);
  assert.equal(pathOf('u1'), 'Biology › Unit 1');
  assert.equal(pathOf('nope'), '');
  assert.equal(cardsTitle([{ front: '**Mitosis**', deckId: 'u1' }], { plain: s => s.replace(/\*/g, ''), pathOf }), 'Mitosis');
  assert.equal(cardsTitle([{ front: 'a', deckId: 'u1' }, { front: 'b', deckId: 'u1' }], { pathOf }), '2 cards from Biology › Unit 1');
  assert.equal(cardsTitle([{ front: 'a', deckId: 'u1' }, { front: 'b', deckId: 'bio' }], { pathOf }), '2 cards');
  assert.equal(cardsTitle([{ front: '', deckId: 'u1' }], { pathOf }), '1 card');
});

test('where is a card\'s deck: here, in Recently deleted, or gone', () => {
  const live = new Set(['a']), trash = new Map([['b', 'entry-9']]);
  assert.deepEqual(deckFate('a', live, trash), { state: 'live' });
  assert.deepEqual(deckFate('b', live, trash), { state: 'trash', entryId: 'entry-9' });
  assert.deepEqual(deckFate('c', live, trash), { state: 'gone' });
});
test('a restored subdeck keeps its parent when the parent is here, comes back too or sits in Recently deleted; else it goes to the top', () => {
  const ctx = { liveDeckIds: new Set(['L']), entryDeckIds: new Set(['E']), trashDecks: new Map([['T', 'e2']]) };
  for (const p of ['L', 'E', 'T']) assert.equal(fixParent({ id: 's', parentId: p }, ctx).parentId, p);
  assert.equal(fixParent({ id: 's', parentId: 'gone' }, ctx).parentId, '');
  assert.equal(fixParent({ id: 's', parentId: '' }, ctx).parentId, '');
  assert.equal(fixParent({ id: 's' }, ctx).parentId, undefined);
});

test('a pair partner that is not coming back leaves the card ordinary', () => {
  const partners = new Map([['n1', new Set(['a'])], ['n2', new Set(['b', 'c'])]]);
  assert.equal(hasPartner({ id: 'a', noteId: 'n1' }, partners), false);       // only itself
  assert.equal(hasPartner({ id: 'b', noteId: 'n2' }, partners), true);
  assert.equal(hasPartner({ id: 'z', noteId: 'none' }, partners), false);
});
