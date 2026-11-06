// Own model: the fixed numbers and the list of parameter blocks. Pure data, no DOM, no storage, no network.
// The model is our own design (docs/design/own-model.md).

export const OWN_FEATURE_VERSION = 1;
export const OWN_STATE_FORMAT = 'own-f32-v1';

export const F = 18;           // numbers per answer: 12 context ones, then 6 outcome ones
export const F_CONTEXT = 12;   // features 0..11 are known before you answer; the prediction may only read these
export const F_HEAD = 9;       // the head reads context features 3..11 (not 0..2: elapsed, first-answer and same-day flags)
export const HEAD_OUT = 10;    // ceiling (1) + mix weights (3) + stabilities (3) + shapes (3)
export const K = 3;            // power-law components in the curve

// Memory sizes. 'm' is a bigger research size; only the default ships.
export const SIZES = {
  s: { card: 32, note: 16, deck: 16, user: 16, hidden: 32 },
  m: { card: 64, note: 32, deck: 32, user: 32, hidden: 32 }
};
export const DEFAULT_SIZE = 's';

// The streams that decay with wall time (the card stream does not).
export const DECAY_STREAMS = ['note', 'deck', 'user'];
export const STREAMS = ['card', 'note', 'deck', 'user'];

// Decay times start log-spaced from 0.05 to 100 days (the learned number is theta = ln(tau)).
export const TAU_MIN_DAYS = 0.05;
export const TAU_MAX_DAYS = 100;
// The three stabilities of the curve start at these many days (the head's last-layer bias starts at their log).
export const STABILITY_INIT_DAYS = [0.5, 5, 50];

export const CURVE = { aMin: 0.02, aSpan: 0.97, betaMin: 0.1, pMin: 1e-4, pMax: 1 - 1e-4, rawLogStabilityMax: 12, rawLogStabilityMin: -12 };

export const sizesOf = size => {
  const s = typeof size === 'string' ? SIZES[size] : size;
  if (!s) throw new Error('Unknown model size.');
  return s;
};

export const inputSize = s => F + s.card + s.note + s.deck + s.user;          // x = [features, h_card, h_note, h_deck, h_user]
export const headInputSize = s => s.card + s.note + s.deck + s.user + F_HEAD; // q

// [{ name, shape }] in storage order. A GRU-like cell per stream: update gate (z) and candidate (c), each W (n x inputSize) and b (n).
export function paramLayout(size = DEFAULT_SIZE) {
  const s = sizesOf(size), nin = inputSize(s), q = headInputSize(s);
  const out = [];
  for (const tag of STREAMS) {
    const n = s[tag];
    out.push({ name: `${tag}.Wz`, shape: [n, nin] }, { name: `${tag}.bz`, shape: [n] }, { name: `${tag}.Wc`, shape: [n, nin] }, { name: `${tag}.bc`, shape: [n] });
  }
  for (const tag of DECAY_STREAMS) out.push({ name: `${tag}.theta`, shape: [s[tag]] });
  for (const tag of STREAMS) out.push({ name: `${tag}.h0`, shape: [s[tag]] });
  out.push({ name: 'head.W1', shape: [s.hidden, q] }, { name: 'head.b1', shape: [s.hidden] }, { name: 'head.W2', shape: [HEAD_OUT, s.hidden] }, { name: 'head.b2', shape: [HEAD_OUT] });
  return out;
}

export const shapeSize = shape => shape.reduce((a, b) => a * b, 1);
export const paramCount = (size = DEFAULT_SIZE) => paramLayout(size).reduce((n, p) => n + shapeSize(p.shape), 0);

// name -> { offset, length, shape } into one flat array
export function paramOffsets(size = DEFAULT_SIZE) {
  const map = {};
  let at = 0;
  for (const p of paramLayout(size)) { const length = shapeSize(p.shape); map[p.name] = { offset: at, length, shape: p.shape }; at += length; }
  return map;
}
