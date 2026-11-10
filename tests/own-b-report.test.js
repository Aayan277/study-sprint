// Tests for tools/own-model/b-report.mjs on made-up result lines only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { droppedWarning, parseResults, pairedShares, replayCells, replayReport, shadowCells, shadowReport, verdictLine } from '../tools/own-model/b-report.mjs';
import { LOG2_BINS } from '../tools/own-model/replay-core.mjs';

const iv = { n: 100, p10: 1, p50: 5, p90: 40, p99: 200, ge365: 10, ge3650: 0, atMax: 0, one: 20, comparable: 80, shrinks: 8, cardsShrink2: 3, cards: 30 };
const run = (rev, meanP) => ({ reviews: rev, meanP, lapses: 10, iv, bandBinds: 5, bandTotal: 50, periods: [[2, 7], [8, 28], [29, 90], [91, 180], [181, 365]].map(([a, b]) => ({ lo: a, hi: b, days: b - a + 1, reviews: rev })) });
const rec = (user, extra = {}) => ({ ok: true, user, cfg: 'c1', runs: { 'own|own|0.90': run(100, 0.8), 'fsrs|own|0.90': run(120, 0.9) }, ...extra });

test('parseResults keeps the last settings and the last record of a user', () => {
  const txt = [{ ok: true, user: 'a', cfg: 'old' }, { ok: true, user: 'a', cfg: 'new', v: 1 }, { ok: true, user: 'a', cfg: 'new', v: 2 }, { ok: true, user: 'b', cfg: 'new' }, { ok: false, user: 'c', cfg: 'new' }].map(x => JSON.stringify(x)).join('\n') + '\n{half';
  const r = parseResults(txt);
  assert.equal(r.length, 2);
  assert.equal(r.find(x => x.user === 'a').v, 2);
});

test('pairedShares: the middle bins count in proportion, far bins whole', () => {
  const h = new Array(LOG2_BINS).fill(0);
  h[11] = 50; h[12] = 50; h[0] = 25; h[23] = 25; h[10] = 10;
  const s = pairedShares(h);
  assert.equal(s.n, 160);
  assert.ok(Math.abs(s.within - 100 * (Math.log2(1.2) / 0.5) / 160) < 1e-9);
  assert.equal(s.far, 50 / 160, 'the bin -1..-0.5 is not whole-far');
  h[9] = 10;
  assert.equal(pairedShares(h).far, 60 / 170);
});

test('replay cells and report give the plain numbers', () => {
  const recs = [rec('u1', { runs: { 'own|own|0.90': { ...run(100, 0.8), paired: { hist: new Array(LOG2_BINS).fill(1), n: 24 } }, 'fsrs|own|0.90': run(120, 0.9) } }), rec('u2')];
  const c = replayCells(recs).get('own|own|0.90');
  assert.equal(c.n, 2);
  assert.equal(c.meanP, 0.8);
  assert.equal(c.perPeriod[0], 100 / 6);
  assert.equal(c.shrink, 0.1);
  assert.equal(c.cards2, 0.1);
  assert.equal(c.ge365, 0.1);
  assert.equal(c.band, 0.1);
  assert.equal(c.paired.users, 1);
  const md = replayReport(['x', 'y'], { x: recs, y: recs });
  assert.match(md, /Side by side/);
  assert.match(md, /own \/ Own \/ R 0.90/);
  assert.match(md, /0\.100/);
  assert.ok(!/"user"|u1|u2/.test(md), 'no ids');
});

const v = (extra = {}) => ({ reached: true, firstBetter: { day: 10, daysAfter: 10, records: 300 }, switches: [], flips: 1, returns: 0, next: { n: 50, diff: -0.01 }, ...extra });
const sh = (user, o = {}) => ({ ok: true, user, cfg: 's', variants: { 'n300-l95-c2': v(), 'n100-l95-c1': v({ firstBetter: { day: 3, daysAfter: 3, records: 100 } }) }, null: { 'n300-l95-c2': { draws: 10, better: 0, days: [] }, 'n100-l95-c1': { draws: 10, better: 2, days: [4, 5] } }, ...o });
const orc = user => sh(user, { oracle: true, variants: { 'n300-l95-c2': v({ firstBetter: null }), 'n100-l95-c1': v({ firstBetter: null }) }, null: undefined });

test('shadow cells and the fastest-safe verdict', () => {
  const recs = [sh('a'), sh('b'), orc('o1'), orc('o2')];
  const cells = shadowCells(recs);
  const c = cells.get('n300-l95-c2');
  assert.equal(c.users, 2);
  assert.equal(c.medDay, 10);
  assert.equal(c.next, -0.01);
  assert.equal(c.nullFb.nullRate, 0);
  assert.equal(c.oracleFb.oracleRate, 0);
  assert.equal(cells.get('n100-l95-c1').nullFb.nullRate, 0.2);
  const line = verdictLine(cells, 'All');
  assert.match(line, /is n300-l95-c2/);
  assert.match(line, /shipped n300-l95-c2 passes/);
  assert.match(verdictLine(shadowCells([sh('a')]), 'All'), /no oracle control/);
  const md = shadowReport(['a', 'b'], { a: recs, b: recs });
  assert.match(md, /Side by side/);
  assert.match(md, /\(shipped\)/);
  assert.ok(!/"user"/.test(md));
});

test('records with other settings are counted as dropped, and the report splits the returns by reason', () => {
  const txt = [{ ok: true, user: 'a', cfg: 'old' }, { ok: true, user: 'b', cfg: 'old' }, { ok: true, user: 'a', cfg: 'new' }].map(x => JSON.stringify(x)).join('\n');
  const info = {};
  assert.equal(parseResults(txt, info).length, 1); assert.equal(info.dropped, 2);
  assert.match(droppedWarning('t', 2), /^WARNING: tag t: 2 result lines/);
  const sw = (why) => ({ day: 20, to: 'fsrs', why });
  const recs = [sh('a', { variants: { 'n300-l95-c2': v({ switches: [sw('rmse'), sw('worse'), sw('worse')], returns: 3 }) }, null: undefined })];
  const c = shadowCells(recs).get('n300-l95-c2');
  assert.equal(c.returnsRmse, 1); assert.equal(c.returnsWorse, 2);
  const md = shadowReport(['a'], { a: recs });
  assert.match(md, /Returns: rate limit/); assert.match(md, /Returns: loss worse/); assert.match(md, /reached the checks/);
  const rmd = replayReport(['x'], { x: [rec('u1')] });
  assert.match(rmd, /different limit for each scheduler/); assert.match(rmd, /first answers of new cards/);
});
