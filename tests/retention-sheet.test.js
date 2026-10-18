// Tests for the pure parts of js/retention-sheet.js (QA item 8): distinct axis labels, and no suggestion without enough data.
// (The file draws sheets, so the page pieces it loads are given stand-ins first.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { chartSVG, fmtReviews, enoughData, MIN_STARTED, MIN_REVIEWS, suggestionText, NOT_ENOUGH } = await import('../js/retention-sheet.js');

const pts = [0.75, 0.8, 0.85, 0.9, 0.95, 0.97].map(r => ({ retention: r, v: 0.5 + (r - 0.7) * 10 }));      // 1.0 .. 3.7 reviews a day
const yTicks = svg => [...svg.matchAll(/<text x="[\d.]+" y="[\d.]+" text-anchor="end" class="rc-tick">([^<]*)<\/text>/g)].map(m => m[1]);

test('the Reviews a day chart with a top of 3: labels differ and keep decimals (they used to round to 0, 1, 2, 2, 3)', () => {
  const svg = chartSVG({ points: pts, value: () => 3, yMax: 3, format: fmtReviews, yLabel: 'Reviews a day', id: 't', selected: 0.9, current: 0.9, suggested: null });
  const t = yTicks(svg);
  assert.equal(new Set(t).size, 5, 'ticks differ: ' + t.join(', '));
  assert.deepEqual(t.sort(), ['0', '0.75', '1.5', '2.25', '3'].sort());
  assert.equal(fmtReviews(12.4, true), '12');
  assert.equal(fmtReviews(2.5, false), '2.5 reviews a day');
});
test('axis labels stay distinct for small tops of 1, 2, 3, 5 and 7 reviews a day', () => {
  for (const top of [1, 2, 3, 5, 7]) {
    const svg = chartSVG({ points: pts, value: () => top, format: fmtReviews, yLabel: 'x', id: 't', selected: 0.9, current: 0.9, suggested: null });
    const t = yTicks(svg);
    assert.equal(new Set(t).size, 5, `top ${top}: ${t.join(', ')}`);
  }
});
test('enough data: a minimum of started cards and recent reviews', () => {
  assert.equal(enoughData({ started: MIN_STARTED, reviews: MIN_REVIEWS }), true);
  assert.equal(enoughData({ started: MIN_STARTED - 1, reviews: 500 }), false);
  assert.equal(enoughData({ started: 500, reviews: MIN_REVIEWS - 1 }), false);
  assert.equal(enoughData({ started: 0, reviews: 0 }), false);
  assert.equal(enoughData(null), false);
});
test('the not-enough wording', () => {
  assert.match(NOT_ENOUGH, /Not enough reviews yet to suggest a number/);
  assert.ok(Array.isArray(suggestionText({ kind: 'none', target: null, knee: null, curve: null }, { current: 0.9, reviewLimit: null })));
});
