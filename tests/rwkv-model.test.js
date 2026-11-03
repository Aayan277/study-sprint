import './rwkv-utc.mjs';           // the golden fixture is in UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseWeights, validateWeights } from '../js/rwkv-weights.js';
import { createModel } from '../js/rwkv-model.js';
import { Engine, splitCurve } from '../js/rwkv-engine.js';
import { modelRows, FeatureBuilder } from '../js/rwkv-features.js';
import { pCurve, pImm } from '../js/rwkv-curve.js';
import { LAYER_STEPS, STREAMS, D } from '../js/rwkv-spec.js';
import { fakeWeights } from './rwkv-fake-weights.mjs';

const fake = parseWeights(fakeWeights({ seed: 9, format: 'int8' }).buffer).tensors;
const feats = seed => { let s = seed; return Float32Array.from({ length: 92 }, () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }); };
const noStates = () => [null, null, null, null, null];
const copy = st => st && { layers: st.layers.map(l => ({ shift: Float32Array.from(l.shift), S: Float32Array.from(l.S), ...(l.cshift ? { cshift: Float32Array.from(l.cshift) } : {}) })) };

test('made-up weights: finite, repeatable, and four output groups of the right size', () => {
  const m = createModel(fake);
  const a = m.step(feats(1), noStates(), false), b = m.step(feats(1), noStates(), false);
  for (const k of ['w', 's', 'd']) assert.equal(a.heads[k].length, 3);
  assert.equal(a.heads.p.length, 4);
  for (const k of ['w', 's', 'd', 'p']) { assert.ok(a.heads[k].every(Number.isFinite)); assert.deepEqual(a.heads[k], b.heads[k]); }
  assert.deepEqual(a.next[0].layers[1].S, b.next[0].layers[1].S);
  assert.deepEqual(a.next.map(s => s.layers.length), [2, 4, 1, 3, 3]);
  assert.equal(a.next[0].layers[0].cshift.length, 64);
  assert.equal(a.next[0].layers[1].cshift, undefined);       // the card's second layer has no channel mixer
  assert.equal(a.next[1].layers[3].cshift.length, 64);        // the deck's last layer has one
  assert.equal(a.next[3].layers[0].cshift, undefined);
});

test('a skipped step (a question) commits nothing and does not touch the saved states', () => {
  const m = createModel(fake);
  const first = m.step(feats(2), noStates(), false);
  const states = first.next, before = states.map(copy);
  const q = m.step(feats(3), states, true);
  assert.equal(q.next, null);
  assert.ok(q.heads.p.every(Number.isFinite));
  assert.deepEqual(states, before);
  // and the same question twice gives the same answer
  assert.deepEqual(m.step(feats(3), states, true).heads, q.heads);
});

test('the saved states change the answer; the 23rd input is ignored', () => {
  const m = createModel(fake);
  const s1 = m.step(feats(2), noStates(), false).next;
  const cold = m.step(feats(3), noStates(), true).heads, warm = m.step(feats(3), s1, true).heads;
  assert.notDeepEqual(cold.p, warm.p);
  const f = feats(4), g = Float32Array.from(f); g[22] = 5;
  assert.deepEqual(m.step(f, noStates(), true).heads, m.step(g, noStates(), true).heads);
});

test('a new entity starts from an empty matrix: the first write is one outer product per head', () => {
  const m = createModel(fake);
  const { next } = m.step(feats(5), noStates(), false);
  for (const st of next) for (const ly of st.layers) for (let h = 0; h < 4; h++) {
    const S = ly.S, o = h * 256;
    // rows are all multiples of one vector: every 2x2 minor with row 0 vanishes
    let ref = 0;
    for (let j = 0; j < 16; j++) if (Math.abs(S[o + j]) > Math.abs(S[o + ref])) ref = j;
    for (let i = 1; i < 16; i++) for (let j = 0; j < 16; j++) {
      const minor = S[o + ref] * S[o + i * 16 + j] - S[o + j] * S[o + i * 16 + ref];
      assert.ok(Math.abs(minor) < 1e-6 * (1 + Math.abs(S[o + ref] * S[o + i * 16 + j])), 'rank one');
    }
  }
});

test('the 13 steps run interleaved: changing the order changes the answer', () => {
  const m = createModel(fake);
  const run = () => m.step(feats(6), noStates(), true).heads.p;
  const normal = run();
  const saved = LAYER_STEPS.map(x => x.slice());
  try {
    [LAYER_STEPS[1], LAYER_STEPS[5]] = [LAYER_STEPS[5], LAYER_STEPS[1]];        // deck L0 after card L1
    const swapped = run();
    assert.notDeepEqual(swapped, normal);
  } finally { LAYER_STEPS.splice(0, LAYER_STEPS.length, ...saved); }
  assert.deepEqual(run(), normal);
});

// ---------- against the model's own reference implementation (needs the owner's weights; skipped without them) ----------
const privateDir = process.env.RWKV_PRIVATE_DIR || path.join(os.homedir(), 'rwkv-lab-private');
const weightsPath = process.env.RWKV_WEIGHTS || path.join(privateDir, 'weights.int8.bin');
const expectedPath = path.join(privateDir, 'golden-expected.json');

test('golden: matches the reference model on a made-up history (stateBits 8 and 0)', t => {
  if (!fs.existsSync(weightsPath) || !fs.existsSync(expectedPath)) { t.skip('owner weights not present'); return; }
  const bytes = fs.readFileSync(weightsPath);
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== expected.weightsSha256) { t.skip('owner weights not present (a different weights file)'); return; }
  const parsed = parseWeights(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  assert.deepEqual(validateWeights(parsed.tensors), { ok: true, errors: [] });
  const g = JSON.parse(fs.readFileSync(new URL('./fixtures/rwkv/golden.json', import.meta.url), 'utf8'));
  const rows = modelRows(g.logs, g.cards, g.decks);
  const own = new Set(g.decks.filter(d => d.options).map(d => d.id));
  const report = {};
  for (const bits of [0, 8]) {
    const E = expected.stateBits[bits], eng = new Engine(parsed.tensors, { stateBits: bits });
    const err = { heads: 0, headsMean: 0, nHeads: 0, probs: 0, whatIf: 0, early: 0 };
    rows.forEach((r, i) => {
      const res = eng.review(r, { keepToken: false });
      const u = E.updates[r.logId], cur = eng.curves.get(r.cardKey);
      const rowErr = { heads: 0, probs: 0 };
      u.heads.forEach((v, k) => { rowErr.heads = Math.max(rowErr.heads, Math.abs(v - cur[k])); err.headsMean += Math.abs(v - cur[k]); err.nHeads++; });
      expected.curveTimes.forEach((tt, k) => { rowErr.probs = Math.max(rowErr.probs, Math.abs(u.pAt[k] - pCurve(splitCurve(cur), tt))); });
      if (res.pImm !== null) {
        const q = E.queries[r.logId];
        rowErr.probs = Math.max(rowErr.probs, Math.abs(q.pImm - res.pImm));
        q.pRating.forEach((v, k) => { rowErr.probs = Math.max(rowErr.probs, Math.abs(v - res.pRating[k])); });
        if (u.pActual !== undefined) rowErr.probs = Math.max(rowErr.probs, Math.abs(u.pActual - res.pCurve));
      } else assert.equal(E.queries[r.logId], undefined, 'a first review has no question');
      err.heads = Math.max(err.heads, rowErr.heads); err.probs = Math.max(err.probs, rowErr.probs);
      if (i < 25) err.early = Math.max(err.early, rowErr.heads, rowErr.probs * 2);
    });
    err.headsMean /= err.nHeads;
    for (const w of g.whatIf) {
      const card = g.cards.find(c => c.id === w.cardId);
      const base = { cardKey: 'c:' + w.cardId, noteKey: card.noteId ? 'n:' + card.noteId : 'c:' + w.cardId, deckKey: 'd:' + card.deckId, presetKey: own.has(card.deckId) ? 'p:' + card.deckId : 'p:default', t: w.t, day: Math.floor((w.t - 4 * 3600000) / 86400000) };
      const heads = eng.whatIf(base, w.ms);
      for (const k of [1, 2, 3, 4]) E.whatIf[w.cardId][k].forEach((v, j) => { err.whatIf = Math.max(err.whatIf, Math.abs(v - [...heads[k].w, ...heads[k].s, ...heads[k].d][j])); });
    }
    report[bits] = err;
    console.log(`golden stateBits ${bits}: max error heads ${err.heads.toExponential(2)}, probabilities ${err.probs.toExponential(2)}, what-if heads ${err.whatIf.toExponential(2)}, mean heads ${err.headsMean.toExponential(2)}`);
  }
  // Exact state (stateBits 0): the full tolerances.
  assert.ok(report[0].probs < 5e-5, 'probabilities, exact state: ' + report[0].probs);
  assert.ok(report[0].heads < 1e-4, 'curve heads, exact state: ' + report[0].heads);
  assert.ok(report[0].whatIf < 1e-4, 'what-if heads, exact state: ' + report[0].whatIf);
  // THE REAL GUARD for the int8 state path: the strict first-25 check. The wide whole-history bounds below would not notice, for
  // example, a missing f16 rounding of the saved shifts (it only shows as a small drift), but this strict check does.
  // (The teacher-forced test after this one checks single steps from the reference's own saved states.)
  // int8 state: the first 25 reviews (before any rounding step can land on the other side of a tie) match to the same tolerance.
  // After that a one-step difference in a single saved number, caused by float rounding in the reference's matrix products, can move later
  // outputs a little, so the whole history gets wider bounds (see docs/design/rwkv-lab.md).
  assert.ok(report[8].early < 1e-4, 'first 25 reviews, int8 state: ' + report[8].early);
  assert.ok(report[8].probs < 3e-4, 'probabilities, int8 state: ' + report[8].probs);
  assert.ok(report[8].heads < 3e-3, 'curve heads, int8 state: ' + report[8].heads);
  assert.ok(report[8].headsMean < 2e-4, 'mean curve-head error, int8 state: ' + report[8].headsMean);
  assert.ok(report[8].whatIf < 3e-3, 'what-if heads, int8 state: ' + report[8].whatIf);
});

// Teacher forcing: the long-history test above lets small differences pile up. Here every checked step starts from the reference's own
// saved (int8-rounded) states for that review, so what is compared is one step of our model against one step of the reference.
test('golden: one step from the reference\'s own saved int8 state matches to about 1e-5 (teacher forcing)', t => {
  if (!fs.existsSync(weightsPath) || !fs.existsSync(expectedPath)) { t.skip('owner weights not present'); return; }
  const bytes = fs.readFileSync(weightsPath);
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== expected.weightsSha256) { t.skip('owner weights not present (a different weights file)'); return; }
  if (!expected.teacher) { t.skip('regenerate ~/rwkv-lab-private/golden-expected.json with the current make_golden.py'); return; }
  const parsed = parseWeights(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const model = createModel(parsed.tensors);
  const g = JSON.parse(fs.readFileSync(new URL('./fixtures/rwkv/golden.json', import.meta.url), 'utf8'));
  const E = expected.stateBits[8];
  const unpack = (stream, b64) => {
    if (b64 === null) return null;
    const raw = Buffer.from(b64, 'base64');
    const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
    let pos = 0;
    const take = n => { const a = f.slice(pos, pos + n); pos += n; return a; };
    const layers = [];
    for (let l = 0; l < STREAMS[stream].layers; l++) {
      const ly = { shift: take(D), S: take(1024) };
      if (STREAMS[stream].mixer.includes(l)) ly.cshift = take(D);
      layers.push(ly);
    }
    assert.equal(pos, f.length, 'the saved state has the expected size');
    return { layers };
  };
  const builder = new FeatureBuilder();
  let worst = 0, worstP = 0, checked = 0;
  for (const r of modelRows(g.logs, g.cards, g.decks)) {
    const saved = expected.teacher[r.logId];
    if (saved) {
      const states = saved.map((b64, i) => unpack(i, b64));
      const q = E.queries[r.logId];
      if (q) worstP = Math.max(worstP, Math.abs(q.pImm - pImm(model.step(builder.features(r, true), states, true).heads)));
      const h = model.step(builder.features(r, false), states, false).heads;
      [...h.w, ...h.s, ...h.d].forEach((v, k) => { worst = Math.max(worst, Math.abs(v - E.updates[r.logId].heads[k])); });
      checked++;
    }
    builder.commit(r);
  }
  console.log(`golden teacher forcing: ${checked} steps, max curve-head error ${worst.toExponential(2)}, max pImm error ${worstP.toExponential(2)}`);
  assert.ok(checked >= 50);
  assert.ok(worst < 2e-5, 'curve heads from the reference\'s own state: ' + worst);
  assert.ok(worstP < 2e-5, 'pImm from the reference\'s own state: ' + worstP);
});
