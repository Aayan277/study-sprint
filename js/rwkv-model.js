// RWKV lab: the forward pass for one review, written from the model's published description. Pure maths on Float32Arrays;
// no DOM, no storage, no network. All matrices come straight from the validated weights file.
import { STREAMS, LAYER_STEPS, D, F, FC, H, K, EPS } from './rwkv-spec.js';

const sigmoid = x => 1 / (1 + Math.exp(-x));
const softplus = x => (x > EPS.softplusThreshold ? x : Math.log(1 + Math.exp(x)));

// y = W x (+ b), W is rows x cols, row-major
function linear(W, rows, cols, x, out, b) {
  for (let r = 0, o = 0; r < rows; r++, o += cols) {
    let s = b ? b[r] : 0;
    for (let c = 0; c < cols; c++) s += W[o + c] * x[c];
    out[r] = s;
  }
}

function layerNorm(x, w, b, out, n = x.length) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mean; v += d * d; }
  const inv = 1 / Math.sqrt(v / n + EPS.layerNorm);
  for (let i = 0; i < n; i++) out[i] = (x[i] - mean) * inv * w[i] + b[i];
}

// the same, over each group of `size` channels
function groupNorm(x, w, b, out, groups, size) {
  for (let g = 0; g < groups; g++) {
    const o = g * size;
    let mean = 0;
    for (let i = 0; i < size; i++) mean += x[o + i];
    mean /= size;
    let v = 0;
    for (let i = 0; i < size; i++) { const d = x[o + i] - mean; v += d * d; }
    const inv = 1 / Math.sqrt(v / size + EPS.groupNorm);
    for (let i = 0; i < size; i++) out[o + i] = (x[o + i] - mean) * inv * w[o + i] + b[o + i];
  }
}

const silu = (a, n) => { for (let i = 0; i < n; i++) a[i] = a[i] / (1 + Math.exp(-a[i])); };

export function createModel(tensors) {
  const T = name => { const t = tensors.get(name); if (!t) throw new Error('Missing tensor ' + name); return t.data; };
  const top = {
    f0W: T('features2card.0.weight'), f0B: T('features2card.0.bias'), f2W: T('features2card.2.weight'), f2B: T('features2card.2.bias'),
    f3W: T('features2card.3.weight'), f3B: T('features2card.3.bias'), preW: T('prehead_norm.weight'), preB: T('prehead_norm.bias'),
    h0W: T('head_w.0.weight'), h0B: T('head_w.0.bias'), h2W: T('head_w.2.weight'), h2B: T('head_w.2.bias'), h4W: T('head_w.4.weight'), h4B: T('head_w.4.bias'),
    gw: T('gru_w_weight'), gwB: T('gru_w_bias'), gs: T('gru_s_weight'), gsB: T('gru_s_bias'), gd: T('gru_d_weight'), gdB: T('gru_d_bias'),
    p0W: T('head_p.0.weight'), p0B: T('head_p.0.bias'), pW: T('p_linear.weight'), pB: T('p_linear.bias')
  };
  const layers = STREAMS.map((s, i) => Array.from({ length: s.layers }, (_, l) => {
    const t = `rwkv_modules.${i}.blocks.${l}.time_mixer.`, c = `rwkv_modules.${i}.blocks.${l}.channel_mixer.`;
    const tm = {
      lnW: T(t + 'layer_norm.weight'), lnB: T(t + 'layer_norm.bias'), lerp: T(t + 'rkvdag_lerp'), bonus: T(t + 'bonus'),
      Wr: T(t + 'W_r.weight'), Wk: T(t + 'W_k.weight'), Wv: T(t + 'W_v.weight'), Wo: T(t + 'W_o.weight'),
      ksW: T(t + 'k_scale_linear.weight'), ksB: T(t + 'k_scale_linear.bias'), vsW: T(t + 'v_scale_linear.weight'), vsB: T(t + 'v_scale_linear.bias'),
      aA: T(t + 'a_lora_simple.A.weight'), aB: T(t + 'a_lora_simple.B_and_lamb.weight'), aBb: T(t + 'a_lora_simple.B_and_lamb.bias'),
      dA: T(t + 'd_lora_mlp.A.weight'), dB: T(t + 'd_lora_mlp.B_and_lamb.weight'), dBb: T(t + 'd_lora_mlp.B_and_lamb.bias'),
      gA: T(t + 'lora_A_g.weight'), gB: T(t + 'lora_B_g.weight'), gnW: T(t + 'out_group_norm.weight'), gnB: T(t + 'out_group_norm.bias')
    };
    if (l > 0) { tm.vA = T(t + 'v_lora_simple.A.weight'); tm.vB = T(t + 'v_lora_simple.B_and_lamb.weight'); tm.vBb = T(t + 'v_lora_simple.B_and_lamb.bias'); }
    const cm = s.mixer.includes(l)
      ? { lnW: T(c + 'layer_norm.weight'), lnB: T(c + 'layer_norm.bias'), lerpK: T(c + 'lerp_k'), Wk: T(c + 'W_k.weight'), Wv: T(c + 'W_v.weight') }
      : null;
    return { tm, cm };
  }));

  // scratch buffers, reused by every step (the model is not re-entrant)
  const b = {
    x: new Float32Array(D), h128: new Float32Array(FC), xl: new Float32Array(D), mix: Array.from({ length: 8 }, () => new Float32Array(D)),
    r: new Float32Array(D), k: new Float32Array(D), v: new Float32Array(D), a: new Float32Array(D), g: new Float32Array(D), w: new Float32Array(D),
    ks: new Float32Array(H), vs: new Float32Array(H), lora: new Float32Array(4), tmp: new Float32Array(D), out: new Float32Array(D),
    gnOut: new Float32Array(D), bon: new Float32Array(H), kd: new Float32Array(D), vv: new Float32Array(D), gated: new Float32Array(D), proj: new Float32Array(D),
    sNew: new Float32Array(H * K * K), cmk: new Float32Array(D), cmMix: new Float32Array(D), hh: new Float32Array(D), u: new Float32Array(FC), u0: new Float32Array(D), p128: new Float32Array(FC)
  };

  function timeMixer(tm, l, x, v0, st, wantNext) {
    const { xl, mix, r, k, v, a, g, w, ks, vs, lora, tmp, out, kd, vv, gated, proj } = b;
    layerNorm(x, tm.lnW, tm.lnB, xl);
    const xs = st ? st.shift : xl;
    for (let j = 0; j < 8; j++) { const m = mix[j], o = j * D; for (let c = 0; c < D; c++) m[c] = xl[c] + tm.lerp[o + c] * (xs[c] - xl[c]); }
    linear(tm.Wr, D, D, mix[0], r);
    linear(tm.Wk, D, D, mix[1], k);
    linear(tm.ksW, H, D, mix[6], ks, tm.ksB);
    linear(tm.vsW, H, D, mix[7], vs, tm.vsB);
    for (let h = 0; h < H; h++) { ks[h] = sigmoid(ks[h]); vs[h] = sigmoid(vs[h]); }
    linear(tm.Wv, D, D, mix[2], v);
    let newV0 = v0;
    if (l === 0) newV0 = Float32Array.from(v);
    else {
      linear(tm.vA, 2, D, mix[2], lora);
      linear(tm.vB, D, 2, lora, tmp, tm.vBb);
      for (let c = 0; c < D; c++) { const lv = sigmoid(tmp[c]); v[c] = v[c] + lv * (v0[c] - v[c]); }
    }
    linear(tm.aA, 4, D, mix[4], lora);
    linear(tm.aB, D, 4, lora, a, tm.aBb);
    for (let c = 0; c < D; c++) a[c] = sigmoid(a[c]);
    linear(tm.gA, 4, D, mix[5], lora);
    for (let i = 0; i < 4; i++) lora[i] = sigmoid(lora[i]);
    linear(tm.gB, D, 4, lora, g);
    linear(tm.dA, 4, D, mix[3], lora);
    for (let i = 0; i < 4; i++) lora[i] = Math.tanh(lora[i]);
    linear(tm.dB, D, 4, lora, tmp, tm.dBb);
    for (let c = 0; c < D; c++) { const dd = -0.5 - softplus(-tmp[c]); w[c] = Math.exp(-Math.exp(dd)); }
    const Snew = wantNext ? new Float32Array(H * K * K) : b.sNew;
    const S = st ? st.S : null;
    for (let h = 0; h < H; h++) {
      const o = h * K;
      let nk = 0, nv = 0;
      for (let j = 0; j < K; j++) { nk += k[o + j] * k[o + j]; nv += v[o + j] * v[o + j]; }
      const ik = ks[h] / Math.max(Math.sqrt(nk), EPS.normalize), iv = vs[h] / Math.max(Math.sqrt(nv), EPS.normalize);
      for (let j = 0; j < K; j++) { kd[o + j] = k[o + j] * ik; vv[o + j] = v[o + j] * iv; }
      let bon = 0;
      for (let j = 0; j < K; j++) bon += r[o + j] * tm.bonus[o + j] * (kd[o + j] * a[o + j]);
      for (let i = 0; i < K; i++) {
        const row = (h * K + i) * K;
        let sk = 0;
        if (S) for (let j = 0; j < K; j++) sk += S[row + j] * kd[o + j];
        let acc = 0;
        const vi = vv[o + i];
        for (let j = 0; j < K; j++) {
          const kj = kd[o + j];
          const val = (S ? S[row + j] * w[o + j] - sk * a[o + j] * kj : 0) + vi * (kj * a[o + j]);
          Snew[row + j] = val;
          acc += val * r[o + j];
        }
        out[o + i] = acc;
      }
      b.bon[h] = bon;           // added after the group norm, below
    }
    groupNorm(out, tm.gnW, tm.gnB, b.gnOut, H, K);
    for (let h = 0; h < H; h++) for (let i = 0; i < K; i++) { const c = h * K + i; gated[c] = g[c] * (b.gnOut[c] + b.bon[h] * vv[c]); }
    linear(tm.Wo, D, D, gated, proj);
    for (let c = 0; c < D; c++) x[c] += proj[c];
    return { v0: newV0, shift: wantNext ? Float32Array.from(xl) : null, S: wantNext ? Snew : null };
  }

  function channelMixer(cm, x, cshift, wantNext) {
    const xl = b.xl, m = b.cmMix, k = b.cmk, proj = b.proj;
    layerNorm(x, cm.lnW, cm.lnB, xl);
    const xs = cshift || xl;
    for (let c = 0; c < D; c++) m[c] = xl[c] + cm.lerpK[c] * (xs[c] - xl[c]);
    linear(cm.Wk, D, D, m, k);
    for (let c = 0; c < D; c++) { const q = k[c] > 0 ? k[c] : 0; k[c] = q * q; }
    linear(cm.Wv, D, D, k, proj);
    for (let c = 0; c < D; c++) x[c] += proj[c];
    return wantNext ? Float32Array.from(xl) : null;
  }

  // features: Float32Array(92). states: array of 5, each null (new entity) or { layers: [{ shift, S, cshift? }] }.
  // skip: true for a question ("asked now") and for what-ifs: nothing is committed, next = null.
  function step(features, states, skip) {
    const x = b.x, h128 = b.h128;
    const f = Float32Array.from(features);
    f[22] = 0;
    linear(top.f0W, FC, F, f, h128, top.f0B);
    silu(h128, FC);
    layerNorm(h128, top.f2W, top.f2B, b.p128);
    linear(top.f3W, D, FC, b.p128, x, top.f3B);
    silu(x, D);
    const v0s = [null, null, null, null, null];
    const next = skip ? null : STREAMS.map(s => ({ layers: new Array(s.layers) }));
    for (const [i, l] of LAYER_STEPS) {
      const st = states[i] ? states[i].layers[l] : null;
      const { tm, cm } = layers[i][l];
      const res = timeMixer(tm, l, x, v0s[i], st, !skip);
      v0s[i] = res.v0;
      let cshift = null;
      if (cm) cshift = channelMixer(cm, x, st ? st.cshift : null, !skip);
      if (!skip) { const ls = { shift: res.shift, S: res.S }; if (cm) ls.cshift = cshift; next[i].layers[l] = ls; }
    }
    const hh = b.hh;
    layerNorm(x, top.preW, top.preB, hh);
    linear(top.h0W, D, D, hh, b.u0, top.h0B);
    for (let c = 0; c < D; c++) if (b.u0[c] < 0) b.u0[c] = 0;
    layerNorm(b.u0, top.h2W, top.h2B, b.tmp);
    linear(top.h4W, FC, D, b.tmp, b.u, top.h4B);
    const heads = { w: new Float32Array(3), s: new Float32Array(3), d: new Float32Array(3), p: new Float32Array(4) };
    linear(top.gw, 3, FC, b.u, heads.w, top.gwB);
    linear(top.gs, 3, FC, b.u, heads.s, top.gsB);
    linear(top.gd, 3, FC, b.u, heads.d, top.gdB);
    linear(top.p0W, FC, D, hh, b.p128, top.p0B);
    for (let c = 0; c < FC; c++) if (b.p128[c] < 0) b.p128[c] = 0;
    linear(top.pW, 4, FC, b.p128, heads.p, top.pB);
    return { heads, next };
  }

  return { step };
}
