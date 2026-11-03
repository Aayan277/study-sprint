// RWKV lab: the memory engine. It owns the model, the feature builder and every entity's saved state, and turns a review
// (or a what-if) into predictions. No DOM, no storage: the worker drives it and decides what to save (snapshotDirty).
import { STREAMS } from './rwkv-spec.js';
import { createModel } from './rwkv-model.js';
import { FeatureBuilder } from './rwkv-features.js';
import { encodeEntity, decodeEntity } from './rwkv-state.js';
import { pCurve, pImm, pRating, headsFinite } from './rwkv-curve.js';

const UNDO_KEEP = 50;
const joinCurve = h => { const c = new Float32Array(9); c.set(h.w, 0); c.set(h.s, 3); c.set(h.d, 6); return c; };
export const splitCurve = c => ({ w: c.subarray(0, 3), s: c.subarray(3, 6), d: c.subarray(6, 9) });

export class Engine {
  // tensors: validated weights. stateBits: 8 (default; card and note states are kept as int8) or 0 (exact; used by tests)
  constructor(tensors, { stateBits = 8 } = {}) {
    this.model = createModel(tensors);
    this.stateBits = stateBits;
    this.builder = new FeatureBuilder();
    this.cards = new Map();     // cardKey -> saved card state (ArrayBuffer when stateBits is 8)
    this.notes = new Map();     // noteKey -> saved note state
    this.shared = new Map();    // deck, preset and user states (decoded, exact)
    this.curves = new Map();    // cardKey -> Float32Array(9): the card's current forgetting curve
    this.preds = {};            // logId -> { pCurve, pImm, elapsedDays }  (filled by replay)
    this.undos = [];
    this.dirty = { cards: new Set(), notes: new Set(), shared: new Set() };
  }

  // the five keys of a row, in stream order: card, deck, note, preset, user
  keys(row) { return [row.cardKey, row.deckKey, row.noteKey, row.presetKey, 'u']; }

  _store(i) { return i === 0 ? this.cards : i === 2 ? this.notes : this.shared; }
  _sk(i, key) { return i === 0 || i === 2 ? key : STREAMS[i].tag + '|' + key; }
  _packed(i) { return this.stateBits === 8 && (i === 0 || i === 2); }
  _get(i, key) {
    const v = this._store(i).get(this._sk(i, key));
    if (!v) return null;
    return this._packed(i) ? decodeEntity(i, v) : v;
  }
  _put(i, key, st) {
    const k = this._sk(i, key);
    this._store(i).set(k, this._packed(i) ? encodeEntity(i, st) : st);
    (i === 0 ? this.dirty.cards : i === 2 ? this.dirty.notes : this.dirty.shared).add(k);
  }
  _states(row) { return this.keys(row).map((k, i) => this._get(i, k)); }

  hasCard(cardKey) { return this.builder.cards.has(cardKey); }

  // A review happened. Updates all states. Returns { pCurve, pImm, elapsedDays, token }.
  //   pRating: chances of Again, Hard, Good, Easy if asked just before this answer.
  //   pImm: chance of passing if asked just before this answer (null on a card's first review).
  //   pCurve: the card's saved curve read at the real gap (null on a first review).
  review(row, { score = true, keepToken = true } = {}) {
    const b = this.builder;
    const e = b.elapsed(row);
    let pi = null, pc = null, pr = null;
    const states = this._states(row);       // decoded once, for the question and for the update
    if (score && !e.first) {
      const qh = this.model.step(b.features(row, true), states, true).heads;
      if (headsFinite(qh)) { pi = pImm(qh); pr = pRating(qh); }
      const cur = this.curves.get(row.cardKey);
      if (cur && cur.every(Number.isFinite)) pc = pCurve(splitCurve(cur), e.seconds);
    }
    const keys = this.keys(row);
    const prev = keepToken ? { states: keys.map((k, i) => this._store(i).get(this._sk(i, k))), curve: this.curves.get(row.cardKey) } : null;
    const { heads, next } = this.model.step(b.features(row, false), states, false);
    keys.forEach((k, i) => this._put(i, k, next[i]));
    this.curves.set(row.cardKey, joinCurve(heads));
    this.dirty.cards.add(row.cardKey);
    const bt = b.commit(row);
    let token = null;
    if (keepToken) {
      token = { logId: row.logId, keys, prev, builder: bt, cardKey: row.cardKey };
      this.undos.push(token);
      if (this.undos.length > UNDO_KEEP) this.undos.shift();
    }
    return { pCurve: pc, pImm: pi, pRating: pr, elapsedDays: e.days, token };
  }

  // Roll back one review by its log id. Only the last 50 reviews can be undone, newest first. Returns false when it can't.
  undo(logId) {
    const i = this.undos.findIndex(t => t.logId === logId);
    if (i < 0 || i !== this.undos.length - 1) return false;       // only the newest can be rolled back exactly
    const t = this.undos.pop();
    t.keys.forEach((k, s) => {
      const sk = this._sk(s, k), store = this._store(s), old = t.prev.states[s];
      if (old === undefined) store.delete(sk); else store.set(sk, old);
      (s === 0 ? this.dirty.cards : s === 2 ? this.dirty.notes : this.dirty.shared).add(sk);
    });
    if (t.prev.curve) this.curves.set(t.cardKey, t.prev.curve); else this.curves.delete(t.cardKey);
    this.dirty.cards.add(t.cardKey);
    this.builder.undo(t.builder);
    return true;
  }

  // Replay a whole history (rows in time order). Yields { done, total } every 500 rows; fills this.preds.
  *replay(rows, { score = true } = {}) {
    this.undos = [];                  // a replay is not undoable
    for (let n = 0; n < rows.length; n++) {
      const r = this.review(rows[n], { score, keepToken: false });
      if (score) this.preds[rows[n].logId] = { pCurve: r.pCurve, pImm: r.pImm, elapsedDays: r.elapsedDays };
      if ((n + 1) % 500 === 0) yield { done: n + 1, total: rows.length };
    }
    yield { done: rows.length, total: rows.length };
  }

  // What would the card's curve be after each answer? -> { 1..4: heads }, or null when any of them is not a real number
  // (the caller then leaves the card to FSRS). Changes nothing.
  whatIf(row, ms) {
    const states = this._states(row), out = {};
    for (let rating = 1; rating <= 4; rating++) {
      const r = { ...row, rating, ms };
      out[rating] = this.model.step(this.builder.features(r, false), states, true).heads;
      if (!headsFinite(out[rating])) return null;
    }
    return out;
  }

  // The records changed since the last call, ready to save. Clears the changed marks.
  snapshotDirty() {
    const pick = (set, map) => [...set].filter(k => map.has(k)).map(k => [k, map.get(k)]);
    const gone = (set, map) => [...set].filter(k => !map.has(k));
    const out = {
      cards: pick(this.dirty.cards, this.cards).map(([k, v]) => [k, v, this.curves.get(k) || null]),
      notes: pick(this.dirty.notes, this.notes),
      shared: pick(this.dirty.shared, this.shared),
      removed: { cards: gone(this.dirty.cards, this.cards), notes: gone(this.dirty.notes, this.notes), shared: gone(this.dirty.shared, this.shared) },
      builder: this.builder.toJSON()
    };
    this.dirty = { cards: new Set(), notes: new Set(), shared: new Set() };
    return out;
  }
}
