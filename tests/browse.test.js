// Tests for js/browse-logic.js (the card list). Run with: node tests/browse.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardStatus, browseCards, isHidden, isBuried, buryUntil, parseTags, FILTERS, FILTER_GROUPS, SORTS, replaceInCards, tagCounts, renameTag } from '../js/browse-logic.js';
import * as leechFns from '../js/browse-logic.js';
import { dayEnd } from '../js/days.js';

const NOW = new Date(2026, 9, 9, 15, 0).getTime();
const DAY = 86400000;
const card = (id, extra = {}) => ({ id, deckId: 'd', front: id, back: `${id} back`, tags: [], created: 0, ...extra });

test('status: suspended and buried win over the schedule', () => {
  assert.equal(cardStatus(card('a', { suspended: true }), { state: 2, due: NOW - DAY }, NOW).key, 'suspended');
  assert.equal(cardStatus(card('a', { buriedUntil: NOW + 1000 }), undefined, NOW).key, 'buried');
  assert.equal(cardStatus(card('a', { buriedUntil: NOW - 1000 }), undefined, NOW).key, 'new');      // bury has worn off
});

test('status from the schedule', () => {
  assert.equal(cardStatus(card('a'), undefined, NOW).label, 'New');
  assert.equal(cardStatus(card('a'), { state: 1, due: NOW + 60000 }, NOW).label, 'Learning');
  assert.equal(cardStatus(card('a'), { state: 3, due: NOW - 1 }, NOW).label, 'Learning · due');
  assert.equal(cardStatus(card('a'), { state: 2, due: NOW - 3 * DAY }, NOW).key, 'due');
  assert.equal(cardStatus(card('a'), { state: 2, due: NOW + 2 * 3600000 }, NOW).key, 'due');        // later today
  assert.deepEqual(cardStatus(card('a'), { state: 2, due: NOW + 3 * DAY }, NOW), { key: 'review', label: 'Due in 3d' });
});

test('hidden from Review and Play: suspended, or buried until tomorrow', () => {
  assert.equal(isHidden(card('a', { suspended: true }), NOW), true);
  assert.equal(isHidden(card('a', { buriedUntil: buryUntil(NOW) }), NOW), true);
  assert.equal(isHidden(card('a', { buriedUntil: buryUntil(NOW) }), dayEnd(NOW) + 1), false);       // tomorrow it's back
  assert.equal(isBuried(card('a'), NOW), false);
  assert.equal(isHidden(card('a', { flag: 1 }), NOW), false);
});

const deck = [
  card('Mitosis', { created: 1, tags: ['cells'] }),
  card('Meiosis', { created: 2, flag: 1 }),
  card('Café', { created: 3, suspended: true }),
  card('Osmosis', { created: 4, flag: 4, tags: ['leech'] }),
  card('apple', { created: 5 })
];
const states = new Map([
  ['Mitosis', { state: 2, due: NOW + 5 * DAY, lapses: 1, difficulty: 4 }],
  ['Meiosis', { state: 2, due: NOW - DAY, lapses: 3, difficulty: 8 }],
  ['Osmosis', { state: 1, due: NOW + 60000, lapses: 0, difficulty: 6 }]
]);
const ids = list => list.map(x => x.card.id);

test('search front, back and tags, ignoring capitals and accents', () => {
  assert.deepEqual(ids(browseCards(deck, states, { query: 'MITO', now: NOW })), ['Mitosis']);
  assert.deepEqual(ids(browseCards(deck, states, { query: 'cafe', now: NOW })), ['Café']);
  assert.deepEqual(ids(browseCards(deck, states, { query: 'cells', now: NOW })), ['Mitosis']);
  assert.deepEqual(ids(browseCards(deck, states, { query: 'osis back', now: NOW, sort: 'added-old' })), ['Mitosis', 'Meiosis', 'Osmosis']);
});

test('filters', () => {
  const f = filter => ids(browseCards(deck, states, { filter, sort: 'added-old', now: NOW }));
  assert.deepEqual(f('new'), ['apple']);                  // Café is suspended, so not "new"
  assert.deepEqual(f('due'), ['Meiosis']);
  assert.deepEqual(f('review'), ['Mitosis']);
  assert.deepEqual(f('learning'), ['Osmosis']);
  assert.deepEqual(f('suspended'), ['Café']);
  assert.deepEqual(f('flagged'), ['Meiosis', 'Osmosis']);
  assert.deepEqual(f('flag4'), ['Osmosis']);
  assert.deepEqual(f('leech'), ['Osmosis']);
  assert.equal(f('all').length, 5);
});

test('sorting', () => {
  const s = sort => ids(browseCards(deck, states, { sort, now: NOW }));
  assert.deepEqual(s('added-new'), ['apple', 'Osmosis', 'Café', 'Meiosis', 'Mitosis']);
  assert.deepEqual(s('due').slice(0, 3), ['Meiosis', 'Osmosis', 'Mitosis']);          // new cards last
  assert.deepEqual(s('lapses').slice(0, 2), ['Meiosis', 'Mitosis']);
  assert.deepEqual(s('difficulty')[0], 'Meiosis');
  assert.deepEqual(s('az'), ['apple', 'Café', 'Meiosis', 'Mitosis', 'Osmosis']);
});

test('tags', () => {
  assert.deepEqual(parseTags(' Biology, cells,,biology , Exam 1 '), ['biology', 'cells', 'exam', '1']);
  assert.deepEqual(parseTags(''), []);
});

test('tags are separated by spaces, commas or line breaks, like Anki (they are kept lower case)', () => {
  assert.deepEqual(parseTags('#AK_Step1_v12::#UWorld::23456 #AK_Step1_v12::#Subject::Pulm'), ['#ak_step1_v12::#uworld::23456', '#ak_step1_v12::#subject::pulm']);
  assert.deepEqual(parseTags('a\tb\nc,  d ,e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(parseTags('x  X x'), ['x']);
});

test('one rule for tags: spaces separate them when typing and when reading what is saved; empty "::" pieces are dropped', async () => {
  const { tagWords } = await import('../js/tag-tree.js');
  assert.deepEqual(parseTags('exam 1, new'), ['exam', '1', 'new']);
  assert.deepEqual(parseTags('a :: b'), ['a', 'b']);
  assert.deepEqual(parseTags(':: :::: x'), ['x']);
  assert.deepEqual(tagWords(['exam 1', 'a :: b', 'c']), ['exam', '1', 'a', 'b', 'c']);
  assert.deepEqual(tagWords(['exam 1']), parseTags('exam 1'));
});

test('every filter and sort has a label', () => {
  assert.ok(FILTERS.every(([k, l]) => k && l) && SORTS.every(([k, l]) => k && l));
});

test('leeches: caught at the threshold, then every half-threshold', () => {
  const { isNewLeech, markLeech } = leechFns;
  assert.equal(isNewLeech(6, 7, 8), false);
  assert.equal(isNewLeech(7, 8, 8), true);
  assert.equal(isNewLeech(8, 8, 8), false);     // no new lapse
  assert.equal(isNewLeech(8, 9, 8), false);
  assert.equal(isNewLeech(11, 12, 8), true);    // 8 + 4
  assert.equal(isNewLeech(15, 16, 8), true);    // 8 + 8
  assert.equal(isNewLeech(2, 3, 3), true);
  assert.equal(isNewLeech(3, 4, 3), false);
  assert.equal(isNewLeech(4, 5, 3), true);      // 3 + 2
  assert.equal(isNewLeech(0, 1, 0), false);     // 0 = leeches turned off
});

test('leeches: tagged, and suspended unless tag-only', () => {
  const { markLeech } = leechFns;
  const c = { id: 'a', tags: ['exam'] };
  assert.deepEqual(markLeech(c, 'suspend'), { id: 'a', tags: ['exam', 'leech'], suspended: true });
  assert.deepEqual(markLeech(c, 'tag'), { id: 'a', tags: ['exam', 'leech'] });
  assert.deepEqual(markLeech({ id: 'b', tags: ['leech'] }, 'tag').tags, ['leech']);
});


test('duplicates filter: same front, listed together', () => {
  const cs = [card('Mitosis', { created: 1 }), card('Meiosis', { created: 2 }), card('**mitosis**', { created: 3 }), card('Mitosis!', { created: 4 }), card('Osmosis', { created: 5 })];
  assert.deepEqual(browseCards(cs, new Map(), { filter: 'dupes', now: NOW }).map(x => x.card.id), ['Mitosis', '**mitosis**', 'Mitosis!']);
});

test('image-occlusion cards are left out of the Duplicates filter and of find and replace', () => {
  const occCard = (id, front, extra = {}) => ({ id, front, back: 'Aorta', created: 1, tags: [], occlusion: { n: 1, w: 1, h: 1, masks: [] }, ...extra });
  const cs = [occCard('o1', 'Heart: hidden part 1 of 2'), occCard('o2', 'Heart: hidden part 1 of 2'), card('Mitosis', { created: 3 }), card('Mitosis', { created: 4 })];
  assert.deepEqual(browseCards(cs, new Map(), { filter: 'dupes', now: NOW }).map(x => x.card.id), ['Mitosis', 'Mitosis']);
  assert.deepEqual(replaceInCards([occCard('o1', 'Heart: hidden part 1 of 2')], { find: 'Heart', replace: 'Brain' }), []);
  assert.deepEqual(replaceInCards([occCard('o1', 'Heart'), { id: 'p', front: 'Heart', back: 'x' }], { find: 'Heart', replace: 'Brain' }).map(c => c.id), ['p']);
});

test('find and replace', () => {
  const cs = [{ id: 'a', front: 'Pavlov dog', back: 'pavlov ran tests' }, { id: 'b', front: 'Skinner', back: 'box (1.5)' }];
  assert.deepEqual(replaceInCards(cs, { find: 'pavlov', replace: 'Pavlov’s' }).map(c => [c.front, c.back]), [['Pavlov’s dog', 'Pavlov’s ran tests']]);
  assert.deepEqual(replaceInCards(cs, { find: 'pavlov', replace: 'X', matchCase: true }).map(c => [c.front, c.back]), [['Pavlov dog', 'X ran tests']]);
  assert.deepEqual(replaceInCards(cs, { find: 'Pavlov', replace: 'X', field: 'back' }).map(c => c.back), ['X ran tests']);
  assert.deepEqual(replaceInCards(cs, { find: '(1.5)', replace: '$&' }).map(c => c.back), ['box $&']);      // literal, not a pattern
  assert.deepEqual(replaceInCards(cs, { find: '' }), []);
});

test('tags: counts, rename and remove everywhere', () => {
  const cs = [{ id: 'a', tags: ['exam1', 'cells'] }, { id: 'b', tags: ['exam1'] }, { id: 'c', tags: ['cells', 'exam-1'] }, { id: 'd', tags: [] }];
  assert.deepEqual(tagCounts(cs), [{ tag: 'cells', count: 2 }, { tag: 'exam1', count: 2 }, { tag: 'exam-1', count: 1 }]);
  assert.deepEqual(renameTag(cs, 'exam1', 'Exam-1').map(c => [c.id, c.tags]), [['a', ['exam-1', 'cells']], ['b', ['exam-1']]]);
  assert.deepEqual(renameTag(cs, 'cells', 'exam-1').map(c => [c.id, c.tags]), [['a', ['exam1', 'exam-1']], ['c', ['exam-1']]]);   // merging doesn't double up
  assert.deepEqual(renameTag(cs, 'cells', '').map(c => c.tags), [['exam1'], ['exam-1']]);                                       // removing
});

test('renaming splits on spaces like every other tag field: "Exam 1" makes two tags', async () => {
  const { renameTagExact, renameTagPrefix } = await import('../js/browse-logic.js');
  const cs = [{ id: 'a', tags: ['exam1', 'cells'] }];
  assert.deepEqual(renameTag(cs, 'exam1', 'Exam 1').map(c => c.tags), [['exam', '1', 'cells']]);
  assert.deepEqual(renameTagExact(cs, 'exam1', 'x, y z').map(c => c.tags), [['x', 'y', 'z', 'cells']]);
  assert.deepEqual(renameTagPrefix([{ id: 'p', tags: ['f::1', 'o'] }], 'f', 'g h').map(c => c.tags), [['g::1', 'h::1', 'o']]);
});

test('a tag saved with a space ("a b", before spaces split tags) counts, renames and searches as the two tags it was meant to be', async () => {
  const { renameTag: rn } = await import('../js/browse-logic.js');
  const cs = [{ id: 'a', front: 'f', back: 'b', tags: ['exam 1', 'cells'] }, { id: 'b', front: 'f', back: 'b', tags: ['exam'] }];
  assert.deepEqual(tagCounts(cs), [{ tag: 'exam', count: 2 }, { tag: '1', count: 1 }, { tag: 'cells', count: 1 }]);
  assert.deepEqual(rn(cs, 'exam', 'test').map(c => [c.id, c.tags]), [['a', ['test', '1', 'cells']], ['b', ['test']]]);
});

test('every filter is in exactly one dropdown group', () => {
  const grouped = FILTER_GROUPS.flatMap(([, keys]) => keys);
  assert.deepEqual([...grouped].sort(), FILTERS.map(([k]) => k).sort());
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(FILTER_GROUPS.map(([g]) => g), [null, 'Status', 'Flags', 'Problems']);
});

test('leeches: Play misses on cards that were not due do not count', () => {
  const { isNewLeechCounted, notDueMisses } = leechFns;
  const miss = { source: 'play', applied: true, reason: 'again', state: 2, rating: 1 };
  const logs = [miss, miss, miss, { source: 'play', applied: true, reason: 'due', state: 2, rating: 1 }, { source: 'review', state: 2, rating: 1 },
    { source: 'play', applied: false, reason: 'not-due', state: 2, rating: 1 }];
  assert.equal(notDueMisses(logs), 3);
  // FSRS says 8 lapses, but 3 were Play misses: 5 count, so the 8th lapse is not yet a leech
  assert.equal(isNewLeechCounted(7, 8, logs, 8), false);
  // once the counted lapses reach 8, it is one
  assert.equal(isNewLeechCounted(10, 11, logs, 8), true);
  assert.equal(isNewLeechCounted(7, 8, [], 8), true);                                  // no Play misses: as before
  assert.equal(notDueMisses([{ source: 'play', applied: true, reason: 'again', state: 1, rating: 1 }]), 0);   // a learning step is no lapse
});


// ---------- v4.2.1: searching for symbols ----------
test('search finds symbols and does not match everything for a symbol-only query', () => {
  const mk = (id, front, back = 'x') => ({ id, deckId: 'd', front, back, tags: [], created: NOW });
  const cards = [mk('a', 'C++ basics'), mk('b', 'C# basics'), mk('c', 'C intro'), mk('d', 'Brain 🧠'), mk('e', 'Really?! yes'), mk('f', 'plain'), mk('g', '1 + 1', 'two'), mk('h', 'ぱん bread'), mk('i', 'はん stamp')];
  const find = query => browseCards(cards, new Map(), { query, sort: 'added-old', now: NOW }).map(x => x.card.id).sort();
  assert.deepEqual(find('c++'), ['a']);
  assert.deepEqual(find('C#'), ['b']);
  assert.deepEqual(find('🧠'), ['d']);
  assert.deepEqual(find('?!'), ['e']);
  assert.deepEqual(find('+'), ['a', 'g']);
  assert.deepEqual(find('ぱ'), ['h']);
  assert.deepEqual(find('はん'), ['i']);
  assert.deepEqual(find('  '), cards.map(c => c.id).sort());       // blank: everything
  assert.deepEqual(find('basics'), ['a', 'b']);
});

// ---------- tags as folders ----------
const tagged = [
  card('a', { tags: ['#ak::#uworld::step::123', 'leech'], front: 'lung', back: 'x' }),
  card('b', { tags: ['#ak::#uworld::step::456'], front: 'heart', back: 'y' }),
  card('c', { tags: ['#ak::#amboss::123'], front: 'lung two', back: 'z' }),
  card('d', { tags: ['#uworld'], front: 'plain', back: 'w' }),
  card('e', { tags: [], front: 'none', back: 'v' })
];
const tagFind = query => browseCards(tagged, new Map(), { query, now: NOW }).map(x => x.card.id).sort();

test('search: tag:<path> finds the tag and everything under it, ignoring capitals', () => {
  assert.deepEqual(tagFind('tag:#ak'), ['a', 'b', 'c']);
  assert.deepEqual(tagFind('tag:#AK::#UWorld'), ['a', 'b']);
  assert.deepEqual(tagFind('tag:#ak::#uworld::step::123'), ['a']);
  assert.deepEqual(tagFind('tag:#uworld'), ['d']);                       // the lone tag, not the one inside #ak
  assert.deepEqual(tagFind('tag:#ak::#u'), []);                          // a path, not a prefix of a name
  assert.deepEqual(tagFind('tag:nothing'), []);
});

test('search: tag: combines with words and with other tag: terms', () => {
  assert.deepEqual(tagFind('lung tag:#ak'), ['a', 'c']);
  assert.deepEqual(tagFind('tag:#ak::#amboss lung'), ['c']);
  assert.deepEqual(tagFind('tag:#ak heart tag:#ak::#uworld'), ['b']);
  assert.deepEqual(tagFind('tag:"#ak::#uworld"'), ['a', 'b']);
  assert.deepEqual(tagFind('tag:'), tagged.map(c => c.id).sort());       // an empty term is no term
  assert.deepEqual(tagFind('TAG:#ak::#amboss'), ['c']);
});

test('parseTagSearch splits the words from the tag terms', async () => {
  const { parseTagSearch } = await import('../js/browse-logic.js');
  const p = parseTagSearch('lung tag:#Ak::X  heart');
  assert.deepEqual([p.text.replace(/\s+/g, ' '), p.tags], ['lung heart', ['#ak::x']]);
  assert.deepEqual(parseTagSearch('xtag:a'), { text: 'xtag:a', tags: [] });        // only a whole word
});

test('renameTagPrefix: moves a folder and everything in it, merging with what exists', async () => {
  const { renameTagPrefix } = await import('../js/browse-logic.js');
  const cs = [card('a', { tags: ['a::b::1', 'a::b::2'] }), card('b', { tags: ['a::b', 'keep'] }), card('c', { tags: ['a::bc'] }), card('d', { tags: ['x::b::1'] }), card('e', { tags: ['z::y::1'] })];
  const out = renameTagPrefix(cs, 'a::b', 'z::y');
  assert.deepEqual(out.map(c => c.id), ['a', 'b']);                       // c (a::bc) and d are not in the folder
  assert.deepEqual(out[0].tags, ['z::y::1', 'z::y::2']);
  assert.deepEqual(out[1].tags, ['z::y', 'keep']);
  // merging: a card that already has the target keeps it once
  const merged = renameTagPrefix([card('m', { tags: ['a::b::1', 'z::y::1'] })], 'a::b', 'z::y');
  assert.deepEqual(merged[0].tags, ['z::y::1']);
  // the target is lower case; the source ignores capitals
  assert.deepEqual(renameTagPrefix([card('n', { tags: ['a::B::1'] })], 'A::b', 'New::Place')[0].tags, ['new::place::1']);
  // a plain tag works too
  assert.deepEqual(renameTagPrefix([card('o', { tags: ['solo'] })], 'solo', 'one')[0].tags, ['one']);
  assert.deepEqual(renameTagPrefix(cs, '', 'x'), []);
});

test('renameTagPrefix: an empty target removes the folder and its tags', async () => {
  const { renameTagPrefix } = await import('../js/browse-logic.js');
  const out = renameTagPrefix([card('a', { tags: ['f::1', 'f', 'other'] }), card('b', { tags: ['other'] })], 'f', '');
  assert.deepEqual(out.map(c => [c.id, c.tags]), [['a', ['other']]]);
});

test('renameTagExact: one tag, matched ignoring capitals and empty pieces; tags below it stay', async () => {
  const { renameTagExact } = await import('../js/browse-logic.js');
  const cs = [card('a', { tags: ['A::B', 'a::b::c'] }), card('b', { tags: ['a::::b'] }), card('c', { tags: ['a::bc'] })];
  const out = renameTagExact(cs, 'a::b', 'x');
  assert.deepEqual(out.map(c => [c.id, c.tags]), [['a', ['x', 'a::b::c']], ['b', ['x']]]);
  assert.deepEqual(renameTagExact(cs, 'a::b', '').map(c => c.tags), [['a::b::c'], []]);
  assert.deepEqual(renameTagExact(cs, '', 'x'), []);
});

// ---- search speed-ups must not change what comes back ----
import { searchMatcher, cardMatcher } from '../js/browse-logic.js';

// The old way, written out: status for all, then tag and text filters, then a sort of what is left.
test('cached search and presorted lists give the same cards in the same order as a plain filter + sort', () => {
  const names = ['Café au lait', 'cafe', 'ΣΊΣΥΦΟΣ', 'C++ pointers', 'c language', 'Zebra 10', 'Zebra 9', 'zebra 2', '🧠 brain', 'か kana', 'が kana'];
  const cards = names.map((f, i) => card(`c${i}`, { front: f, back: `back ${i % 3}`, created: (i * 7) % 5, tags: i % 2 ? ['#a::b', 'x'] : ['y'] }));
  const states = new Map(cards.filter((_, i) => i % 3 === 0).map((c, i) => [c.id, { cardId: c.id, state: 2, due: NOW + i * DAY, lapses: i, difficulty: 5 - i }]));
  const plain = (q, sort) => {
    const m = searchMatcher(q);
    const by = { 'added-new': (a, b) => b.created - a.created, 'added-old': (a, b) => a.created - b.created, az: (a, b) => new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare(a.front, b.front) }[sort];
    return cards.filter(c => !m || m(`${c.front} ${c.back} ${(c.tags || []).join(' ')}`)).sort(by).map(c => c.id);
  };
  for (const sort of ['added-new', 'added-old', 'az'])
    for (const q of ['', 'c', 'caf', 'cafe', 'c++', '+', '🧠', 'kana', 'か', 'zebra', 'σισυφοσ', 'back 1', 'nothing here', 'y'])
      for (let again = 0; again < 2; again++)     // second pass uses the remembered text and order
        assert.deepEqual(ids(browseCards(cards, states, { query: q, sort, now: NOW })), plain(q, sort), `${sort} / ${q}`);
});

test('cardMatcher agrees with searchMatcher and notices a card edited in place', () => {
  const c = card('e', { front: 'Mitosis', back: 'Cell division', tags: ['bio'] });
  const m = cardMatcher('mitosis'), m2 = cardMatcher('osmosis');
  assert.equal(m(c), true); assert.equal(m2(c), false);
  c.front = 'Osmosis';
  assert.equal(m(c), false); assert.equal(m2(c), true);
  c.tags.push('chem'); c.tags = [...c.tags];
  assert.equal(cardMatcher('chem')(c), true);
  assert.equal(cardMatcher('   '), null);
  assert.equal(cardMatcher('?!')(card('q', { front: 'what?!' })), true);
});

test('rangeIds: anchor to target, either direction, inclusive, in shown order', async () => {
  const { rangeIds } = await import('../js/browse-logic.js');
  const v = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rangeIds(v, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(v, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(v, 'c', 'c'), ['c']);
  assert.deepEqual(rangeIds(v, null, 'c'), ['c']);
  assert.deepEqual(rangeIds(v, 'zzz', 'c'), ['c']);        // anchor filtered out: just the target
  assert.deepEqual(rangeIds(v, 'a', 'zzz'), []);           // target not shown
  assert.deepEqual(rangeIds([], 'a', 'b'), []);
  assert.deepEqual(rangeIds(['x', 'c', 'a'], 'x', 'a'), ['x', 'c', 'a']);   // follows the shown order, not id order
});
