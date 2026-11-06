import './rwkv-utc.mjs';
// Tests for the learner simulator (tools/own-model/sim.mjs) on small, made-up runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLearner, learners, scoredRows, logLossOf, resolveConfig, EFFECTS, DEFAULT_W } from '../tools/own-model/sim.mjs';
import { rowKind } from '../js/fsrs-data.js';
import { initState, nextState, forgettingCurve } from '../js/fsrs-fit.js';
import { OwnFeatures, studyDay } from '../js/own-features.js';
import { rowsOf } from '../tools/own-model/sources/rows.mjs';

const DAY = 86400000;
const mini = (extra = {}) => ({ days: [90, 120], newPerDay: [6, 12], count: 12, ...extra });
const all = (cfg, seed = 100) => [...learners(cfg, seed)];
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, sa = 0, sb = 0; a.forEach((x, i) => { sab += (x - ma) * (b[i] - mb); sa += (x - ma) ** 2; sb += (b[i] - mb) ** 2; }); return sab / Math.sqrt(sa * sb); };
const longRows = ls => ls.flatMap(l => scoredRows(l).long.map(r => ({ ...r, l })));
const dayOfLog = (l, i) => Math.floor((l.logs[i].timestamp - l.truth.baseMs) / DAY);

test('the same seed gives the same learner, another seed another one', () => {
  const a = makeLearner(mini(), 7), b = makeLearner(mini(), 7), c = makeLearner(mini(), 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.logs, c.logs);
  const viaIter = [...learners(mini({ count: 3 }), 7)];
  assert.equal(viaIter.length, 3);
  assert.deepEqual(viaIter[0], a);
  assert.deepEqual(viaIter[1], makeLearner(mini(), 8));
});

test('unknown worlds and effects are refused', () => {
  assert.throws(() => resolveConfig({ world: 'x' }), /Unknown world/);
  assert.throws(() => resolveConfig({ effects: { nope: true } }), /Unknown effect/);
  assert.deepEqual(Object.keys(resolveConfig().effects), EFFECTS);
});

test('rows have the app shape, pass rowKind as train and follow the rules of a real log', () => {
  for (const world of ['own', 'fsrs']) {
    for (const l of all(mini({ world, count: 4 }))) {
      assert.ok(l.logs.length > 200, 'a real amount of reviews');
      const ids = new Set(), seen = new Map();
      let prevT = -1;
      for (const x of l.logs) {
        assert.deepEqual(Object.keys(x), ['id', 'cardId', 'timestamp', 'source', 'mode', 'rating', 'ms', 'state']);
        assert.equal(rowKind(x), 'train');
        assert.ok(!ids.has(x.id)); ids.add(x.id);
        assert.ok(x.timestamp > prevT, 'time only moves forward'); prevT = x.timestamp;
        assert.ok(Number.isInteger(x.rating) && x.rating >= 1 && x.rating <= 4);
        assert.ok(Number.isInteger(x.ms) && x.ms >= 800 && x.ms <= 120000);
        if (!seen.has(x.cardId)) assert.equal(x.state, 0, 'a card starts at state 0'); else assert.notEqual(x.state, 0);
        seen.set(x.cardId, true);
        const h = new Date(x.timestamp).getUTCHours();
        assert.ok(h >= 6 && h < 24, 'sessions are inside one UTC date');
      }
      const cardIds = new Set(l.cards.map(c => c.id));
      assert.deepEqual([...seen.keys()].sort(), [...cardIds].sort(), 'cards lists exactly the cards that were answered');
      const deckIds = new Set(l.decks.map(d => d.id));
      for (const c of l.cards) assert.ok(deckIds.has(c.deckId) && typeof c.noteId === 'string');
      assert.equal(l.truth.p.length, l.logs.length);
    }
  }
});

test('the truth never appears in rows, cards or decks', () => {
  const l = makeLearner(mini(), 3);
  for (const c of l.cards) assert.deepEqual(Object.keys(c), ['id', 'deckId', 'noteId']);
  for (const d of l.decks) assert.deepEqual(Object.keys(d), ['id']);
  const text = JSON.stringify({ logs: l.logs, cards: l.cards, decks: l.decks });
  for (const word of ['truth', 'delta', 'group', 'tauS', 'tauF', 'bad', 'logG', 'kappa', 'mf', 'baseMs', 'effects']) assert.ok(!text.includes(word), word);
  assert.ok(l.truth && l.truth.p.some(Number.isFinite));
  // and the rows the features read carry nothing extra either
  for (const r of rowsOf(l)) assert.ok(!('truth' in r) && !('p' in r));
});

test('bad days: recall is lower on them, and the switch removes them', () => {
  const on = all(mini()), off = all(mini({ effects: { badDays: false } }));
  assert.ok(on.every(l => l.truth.bad.some(Boolean)) || on.some(l => l.truth.bad.some(Boolean)));
  assert.ok(off.every(l => !l.truth.bad.some(Boolean)));
  const rows = longRows(on);
  const bad = rows.filter(r => r.l.truth.bad[dayOfLog(r.l, r.i)]), ok = rows.filter(r => !r.l.truth.bad[dayOfLog(r.l, r.i)]);
  assert.ok(bad.length > 300);
  assert.ok(mean(ok.map(r => r.y)) - mean(bad.map(r => r.y)) > 0.04, `${mean(ok.map(r => r.y))} vs ${mean(bad.map(r => r.y))}`);
  const o = longRows(off);
  assert.ok(mean(o.map(r => r.y)) > mean(rows.map(r => r.y)), 'without bad days more is remembered');
});

test('interference: with it on, less is remembered; the group is hidden in the rows', () => {
  const on = longRows(all(mini())), off = longRows(all(mini({ effects: { interference: false } })));
  assert.ok(mean(off.map(r => r.y)) - mean(on.map(r => r.y)) > 0.01, `${mean(off.map(r => r.y))} vs ${mean(on.map(r => r.y))}`);
  const l = makeLearner(mini(), 5);
  const groups = new Map();
  for (const c of l.cards) { const g = l.truth.card[c.id].group; groups.set(g, (groups.get(g) || 0) + 1); }
  assert.ok([...groups.values()].every(n => n <= 8) && groups.size > 1);
});

test('siblings: notes of 1 to 3 cards share difficulty only when the effect is on', () => {
  const pairs = ls => { const a = [], b = []; for (const l of ls) { const byNote = new Map(); for (const c of l.cards) { const k = l.truth.card[c.id].note; (byNote.get(k) || byNote.set(k, []).get(k)).push(l.truth.card[c.id].deltaOwn); } for (const v of byNote.values()) if (v.length >= 2) { a.push(v[0]); b.push(v[1]); } } return [a, b]; };
  const [a1, b1] = pairs(all(mini())), [a0, b0] = pairs(all(mini({ effects: { siblings: false } })));
  assert.ok(a1.length > 100);
  assert.ok(corr(a1, b1) > 0.3, `on ${corr(a1, b1)}`);
  assert.ok(Math.abs(corr(a0, b0)) < 0.15, `off ${corr(a0, b0)}`);
  const sizes = new Set(); const l = makeLearner(mini(), 9); const per = new Map();
  for (const c of l.cards) per.set(c.noteId, (per.get(c.noteId) || 0) + 1);
  for (const n of per.values()) sizes.add(n);
  assert.ok([...sizes].every(n => n >= 1 && n <= 3) && sizes.size >= 2);
});

test('siblings: a success on one card helps the other, only with the effect on', () => {
  // difference of the (difficulty-free) recall logit between rows whose sibling was answered right in the last 12 hours and the rest, on and off
  const gain = ls => {
    const near = [], far = [];
    for (const l of ls) {
      const noteOf = new Map(l.cards.map(c => [c.id, c.noteId])), lastOk = new Map(), seen = new Set();
      l.logs.forEach((x, i) => {
        const note = noteOf.get(x.cardId), t = lastOk.get(note);
        const p = l.truth.p[i], z = Math.log(p / (1 - p)) + l.truth.card[x.cardId].delta;       // the logit with the card's own difficulty taken out
        if (seen.has(x.cardId) && Number.isFinite(p) && Math.floor(x.timestamp / DAY) > 0) (t && x.timestamp - t.t < 12 * 3600000 && t.card !== x.cardId ? near : far).push(z);
        seen.add(x.cardId);
        if (x.rating > 1) lastOk.set(note, { t: x.timestamp, card: x.cardId });
      });
    }
    return mean(near) - mean(far);
  };
  const on = gain(all(mini())), off = gain(all(mini({ effects: { siblings: false } })));
  assert.ok(on > off + 0.03, `${on} vs ${off}`);
});

test('drift: the learning gain wanders only when the effect is on', () => {
  const on = all(mini(), 50), off = all(mini({ effects: { drift: false } }), 50);
  const sd = l => { const v = Array.from(l.truth.logG); const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
  assert.ok(mean(on.map(sd)) > 0.08, String(mean(on.map(sd))));
  assert.ok(off.every(l => l.truth.logG.every(x => x === 0)));
});

test('answer time: slower on forgotten reviews only when the effect is on', () => {
  const gap = ls => { const rows = longRows(ls); const f = rows.filter(r => !r.y).map(r => Math.log(r.l.logs[r.i].ms)), s = rows.filter(r => r.y).map(r => Math.log(r.l.logs[r.i].ms)); return mean(f) - mean(s); };
  const on = gap(all(mini())), off = gap(all(mini({ effects: { answerTime: false } })));
  assert.ok(on > 0.12, String(on));
  assert.ok(Math.abs(off) < 0.1, String(off));
});

test('scheduling noise: days off and a backlog only when the effect is on', () => {
  const emptyShare = ls => mean(ls.map(l => { const days = new Set(l.logs.map(x => Math.floor((x.timestamp - l.truth.baseMs) / DAY))); const n = Math.floor((l.logs.at(-1).timestamp - l.truth.baseMs) / DAY) + 1; return 1 - days.size / n; }));
  assert.ok(emptyShare(all(mini())) > 0.05);
  assert.equal(emptyShare(all(mini({ effects: { schedNoise: false } }))), 0);
  // gaps: with noise some reviews come well before or after the plan; the spread of gap / (gap of the same card before) is wider
  const spread = ls => { const r = []; for (const l of ls) { const last = new Map(); for (const x of l.logs) { const d = Math.floor(x.timestamp / DAY), p = last.get(x.cardId); if (p !== undefined && d > p.d && p.prev) r.push(Math.log((d - p.d) / p.prev)); last.set(x.cardId, { d, prev: p ? (d - p.d || p.prev) : 0 }); } } const m = mean(r); return Math.sqrt(mean(r.map(v => (v - m) ** 2))); };
  assert.ok(spread(all(mini())) > spread(all(mini({ effects: { schedNoise: false } }))));
});

test('the fsrs control: outcomes follow forgettingCurve of the true weights', () => {
  const ls = all(mini({ world: 'fsrs', count: 10 }));
  const ps = [], ys = [];
  for (const l of ls) {
    const w = l.truth.w;
    assert.equal(w.length, 21);
    assert.notDeepEqual(w, DEFAULT_W, 'the true weights are jittered around the defaults');
    const st = new Map(), lastDay = new Map();
    l.logs.forEach((x, i) => {
      const day = Math.floor(x.timestamp / DAY), s = st.get(x.cardId);
      if (!s) { st.set(x.cardId, initState(w, x.rating, true)); lastDay.set(x.cardId, day); return; }
      const t = day - lastDay.get(x.cardId);
      const r = t > 0 ? forgettingCurve(w, t, s.s, true) : forgettingCurve(w, (x.timestamp - l.logs[i - 1 >= 0 ? i - 1 : 0].timestamp) / DAY, s.s, false);
      if (t > 0) { assert.equal(l.truth.p[i], r, 'the recorded chance is the curve'); ps.push(r); ys.push(x.rating > 1 ? 1 : 0); }
      st.set(x.cardId, nextState(w, s.s, s.d, t, x.rating, true, t > 0 ? r : l.truth.p[i]));
      lastDay.set(x.cardId, day);
    });
  }
  assert.ok(ps.length > 3000);
  const z = (idx) => { let e = 0, o = 0, v = 0; for (const i of idx) { e += ps[i]; o += ys[i]; v += ps[i] * (1 - ps[i]); } return { n: idx.length, d: (o - e) / Math.sqrt(v) }; };
  const everyone = z(ps.map((_, i) => i));
  assert.ok(Math.abs(everyone.d) < 4, `all rows z=${everyone.d}`);
  for (let b = 0; b < 5; b++) {
    const lo = 0.5 + b * 0.1, idx = ps.map((p, i) => i).filter(i => ps[i] >= lo && ps[i] < lo + 0.1 + (b === 4 ? 0.01 : 0));
    if (idx.length >= 200) assert.ok(Math.abs(z(idx).d) < 4.5, `bin ${lo}: z=${z(idx).d} n=${idx.length}`);
  }
});

test('the oracle beats a constant guess in both worlds', () => {
  const own = all(mini({ count: 6 })), ctl = all(mini({ world: 'fsrs', count: 6 }));
  const loss = ls => { const rows = longRows(ls), rate = mean(rows.map(r => r.y)); return { oracle: logLossOf(rows), base: logLossOf(rows, () => rate) }; };
  const a = loss(own), c = loss(ctl);
  assert.ok(a.oracle < a.base - 0.01, JSON.stringify(a));
  assert.ok(c.oracle < c.base, JSON.stringify(c));
});

test('features from the overrides equal the features from the timestamps', () => {
  const l = makeLearner(mini(), 11);
  const rows = rowsOf(l);
  const run = rs => { const f = new OwnFeatures(), out = []; for (const r of rs) { out.push(f.features(r)); f.commit(r); } return out; };
  const plain = run(rows);
  const last = new Map();
  const over = rows.map(r => { const o = { ...r, day: studyDay(r.t) }; const p = last.get(r.cardKey); if (p !== undefined) o.gapSec = (r.t - p) / 1000; last.set(r.cardKey, r.t); return o; });
  const withOver = run(over);
  assert.equal(plain.length, withOver.length);
  plain.forEach((f, i) => { for (let k = 0; k < f.length; k++) assert.ok(Math.abs(f[k] - withOver[i][k]) < 1e-6, `row ${i} feature ${k}`); });
  assert.ok(over.some(r => Number.isFinite(r.gapSec)));
});
