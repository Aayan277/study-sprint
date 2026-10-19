// Tests for js/reading-suggest.js (the rows, the summary, the filter and the ticks of "Suggest cards"). Run with: node --test tests/reading-suggest.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toResult, decorate, editCloze, changesOf, applyChanges, summaryHtml, filterOptions, shownBy, rowHtml, kindWord, SUGGESTED_TAG } from '../js/reading-suggest.js';
import { buildCards } from '../js/import.js';

const sugs = [
  { kind: 'definition', type: 'basic', front: 'Osmosis', back: 'the movement of water', source: 'Osmosis is the movement of water.', where: 'Page 3', strong: true, both: false, key: 'definition|osmosis|' },
  { kind: 'acronym', type: 'basic', front: 'ATP', back: 'adenosine triphosphate', source: 'adenosine triphosphate (ATP)', where: '', strong: true, both: true, key: 'acronym|atp|' },
  { kind: 'sentence', type: 'cloze', cloze: 'Water enters by {{c1::osmosis}} and the cell may burst.', front: '', back: '', source: 'Water enters by osmosis and the cell may burst.', where: 'Page 3', strong: false, both: false, key: 'sentence||water' }
];
const cards = (onDeck = () => false) => buildCards(toResult(sugs), 0, 1).map((c, i) => decorate({ ...c, row: i }, sugs[i], onDeck(c)));

test('toResult: the shape buildCards reads, with a suggested tag, both directions and cloze notes', () => {
  const r = toResult(sugs);
  assert.equal(r.format.id, 'suggest');
  assert.deepEqual(r.rows[0], ['Osmosis', 'the movement of water']);
  assert.deepEqual(r.rows[2], ['Water enters by […] and the cell may burst.', 'osmosis']);
  assert.deepEqual(r.clozes, [null, null, { noteKey: 'sug2', n: 1, text: sugs[2].cloze }]);
  assert.deepEqual(r.both, [false, true, false]);
  assert.deepEqual(r.tags, [[SUGGESTED_TAG], [SUGGESTED_TAG], [SUGGESTED_TAG]]);
  const built = buildCards(r);
  assert.deepEqual(built[1].reversed, {}, 'both directions makes a reverse card on save');
  assert.equal(built[0].reversed, undefined);
  assert.equal(built[2].cloze.text, sugs[2].cloze);
  assert.deepEqual(built[0].tags, [SUGGESTED_TAG]);
});

test('decorate: strong suggestions start ticked, unless the deck already has them', () => {
  const c = cards(x => x.front === 'ATP');
  assert.deepEqual(c.map(x => x.pick), [true, false, false]);
  assert.equal(cards()[1].pick, true);
});

test('editCloze: a text with a {{c1::…}} blank stays a card; without one it is skipped', () => {
  const c = cards()[2];
  assert.equal(editCloze(c, 'The {{c1::cell}} bursts in water.'), true);
  assert.equal(c.front, 'The […] bursts in water.');
  assert.equal(c.back, 'cell');
  assert.equal(editCloze(c, 'The cell bursts in water.'), false);
  assert.equal(c.front, '');
  assert.equal(editCloze(c, 'A {{c2::cell}} bursts.'), false, 'only c1 is a card here');
});

test('changes: only the unticked or edited ones are kept, and they come back by key', () => {
  const c = cards();
  assert.deepEqual(changesOf(c), {});
  c[0].pick = false;
  c[1].front = 'Adenosine TP';
  editCloze(c[2], 'Water enters by {{c1::diffusion}}.');
  c[2].pick = true;
  const ch = changesOf(c);
  assert.deepEqual(ch, { 'definition|osmosis|': { pick: false }, 'acronym|atp|': { front: 'Adenosine TP' }, 'sentence||water': { pick: true, cloze: 'Water enters by {{c1::diffusion}}.' } });
  const fresh = cards();
  applyChanges(fresh, JSON.parse(JSON.stringify(ch)));
  assert.deepEqual(fresh.map(x => x.pick), [false, true, true]);
  assert.equal(fresh[1].front, 'Adenosine TP');
  assert.equal(fresh[2].back, 'diffusion');
  applyChanges(fresh, null);
  applyChanges(fresh, { 'no such key': { pick: false } });
  assert.deepEqual(fresh.map(x => x.pick), [false, true, true]);
});

test('changes: no more than 300 are kept', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ kind: 'definition', type: 'basic', front: 'T' + i, back: 'b', source: 's', where: '', strong: true, both: false, key: 'k' + i }));
  const c = buildCards(toResult(many)).map((x, i) => decorate({ ...x, row: i }, many[i], false));
  c.forEach(x => { x.pick = false; });
  assert.equal(Object.keys(changesOf(c)).length, 300);
});

test('summary: what was found, how many are ticked, and the warnings', () => {
  const c = cards();
  const html = summaryHtml({ cards: c, stats: { cut: false, total: 3, shown: 3 } });
  assert.match(html, /^Suggested <b>3 cards<\/b> from your text: 1 definition, 1 abbreviation, 1 key sentence\./);
  assert.match(html, /The strongest <b>2<\/b> are ticked\./);
  assert.match(html, /Check each one: suggestions can be wrong\./);
  assert.match(html, /<b>suggested<\/b> tag/);
  assert.ok(!/very long|Showing the best/.test(html));
  const big = summaryHtml({ cards: c, stats: { cut: true, total: 412, shown: 200 } });
  assert.match(big, /first 600,000 characters/);
  assert.match(big, /Showing the best 200 of 412\./);
  c.forEach(x => { x.pick = false; });
  assert.ok(!/tag so you can find/.test(summaryHtml({ cards: c, stats: null })), 'no tag note when nothing is ticked');
  assert.equal(kindWord('definition', 1), 'definition');
  assert.equal(kindWord('fact', 5), 'numbers or dates');
});

test('filter: All, Ticked and each kind that is there; the shown rows', () => {
  const c = cards();
  assert.deepEqual(filterOptions(c), [{ value: 'all', label: 'All (3)' }, { value: 'ticked', label: 'Ticked (2)' }, { value: 'definition', label: 'Definitions (1)' }, { value: 'acronym', label: 'Abbreviations (1)' }, { value: 'sentence', label: 'Key sentences (1)' }]);
  assert.deepEqual(c.map(x => shownBy(x, 'ticked')), [true, true, false]);
  assert.deepEqual(c.map(x => shownBy(x, 'sentence')), [false, false, true]);
  assert.ok(c.every(x => shownBy(x, 'all')));
});

test('rowHtml: a named tick box, labelled fields, where it came from, and nothing that could run', () => {
  const c = cards();
  const html = rowHtml(c[0], 0);
  assert.match(html, /<li class="prow sug" data-i="0" data-kind="definition">/);
  assert.match(html, /<input type="checkbox" class="pick" checked aria-label="Use card 1: Definition">/);
  assert.match(html, /aria-label="Front of card 1"/);
  assert.match(html, /aria-label="Back of card 1"/);
  assert.match(html, /Where it came from/);
  assert.match(html, /· Page 3/);
  const cloze = rowHtml(c[2], 2);
  assert.match(cloze, /data-side="cloze"/);
  assert.match(cloze, /aria-label="Card 3, fill in the blank\. The hidden words are inside \{\{c1:: and \}\}"/);
  assert.match(cloze, /class="prow sug off"/);
  assert.ok(!/ checked/.test(cloze));
  // text from the notes is escaped
  const evil = { ...c[0], front: '<img src=x onerror=alert(1)>', sug: { ...sugs[0], source: '"><script>x</script>', where: '<b>' } };
  const out = rowHtml(evil, 0);
  assert.ok(!/<img|<script|<b>/.test(out) && !/\son\w+=/.test(out.replace(/&lt;img src=x onerror=/g, '')), out);
});
