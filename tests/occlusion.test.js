// Tests for js/occlusion.js (image occlusion). Run with: node tests/occlusion.test.js

import { assertFast, size } from './speed-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOcclusion, hasMasks, groupsOf, groupIndex, occLabel, occFrontBack, validOcclusion, cleanMask,
  parseAnkiOcclusion, toFractions, ankiOcclusionText, planOcclusionSave, occRemovalText, healOcclusion,
  occlusionHTML, occSpeech, occPlace, fitView, zoomAt, clampView, toImage, rectFrom, hitTest, handleAt, moveMask, resizeMask,
  nextN, groupMasks, splitMask, deleteMasks, newH, pushH, undoH, redoH
} from '../js/occlusion.js';

const mask = (id, n, x, y, w, h, extra = {}) => ({ id, n, shape: 'rect', x, y, w, h, ...extra });
const MASKS = [mask('m1', 1, 0.1, 0.1, 0.2, 0.2, { label: 'Aorta' }), mask('m2', 3, 0.5, 0.5, 0.2, 0.2), mask('m3', 3, 0.7, 0.1, 0.1, 0.1, { label: 'Vein' })];
const note = (over = {}) => ({ masks: MASKS, header: 'Heart', w: 2048, h: 1365, image: 'img1', ...over });
const card = (n, over = {}) => ({ id: 'c' + n, noteId: 'N', deckId: 'd', backImage: 'img1', ...occFrontBack({ header: 'Heart', masks: MASKS }, n), occlusion: { n, w: 2048, h: 1365, header: 'Heart', masks: MASKS }, ...over });

// ---------- groups and text ----------
test('groups: numbers sorted, display position k of G (n can have gaps)', () => {
  assert.deepEqual(groupsOf(MASKS), [1, 3]);
  assert.deepEqual(groupIndex(MASKS, 3), { k: 2, total: 2 });
  assert.deepEqual(groupIndex(MASKS, 9), { k: 0, total: 2 });
  assert.equal(occLabel(MASKS, 3), 'Vein');
  assert.equal(occLabel([mask('a', 1, 0, 0, 1, 1, { label: 'X' }), mask('b', 1, 0, 0, 1, 1, { label: 'X' }), mask('c', 1, 0, 0, 1, 1, { label: 'Y' })], 1), 'X, Y');
  assert.deepEqual(occFrontBack({ header: 'Heart', masks: MASKS }, 3), { front: 'Heart: hidden part 2 of 2', back: 'Vein' });
  assert.deepEqual(occFrontBack({ masks: MASKS }, 2), { front: 'Diagram: hidden part 0 of 2', back: '' });
});

test('isOcclusion and hasMasks', () => {
  assert.ok(isOcclusion(card(1)) && hasMasks(card(1)));
  assert.ok(!isOcclusion({ ...card(1), noteId: undefined }));
  assert.ok(!isOcclusion({ ...card(1), occlusion: [] }));
  assert.ok(!isOcclusion({ ...card(1), occlusion: { n: 'x', masks: [] } }));
  assert.ok(isOcclusion(card(2)) && !hasMasks(card(2)));          // its group is gone: shown as an ordinary card
});

// ---------- validation ----------
test('validOcclusion: a table of good and bad data', () => {
  const o = (over = {}, m = {}) => ({ n: 1, w: 100, h: 50, masks: [{ ...mask('a', 1, 0.1, 0.1, 0.5, 0.5), ...m }], ...over });
  assert.ok(validOcclusion(o()));
  assert.ok(validOcclusion(o({ header: 'H' }, { label: 'L', shape: 'ellipse' })));
  assert.ok(validOcclusion(o({}, { x: 0.5, w: 0.5 + 1e-7 })));
  for (const bad of [
    o({ n: 0 }), o({ n: 1.5 }), o({ w: 0 }), o({ h: NaN }), o({ w: '100' }), o({ header: 5 }), o({ masks: [] }), o({ masks: 'x' }),
    o({}, { id: 5 }), o({}, { n: 0 }), o({}, { n: 'a' }), o({}, { shape: 'star' }), o({}, { x: -0.1 }), o({}, { x: 0.6 }), o({}, { y: 0.6 }),
    o({}, { w: 0 }), o({}, { h: Infinity }), o({}, { w: '0.5' }), o({}, { label: 7 }), o({}, { points: [[0, 0], [1, 1]] }), o({}, { points: [[0, 0], [1, 1], [2, 0]] }),
    o({}, { points: [[0, 0], [1, 1], ['a', 0]] }), o({ masks: Array.from({ length: 301 }, (_, i) => mask('m' + i, 1, 0, 0, 0.1, 0.1)) }),
    o({}, { points: Array.from({ length: 201 }, () => [0.1, 0.1]) }), null, [], 'x'
  ]) assert.ok(!validOcclusion(bad), JSON.stringify(bad));
  assert.ok(validOcclusion(o({}, { points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]] })));
});

test('cleanMask: numbers, clamping, empty boxes dropped', () => {
  assert.deepEqual(cleanMask({ id: 'a', n: '2', x: '0.1', y: 0.2, w: '0.3', h: 0.4, label: '  hi ' }), { id: 'a', n: 2, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'hi' });
  assert.deepEqual(cleanMask({ id: 'a', x: 0.9, y: -1, w: 0.5, h: 2 }), { id: 'a', n: 1, shape: 'rect', x: 0.9, y: 0, w: 0.1, h: 1 });
  assert.equal(cleanMask({ id: 'a', x: 1.2, y: 0, w: 0.1, h: 0.1 }), null);
  assert.equal(cleanMask({ id: 'a', x: NaN, y: 0, w: 0.1, h: 0.1 }), null);
  assert.equal(cleanMask({ id: 'a', x: 0, y: 0, w: 0, h: 0.1 }), null);
  const poly = cleanMask({ id: 'p', n: 1, shape: 'polygon', x: 0, y: 0, w: 0, h: 0, points: [[0.2, 0.2], [0.6, 0.2], [0.4, 0.8]] });
  assert.deepEqual([poly.x, poly.y, poly.w, poly.h], [0.2, 0.2, 0.4, 0.6]);           // bounding box from the points
  assert.equal(cleanMask({ id: 'p', shape: 'polygon', x: 0, y: 0, w: 0.5, h: 0.5, points: [[0, 0]] }).shape, 'rect');   // too few corners: a rectangle
  assert.equal(cleanMask({ id: 'p', shape: 'polygon', points: Array.from({ length: 500 }, (_, i) => [i / 500, (i % 7) / 7]) }).points.length, 200);
});

// ---------- Anki ----------
test('parse: rect, ellipse, polygon (bounding box), text skipped', () => {
  const field = '{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.4:oi=1}}'
    + '{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.2:oi=1}}'
    + '{{c3::image-occlusion:polygon:points=0.1,0.1 0.5,0.1 0.3,0.5:oi=1}}'
    + '{{c4::image-occlusion:text:left=.1:top=.1:text=Hello:scale=1}}';
  const { shapes, pixels } = parseAnkiOcclusion(field);
  assert.equal(pixels, false);
  assert.equal(shapes.length, 3);
  assert.deepEqual(shapes[0], { n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.deepEqual(shapes[1], { n: 2, shape: 'ellipse', x: 0.5, y: 0.5, w: 0.2, h: 0.4 });
  assert.equal(shapes[2].shape, 'polygon');
  assert.deepEqual([shapes[2].x, shapes[2].y, shapes[2].w, shapes[2].h], [0.1, 0.1, 0.4, 0.4]);
  assert.deepEqual(shapes[2].points, [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]]);
});

test('parse: a polygon moved in Anki (left/top changed, points not) is shifted to left/top', () => {
  const { shapes } = parseAnkiOcclusion('{{c1::image-occlusion:polygon:left=.3:top=.3:points=.1,.1 .2,.1 .15,.2:oi=1}}');
  assert.equal(round(shapes[0].x), 0.3);
  assert.equal(round(shapes[0].y), 0.3);
  assert.deepEqual([round(shapes[0].w), round(shapes[0].h)], [0.1, 0.1]);
  assert.deepEqual(shapes[0].points.map(p => p.map(round)), [[0.3, 0.3], [0.4, 0.3], [0.35, 0.4]]);
  // no left/top: the points stay where they are
  assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:polygon:points=.1,.1 .2,.1 .15,.2}}').shapes[0].x, 0.1);
});

test('parse: a long run of backslashes is not a slow regex, and \\: and \\} still work', () => {
  assertFast('parseAnkiOcclusion on backslashes', () => {
    assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:rect:' + '\\'.repeat(size(5000))).shapes.length, 0);
    assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:rect:left=.1:' + '\\'.repeat(size(5000)) + 'x').shapes.length, 0);
  });
  assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:foo=a\\:b}}').shapes.length, 1);
  assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:foo=a\\}b}}').shapes.length, 1);
});

test('parse: tags, entities, quotes, escaped colons, several shapes in one cN, missing oi, unknown keys', () => {
  const field = '<div>{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:angle=15:foo=a\\:b}}</div><br>'
    + '{{c1::image-occlusion:rect:left=.5:top=.5:width=.2:height=.2:oi=1}}'
    + '{{c2::image-occlusion:polygon:points=&quot;.1,.1 .5,.1 .3,.5&quot;}}';
  const { shapes } = parseAnkiOcclusion(field);
  assert.equal(shapes.length, 3);
  assert.deepEqual(shapes.map(s => s.n), [1, 1, 2]);
  assert.deepEqual(shapes[2].points.length, 3);
  const amp = parseAnkiOcclusion('&#123;&#123;c1::image-occlusion:rect:left=.1&amp;:top=.1:width=.2:height=.2&#125;&#125;');
  assert.equal(amp.shapes.length, 0);                          // "left=.1&" is not a number
  assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}').shapes.length, 1);
});

test('parse: bad numbers and unknown shapes are dropped', () => {
  const { shapes } = parseAnkiOcclusion('{{c1::image-occlusion:rect:left=abc:top=.1:width=.2:height=.2}}{{c2::image-occlusion:rect:left=.1:top=.1:width=0:height=.2}}'
    + '{{c3::image-occlusion:rect:left=.1:top=.1:width=.2}}{{c4::image-occlusion:star:left=.1}}{{c5::image-occlusion:polygon:points=.1,.1 .2,.2}}{{c6::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}');
  assert.deepEqual(shapes.map(s => s.n), [6]);
  assert.deepEqual(parseAnkiOcclusion(''), { shapes: [], pixels: false });
  assert.deepEqual(parseAnkiOcclusion(null), { shapes: [], pixels: false });
});

test('pixels: any coordinate above 1 makes the whole note pixels', () => {
  const both = parseAnkiOcclusion('{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}{{c2::image-occlusion:rect:left=150:top=20:width=40:height=30}}');
  assert.equal(both.pixels, true);
  assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:rect:left=1:top=0.5:width=0.5:height=0.5}}').pixels, false);
  assert.equal(parseAnkiOcclusion('{{c1::image-occlusion:polygon:points=10,10 50,10 30,50}}').pixels, true);
});

test('toFractions: fractions pass through, pixels are divided by the original size, results are clamped', () => {
  const frac = toFractions(parseAnkiOcclusion('{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.4}}').shapes, false, 100, 100);
  assert.deepEqual(frac, [{ id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
  const px = toFractions([{ n: 2, shape: 'rect', x: 300, y: 100, w: 600, h: 200 }, { n: 2, shape: 'rect', x: 2900, y: 0, w: 500, h: 10 }, { n: 3, shape: 'rect', x: 5000, y: 0, w: 5, h: 5 }], true, 3000, 2000);
  assert.deepEqual(px.map(m => m.id), ['m1', 'm2']);                // the third is outside the picture
  assert.deepEqual([px[0].x, px[0].y, px[0].w, px[0].h], [0.1, 0.05, 0.2, 0.1]);
  assert.equal(px[1].w, round(1 - 2900 / 3000));                  // clamped at the edge
  assert.deepEqual(toFractions([{ n: 1, shape: 'rect', x: 1, y: 1, w: 1, h: 1 }], true, 0, 0), []);
  const poly = toFractions([{ n: 1, shape: 'polygon', x: 10, y: 10, w: 40, h: 40, points: [[10, 10], [50, 10], [30, 50]] }], true, 100, 100);
  assert.deepEqual(poly[0].points, [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]]);
  assert.ok(validOcclusion({ n: 1, w: 100, h: 100, masks: poly }));
});
const round = v => Math.round(v * 1e5) / 1e5;

test('ankiOcclusionText: Anki format, and it round trips within 1e-4', () => {
  const masks = [mask('a', 1, 0.123456, 0.5, 0.25, 0.1), mask('b', 2, 0.1, 0.2, 0.4, 0.6, { shape: 'ellipse' }),
    { id: 'c', n: 3, shape: 'polygon', x: 0.1, y: 0.1, w: 0.4, h: 0.4, points: [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]] }];
  const text = ankiOcclusionText(masks);
  assert.ok(text.startsWith('{{c1::image-occlusion:rect:left=.1235:top=.5000:width=.2500:height=.1000:oi=1}}'));
  assert.ok(text.includes('{{c2::image-occlusion:ellipse:left=.1000:top=.2000:rx=.2000:ry=.3000:oi=1}}'));
  // Anki always writes left/top, and draws a polygon offset by (left - minX, top - minY)
  assert.ok(text.includes('{{c3::image-occlusion:polygon:left=.1000:top=.1000:points=.1000,.1000 .5000,.1000 .3000,.5000:oi=1}}'));
  const back = toFractions(parseAnkiOcclusion(text).shapes, false, 1, 1);
  assert.equal(back.length, 3);
  // left/top are read too: moving only left/top moves the polygon, like Anki's editor does
  const moved = parseAnkiOcclusion(text.replace('polygon:left=.1000:top=.1000', 'polygon:left=.3000:top=.2000')).shapes[2];
  assert.deepEqual([moved.x, moved.y].map(round), [0.3, 0.2]);
  assert.deepEqual(moved.points.map(p => p.map(round)), [[0.3, 0.2], [0.7, 0.2], [0.5, 0.6]]);
  masks.forEach((m, i) => { for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(back[i][k] - m[k]) <= 1e-4, `${i} ${k}`); assert.equal(back[i].n, m.n); assert.equal(back[i].shape, m.shape); });
});

// ---------- saving ----------
test('plan: a new note makes one card per group', () => {
  const plan = planOcclusionSave([], note());
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.add.map(c => c.occlusion.n), [1, 3]);
  assert.equal(plan.add[0].front, 'Heart: hidden part 1 of 2');
  assert.equal(plan.add[1].back, 'Vein');
  assert.ok(plan.add.every(c => c.backImage === 'img1' && c.occlusion.w === 2048 && c.occlusion.h === 1365 && c.occlusion.masks === MASKS && c.occlusion.header === 'Heart'));
  assert.deepEqual([plan.update, plan.remove, plan.duplicates], [[], [], []]);
  assert.equal(planOcclusionSave([], note({ header: '  ' })).add[0].occlusion.header, undefined);
});

test('plan: moving and relabelling keeps the card (same id, schedule stays)', () => {
  const old = [card(1), card(3)];
  const moved = MASKS.map(m => (m.id === 'm1' ? { ...m, x: 0.2, label: 'Aortic arch' } : m));
  const plan = planOcclusionSave(old, note({ masks: moved, image: 'img2', w: 1000, h: 500 }));
  assert.deepEqual(plan.update.map(c => c.id), ['c1', 'c3']);
  assert.equal(plan.update[0].back, 'Aortic arch');
  assert.ok(plan.update.every(c => c.backImage === 'img2' && c.occlusion.w === 1000 && c.occlusion.h === 500 && c.noteId === 'N'));
  assert.deepEqual([plan.add, plan.remove], [[], []]);
});

test('plan: a deleted group removes its card, a new group adds one, merging removes the other', () => {
  const old = [card(1), card(3)];
  const noThree = planOcclusionSave(old, note({ masks: MASKS.filter(m => m.n !== 3) }));
  assert.deepEqual(noThree.remove.map(c => c.id), ['c3']);
  assert.equal(noThree.duplicates.length, 0);
  const four = planOcclusionSave(old, note({ masks: [...MASKS, mask('m4', 4, 0.8, 0.8, 0.1, 0.1)] }));
  assert.deepEqual(four.add.map(c => c.occlusion.n), [4]);
  assert.equal(four.add[0].front, 'Heart: hidden part 3 of 3');
  const merged = planOcclusionSave(old, note({ masks: MASKS.map(m => (m.n === 3 ? { ...m, n: 1 } : m)) }));
  assert.deepEqual(merged.update.map(c => c.id), ['c1']);
  assert.deepEqual(merged.remove.map(c => c.id), ['c3']);
});

test('plan: duplicates (same n twice, or a card without boxes) are removed; the higher score stays', () => {
  const dup = card(1, { id: 'c1b' });
  const plain = { id: 'p', noteId: 'N', front: 'x', back: 'y' };
  const plan = planOcclusionSave([card(1), dup, plain], note(), c => (c.id === 'c1b' ? 5 : 0));
  assert.deepEqual(plan.update.map(c => c.id).sort(), ['c1b']);
  assert.deepEqual(plan.duplicates.map(c => c.id).sort(), ['c1', 'p']);
  assert.ok(plan.duplicates.every(c => plan.remove.includes(c)));
});

test('plan: errors', () => {
  assert.match(planOcclusionSave([], note({ masks: [] })).error, /Draw at least one box/);
  assert.match(planOcclusionSave([], note({ masks: undefined })).error, /Draw at least one box/);
  assert.match(planOcclusionSave([], note({ image: null })).error, /Choose a picture/);
  assert.ok(planOcclusionSave([], note({ masks: [mask('a', 1, 0.9, 0.9, 0.5, 0.5)] })).error);
  assert.ok(planOcclusionSave([], note({ w: 0 })).error);
  assert.deepEqual(planOcclusionSave([], note({ masks: [] })).update, []);
});

test('removal text uses display positions', () => {
  const old = [card(1), card(3)];
  const plan = planOcclusionSave(old, note({ masks: MASKS.filter(m => m.n !== 3) }));
  assert.equal(occRemovalText(plan), 'Box 2 was removed: its card and review history go too.');
  const none = planOcclusionSave(old, note({ masks: [mask('z', 9, 0.1, 0.1, 0.1, 0.1)] }));
  assert.equal(occRemovalText(none), 'Boxes 1 and 2 were removed: their cards and review history go too.');
  const dup = planOcclusionSave([card(1), card(1, { id: 'x' }), card(3)], note());
  assert.match(occRemovalText(dup), /^Duplicate box 1 removed: its card/);
  const both = { remove: [card(3), { ...card(1, { id: 'x' }) }], duplicates: [card(1, { id: 'x' })] };
  both.remove[1] = both.duplicates[0];
  assert.match(occRemovalText(both), /^Box 2 was removed and duplicate box 1 removed: their cards/);
});

// ---------- healing ----------
test('heal: the newest edit wins; siblings keep their own n; a gone n is left alone', () => {
  const edited = MASKS.map(m => (m.id === 'm1' ? { ...m, label: 'Aortic arch' } : m));
  const a = card(1, { noteEditedAt: 100 }), b = card(3, { noteEditedAt: 200, occlusion: { ...card(3).occlusion, masks: edited } });
  const fixed = healOcclusion([a, b]);
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].id, 'c1');
  assert.equal(fixed[0].back, 'Aortic arch');
  assert.equal(fixed[0].occlusion.n, 1);
  assert.equal(fixed[0].noteEditedAt, 200);
  assert.deepEqual(healOcclusion([card(1), card(3)]), []);                             // already agree
  const gone = card(1, { noteEditedAt: 100 }), winner = card(3, { noteEditedAt: 200, ...occFrontBack({ header: 'Heart', masks: MASKS.filter(m => m.n === 3) }, 3), occlusion: { ...card(3).occlusion, masks: MASKS.filter(m => m.n === 3) } });
  assert.deepEqual(healOcclusion([gone, winner]), []);                                 // group 1 no longer exists in the winner
});

test('heal: picture, extra, ties and cards without stamps', () => {
  const a = card(1, { updatedAt: 5 }), b = card(3, { updatedAt: 9, backImage: 'img9', noteExtra: 'Note' });
  const fixed = healOcclusion([a, b]);
  assert.equal(fixed[0].backImage, 'img9');
  assert.equal(fixed[0].noteExtra, 'Note');
  assert.equal(fixed[0].noteEditedAt, undefined);                                      // never invents a time
  const tieA = card(1, { noteEditedAt: 5, noteExtra: 'x' }), tieB = card(3, { noteEditedAt: 5, noteExtra: 'y' });
  assert.equal(healOcclusion([tieA, tieB])[0].noteExtra, 'y');                         // the larger id (c3) wins
  assert.deepEqual(healOcclusion([{ id: 'q', noteId: 'N', front: 'a', back: 'b' }]), []);
});

test('heal: siblings that differ only in key order are already in agreement', () => {
  const reorder = m => Object.fromEntries(Object.entries(m).reverse());
  const a = card(1), b = card(3, { occlusion: { ...card(3).occlusion, masks: MASKS.map(reorder), h: 1365 } });
  b.occlusion = Object.fromEntries(Object.entries(b.occlusion).reverse());
  assert.deepEqual(healOcclusion([a, b]), []);
});

test('heal: a missing picture never wins and never strips the siblings', () => {
  // the newest edit has lost its backImage: the card that still has one wins, and nobody is left without a picture
  const edited = MASKS.map(m => (m.id === 'm1' ? { ...m, label: 'Arch' } : m));
  const a = card(1, { noteEditedAt: 100 }), b = card(3, { noteEditedAt: 200, backImage: undefined, occlusion: { ...card(3).occlusion, masks: edited } });
  const fixed = healOcclusion([a, b]);
  assert.deepEqual(fixed.map(f => [f.id, f.backImage]), [['c3', 'img1']]);
  // the winner has a picture: it is given to a sibling that has none
  assert.equal(healOcclusion([card(1, { updatedAt: 1, backImage: undefined }), card(3, { updatedAt: 9 })])[0].backImage, 'img1');
  // nobody has one: nothing is invented
  assert.ok(healOcclusion([card(1, { backImage: undefined }), card(3, { backImage: undefined, noteExtra: 'x' })]).every(f => f.backImage === undefined));
  // same noteEditedAt: the later updatedAt wins, then the larger id
  const e = card(1, { noteEditedAt: 5, updatedAt: 9, noteExtra: 'late' }), f = card(3, { noteEditedAt: 5, updatedAt: 1, noteExtra: 'early' });
  assert.equal(healOcclusion([e, f])[0].noteExtra, 'late');
});

test('helpers survive junk entries in the masks (from pulled sync data)', () => {
  const junk = [null, 5, 'x', ...MASKS];
  assert.equal(occLabel(junk, 1), 'Aorta');
  assert.deepEqual(groupsOf(junk), [1, 3]);
  assert.equal(hitTest(junk, 0.15, 0.15)?.id, 'm1');
  assert.equal(nextN(junk), 4);
  assert.equal(deleteMasks(junk, ['m1']).length, 5);
  assert.equal(splitMask(junk, 'm3').find(m => m?.id === 'm3').n, 4);
  assert.equal(groupMasks(junk, ['m1', 'm2']).find(m => m?.id === 'm2').n, 1);
  assert.ok(occlusionHTML(card(1, { occlusion: { ...card(1).occlusion, masks: junk } }), 'back').includes('occ-reveal'));
});

test('a note with more than 300 boxes fails validOcclusion (the importer then makes a plain picture)', () => {
  const many = Array.from({ length: 301 }, (_, i) => mask('m' + i, 1, 0.1, 0.1, 0.1, 0.1));
  assert.equal(validOcclusion({ n: 1, w: 100, h: 100, masks: many }), false);
  assert.equal(validOcclusion({ n: 1, w: 100, h: 100, masks: many.slice(0, 300) }), true);
});

// ---------- showing ----------
test('HTML front: the active group asks, the others are hidden from screen readers', () => {
  const html = occlusionHTML(card(3), 'front');
  assert.match(html, /<figure class="occ occ-front" style="aspect-ratio:2048 \/ 1365;--ar:1\.5004" role="group" aria-label="Heart: 2 hidden parts">/);
  assert.match(html, /data-media="img1"/);
  assert.equal((html.match(/occ-ask/g) || []).length, 2);                               // m2 and m3 are both group 3
  assert.match(html, /role="img" aria-label="Hidden part 2 of 2, centre: name this part"/);
  assert.match(html, /left:10\.000%;top:10\.000%;width:20\.000%;height:20\.000%/);
  assert.match(html, /aria-hidden="true"><\/div>/);
  assert.match(html, /class="occ-zoom"/);
  assert.ok(!occlusionHTML(card(3), 'front', { zoom: false }).includes('occ-zoom'));
  assert.ok(!html.includes('occ-tag'));
});

test('HTML back: the group is uncovered with its label, the others stay covered', () => {
  const html = occlusionHTML(card(1), 'back');
  assert.match(html, /occ-mask occ-reveal/);
  assert.match(html, /aria-label="Answer: Aorta"/);
  assert.match(html, /<span class="occ-tag" aria-hidden="true" style="left:20\.000%;transform:translateX\(-20\.000%\);top:30\.000%">Aorta<\/span>/);
  assert.equal((html.match(/class="occ-mask"/g) || []).length, 2);
  assert.match(occlusionHTML(card(3, { occlusion: { ...card(3).occlusion, masks: [mask('m', 3, 0.1, 0.1, 0.2, 0.2), mask('o', 4, 0.5, 0.5, 0.2, 0.2)] } }), 'back'), /aria-label="Uncovered part 1 of 2"/);
  const low = occlusionHTML(card(1, { occlusion: { ...card(1).occlusion, masks: [mask('m', 1, 0.3, 0.8, 0.2, 0.2, { label: 'Low' })] } }), 'back');
  assert.match(low, /occ-tag occ-tag-up/);
  assert.match(low, /transform:translate\(-40\.000%,-100%\)/);
  // near the edges the centre is clamped to 15%..85% and the tag is pulled back by its own width
  const edge = x => occlusionHTML(card(1, { occlusion: { ...card(1).occlusion, masks: [mask('m', 1, x, 0.1, 0.04, 0.1, { label: 'E' })] } }), 'back');
  assert.match(edge(0.02), /left:15\.000%;transform:translateX\(-15\.000%\)/);
  assert.match(edge(0.94), /left:85\.000%;transform:translateX\(-85\.000%\)/);
});

test('HTML all: every box numbered by display position, this card highlighted', () => {
  const html = occlusionHTML(card(3), 'all', { zoom: false });
  assert.match(html, /occ-all/);
  assert.match(html, /<span class="occ-num">2<\/span>/);
  assert.match(html, /<span class="occ-num">1<\/span>/);
});

test('HTML: user text is escaped, bad numbers and unknown shapes never reach the style', () => {
  const evil = card(1, { backImage: '"><img src=x onerror=1>', occlusion: { n: 1, w: 100, h: 100, header: '<script>alert(1)</script>', masks: [
    mask('a', 1, 0.1, 0.1, 0.2, 0.2, { label: '<b>"x"</b>' }),
    { id: 'b', n: 1, shape: 'rect', x: '0.1;background:url(x)', y: 0, w: 0.1, h: 0.1 },
    { id: 'c', n: 1, shape: 'rect', x: NaN, y: 0, w: 0.1, h: 0.1 },
    { id: 'd', n: 1, shape: 'star;x', x: 0, y: 0, w: 0.1, h: 0.1 }] } });
  for (const side of ['front', 'back', 'all']) {
    const html = occlusionHTML(evil, side);
    assert.ok(!html.includes('<script>') && !html.includes('<b>') && !html.includes('<img src=x'), side);
    assert.ok(!html.includes('url(') && !html.includes('NaN') && !html.includes('star'), side);
    assert.equal((html.match(/class="occ-mask/g) || []).length, 1, side);
  }
  assert.match(occlusionHTML(evil, 'back'), /Answer: &lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
});

test('HTML: ellipse radius, polygon clip-path in percent of its box, no size means no aspect-ratio', () => {
  const o = { n: 1, header: 'H', masks: [{ id: 'e', n: 1, shape: 'ellipse', x: 0, y: 0, w: 0.5, h: 0.5 }, { id: 'p', n: 1, shape: 'polygon', x: 0.2, y: 0.2, w: 0.4, h: 0.4, points: [[0.2, 0.2], [0.6, 0.2], [0.4, 0.6]] }] };
  const html = occlusionHTML({ backImage: 'i', occlusion: o }, 'front');
  assert.match(html, /border-radius:50%/);
  assert.match(html, /clip-path:polygon\(0\.00% 0\.00%,100\.00% 0\.00%,50\.00% 100\.00%\)/);
  assert.ok(!html.includes('aspect-ratio') && html.includes('occ-flow'));
  const bad = occlusionHTML({ occlusion: { ...o, masks: [{ ...o.masks[1], points: [[0.2, 'x'], [0.6, 0.2], [0.4, 0.6]] }] } }, 'front');
  assert.ok(!bad.includes('clip-path'));                                                // bad points: a plain box
});

test('speech', () => {
  assert.equal(occSpeech(card(3), false), 'Heart. What is hidden part 2 of 2?');
  assert.equal(occSpeech(card(3), true), 'Vein');
  assert.equal(occSpeech(card(1, { occlusion: { ...card(1).occlusion, header: undefined, masks: [mask('a', 1, 0, 0, 1, 1)] } }), true), 'Part 1 of 1');
  assert.equal(occSpeech(card(1, { occlusion: { ...card(1).occlusion, header: undefined } }), false), 'What is hidden part 1 of 2?');
});

// ---------- geometry ----------
test('view: fit, zoom keeps the point under the cursor, clamp, toImage round trip', () => {
  const v = fitView(400, 300, 2000, 1000);
  assert.deepEqual([v.cw, v.ch, v.s, v.x, v.y], [400, 200, 1, 0, 50]);
  const z = zoomAt(v, 4, 100, 120);
  assert.equal(z.s, 4);
  const before = toImage(v, 100, 120, v.cw, v.ch), after = toImage(z, 100, 120, v.cw, v.ch);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAt(v, 20, 0, 0).s, 8);
  assert.equal(zoomAt(z, 0.2, 0, 0).s, 1);
  const lost = clampView({ ...z, x: -99999, y: 99999 }, 400, 300, v.cw, v.ch);
  assert.ok(lost.x <= 400 - 0.4 * 400 && lost.x >= 0.4 * 400 - 1600);                    // still 40% on screen
  assert.ok(lost.y <= 300 - 0.4 * 300);
  assert.deepEqual(clampView(z, 400, 300, v.cw, v.ch), z);                              // fine as it is
  const p = toImage(z, 250, 90, v.cw, v.ch);
  assert.ok(Math.abs(z.x + p.x * z.s * v.cw - 250) < 1e-9 && Math.abs(z.y + p.y * z.s * v.ch - 90) < 1e-9);
});

test('rectFrom: any corner first, kept inside the picture', () => {
  assert.deepEqual(rectFrom({ x: 0.5, y: 0.6 }, { x: 0.2, y: 0.1 }), { x: 0.2, y: 0.1, w: 0.3, h: 0.5 });
  const r = rectFrom({ x: -0.5, y: 0.5 }, { x: 0.5, y: 1.7 });
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0.5, 0.5, 0.5]);
});

test('hitTest: topmost wins; ellipses and polygons by shape', () => {
  const list = [mask('a', 1, 0, 0, 0.5, 0.5), mask('b', 2, 0.25, 0.25, 0.5, 0.5)];
  assert.equal(hitTest(list, 0.3, 0.3).id, 'b');
  assert.equal(hitTest(list, 0.1, 0.1).id, 'a');
  assert.equal(hitTest(list, 0.9, 0.9), null);
  const el = { id: 'e', n: 1, shape: 'ellipse', x: 0, y: 0, w: 1, h: 1 };
  assert.ok(hitTest([el], 0.5, 0.5) && !hitTest([el], 0.05, 0.05));
  const tri = { id: 't', n: 1, shape: 'polygon', x: 0, y: 0, w: 1, h: 1, points: [[0, 0], [1, 0], [0.5, 1]] };
  assert.ok(hitTest([tri], 0.5, 0.2) && !hitTest([tri], 0.05, 0.9) && !hitTest([tri], 0.95, 0.9));
});

test('handleAt: the corner under the point', () => {
  const m = mask('a', 1, 0.2, 0.2, 0.4, 0.4);
  assert.equal(handleAt(m, 0.21, 0.19, 0.03, 0.03), 'nw');
  assert.equal(handleAt(m, 0.6, 0.2, 0.03, 0.03), 'ne');
  assert.equal(handleAt(m, 0.2, 0.6, 0.03, 0.03), 'sw');
  assert.equal(handleAt(m, 0.59, 0.61, 0.03, 0.03), 'se');
  assert.equal(handleAt(m, 0.4, 0.4, 0.03, 0.03), null);
});

test('move and resize: clamped, corners swap when dragged past the other side', () => {
  const m = mask('a', 1, 0.2, 0.2, 0.4, 0.4);
  assert.deepEqual([moveMask(m, 0.1, -0.5).x, moveMask(m, 0.1, -0.5).y], [0.3, 0]);
  assert.equal(moveMask(m, 5, 0).x, 0.6);
  const tri = { ...m, shape: 'polygon', points: [[0.2, 0.2], [0.6, 0.2], [0.4, 0.6]] };
  assert.deepEqual(moveMask(tri, 0.1, 0).points[0], [0.3, 0.2]);
  const se = resizeMask(m, 'se', 0.8, 0.9);
  assert.deepEqual([se.x, se.y, se.w, se.h], [0.2, 0.2, 0.6, 0.7]);
  const flipped = resizeMask(m, 'se', 0.1, 0.1);                                        // past the north-west corner
  assert.deepEqual([flipped.x, flipped.y, flipped.w, flipped.h], [0.1, 0.1, 0.1, 0.1]);
  const nw = resizeMask(m, 'nw', 0.1, 0.0);
  assert.deepEqual([nw.x, nw.y, nw.w, nw.h], [0.1, 0, 0.5, 0.6]);
  const tiny = resizeMask(m, 'se', 0.2, 0.2, 0.05, 0.05);
  assert.deepEqual([tiny.w, tiny.h], [0.05, 0.05]);
  const out = resizeMask(m, 'se', 3, 3);
  assert.deepEqual([out.w, out.h], [0.8, 0.8]);
  const pr = resizeMask(tri, 'se', 1, 1);
  assert.deepEqual(pr.points[1], [1, 0.2]);                                             // scaled with the box
});

test('editing the list: next number never reused, group, split, delete', () => {
  assert.equal(nextN(MASKS, 0), 4);
  assert.equal(nextN(MASKS, 10), 11);
  assert.equal(nextN([], 0), 1);
  const g = groupMasks(MASKS, ['m1', 'm2']);
  assert.deepEqual(g.map(m => m.n), [1, 1, 3]);
  assert.deepEqual(groupMasks(MASKS, ['nope']), MASKS);
  // the first box picked keeps its number, not the lowest; preferN wins when it is among them
  assert.deepEqual(groupMasks(MASKS, ['m2', 'm1']).map(m => m.n), [3, 3, 3]);
  assert.deepEqual(groupMasks(MASKS, ['m2', 'm1'], 1).map(m => m.n), [1, 1, 3]);
  assert.deepEqual(groupMasks(MASKS, ['m1', 'm2'], 7).map(m => m.n), [1, 1, 3]);
  const s = splitMask(g, 'm2', 3);
  assert.deepEqual(s.map(m => m.n), [1, 4, 3]);
  assert.deepEqual(deleteMasks(MASKS, ['m1', 'm3']).map(m => m.id), ['m2']);
});

test('history: push, undo, redo, a new push clears redo, capped at 100', () => {
  let h = newH([]);
  h = pushH(h, [1]); h = pushH(h, [1, 2]);
  assert.deepEqual(h.present, [1, 2]);
  h = undoH(h); assert.deepEqual(h.present, [1]);
  h = undoH(h); assert.deepEqual(h.present, []);
  assert.equal(undoH(h), h);
  h = redoH(h); assert.deepEqual(h.present, [1]);
  h = pushH(h, [9]); assert.deepEqual(h.future, []);
  assert.equal(redoH(h), h);
  for (let i = 0; i < 150; i++) h = pushH(h, [i]);
  assert.equal(h.past.length, 100);
});

// ---------- where a part is, in words ----------
test('occPlace: the middle of the group on a 3 x 3 grid (never the other cards\' labels)', () => {
  assert.deepEqual(occPlace(MASKS, 1), { where: 'upper left' });
  assert.deepEqual(occPlace(MASKS, 3), { where: 'centre' });
  const m = [mask('a', 1, 0.8, 0.8, 0.1, 0.1), mask('b', 2, 0.4, 0.05, 0.2, 0.1, { label: 'Top' }), mask('c', 3, 0.05, 0.45, 0.1, 0.1), mask('d', 4, 0.9, 0.5, 0.05, 0.05)];
  assert.deepEqual(occPlace(m, 1), { where: 'lower right' });
  assert.equal(occPlace(m, 2).where, 'upper middle');
  assert.equal(occPlace(m, 3).where, 'middle left');
  assert.equal(occPlace(m, 4).where, 'middle right');
  assert.deepEqual(occPlace(m, 9), { where: '' });
  assert.deepEqual(occPlace([mask('a', 1, 0, 0, 1, 1)], 1), { where: 'centre' });
  assert.equal(occPlace([null, 5, ...m], 2).where, 'upper middle');                              // junk entries are skipped
});

test('HTML front: the position is in the asked box name; a header shown by the page is not repeated in the picture name', () => {
  const html = occlusionHTML(card(1), 'front', { headed: true });
  assert.match(html, /aria-label="Hidden part 1 of 2, upper left: name this part"/);
  assert.match(html, /aria-label="Picture: 2 hidden parts"/);
  assert.match(html, /alt=""/);
  assert.ok(!html.includes('Heart'));
  assert.match(occlusionHTML(card(1), 'front'), /alt="Heart"/);
  const alone = occlusionHTML(card(1, { occlusion: { ...card(1).occlusion, masks: [mask('a', 1, 0.1, 0.1, 0.2, 0.2)] } }), 'front');
  assert.match(alone, /aria-label="Hidden part 1 of 1, upper left: name this part"/);
  assert.ok(!occlusionHTML(card(1), 'front').includes('Vein'));                                  // other cards' answers are not given away
});
