// Own model: reverse-mode automatic differentiation ("backpropagation") over Float64Array vectors, plus the Adam optimiser.
// Pure maths, no DOM, no storage, no network. tests/own-grad.test.js checks every op against nudging each number by hand.
//
// How it works. A Tape records each calculation as it runs forward (every op returns a new Var holding its values `v` and a
// gradient slot `g`). tape.backward(loss) then walks the record backwards: each op passes "how much does the loss change if
// my output changes" back to its inputs by the chain rule, and gradients add up wherever a Var is used more than once.
//
//   const tape = new Tape();
//   const w = tape.param(weights, weightGrads);      // gradients are ADDED into weightGrads (zero them yourself between batches)
//   const loss = tape.bce(tape.sigmoid(tape.matvec(w, x, 1, n)), [1]);
//   tape.backward(loss);
//   tape.reset();                                    // recycles the buffers; Vars from before the reset must not be used again
//
// Binary ops (add, sub, mul, div, pow) take two Vars of the same length, or one of length 1 (a single number used for all).

const EPS_P = 1e-12;

export class Tape {
  constructor() {
    this.nodes = [];          // one backward step per op, in forward order
    this.used = [];           // every buffer handed out since the last reset
    this.pool = new Map();    // length -> buffers ready for reuse (the arena)
  }

  alloc(n) {
    const free = this.pool.get(n);
    const a = free && free.length ? free.pop() : new Float64Array(n);
    a.fill(0);
    this.used.push(a);
    return a;
  }

  reset() {
    for (const a of this.used) {
      let free = this.pool.get(a.length);
      if (!free) this.pool.set(a.length, free = []);
      free.push(a);
    }
    this.used.length = 0;
    this.nodes.length = 0;
  }

  // ---------- leaves ----------
  // A learned number: its gradient is added into `grad` (same length). Values are used in place, not copied.
  param(value, grad) {
    if (grad.length !== value.length) throw new Error('param: value and grad must have the same length');
    return { v: value, g: grad, n: value.length };
  }
  // A fixed input: gradients stop here. Used in place, not copied: do not change it before backward().
  constant(values) {
    return { v: values, g: this.alloc(values.length), n: values.length };
  }

  make(n) { return { v: this.alloc(n), g: this.alloc(n), n }; }

  backward(loss) {
    if (loss.n !== 1) throw new Error('backward: the loss must be a single number');
    loss.g[0] = 1;
    for (let i = this.nodes.length - 1; i >= 0; i--) this.nodes[i]();
  }

  // ---------- matrix ----------
  // W is rows x cols, row-major, as one Var of length rows*cols. x has length cols. Result has length rows.
  matvec(W, x, rows, cols) {
    if (W.n !== rows * cols || x.n !== cols) throw new Error('matvec: shape mismatch');
    const out = this.make(rows), Wv = W.v, xv = x.v;
    for (let i = 0, k = 0; i < rows; i++) {
      let s = 0;
      for (let j = 0; j < cols; j++, k++) s += Wv[k] * xv[j];
      out.v[i] = s;
    }
    this.nodes.push(() => {
      for (let i = 0, k = 0; i < rows; i++) {
        const gi = out.g[i];
        for (let j = 0; j < cols; j++, k++) { W.g[k] += gi * xv[j]; x.g[j] += gi * Wv[k]; }
      }
    });
    return out;
  }

  // ---------- two inputs ----------
  binary(a, b, fwd, back) {
    const n = Math.max(a.n, b.n);
    if ((a.n !== n && a.n !== 1) || (b.n !== n && b.n !== 1)) throw new Error('shape mismatch: lengths must match, or one must be 1');
    const out = this.make(n), sa = a.n === 1 ? 0 : 1, sb = b.n === 1 ? 0 : 1;
    for (let i = 0; i < n; i++) out.v[i] = fwd(a.v[i * sa], b.v[i * sb]);
    this.nodes.push(() => {
      for (let i = 0; i < n; i++) back(out.g[i], a.v[i * sa], b.v[i * sb], out.v[i], a.g, i * sa, b.g, i * sb);
    });
    return out;
  }
  add(a, b) { return this.binary(a, b, (x, y) => x + y, (g, x, y, o, ag, ia, bg, ib) => { ag[ia] += g; bg[ib] += g; }); }
  sub(a, b) { return this.binary(a, b, (x, y) => x - y, (g, x, y, o, ag, ia, bg, ib) => { ag[ia] += g; bg[ib] -= g; }); }
  mul(a, b) { return this.binary(a, b, (x, y) => x * y, (g, x, y, o, ag, ia, bg, ib) => { ag[ia] += g * y; bg[ib] += g * x; }); }
  div(a, b) { return this.binary(a, b, (x, y) => x / y, (g, x, y, o, ag, ia, bg, ib) => { ag[ia] += g / y; bg[ib] -= g * x / (y * y); }); }
  // a ^ b, element by element. a must be positive.
  pow(a, b) {
    return this.binary(a, b, (x, y) => Math.pow(x, y), (g, x, y, o, ag, ia, bg, ib) => { ag[ia] += g * y * o / x; bg[ib] += g * o * Math.log(x); });
  }

  // ---------- one input ----------
  unary(a, fwd, dfn) {
    const out = this.make(a.n);
    for (let i = 0; i < a.n; i++) out.v[i] = fwd(a.v[i]);
    this.nodes.push(() => { for (let i = 0; i < a.n; i++) a.g[i] += out.g[i] * dfn(a.v[i], out.v[i]); });
    return out;
  }
  // c * a + d, with c and d plain numbers
  scale(a, c, d = 0) { return this.unary(a, x => c * x + d, () => c); }
  sigmoid(a) { return this.unary(a, x => 1 / (1 + Math.exp(-x)), (x, y) => y * (1 - y)); }
  tanh(a) { return this.unary(a, Math.tanh, (x, y) => 1 - y * y); }
  exp(a) { return this.unary(a, Math.exp, (x, y) => y); }
  log1p(a) { return this.unary(a, Math.log1p, x => 1 / (1 + x)); }
  softplus(a) { return this.unary(a, x => (x > 20 ? x : Math.log1p(Math.exp(x))), x => 1 / (1 + Math.exp(-x))); }
  // limits the values to [lo, hi]; the gradient is 1 inside and 0 outside (the true slope)
  clamp(a, lo, hi) { return this.unary(a, x => (x < lo ? lo : x > hi ? hi : x), x => (x < lo || x > hi ? 0 : 1)); }
  // limits the values to [lo, hi] but passes the gradient straight through (so a clamp never stops learning)
  clampThrough(a, lo, hi) { return this.unary(a, x => (x < lo ? lo : x > hi ? hi : x), () => 1); }

  softmax(a) {
    const out = this.make(a.n);
    let m = -Infinity;
    for (let i = 0; i < a.n; i++) if (a.v[i] > m) m = a.v[i];
    let s = 0;
    for (let i = 0; i < a.n; i++) { out.v[i] = Math.exp(a.v[i] - m); s += out.v[i]; }
    for (let i = 0; i < a.n; i++) out.v[i] /= s;
    this.nodes.push(() => {
      let dot = 0;
      for (let i = 0; i < a.n; i++) dot += out.g[i] * out.v[i];
      for (let i = 0; i < a.n; i++) a.g[i] += out.v[i] * (out.g[i] - dot);
    });
    return out;
  }

  // ---------- shape ----------
  concat(list) {
    const n = list.reduce((s, x) => s + x.n, 0), out = this.make(n);
    let at = 0;
    for (const x of list) { out.v.set(x.v, at); at += x.n; }
    this.nodes.push(() => {
      let o = 0;
      for (const x of list) { for (let i = 0; i < x.n; i++) x.g[i] += out.g[o + i]; o += x.n; }
    });
    return out;
  }
  slice(a, start, len) {
    if (start < 0 || len < 0 || start + len > a.n) throw new Error('slice: out of range');
    const out = this.make(len);
    for (let i = 0; i < len; i++) out.v[i] = a.v[start + i];
    this.nodes.push(() => { for (let i = 0; i < len; i++) a.g[start + i] += out.g[i]; });
    return out;
  }
  sum(a) {
    const out = this.make(1);
    let s = 0;
    for (let i = 0; i < a.n; i++) s += a.v[i];
    out.v[0] = s;
    this.nodes.push(() => { for (let i = 0; i < a.n; i++) a.g[i] += out.g[0]; });
    return out;
  }

  // ---------- loss ----------
  // Binary cross-entropy, summed: -sum(y ln p + (1 - y) ln(1 - p)). p are chances (0..1), y the plain 0/1 answers.
  bce(p, y) {
    if (y.length !== p.n) throw new Error('bce: p and y must have the same length');
    const out = this.make(1);
    const pc = i => (p.v[i] < EPS_P ? EPS_P : p.v[i] > 1 - EPS_P ? 1 - EPS_P : p.v[i]);
    let s = 0;
    for (let i = 0; i < p.n; i++) { const q = pc(i); s -= y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q); }
    out.v[0] = s;
    this.nodes.push(() => { for (let i = 0; i < p.n; i++) { const q = pc(i); p.g[i] += out.g[0] * (q - y[i]) / (q * (1 - q)); } });
    return out;
  }
}

// ---------- gradient clipping ----------
export function globalNorm(grads) {
  let s = 0;
  for (const g of Array.isArray(grads) ? grads : [grads]) for (let i = 0; i < g.length; i++) s += g[i] * g[i];
  return Math.sqrt(s);
}
// If the combined length of all the gradients is over maxNorm, shrink them all together (same direction). Returns the length before.
export function clipGlobalNorm(grads, maxNorm) {
  const norm = globalNorm(grads);
  if (norm > maxNorm && norm > 0) {
    const k = maxNorm / norm;
    for (const g of Array.isArray(grads) ? grads : [grads]) for (let i = 0; i < g.length; i++) g[i] *= k;
  }
  return norm;
}

// lr0 at step 0 falling along a half cosine to lr1 at step total
export const cosineLr = (step, total, lr0, lr1) => lr1 + 0.5 * (lr0 - lr1) * (1 + Math.cos(Math.PI * Math.min(1, step / Math.max(1, total))));

// ---------- Adam ----------
// Each step: (1) clip the loss gradient by its global norm (if `clip` is set), (2) add the leash l2 * (param - anchor) (anchor
// defaults to 0, which is plain L2 weight decay; for fine-tuning pass the starting values), (3) the Adam update: smoothed gradient
// over smoothed squared gradient, with bias correction. Your gradient array is never changed. Returns the gradient's norm before clipping.
export class Adam {
  constructor(n, { lr = 1e-3, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, l2 = 0, anchor = null, clip = Infinity } = {}) {
    this.n = n; this.lr = lr; this.beta1 = beta1; this.beta2 = beta2; this.eps = eps; this.l2 = l2; this.clip = clip;
    this.anchor = anchor ? Float64Array.from(anchor) : null;
    if (this.anchor && this.anchor.length !== n) throw new Error('Adam: anchor length mismatch');
    this.m = new Float64Array(n); this.v = new Float64Array(n); this.t = 0;
    this.buf = new Float64Array(n);
  }

  step(params, grad, lr = this.lr) {
    if (params.length !== this.n || grad.length !== this.n) throw new Error('Adam: length mismatch');
    const g = this.buf;
    g.set(grad);
    const norm = Number.isFinite(this.clip) ? clipGlobalNorm(g, this.clip) : globalNorm(g);
    if (this.l2 > 0) {
      const a = this.anchor;
      for (let i = 0; i < this.n; i++) g[i] += this.l2 * (params[i] - (a ? a[i] : 0));
    }
    this.t++;
    const c1 = 1 - Math.pow(this.beta1, this.t), c2 = 1 - Math.pow(this.beta2, this.t);
    for (let i = 0; i < this.n; i++) {
      this.m[i] = this.beta1 * this.m[i] + (1 - this.beta1) * g[i];
      this.v[i] = this.beta2 * this.v[i] + (1 - this.beta2) * g[i] * g[i];
      params[i] -= lr * (this.m[i] / c1) / (Math.sqrt(this.v[i] / c2) + this.eps);
    }
    return norm;
  }

  toJSON() { return { t: this.t, m: Array.from(this.m), v: Array.from(this.v) }; }
  loadState(j) { this.t = j.t; this.m.set(j.m); this.v.set(j.v); }
}
