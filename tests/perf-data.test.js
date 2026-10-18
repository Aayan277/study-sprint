// Tests for the data-layer speed-ups: the short review-log read Today does (recentHistoryEnough), and the quick size check
// for cards (quota.js certainlyFits), which must never change an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentHistoryEnough, recentHistoryFrom, typicalCardMs, rescueState } from '../js/study-data.js';
import { daysAgoStart } from '../js/stats-calc.js';
import { dayStart } from '../js/days.js';
import { rowBytes, splitTooBig, savedTooBigNote, MAX_ROW_BYTES } from '../js/quota.js';

let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const DAY = 86400000;

// ---------- Today's review log: two weeks when they say enough, else 60 days ----------
// A random 60 days of reviews: study sessions of cards 3 to 60 seconds apart, on some days, plus a few Play answers.
function randomLog(now) {
  const rows = [];
  const busy = rnd(), skip = rnd() < 0.3 ? rnd() * 0.06 : rnd() * 0.8, lull = rnd() < 0.3 ? Math.floor(rnd() * 50) : -1;     // a long break somewhere
  for (let d = 0; d < 62; d++) {
    if (rnd() < skip && d > 0) continue;
    if (lull >= 0 && d >= lull && d < lull + 12) continue;
    const start = daysAgoStart(d, now) + Math.floor(rnd() * 16) * 3600000 + 5 * 3600000;
    let t = start;
    const n = Math.floor(rnd() * 90 * (0.1 + busy));
    for (let i = 0; i < n; i++) {
      t += rnd() < 0.1 ? 5000 + rnd() * 300000 : [1000, 2000, 2500, 8000, 9000, 12000, 15000, 15000, 30000, 44999, 45000, 45001][Math.floor(rnd() * 12)] + Math.floor(rnd() * 3000);
      rows.push({ timestamp: Math.floor(t), source: rnd() < 0.85 ? 'review' : 'play', cardId: 'c' + i });
    }
  }
  // Rows straddling the edge of the two weeks (a pair of reviews 20 to 44 seconds apart on either side of it).
  if (rnd() < 0.5) { const edge = now - 14 * DAY; rows.push({ timestamp: edge - 20000, source: 'review' }, { timestamp: edge + 5000, source: 'review' }); }
  return rows.filter(r => r.timestamp <= now).sort((a, b) => a.timestamp - b.timestamp);
}

test('when the last two weeks say enough, the 60 days give the same time estimate and catch-up numbers', () => {
  let enough = 0, notEnough = 0;
  for (let round = 0; round < 400; round++) {
    const now = Date.now() - Math.floor(rnd() * 20 * DAY);
    const full = randomLog(now).filter(l => l.timestamp >= daysAgoStart(60, now));
    const short = full.filter(l => l.timestamp >= recentHistoryFrom(now));
    if (!recentHistoryEnough(short, now)) { notEnough++; continue; }
    enough++;
    assert.equal(typicalCardMs(short, now), typicalCardMs(full, now), 'time per card, round ' + round);
    const data = h => ({ settings: {}, cards: [], statesById: new Map(), exempt: new Set(), history: h });
    const a = rescueState(data(short), now), b = rescueState(data(full), now);
    assert.deepEqual(a, b, 'catch-up state, round ' + round);
  }
  assert.ok(enough > 40 && notEnough > 40, `both cases should come up (${enough} enough, ${notEnough} not)`);
});

test('too few gaps or study days in two weeks: more is read', () => {
  const now = Date.now();
  assert.equal(recentHistoryEnough([], now), false);
  // 14 study days with no two reviews close together: enough days, too few gaps
  const sparse = Array.from({ length: 14 }, (_, i) => ({ timestamp: daysAgoStart(i + 1, now) + 6 * 3600000, source: 'review' }));
  assert.equal(recentHistoryEnough(sparse, now), false);
  // 30 reviews 10 s apart on one day: enough gaps, one study day
  const oneDay = Array.from({ length: 30 }, (_, i) => ({ timestamp: daysAgoStart(1, now) + 6 * 3600000 + i * 10000, source: 'review' }));
  assert.equal(recentHistoryEnough(oneDay, now), false);
  // both
  const both = [...sparse, ...oneDay];
  assert.equal(recentHistoryEnough(both, now), true);
  // today's study does not count as one of the 14 days
  const today = [...oneDay.slice(0, 0), ...Array.from({ length: 13 }, (_, i) => ({ timestamp: daysAgoStart(i + 1, now) + 6 * 3600000, source: 'review' })), ...Array.from({ length: 30 }, (_, i) => ({ timestamp: dayStart(now) + 5 * 3600000 + i * 10000 > now ? now - 1000 - i * 10000 : dayStart(now) + 5 * 3600000 + i * 10000, source: 'review' }))];
  assert.equal(recentHistoryEnough(today, now), false);
});

// ---------- the quick size check ----------
// The exact count that was used for every card before the quick check.
const exact = (r, extra = {}) => {
  const { updatedAt, syncedAt, ...data } = { ...r, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined || v === '') delete data[k];
  return rowBytes({ data });
};
const CHARS = ['a', 'b', ' ', 'é', 'ß', 'ж', '漢', 'か', '😀', '𝒳', '"', '\\', '\n', '\t', '\u0001', '\u001f', '<', 'é'];
const text = n => { let s = ''; for (let i = 0; i < n; i++) s += CHARS[Math.floor(rnd() * CHARS.length)]; return s; };

test('the quick size check never changes which cards are too large', () => {
  let tooBig = 0, fits = 0;
  for (let round = 0; round < 3000; round++) {
    const max = [60, 120, 400, 1000, 5000, MAX_ROW_BYTES][Math.floor(rnd() * 6)];
    const card = { id: text(5), front: text(Math.floor(rnd() * max / 3)), back: text(Math.floor(rnd() * max / 3)), tags: Array.from({ length: Math.floor(rnd() * 5) }, () => text(4)), created: 1, updatedAt: 5, syncedAt: 6 };
    if (rnd() < 0.3) card.noteFields = [{ n: text(3), v: text(Math.floor(rnd() * max / 5)) }];
    if (rnd() < 0.2) card.skip = undefined;
    const extra = rnd() < 0.3 ? { noteExtra: text(Math.floor(rnd() * max / 3)), tags: undefined } : {};
    const want = exact(card, extra) > max;
    const { ok, big } = splitTooBig([card], extra, max);
    assert.equal(big.length === 1, want, `round ${round}: ${exact(card, extra)} bytes, limit ${max}`);
    assert.equal(ok.length === 1, !want);
    assert.equal(savedTooBigNote([card], extra, max) !== '', want, 'the editor note, round ' + round);
    want ? tooBig++ : fits++;
  }
  assert.ok(tooBig > 300 && fits > 300, `both outcomes should come up (${tooBig} too large, ${fits} fit)`);
});

test('a card of ordinary size never needs the exact count', () => {
  // 4 bytes a character is the most the text can take, so a card whose JSON text is under max/4 characters is settled at once.
  const small = { id: 'a', front: 'Capital of France?', back: 'Paris', tags: ['geo'], created: 1 };
  assert.deepEqual(splitTooBig([small]).ok, [small]);
  const orig = TextEncoder.prototype.encode;
  let calls = 0;
  TextEncoder.prototype.encode = function (...a) { calls++; return orig.apply(this, a); };
  try { splitTooBig(Array.from({ length: 200 }, (_, i) => ({ ...small, id: 'c' + i }))); } finally { TextEncoder.prototype.encode = orig; }
  assert.equal(calls, 0);
});

test('with only a few gaps in two weeks the older weeks matter, so they are read', () => {
  const now = Date.now();
  const rows = [];
  // Older weeks: long sessions with 30 s between answers. Last two weeks: 14 study days, 10 gaps of 6 s in all.
  for (let d = 20; d < 55; d++) for (let i = 0; i < 40; i++) rows.push({ timestamp: daysAgoStart(d, now) + 6 * 3600000 + i * 30000, source: 'review' });
  for (let d = 1; d <= 14; d++) {
    rows.push({ timestamp: daysAgoStart(d, now) + 6 * 3600000, source: 'review' });
    if (d <= 10) rows.push({ timestamp: daysAgoStart(d, now) + 6 * 3600000 + 6000, source: 'review' });
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  const short = rows.filter(l => l.timestamp >= recentHistoryFrom(now));
  assert.equal(recentHistoryEnough(short, now), false);
  assert.notEqual(typicalCardMs(short, now), typicalCardMs(rows, now));       // reading only two weeks here would have changed the estimate
});
