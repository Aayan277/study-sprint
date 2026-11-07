// Own model: the memory engine. It owns the model, the feature builder and every entity's saved state, and turns a review (or a
// what-if) into predictions. No DOM, no storage: a worker drives it and decides what to save (snapshotDirty).
// Same surface as the RWKV lab's Engine (js/rwkv-engine.js) so one worker can drive either:
//   review(row, { score, keepToken }) -> { pCurve, pImm: null, elapsedDays, token }     undo(logId)     *replay(rows)
//   whatIf(row, ms) -> { 1..4: head } or null     hasCard(cardKey)     snapshotDirty()     toJSON() / Engine.fromJSON()
// Saved states are Float32Array: card 32 numbers (+ 10 curve numbers), note 16, deck 16, you 16.
import { OwnFeatures } from './own-features.js';
import { createOwnModel } from './own-model.js';
import { pAt, headFinite } from './own-curve.js';
import { DEFAULT_SIZE, K, OWN_FEATURE_VERSION, OWN_STATE_FORMAT } from './own-spec.js';

const UNDO_KEEP = 50;

// A head <-> 10 numbers: ceiling, mix weights, stabilities (days), shapes.
export const headToCurve = h => Float32Array.from([h.a, ...h.pi, ...h.s, ...h.beta]);
export const curveToHead = c => ({ a: c[0], pi: [c[1], c[2], c[3]], s: [c[4], c[5], c[6]], beta: [c[7], c[8], c[9]] });

const toB64 = arr => {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
};
const fromB64 = text => {
  const s = atob(text), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
};

export class Engine {
  // params: the parameter array (Float32Array or Float64Array) for `size`
  constructor(params, { size = DEFAULT_SIZE } = {}) {
    this.params = params;
    this.size = size;
    this.model = createOwnModel(params, size);
    this.builder = new OwnFeatures();
    this.cards = new Map();     // cardKey -> Float32Array(card size)
    this.notes = new Map();     // noteKey -> Float32Array(note size)
    this.shared = new Map();    // deckKey and 'u' -> Float32Array
    this.curves = new Map();    // cardKey -> Float32Array(10): the card's curve right after its last answer
    this.preds = {};            // logId -> { pCurve, pImm, elapsedDays }  (filled by replay)
    this.undos = [];
    this.dirty = { cards: new Set(), notes: new Set(), shared: new Set() };
  }

  hasCard(cardKey) { return this.builder.cards.has(cardKey); }

  _states(row) {
    return { card: this.cards.get(row.cardKey), note: this.notes.get(row.noteKey), deck: this.shared.get(row.deckKey), user: this.shared.get('u') };
  }

  // A review happened. Updates all states. Returns { pCurve, pImm, elapsedDays, token, head }.
  //   pCurve: the chance of passing if asked just before this answer (null on a card's first review, or when not scored).
  //           It is computed before the answer is looked at: the rating, time and replay flag cannot reach it.
  //   head:   the curve that prediction was read from (null when pCurve was not computed)
  review(row, { score = true, keepToken = true } = {}) {
    const b = this.builder, m = this.model;
    const g = b.gaps(row), fq = b.features(row, true), f = b.features(row, false);
    const st = this._states(row), dec = m.decayAll(st, g);
    let pc = null, qh = null;
    if (score && g.card !== null) {
      qh = m.headOf(dec, fq);
      pc = headFinite(qh) ? pAt(qh, g.card) : null;
    }
    const next = m.advance(f, dec);
    const curve = headToCurve(m.headOf(next, fq));
    const prev = keepToken ? { ...st, curve: this.curves.get(row.cardKey) } : null;
    this.cards.set(row.cardKey, next.card); this.dirty.cards.add(row.cardKey);
    this.notes.set(row.noteKey, next.note); this.dirty.notes.add(row.noteKey);
    this.shared.set(row.deckKey, next.deck); this.dirty.shared.add(row.deckKey);
    this.shared.set('u', next.user); this.dirty.shared.add('u');
    this.curves.set(row.cardKey, curve);
    const bt = b.commit(row);
    let token = null;
    if (keepToken) {
      token = { logId: row.logId, cardKey: row.cardKey, noteKey: row.noteKey, deckKey: row.deckKey, prev, builder: bt };
      this.undos.push(token);
      if (this.undos.length > UNDO_KEEP) this.undos.shift();
    }
    return { pCurve: pc, pImm: null, elapsedDays: g.card, token, head: qh };
  }

  // Roll back one review by its log id. Only the newest of the last 50 reviews can be undone. Returns false when it can't.
  undo(logId) {
    const i = this.undos.findIndex(t => t.logId === logId);
    if (i < 0 || i !== this.undos.length - 1) return false;
    const t = this.undos.pop(), p = t.prev;
    const back = (map, key, old, dirty) => { if (old === undefined) map.delete(key); else map.set(key, old); dirty.add(key); };
    back(this.cards, t.cardKey, p.card, this.dirty.cards);
    back(this.notes, t.noteKey, p.note, this.dirty.notes);
    back(this.shared, t.deckKey, p.deck, this.dirty.shared);
    back(this.shared, 'u', p.user, this.dirty.shared);
    if (p.curve) this.curves.set(t.cardKey, p.curve); else this.curves.delete(t.cardKey);
    this.dirty.cards.add(t.cardKey);
    this.builder.undo(t.builder);
    return true;
  }

  // Replay a whole history (rows in time order). Yields { done, total } every 500 rows; fills this.preds.
  *replay(rows, { score = true } = {}) {
    this.undos = [];
    for (let n = 0; n < rows.length; n++) {
      const r = this.review(rows[n], { score, keepToken: false });
      if (score) this.preds[rows[n].logId] = { pCurve: r.pCurve, pImm: null, elapsedDays: r.elapsedDays };
      if ((n + 1) % 500 === 0) yield { done: n + 1, total: rows.length };
    }
    yield { done: rows.length, total: rows.length };
  }

  // What would the card's curve be after each answer (Again, Hard, Good, Easy), answered now in `ms` milliseconds?
  // -> { 1..4: head }, or null when any head is not made of real numbers (the caller then leaves the card to FSRS). Changes nothing.
  whatIf(row, ms) {
    const b = this.builder, m = this.model;
    const dec = m.decayAll(this._states(row), b.gaps(row)), fq = b.features(row, true), out = {};
    for (let rating = 1; rating <= 4; rating++) {
      const f = b.features({ ...row, rating, ms }, false);
      out[rating] = m.headOf(m.advance(f, dec), fq);
      if (!headFinite(out[rating])) return null;
    }
    return out;
  }

  // The whole days the Hard, Good and Easy buttons would give (target retention R, at most maxDays), the way the replay test schedules:
  // each what-if answer's states are read with the note memory faded over the gap, so the prediction at review time (not the curve right
  // after the answer) is what meets R. -> { 2, 3, 4 } at least 1, never decreasing, or null when a head is not made of real numbers
  // (the caller then leaves the card to FSRS). Changes nothing.
  daysForButtons(row, ms, target, maxDays) {
    const b = this.builder, m = this.model;
    const dec = m.decayAll(this._states(row), b.gaps(row)), fq = b.features(row, true), out = {};
    for (const rating of [2, 3, 4]) {
      const next = m.advance(b.features({ ...row, rating, ms }, false), dec);
      if (!headFinite(m.headOf(next, fq))) return null;
      const d = m.fadedDays(next, fq, target, maxDays);
      if (d === null) return null;
      out[rating] = Math.max(1, Math.min(maxDays, d));
    }
    out[3] = Math.max(out[3], out[2]);
    out[4] = Math.max(out[4], out[3]);
    return out;
  }

  // The interval for a card from its stored states (what is saved right after its last answer, as the stored curve is), read for `row`'s
  // query features: whole days at least 1, at most maxDays, or null when the card is unknown or its numbers are not real numbers.
  intervalDays(row, target, maxDays) {
    const st = this._states(row);
    if (!st.card) return null;
    const m = this.model, fq = this.builder.features(row, true), next = m.decayAll(st, null);
    if (!headFinite(m.headOf(next, fq))) return null;
    return m.fadedDays(next, fq, target, maxDays);
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

  // Everything the engine remembers, as plain JSON (states are base64 of the raw float32 bytes; bytes survive a round trip).
  toJSON() {
    const enc = map => [...map].map(([k, v]) => [k, toB64(v)]);
    return {
      format: OWN_STATE_FORMAT, featureVersion: OWN_FEATURE_VERSION, size: this.size,
      builder: this.builder.toJSON(), cards: enc(this.cards), notes: enc(this.notes), shared: enc(this.shared), curves: enc(this.curves)
    };
  }

  static fromJSON(json, params, opts = {}) {
    if (!json || json.format !== OWN_STATE_FORMAT || json.featureVersion !== OWN_FEATURE_VERSION) throw new Error('This saved state was made by a different version of the model.');
    const e = new Engine(params, { size: opts.size || json.size || DEFAULT_SIZE });
    const dec = list => new Map(list.map(([k, v]) => [k, fromB64(v)]));
    e.builder = OwnFeatures.fromJSON(json.builder);
    e.cards = dec(json.cards); e.notes = dec(json.notes); e.shared = dec(json.shared); e.curves = dec(json.curves);
    for (const c of e.curves.values()) if (c.length !== 3 * K + 1) throw new Error('Saved curve has the wrong length.');
    return e;
  }
}
