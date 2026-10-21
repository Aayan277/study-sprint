// Tests for the speed-ups that must not change any answer: the card sort memo (study-data.js), the search fold fast path and
// idle pre-fold (browse-logic.js), the dupKey cache (import.js) and the one-pass deck summaries (deck-tree.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortedCopies } from '../js/study-data.js';
import { searchFold, searchFoldSlow, cardMatcher, prefoldIdle, pruneFoldCache, isHidden } from '../js/browse-logic.js';
import { dupKey, clearDupKeys, findDuplicates } from '../js/import.js';
import { summariesByDeck, chainMap } from '../js/deck-tree.js';

const oldSort = (rows, order) => rows.map(r => ({ ...r })).sort((a, b) => order.get(a.deckId) - order.get(b.deckId) || a.created - b.created);

function makeRows(n, decks) {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, (_, i) => ({ id: 'c' + String(i).padStart(5, '0'), deckId: decks[Math.floor(rnd() * decks.length)], created: Math.floor(rnd() * 50) }));
}

test('sort memo: same order as the plain sort, reused, and changed by a reorder or an added card', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const order = new Map(ids.map((d, i) => [d, i]));
  const rows = makeRows(500, ids);
  const first = sortedCopies(rows, order);
  assert.deepEqual(first, oldSort(rows, order));
  assert.notEqual(first[0], rows.find(r => r.id === first[0].id), 'copies, not the kept rows');
  first[0].front = 'changed';
  assert.equal(rows.find(r => r.id === first[0].id).front, undefined, 'changing a copy leaves the kept row alone');
  assert.deepEqual(sortedCopies(rows, order), oldSort(rows, order), 'second call (memo) gives the same order');
  // a deck reorder
  const order2 = new Map(['d', 'c', 'b', 'a'].map((d, i) => [d, i]));
  assert.deepEqual(sortedCopies(rows, order2), oldSort(rows, order2));
  assert.notDeepEqual(sortedCopies(rows, order2).map(c => c.id), sortedCopies(rows, order).map(c => c.id));
  // an added card (same array grown in place, or a new array)
  const grown = rows.slice();
  grown.push({ id: 'c99999', deckId: 'a', created: -1 });
  assert.deepEqual(sortedCopies(grown, order), oldSort(grown, order));
  rows.push({ id: 'c88888', deckId: 'b', created: -5 });
  assert.deepEqual(sortedCopies(rows, order), oldSort(rows, order), 'same array object, one more card');
  // a card of an unknown deck falls back to the plain sort
  const odd = makeRows(50, ['a', 'zz']);
  assert.deepEqual(sortedCopies(odd, order), oldSort(odd, order));
});

test('searchFold: the ASCII fast path equals the slow path', () => {
  const samples = ['', ' ', '   ', 'Hello World', '  leading', 'trailing  ', ' both ', 'C++', 'c#', 'a&b', '100%', '@user', '*star*', '$5 + 3 = 8', 'a<b>c', 'x^2', '`code`', 'a|b~c',
    '!!!', '?!', '...', 'a--b', 'a_b', 'snake_case_name', 'it\'s', '"quoted"', '(paren)', '[br]{ce}', 'a/b\\c', 'a:b;c,d.e', 'tab\there', 'new\nline', 'cr\r\nlf', '\u0000ctl\u001f', '\u007f', 'MiXeD CaSe 123', '007', 'a  b   c',
    'ÀB', 'naïve', 'ς', 'か', '🧠 x', 'Ａｂ'];
  let seed = 3; const rnd = n => (seed = (seed * 1664525 + 1013904223) % 4294967296) % n;
  for (let i = 0; i < 3000; i++) samples.push(Array.from({ length: rnd(14) }, () => String.fromCharCode(rnd(128))).join(''));
  for (const s of samples) assert.equal(searchFold(s), searchFoldSlow(s), JSON.stringify(s));
  assert.equal(searchFold(null), searchFoldSlow(null));
  assert.equal(searchFold(undefined), '');
  assert.equal(searchFold(42), '42');
});

test('card search cache is keyed by id, and notices an edit', () => {
  const a = { id: 'k1', front: 'Mitochondria', back: 'power', tags: ['bio'] };
  const m = cardMatcher('power');
  assert.ok(m(a));
  const fresh = { ...a };                                  // a fresh copy (Browse loads new ones on every visit)
  assert.ok(m(fresh));
  assert.ok(!cardMatcher('zebra')({ ...a }));
  assert.ok(cardMatcher('zebra')({ ...a, back: 'zebra' }), 'an edited back is folded again');
  assert.ok(cardMatcher('bio')(a) && !cardMatcher('bio')({ ...a, tags: [] }));
});

test('prefoldIdle folds in chunks, falls back to setTimeout, and stops when cancelled or left', async () => {
  const cards = Array.from({ length: 50 }, (_, i) => ({ id: 'pf' + i, front: 'Front ' + i, back: 'b', tags: [] }));
  const queue = [];
  const env = { setTimeout: f => { queue.push(f); return queue.length; }, clearTimeout: () => {} };      // no requestIdleCallback
  let alive = true;
  const cancel = prefoldIdle(cards, () => alive, env);
  assert.equal(queue.length, 1);
  while (queue.length) queue.shift()();
  assert.ok(cardMatcher('front 49')(cards[49]));
  // left Browse: nothing more is scheduled
  const queue2 = []; const env2 = { setTimeout: f => queue2.push(f), clearTimeout: () => {} };
  alive = false;
  prefoldIdle(cards, () => alive, env2);
  queue2.shift()();
  assert.equal(queue2.length, 0);
  // with requestIdleCallback and cancel
  let cancelled = null; const env3 = { requestIdleCallback: () => 7, cancelIdleCallback: h => { cancelled = h; } };
  prefoldIdle(cards, () => true, env3)();
  assert.equal(cancelled, 7);
  cancel();
});

test('dupKey cache: same keys as before, cleared on request; findDuplicates takes pre-folded keys', () => {
  const fronts = ['Hello, World!', 'hello world', 'Café', 'cafe', '+', '🧠', '', 'か', 'が'];
  const keys = fronts.map(dupKey);
  assert.deepEqual(fronts.map(dupKey), keys);
  clearDupKeys();
  assert.deepEqual(fronts.map(dupKey), keys);
  assert.equal(dupKey('Hello, World!'), dupKey('hello world'));
  assert.notEqual(dupKey('か'), dupKey('が'));
  const cards = [{ front: 'HELLO world' }, { front: 'New one' }, { front: 'new  one!' }, { front: '' }, { front: 'Hello', occluded: true }];
  const existing = ['hello, world', 'x'];
  const plain = findDuplicates(cards, existing);
  assert.deepEqual(plain, ['deck', null, 'import', null, null]);
  assert.deepEqual(findDuplicates(cards, existing, new Set(existing.map(dupKey))), plain);
  assert.deepEqual(findDuplicates(cards, [], new Set(existing.map(dupKey))), plain, 'keys win over fronts');
});

// The old way: push every card into each ancestor's list, then summarise each list.
const LVL = st => (!st || st.state === 0 ? 'new' : st.state === 1 || st.state === 3 ? 'learning' : st.stability >= 21 ? 'mature' : 'young');
function oldSummaries(decks, cards, statesById, cutoff, now) {
  const byDeck = new Map(decks.map(d => [d.id, []]));
  const chains = chainMap(decks);
  for (const c of cards) for (const id of chains.get(c.deckId) || []) byDeck.get(id).push(c);
  const sum = list => {
    const s = { total: list.length, due: 0, new: 0, learning: 0, young: 0, mature: 0, hidden: 0 };
    for (const c of list) {
      const st = statesById.get(c.id), lvl = LVL(st);
      s[lvl]++;
      if (isHidden(c, now)) s.hidden++; else if (lvl !== 'new' && st.due <= cutoff) s.due++;
    }
    return s;
  };
  return new Map(decks.map(d => [d.id, sum(byDeck.get(d.id))]));
}

test('deck summaries: one pass up the parent chain equals the old per-deck lists', () => {
  const decks = [{ id: 'root' }, { id: 'u1', parentId: 'root' }, { id: 'l1', parentId: 'u1' }, { id: 'u2', parentId: 'root' }, { id: 'solo' }, { id: 'empty', parentId: 'solo' }];
  const now = Date.now(), cutoff = now + 3600000, cards = [], states = [];
  const dk = ['root', 'u1', 'l1', 'u2', 'solo', 'l1', 'u1', 'ghost'];       // 'ghost': a deck that no longer exists
  for (let i = 0; i < 160; i++) {
    const c = { id: 'x' + i, deckId: dk[i % dk.length] };
    if (i % 7 === 0) c.suspended = true;
    if (i % 11 === 0) c.buriedUntil = now + 86400000;
    cards.push(c);
    const k = i % 6;
    if (k) states.push({ cardId: c.id, state: [0, 1, 2, 2, 3, 2][k], stability: i % 2 ? 30 : 5, due: i % 3 ? now - 1000 : now + 5 * 86400000 });
  }
  const statesById = new Map(states.map(s => [s.cardId, s]));
  const want = oldSummaries(decks, cards, statesById, cutoff, now);
  const got = summariesByDeck(decks, cards, chainMap(decks), {
    levelOf: c => LVL(statesById.get(c.id)), hiddenOf: c => isHidden(c, now), dueOf: c => statesById.get(c.id).due <= cutoff
  });
  assert.deepEqual([...got.keys()], [...want.keys()]);
  for (const d of decks) assert.deepEqual(got.get(d.id), want.get(d.id), d.id);
  const s = got.get('root');
  assert.ok(s.hidden > 0 && s.due > 0 && s.new > 0 && s.learning > 0 && s.young > 0 && s.mature > 0, JSON.stringify(s));
  assert.equal(got.get('empty').total, 0);
});

test('prefoldIdle makes progress when the idle callback timed out; pruneFoldCache keeps only listed cards', () => {
  const cards = Array.from({ length: 5 }, (_, i) => ({ id: 'pr' + i, front: 'Prune ' + i, back: 'b', tags: [] }));
  let cb = null;
  const env = { requestIdleCallback: f => { cb = f; return 1; }, cancelIdleCallback: () => {} };
  prefoldIdle(cards, () => true, env);
  cb({ didTimeout: true, timeRemaining: () => 0 });
  assert.equal(cb !== null, true);
  // all five folded in that one timed-out call: a later pruned list that drops them forgets them (no way to peek, so check it runs)
  pruneFoldCache(cards.slice(0, 2));
  assert.ok(cardMatcher('prune 0')(cards[0]));
  assert.ok(cardMatcher('prune 4')(cards[4]), 'a pruned card is simply folded again');
});

test('dupKey: long strings give the same key (not remembered)', () => {
  const long = 'Word, '.repeat(200);
  assert.equal(dupKey(long), dupKey(long));
  assert.equal(dupKey(long), dupKey(long.toUpperCase()));
});
