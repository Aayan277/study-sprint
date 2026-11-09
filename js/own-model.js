// Own model: the network itself. Pure maths, no DOM, no storage, no network. Design: docs/design/own-model.md.
//
// Four small memories (card, note, deck, you) read your answers one at a time. For each answer:
//   1. the note, deck and you memories relax toward their starting vector by the time that passed:  h = h0 + (h - h0) * exp(-dt / tau)
//   2. PREDICTION (what the loss is measured on): the head reads the four memories plus context features 3..11 and draws a
//      forgetting curve; the curve is read at the card's real gap. It never sees the rating, the time taken or the replay flag.
//   3. UPDATE: a GRU-like cell reads all 18 features plus the four memories and rewrites each memory:  h' = h + z * (c - h)
// The app runs this recipe as plain Float64-arithmetic loops (states are stored as Float32). The training tools keep a second
// version on an autodiff tape; it is not shipped in the app.
//
// An EVENT (what both paths read) is { f, ck, nk, dk, dt, gn, gd, gu, score, y }:
//   f       Float32Array(18), the features of the answer (OwnFeatures.features)
//   ck, nk, dk   the card, note and deck keys
//   dt      days since this card's last answer (null on its first answer)
//   gn, gd, gu   days since the note's, deck's and your last answer (null where there was none)
//   score   is this answer scored (a card's first answer is not)
//   y       1 if you passed (not Again), else 0
import { mulberry32 } from './fsrs-fit.js';
import { OwnFeatures } from './own-features.js';
import { headFromRaw, pAt, largestDayAtLeast } from './own-curve.js';
import {
  CURVE, DEFAULT_SIZE, DECAY_STREAMS, F, F_HEAD, HEAD_OUT, K, STABILITY_INIT_DAYS, STREAMS, TAU_MAX_DAYS, TAU_MIN_DAYS,
  headInputSize, inputSize, paramCount, paramLayout, paramOffsets, sizesOf
} from './own-spec.js';

const sigmoid = x => 1 / (1 + Math.exp(-x));
const HEAD_FROM = 3;                 // the head reads features 3 .. 3 + F_HEAD - 1
const gapOrNull = g => (g === undefined || g === null ? null : g);

// ---------- starting parameters ----------
// Deterministic: the same size and seed always give the same numbers (mulberry32).
export function initParams(size = DEFAULT_SIZE, seed = 1) {
  const s = sizesOf(size), off = paramOffsets(size), p = new Float64Array(paramCount(size)), rng = mulberry32(seed >>> 0);
  const nin = inputSize(s), qn = headInputSize(s);
  const uniform = (name, scale) => { const { offset, length } = off[name]; for (let i = 0; i < length; i++) p[offset + i] = (rng() * 2 - 1) * scale; };
  const fill = (name, v) => { const { offset, length } = off[name]; p.fill(v, offset, offset + length); };
  for (const tag of STREAMS) {
    uniform(`${tag}.Wz`, 1 / Math.sqrt(nin)); fill(`${tag}.bz`, -1);          // a gate that starts mostly closed: keep the old memory
    uniform(`${tag}.Wc`, 1 / Math.sqrt(nin)); fill(`${tag}.bc`, 0);
    fill(`${tag}.h0`, 0);
  }
  for (const tag of DECAY_STREAMS) {                                           // memory times, log-spaced from 0.05 to 100 days
    const { offset, length } = off[`${tag}.theta`];
    for (let j = 0; j < length; j++) p[offset + j] = Math.log(TAU_MIN_DAYS) + (Math.log(TAU_MAX_DAYS) - Math.log(TAU_MIN_DAYS)) * (length > 1 ? j / (length - 1) : 0);
  }
  uniform('head.W1', 1 / Math.sqrt(qn)); fill('head.b1', 0);
  uniform('head.W2', 0.1 / Math.sqrt(s.hidden));
  const b2 = off['head.b2'].offset;
  p[b2] = 2.2;                                                                 // ceiling about 0.9
  for (let k = 0; k < K; k++) { p[b2 + 1 + k] = 0; p[b2 + 4 + k] = Math.log(STABILITY_INIT_DAYS[k]); p[b2 + 7 + k] = -0.5; }
  return p;
}

// ---------- remembered states of one learner (values only; no gradients) ----------
export class StateStore {
  constructor() { this.cards = new Map(); this.notes = new Map(); this.decks = new Map(); this.user = null; }
  clone() {
    const c = new StateStore();
    c.cards = new Map(this.cards); c.notes = new Map(this.notes); c.decks = new Map(this.decks); c.user = this.user;   // arrays are replaced, never edited
    return c;
  }
}

// Rows (modelRows order) -> events. Walks a fresh feature builder through the rows. Pass your own builder to continue one.
export function eventsFromRows(rows, feats = new OwnFeatures()) {
  const out = [];
  for (const row of rows) {
    const g = feats.gaps(row);
    out.push({
      f: feats.features(row, false), ck: row.cardKey, nk: row.noteKey, dk: row.deckKey,
      dt: g.card, gn: g.note, gd: g.deck, gu: g.user, score: g.card !== null, y: row.rating > 1 ? 1 : 0
    });
    feats.commit(row);
  }
  return out;
}

// ---------- the model ----------
export function createOwnModel(params, size = DEFAULT_SIZE) {
  const s = sizesOf(size), off = paramOffsets(size), nin = inputSize(s), qn = headInputSize(s), hid = s.hidden;
  if (params.length !== paramCount(size)) throw new Error('Wrong number of parameters for this model size.');
  const O = name => off[name].offset;

  // ---------- fast path ----------
  // states: { card, note, deck, user } arrays or undefined (never seen -> the starting vector). gaps: { note, deck, user } days or null.
  // Returns decayed copies (Float64Array) that the prediction and the update both read.
  // One stream relaxed toward its starting vector by dt days (dt null or 0: no relaxation; h undefined: the starting vector).
  function decayStream(tag, h, dt) {
    const n = s[tag], o = new Float64Array(n), h0 = O(`${tag}.h0`);
    if (!h) for (let j = 0; j < n; j++) o[j] = params[h0 + j];
    else if (dt === null || !(dt > 0)) for (let j = 0; j < n; j++) o[j] = h[j];
    else {
      const th = O(`${tag}.theta`);
      for (let j = 0; j < n; j++) { const a = params[h0 + j]; o[j] = a + (h[j] - a) * Math.exp(-dt * Math.exp(-params[th + j])); }
    }
    return o;
  }
  function decayAll(states, gaps) {
    const out = {};
    for (const tag of STREAMS) out[tag] = decayStream(tag, states[tag], tag === 'card' || !gaps ? null : gapOrNull(gaps[tag]));
    return out;
  }

  // The head: the 10 raw numbers, then the curve. Reads features 3..11 only.
  function headRaw(dec, f) {
    const q = new Float64Array(qn);
    let at = 0;
    for (const tag of STREAMS) { q.set(dec[tag], at); at += s[tag]; }
    for (let i = 0; i < F_HEAD; i++) q[at + i] = f[HEAD_FROM + i];
    const w1 = O('head.W1'), b1 = O('head.b1'), w2 = O('head.W2'), b2 = O('head.b2');
    const u = new Float64Array(hid);
    for (let i = 0; i < hid; i++) {
      let a = 0;
      for (let j = 0, r = w1 + i * qn; j < qn; j++) a += params[r + j] * q[j];
      u[i] = Math.tanh(a + params[b1 + i]);
    }
    const raw = new Float64Array(HEAD_OUT);
    for (let k = 0; k < HEAD_OUT; k++) {
      let a = 0;
      for (let i = 0, r = w2 + k * hid; i < hid; i++) a += params[r + i] * u[i];
      raw[k] = a + params[b2 + k];
    }
    return raw;
  }
  const headOf = (dec, f) => headFromRaw(headRaw(dec, f));

  // The interval for a target R when the note memory fades before the card comes back.
  //   next: the four states right after an answer ({ card, note, deck, user }); fq: the query features (OwnFeatures.features(row, true)).
  // After t days the note memory has relaxed by t (deck and you by 0, as they will have been used again); the other query features are as of the
  // answer, not of the review. So p(t) = pAt(head(states faded by t), t) is lower than the curve read straight after the answer. Returns the largest whole
  // day in 1..maxDays with p >= target (at least 1), or null when p is not a real number. Only the note part of the head's first layer
  // depends on t, so the rest of it is computed once.
  function fadedDays(next, fq, target, maxDays) {
    const base = decayAll(next, { note: 0, deck: 0, user: 0 });
    const q = new Float64Array(qn);
    let at = 0;
    for (const tag of STREAMS) { q.set(base[tag], at); at += s[tag]; }
    for (let i = 0; i < F_HEAD; i++) q[at + i] = fq[HEAD_FROM + i];
    const w1 = O('head.W1'), b1 = O('head.b1'), w2 = O('head.W2'), b2 = O('head.b2'), n0 = s.card, n1 = s.card + s.note;
    const pre = new Float64Array(hid);
    for (let i = 0; i < hid; i++) {
      let a = params[b1 + i];
      for (let j = 0, r = w1 + i * qn; j < qn; j++) if (j < n0 || j >= n1) a += params[r + j] * q[j];
      pre[i] = a;
    }
    const u = new Float64Array(hid), raw = new Float64Array(HEAD_OUT);
    const pOf = t => {
      const note = decayStream('note', next.note, t);
      for (let i = 0; i < hid; i++) {
        let a = pre[i];
        for (let j = 0, r = w1 + i * qn + n0; j < s.note; j++) a += params[r + j] * note[j];
        u[i] = Math.tanh(a);
      }
      for (let k = 0; k < HEAD_OUT; k++) {
        let a = params[b2 + k];
        for (let i = 0, r = w2 + k * hid; i < hid; i++) a += params[r + i] * u[i];
        raw[k] = a;
      }
      return pAt(headFromRaw(raw), t);
    };
    const p1 = pOf(1);
    if (!Number.isFinite(p1)) return null;
    return largestDayAtLeast(t => (t === 1 ? p1 : pOf(t)), target, maxDays);
  }

  // The update: all four memories from the same input. Returns Float32Array states (what gets stored).
  function advance(f, dec) {
    const x = new Float64Array(nin);
    for (let i = 0; i < F; i++) x[i] = f[i];
    let at = F;
    for (const tag of STREAMS) { x.set(dec[tag], at); at += s[tag]; }
    const next = {};
    for (const tag of STREAMS) {
      const n = s[tag], h = dec[tag], out = new Float32Array(n), wz = O(`${tag}.Wz`), wc = O(`${tag}.Wc`), bz = O(`${tag}.bz`), bc = O(`${tag}.bc`);
      for (let i = 0; i < n; i++) {
        let zs = 0, cs = 0;
        for (let j = 0, rz = wz + i * nin, rc = wc + i * nin; j < nin; j++) { zs += params[rz + j] * x[j]; cs += params[rc + j] * x[j]; }
        const z = sigmoid(zs + params[bz + i]), c = Math.tanh(cs + params[bc + i]);
        out[i] = h[i] + z * (c - h[i]);
      }
      next[tag] = out;
    }
    return next;
  }

  // Run events through the fast path, changing `store` (Float32 states). Returns the chance of passing for each SCORED event.
  function predictChunk(events, store) {
    const ps = [];
    for (const ev of events) {
      const dec = decayAll({ card: store.cards.get(ev.ck), note: store.notes.get(ev.nk), deck: store.decks.get(ev.dk), user: store.user || undefined },
        { note: ev.gn, deck: ev.gd, user: ev.gu });
      if (ev.score) ps.push(pAt(headOf(dec, ev.f), ev.dt));
      const next = advance(ev.f, dec);
      store.cards.set(ev.ck, next.card); store.notes.set(ev.nk, next.note); store.decks.set(ev.dk, next.deck); store.user = next.user;
    }
    return ps;
  }

  // ---------- tape path (training) ----------
  // Forward over one chunk of events on `tape`, with states carried in from `store` as plain numbers (no gradient flows into them)
  // and written back to it at the end. The loss is the summed binary cross-entropy over the scored events. With backward = true
  // the gradients are ADDED into `grads` (Float64Array(paramCount), zero it between batches). The tape is reset at the end.
  // Returns { loss, count } (loss is the sum, not the mean; 0 when nothing was scored).
  function trainChunk(tape, grads, events, store, backward = true) {
    if (grads.length !== params.length) throw new Error('grads must be as long as the parameters.');
    const W = {};
    for (const { name } of paramLayout(size)) { const { offset, length } = off[name]; W[name] = tape.param(params.subarray(offset, offset + length), grads.subarray(offset, offset + length)); }
    const tauInv = {};
    for (const tag of DECAY_STREAMS) tauInv[tag] = tape.exp(tape.scale(W[`${tag}.theta`], -1));

    const live = { card: new Map(), note: new Map(), deck: new Map(), user: null };      // newest Var of each entity touched in this chunk
    const start = (tag, map, key, stored, dt) => {
      let h = map ? map.get(key) : live.user;
      if (!h && stored) h = tape.constant(stored);
      if (!h) return W[`${tag}.h0`];                                                        // never seen: the starting vector
      if (tag !== 'card' && dt !== null && dt > 0) {
        const e = tape.exp(tape.scale(tauInv[tag], -dt)), h0 = W[`${tag}.h0`];
        h = tape.add(h0, tape.mul(tape.sub(h, h0), e));
      }
      return h;
    };
    const ps = [], ys = [];
    for (const ev of events) {
      const hs = {
        card: start('card', live.card, ev.ck, store.cards.get(ev.ck), null),
        note: start('note', live.note, ev.nk, store.notes.get(ev.nk), gapOrNull(ev.gn)),
        deck: start('deck', live.deck, ev.dk, store.decks.get(ev.dk), gapOrNull(ev.gd)),
        user: start('user', null, 'u', store.user, gapOrNull(ev.gu))
      };
      const f = tape.constant(ev.f);
      if (ev.score) {
        const q = tape.concat([hs.card, hs.note, hs.deck, hs.user, tape.constant(ev.f.subarray(HEAD_FROM, HEAD_FROM + F_HEAD))]);
        const u = tape.tanh(tape.add(tape.matvec(W['head.W1'], q, hid, qn), W['head.b1']));
        const raw = tape.add(tape.matvec(W['head.W2'], u, HEAD_OUT, hid), W['head.b2']);
        const a = tape.scale(tape.sigmoid(tape.slice(raw, 0, 1)), CURVE.aSpan, CURVE.aMin);
        const pi = tape.softmax(tape.slice(raw, 1, K));
        const sv = tape.exp(tape.clampThrough(tape.slice(raw, 4, K), CURVE.rawLogStabilityMin, CURVE.rawLogStabilityMax));
        const beta = tape.scale(tape.softplus(tape.slice(raw, 7, K)), 1, CURVE.betaMin);
        const base = tape.scale(tape.div(tape.constant([ev.dt > 0 ? ev.dt : 0]), sv), 1, 1);      // 1 + t / s_k
        const r = tape.sum(tape.mul(pi, tape.pow(base, tape.scale(beta, -1))));
        ps.push(tape.clampThrough(tape.mul(a, r), CURVE.pMin, CURVE.pMax));
        ys.push(ev.y);
      }
      const x = tape.concat([f, hs.card, hs.note, hs.deck, hs.user]);
      const upd = (tag, h) => {
        const z = tape.sigmoid(tape.add(tape.matvec(W[`${tag}.Wz`], x, s[tag], nin), W[`${tag}.bz`]));
        const c = tape.tanh(tape.add(tape.matvec(W[`${tag}.Wc`], x, s[tag], nin), W[`${tag}.bc`]));
        return tape.add(h, tape.mul(z, tape.sub(c, h)));
      };
      live.card.set(ev.ck, upd('card', hs.card));
      live.note.set(ev.nk, upd('note', hs.note));
      live.deck.set(ev.dk, upd('deck', hs.deck));
      live.user = upd('user', hs.user);
    }
    let loss = 0;
    if (ps.length) {
      const l = tape.bce(tape.concat(ps), ys);
      loss = l.v[0];
      if (backward) tape.backward(l);
    }
    for (const [map, key] of [[live.card, 'cards'], [live.note, 'notes'], [live.deck, 'decks']]) for (const [k, v] of map) store[key].set(k, Float64Array.from(v.v));
    if (live.user) store.user = Float64Array.from(live.user.v);
    tape.reset();
    return { loss, count: ps.length };
  }

  return {
    size, sizes: s, params, paramCount: params.length,
    initVector: tag => params.slice(O(`${tag}.h0`), O(`${tag}.h0`) + s[tag]),
    decayAll, headRaw, headOf, fadedDays, advance, predictChunk, trainChunk
  };
}
