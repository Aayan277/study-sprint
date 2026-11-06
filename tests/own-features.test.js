import './rwkv-utc.mjs';           // study days and the 4am rollover are worked out in UTC here
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OwnFeatures, modelRows, studyDay, F, F_CONTEXT } from '../js/own-features.js';
import { paramCount, paramLayout, paramOffsets, OWN_FEATURE_VERSION, OWN_STATE_FORMAT } from '../js/own-spec.js';

const DAY = 86400000, HOUR = 3600000;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);          // noon
const row = (card, t, extra = {}) => ({ logId: t, cardKey: 'c:' + card, noteKey: 'c:' + card, deckKey: 'd:1', presetKey: 'p:default', t, day: studyDay(t), rating: 3, ms: 8000, kind: 'train', ...extra });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const L = x => Math.log1p(x);

test('spec: sizes and the exact parameter count', () => {
  assert.equal(F, 18);
  assert.equal(F_CONTEXT, 12);
  assert.equal(OWN_FEATURE_VERSION, 1);
  assert.equal(OWN_STATE_FORMAT, 'own-f32-v1');
  assert.equal(paramCount('s'), 6336 + 9504 + 128 + 3210 + 0);            // card cell + three small cells + (tau, init) + head, as in the design doc
  assert.equal(paramCount('s'), 19178);
  assert.equal(paramCount('m'), 63306);
  const names = paramLayout('s').map(p => p.name);
  assert.equal(new Set(names).size, names.length);
  const off = paramOffsets('s');
  assert.equal(off['head.b2'].offset + off['head.b2'].length, 19178);
  assert.deepEqual(off['card.Wz'].shape, [32, 98]);
  assert.deepEqual(off['head.W1'].shape, [32, 89]);
  assert.throws(() => paramCount('xl'), /Unknown model size/);
});

test('first answer of the first card: every number by hand', () => {
  const b = new OwnFeatures(), f = b.features(row('a', T0));
  assert.equal(f.length, 18);
  assert.deepEqual(Array.from(f.subarray(0, 12)).map(x => Math.round(x * 1e6) / 1e6), [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(f.subarray(12, 16)), [0, 0, 1, 0]);      // Good
  near(f[16], 0);                                                       // ms = 8000 is the centre
  assert.equal(f[17], 0);
});

test('a later answer: every number by hand', () => {
  const b = new OwnFeatures();
  b.commit(row('a', T0, { rating: 1, noteKey: 'n:1', deckKey: 'd:1' }));            // 12:00 day 1, Again
  b.commit(row('b', T0 + HOUR, { rating: 3, noteKey: 'n:2', deckKey: 'd:2' }));      // 13:00
  b.commit(row('c', T0 + 2 * HOUR, { rating: 3, noteKey: 'n:3', deckKey: 'd:1' }));  // 14:00
  const t = T0 + 3 * HOUR;
  const f = b.features(row('a', t, { rating: 4, ms: 2000, noteKey: 'n:1', deckKey: 'd:1' }));
  near(f[0], L(3 / 24) / 5);                     // card a: 3 hours ago
  assert.equal(f[1], 0);
  assert.equal(f[2], 1);                         // same study day
  near(f[3], L(3 / 24) / 5);                     // note n:1 last answered at 12:00 too
  near(f[4], L(1 / 24) / 5);                     // deck d:1 last answered at 14:00
  near(f[5], L(1 / 24) / 5);                     // you: 14:00
  near(f[6], L(1) / 3);                          // 1 answer so far
  near(f[7], L(1) / 2);                          // 1 lapse so far
  near(f[8], 0);                                 // same day as first seen
  near(f[9], L(3) / 4);                          // 3 answers today
  near(f[10], 1 / 3);                            // 1 of 3 was Again
  near(f[11], L(3) / 3);                         // 3 new cards today
  assert.deepEqual(Array.from(f.subarray(12, 16)), [0, 0, 0, 1]);
  near(f[16], Math.log(2000 / 8000) / 3);
  assert.equal(f[17], 0);
});

test('days since first seen, clipped answer time and the replay flag', () => {
  const b = new OwnFeatures();
  b.commit(row('a', T0));
  const f = b.features(row('a', T0 + 10 * DAY, { ms: 1e9, kind: 'replay' }));
  near(f[8], L(10) / 6);
  near(f[16], 1);                                // clipped at +3, divided by 3
  assert.equal(f[17], 1);
  near(b.features(row('a', T0 + 10 * DAY, { ms: 0 }))[16], -1);
  assert.equal(b.features(row('a', T0 + 10 * DAY, { ms: NaN }))[16], 0);
  assert.equal(b.features(row('a', T0 + 10 * DAY, { ms: 1 }))[16], -1);
});

test('the leakage rule: context numbers do not change with the rating, time taken or kind of the answer being predicted', () => {
  const b = new OwnFeatures();
  for (let i = 0; i < 6; i++) b.commit(row('a' + (i % 3), T0 + i * HOUR * 5, { rating: 1 + (i % 4), ms: 3000 + i * 700, noteKey: 'n:' + (i % 2) }));
  const t = T0 + 40 * HOUR;
  const base = b.features(row('a1', t, { noteKey: 'n:1' }));
  for (const rating of [1, 2, 3, 4]) for (const ms of [0, 500, 8000, 1e6]) for (const kind of ['train', 'replay']) {
    const f = b.features(row('a1', t, { rating, ms, kind, noteKey: 'n:1' }));
    assert.deepEqual(Array.from(f.subarray(0, F_CONTEXT)), Array.from(base.subarray(0, F_CONTEXT)));
  }
  // a query row has no outcome numbers at all
  const q = b.features(row('a1', t, { rating: 4, ms: 99, kind: 'replay', noteKey: 'n:1' }), true);
  assert.deepEqual(Array.from(q.subarray(F_CONTEXT)), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(q.subarray(0, F_CONTEXT)), Array.from(base.subarray(0, F_CONTEXT)));
});

test('features() changes nothing', () => {
  const b = new OwnFeatures();
  b.commit(row('a', T0));
  const before = JSON.stringify(b);
  b.features(row('a', T0 + DAY)); b.features(row('z', T0 + DAY), true); b.gaps(row('a', T0 + DAY));
  assert.equal(JSON.stringify(b), before);
});

test('the new study day starts at 4am', () => {
  const b = new OwnFeatures();
  b.commit(row('a', Date.UTC(2026, 0, 6, 3, 0)));
  assert.equal(b.features(row('a', Date.UTC(2026, 0, 6, 3, 59)))[2], 1);
  assert.equal(b.features(row('a', Date.UTC(2026, 0, 6, 4, 0)))[2], 0);
  // 00:05 belongs to the day before, so it still counts as today's third answer
  const c = new OwnFeatures();
  c.commit(row('a', Date.UTC(2026, 0, 5, 22, 0)));
  c.commit(row('b', Date.UTC(2026, 0, 5, 23, 55)));
  near(c.features(row('c', Date.UTC(2026, 0, 6, 0, 5)))[9], L(2) / 4);
});

test('daylight saving: the day still turns over at 4am local time', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./own-features.dst.child.mjs', import.meta.url))], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a card without a note uses its own key, and a note links its cards', () => {
  const b = new OwnFeatures();
  b.commit(row('a', T0, { noteKey: 'n:1' }));
  assert.equal(b.features(row('b', T0 + 6 * HOUR, { noteKey: 'n:1' }))[3] > 0, true);       // sibling b sees the note's last answer
  near(b.features(row('b', T0 + 6 * HOUR, { noteKey: 'n:1' }))[3], L(0.25) / 5);
  assert.equal(b.features(row('b', T0 + 6 * HOUR, { noteKey: 'c:b' }))[3], 0);              // an unrelated note has no history
});

test('overrides: day and gapSec give the same numbers as the timestamps they stand for', () => {
  const stamps = [[T0, 'a', 1], [T0 + 2 * HOUR, 'b', 3], [T0 + 3 * HOUR, 'a', 3], [T0 + 2 * DAY + HOUR, 'a', 4], [T0 + 2 * DAY + 2 * HOUR, 'b', 2], [T0 + 9 * DAY, 'a', 3]];
  const plain = new OwnFeatures(), over = new OwnFeatures();
  const last = new Map();
  for (const [t, card, rating] of stamps) {
    const a = row(card, t, { rating });
    const prev = last.get(card);
    const b = { ...a, day: studyDay(t), gapSec: prev === undefined ? undefined : (t - prev) / 1000 };
    delete a.day;                                    // a: nothing but the time; b: explicit day and gap
    last.set(card, t);
    assert.deepEqual(Array.from(over.features(b)), Array.from(plain.features(a)));
    plain.commit(a); over.commit(b);
  }
});

test('overrides win over timestamps when they disagree', () => {
  const b = new OwnFeatures();
  b.commit(row('a', T0, { day: 100 }));
  // the clock says 5 hours later, but the data says 3 days later, on a later day
  const f = b.features(row('a', T0 + 5 * HOUR, { day: 103, gapSec: 3 * 86400 }));
  near(f[0], L(3) / 5);
  assert.equal(f[2], 0);
  near(f[8], L(3) / 6);
  // the same day number means same day, whatever the clock says
  assert.equal(b.features(row('a', T0 + 30 * DAY, { day: 100, gapSec: 60 }))[2], 1);
  // a bad override (NaN, negative) is ignored or clamped, never leaks through
  near(b.features(row('a', T0 + DAY, { day: 101, gapSec: NaN }))[0], L(1) / 5);
  near(b.features(row('a', T0 + DAY, { day: 101, gapSec: -50 }))[0], 0);
});

test('undo puts everything back exactly', () => {
  const b = new OwnFeatures();
  b.commit(row('a', T0, { noteKey: 'n:1' }));
  const before = JSON.stringify(b);
  const t1 = b.commit(row('a', T0 + DAY, { rating: 1, noteKey: 'n:1', deckKey: 'd:2' }));
  const t2 = b.commit(row('z', T0 + 2 * DAY, { noteKey: 'n:9' }));
  b.undo(t2); b.undo(t1);
  assert.equal(JSON.stringify(b), before);
});

test('save and load give the same builder', () => {
  const b = new OwnFeatures();
  for (let i = 0; i < 10; i++) b.commit(row('c' + (i % 4), T0 + i * 7 * HOUR, { rating: 1 + (i % 4), noteKey: 'n:' + (i % 3), deckKey: 'd:' + (i % 2) }));
  const c = OwnFeatures.fromJSON(JSON.parse(JSON.stringify(b)));
  const next = row('c1', T0 + 90 * HOUR, { noteKey: 'n:1', deckKey: 'd:1' });
  assert.deepEqual(Array.from(c.features(next)), Array.from(b.features(next)));
  c.commit(next); b.commit(next);
  assert.equal(JSON.stringify(c), JSON.stringify(b));
});

test('works on rows from modelRows (the app path)', () => {
  const logs = [1, 2, 3].map(i => ({ id: i, cardId: 'a', timestamp: T0 + i * DAY, source: 'review', rating: 3, ms: 5000 }));
  const rows = modelRows(logs, [{ id: 'a', deckId: 'D', noteId: 'N' }], [{ id: 'D' }]);
  const b = new OwnFeatures();
  const out = rows.map(r => { const f = b.features(r); b.commit(r); return f; });
  assert.equal(out[0][1], 1);
  near(out[2][0], L(1) / 5);
  near(out[2][6], L(2) / 3);
});
