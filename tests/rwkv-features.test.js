import './rwkv-utc.mjs';           // the golden fixture is in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FeatureBuilder, modelRows, entityCode, studyDay, fnv1a } from '../js/rwkv-features.js';

const DAY = 86400000, HOUR = 3600000;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);          // noon
const row = (card, t, extra = {}) => ({ logId: t, cardKey: 'c:' + card, noteKey: 'c:' + card, deckKey: 'd:1', presetKey: 'p:default', t, day: studyDay(t), rating: 3, ms: 5000, ...extra });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const ln = Math.log;

test('first review of the first card: every number by hand', () => {
  const b = new FeatureBuilder(), f = b.features(row('a', T0));
  near(f[0], (0 - 1.51) / 1.62);                     // first review counts as "no log term"
  near(f[1], (0 - 2.14) / 2.25);
  near(f[2], (0 - 9.96) / 5.21);
  near(f[3], Math.sin(2 * Math.PI * 86399 / 86400)); // -1 seconds is 86399 (mathematical mod)
  near(f[4], Math.cos(2 * Math.PI * 86399 / 86400));
  near(f[8], (ln(10 + 5000) - 8.9) / 1.07);
  assert.deepEqual(Array.from(f.subarray(9, 13)), [0, 0, 1, 0]);
  assert.deepEqual(Array.from(f.subarray(13, 16)), [0, 0, 0]);
  near(f[16], 0);                                    // ln(ln(e + 0))
  near(f[17], -1);                                   // day 0 of the 7-day cycle
  near(f[18], (ln(3) - 2.945) / 2.011);
  near(f[19], (ln(3) - 4.64) / 2.59);
  near(f[20], (ln(4) - 2.55) / 1.41);                // this first review is the first new card today
  near(f[21], (ln(3) - 4.59) / 1.30);
  assert.equal(f[22], 0);
  assert.equal(f[23], 0);
  assert.equal(f.length, 92);
});

test('a query row hides the answer and sets the flag', () => {
  const b = new FeatureBuilder();
  const first = row('a', T0);
  b.commit(first);
  const r2 = row('a', T0 + 2 * DAY + HOUR);
  const u = b.features(r2, false), q = b.features(r2, true);
  assert.equal(q[8], 0); assert.deepEqual(Array.from(q.subarray(9, 13)), [0, 0, 0, 0]); assert.equal(q[23], 1);
  assert.notEqual(u[8], 0); assert.equal(u[23], 0);
  for (let i = 0; i < 92; i++) if (![8, 9, 10, 11, 12, 23].includes(i)) assert.equal(q[i], u[i], 'feature ' + i);
});

test('the running sum quirk: a sum of exactly -1 looks like a first review', () => {
  const b = new FeatureBuilder();
  b.commit(row('a', T0));
  const same = b.features(row('a', T0 + HOUR), false);           // gap 0 days: -1 + 0 = -1
  near(same[1], (0 - 2.14) / 2.25);
  near(same[0], (ln(1 + 1e-5) - 1.51) / 1.62);                   // but its own gap of 0 days is a real zero
  b.commit(row('a', T0 + HOUR));
  const next = b.features(row('a', T0 + DAY + HOUR), false);     // gap 1: sum is 0
  near(next[1], (ln(1 + 1e-5) - 2.14) / 2.25);
  near(next[2], (ln(1 + 1e-5 + 86400) - 9.96) / 5.21);
});

test('counters: new cards, reviews since, today, and the 7-day position', () => {
  const b = new FeatureBuilder();
  b.commit(row('a', T0));
  b.commit(row('b', T0 + HOUR));
  b.commit(row('c', T0 + 2 * HOUR));
  b.commit(row('a', T0 + 3 * HOUR));
  const f = b.features(row('a', T0 + 4 * HOUR), false);
  near(f[18], (ln(3 + 0) - 2.945) / 2.011);                      // no new card since a's last review
  near(f[19], (ln(3 + 0) - 4.64) / 2.59);
  const g = b.features(row('b', T0 + 4 * HOUR), false);
  near(g[18], (ln(3 + 1) - 2.945) / 2.011);                      // c started after b's last review
  near(g[19], (ln(3 + 2) - 4.64) / 2.59);                        // c and a's second review
  near(g[20], (ln(3 + 3) - 2.55) / 1.41);                        // 3 new cards today (not counting this one)
  near(g[21], (ln(3 + 4) - 4.59) / 1.30);                        // 4 reviews earlier today
  // next study day: counters restart, day of the week moves on
  const h = b.features(row('a', T0 + DAY), false);
  near(h[20], (ln(3) - 2.55) / 1.41);
  near(h[21], (ln(3) - 4.59) / 1.30);
  near(h[17], (1 - 3) / 3);
  near(h[16], Math.log(Math.log(Math.E + 1)));
  const k = b.features(row('a', T0 + 6 * DAY), false);
  near(k[17], (6 - 3) / 3);
  near(b.features(row('a', T0 + 7 * DAY), false)[17], (0 - 3) / 3);
});

test('commit/undo restores the builder exactly, and JSON round-trips it', () => {
  const b = new FeatureBuilder();
  for (let i = 0; i < 6; i++) b.commit(row('x' + (i % 3), T0 + i * 5 * HOUR));
  const before = JSON.stringify(b);
  const tok = b.commit(row('x1', T0 + 3 * DAY));
  assert.notEqual(JSON.stringify(b), before);
  b.undo(tok);
  assert.equal(JSON.stringify(b), before);
  const tokNew = b.commit(row('fresh', T0 + 3 * DAY));
  b.undo(tokNew);
  assert.equal(JSON.stringify(b), before);
  const copy = FeatureBuilder.fromJSON(JSON.parse(before));
  const r = row('x2', T0 + 4 * DAY);
  assert.deepEqual(copy.features(r), b.features(r));
});

test('features() changes nothing', () => {
  const b = new FeatureBuilder();
  b.commit(row('a', T0));
  const s = JSON.stringify(b);
  b.features(row('a', T0 + DAY)); b.features(row('z', T0 + DAY), true);
  assert.equal(JSON.stringify(b), s);
});

test('entity codes: fixed per entity, in {-1.5,-0.5,0.5,1.5}, different between entities', () => {
  const a = entityCode('c', 'c:abc'), a2 = entityCode('c', 'c:abc');
  assert.deepEqual(a, a2);
  assert.equal(a.length, 12); assert.equal(entityCode('d', 'd:1').length, 8);
  assert.equal(entityCode('n', 'n:1').length, 12); assert.equal(entityCode('p', 'p:default').length, 8);
  for (const v of a) assert.ok([-1.5, -0.5, 0.5, 1.5].includes(v));
  assert.notDeepEqual(entityCode('c', 'c:abc'), entityCode('c', 'c:abd'));
  assert.notDeepEqual(entityCode('c', 'x'), entityCode('n', 'x'));
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);                           // the standard FNV-1a test value
  // over many entities every value appears about equally often
  const counts = new Map();
  for (let i = 0; i < 400; i++) for (const v of entityCode('c', 'c:' + i)) counts.set(v, (counts.get(v) || 0) + 1);
  for (const v of [-1.5, -0.5, 0.5, 1.5]) assert.ok(counts.get(v) > 0.2 * 4800 && counts.get(v) < 0.3 * 4800);
});

test('calendar numbers: this day and the card\'s first day, on each cycle', () => {
  const b = new FeatureBuilder();
  b.commit(row('a', T0));
  const f = b.features(row('a', T0 + 10 * DAY), false);
  for (const [i, p] of [3, 7, 30, 100, 365, 3650, 36500].entries()) {
    const w = 2 * Math.PI / p, o = 64 + i * 4;
    near(f[o], Math.sin(w * (10 % p))); near(f[o + 1], Math.cos(w * (10 % p)));
    near(f[o + 2], Math.sin(0)); near(f[o + 3], 1);
  }
});

test('the new study day starts at 4am', () => {
  assert.equal(studyDay(Date.UTC(2026, 0, 6, 3, 59)), studyDay(Date.UTC(2026, 0, 5, 12)));
  assert.equal(studyDay(Date.UTC(2026, 0, 6, 4, 0)), studyDay(Date.UTC(2026, 0, 5, 12)) + 1);
  assert.equal(studyDay(Date.UTC(2026, 0, 6, 0, 5)), studyDay(Date.UTC(2026, 0, 5, 23, 55)));
});

test('daylight saving: the day still turns over at 4am local time', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./rwkv-features.dst.child.mjs', import.meta.url))], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('modelRows: which rows count, how they map, and their order', () => {
  const cards = [{ id: 'a', deckId: 'D1', noteId: 'N1' }, { id: 'b', deckId: 'D1', noteId: 'N1' }, { id: 'c', deckId: 'D2', noteId: '' }, { id: 'd', deckId: 'D2' }];
  const decks = [{ id: 'D1' }, { id: 'D2', options: { x: 1 } }];
  const log = (id, cardId, t, extra = {}) => ({ id, cardId, timestamp: t, source: 'review', rating: 3, ms: 4000, ...extra });
  const logs = [
    log(5, 'b', T0 + 2 * HOUR), log(2, 'a', T0), log(3, 'c', T0 + HOUR), log(4, 'd', T0 + HOUR), log(6, 'gone', T0 + 3 * HOUR),
    log(7, 'a', T0 + 4 * HOUR, { source: 'play', applied: true }), log(8, 'a', T0 + 5 * HOUR, { source: 'play' }), log(9, 'a', T0 + 6 * HOUR, { source: 'anki', ms: 60000 }),
    log(10, 'a', T0 + 7 * HOUR, { rating: 0 }), log(11, 'a', T0 + 8 * HOUR, { ms: 9e9 }), log(12, 'a', T0 + 9 * HOUR, { source: 'weird' }), log(1, 'a', T0)
  ];
  const rows = modelRows(logs, cards, decks);
  assert.deepEqual(rows.map(r => r.logId), [1, 2, 3, 4, 5, 6, 7, 9, 11]);       // same time: smaller id first; ignored kinds left out
  const by = id => rows.find(r => r.logId === id);
  assert.deepEqual([by(2).noteKey, by(2).deckKey, by(2).presetKey], ['n:N1', 'd:D1', 'p:default']);
  assert.deepEqual([by(5).noteKey], ['n:N1']);                                     // a sibling shares the note
  assert.deepEqual([by(3).noteKey, by(3).presetKey], ['c:c', 'p:D2']);             // empty note id: a note of its own; a deck with options is its own preset
  assert.deepEqual([by(4).noteKey], ['c:d']);
  assert.deepEqual([by(6).noteKey, by(6).deckKey, by(6).presetKey], ['c:gone', 'd:?', 'p:default']);   // the card no longer exists
  assert.equal(by(7).kind, 'replay'); assert.equal(by(2).kind, 'train');
  assert.equal(by(11).ms, 600000);
  assert.equal(by(2).day, studyDay(T0));
});

test('golden: our 92 numbers match the independently written Python builder (no weights needed)', () => {
  const g = JSON.parse(fs.readFileSync(new URL('./fixtures/rwkv/golden.json', import.meta.url), 'utf8'));
  const rows = modelRows(g.logs, g.cards, g.decks);
  assert.equal(rows.length, g.modelRows);
  const b = new FeatureBuilder();
  let worst = 0;
  for (let i = 0; i < g.features.updateRows.length; i++) {
    const f = b.features(rows[i], false);
    g.features.updateRows[i].forEach((v, j) => { worst = Math.max(worst, Math.abs(v - f[j])); assert.ok(Math.abs(v - f[j]) < 1e-5, `row ${i} feature ${j}: ${f[j]} vs ${v}`); });
    b.commit(rows[i]);
  }
  // the query rows: rebuild up to each one
  const q = new FeatureBuilder(); let next = 0;
  g.features.queryRows.sort((x, y) => x.index - y.index);
  for (let i = 0; i < rows.length && next < g.features.queryRows.length; i++) {
    if (g.features.queryRows[next].index === i) {
      const f = q.features(rows[i], true);
      g.features.queryRows[next].f.forEach((v, j) => assert.ok(Math.abs(v - f[j]) < 1e-5, `query row ${i} feature ${j}: ${f[j]} vs ${v}`));
      next++;
    }
    q.commit(rows[i]);
  }
  assert.equal(next, g.features.queryRows.length);
  assert.ok(worst < 1e-5);
});
