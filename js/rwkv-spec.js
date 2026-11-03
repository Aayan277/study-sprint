// RWKV lab: the fixed numbers and the list of tensors the memory model uses. Pure data, no DOM, no network.
// The model is a small recurrent network written from its published description; the owner supplies the weights file.

export const D = 64, F = 92, FC = 128, H = 4, K = 16;

// Stream index = the module number in the tensor names. `mixer` lists the layers that have a channel mixer.
export const STREAMS = [
  { tag: 'c', name: 'card', layers: 2, mixer: [0] },
  { tag: 'd', name: 'deck', layers: 4, mixer: [0, 3] },
  { tag: 'n', name: 'note', layers: 1, mixer: [0] },
  { tag: 'p', name: 'preset', layers: 3, mixer: [] },
  { tag: 'u', name: 'user', layers: 3, mixer: [] }
];

// One review runs these 13 [stream, layer] steps in this order. The order matters: later layers see every stream's earlier output.
export const LAYER_STEPS = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [3, 1], [4, 1], [1, 2], [3, 2], [4, 2], [1, 3]];

export const EPS = {
  layerNorm: 1e-5, groupNorm: 6.4e-4, normalize: 1e-12, softplusThreshold: 20,
  probClamp: 1e-5, powerClamp: 25, sEps: 1e-7, minElapsedSeconds: 1
};

// (mean, spread) pairs for the scaled inputs
export const NORM = {
  days: [1.51, 1.62], daysCum: [2.14, 2.25], secs: [9.96, 5.21], secsCum: [10.86, 5.80], duration: [8.9, 1.07],
  newSince: [2.945, 2.011], reviewsSince: [4.64, 2.59], newToday: [2.55, 1.41], reviewsToday: [4.59, 1.30]
};

export const PERIODS = [3, 7, 30, 100, 365, 3650, 36500];
export const CODE_DIMS = { c: 12, n: 12, d: 8, p: 8 };

export const FEATURE_VERSION = 1;
export const STATE_FORMAT = 's8-v1';

// sha256 of the weights files we have tested against
export const KNOWN_MODELS = {
  'ff626af2e974346ed282615d190500148b22cfe05cbfd081b1e70d5a1dfa3cd9': 'SM72e25 int8',
  '42b79e35ad78bf291817cb48979f48fd105b39fc43b6a5ca954938d3f25cf261': 'SM72e25 f32'
};

export const TOTAL_TENSORS = 420;
export const TOTAL_NUMBERS = 331511;
export const DUMMY_MAX = 4;     // a placeholder tensor holds at most this many numbers

const prod = shape => shape.reduce((a, b) => a * b, 1);

// Map name -> { shape, dummy }. `dummy` tensors are placeholders the model never reads.
export function expectedTensors() {
  const m = new Map();
  const add = (name, shape, dummy = false) => m.set(name, { shape, dummy, count: prod(shape) });
  const lin = (name, out, inn, bias = true) => { add(name + '.weight', [out, inn]); if (bias) add(name + '.bias', [out]); };
  lin('features2card.0', FC, F);
  add('features2card.2.weight', [FC]); add('features2card.2.bias', [FC]);
  lin('features2card.3', D, FC);
  add('prehead_norm.weight', [D]); add('prehead_norm.bias', [D]);
  lin('head_w.0', D, D);
  add('head_w.2.weight', [D]); add('head_w.2.bias', [D]);
  lin('head_w.4', FC, D);
  for (const n of ['w', 's', 'd']) { add(`gru_${n}_weight`, [3, FC]); add(`gru_${n}_bias`, [3]); }
  lin('head_p.0', FC, D);
  lin('p_linear', 4, FC);
  for (const n of ['head_ahead_logits.0', 'ahead_linear', 'w_linear']) { add(n + '.weight', [1, 1], true); add(n + '.bias', [1], true); }
  STREAMS.forEach((s, i) => {
    for (let l = 0; l < s.layers; l++) {
      const T = `rwkv_modules.${i}.blocks.${l}.time_mixer.`, C = `rwkv_modules.${i}.blocks.${l}.channel_mixer.`;
      add(T + 'layer_norm.weight', [D]); add(T + 'layer_norm.bias', [D]);
      add(T + 'rkvdag_lerp', [8, 1, 1, D]);
      add(T + 'bonus', [1, 1, H, K]);
      for (const w of ['W_r', 'W_k', 'W_v', 'W_o']) add(T + w + '.weight', [D, D]);
      for (const w of ['k_scale_linear', 'v_scale_linear']) lin(T + w, H, D);
      if (l === 0) { add(T + 'v_lora_simple.A.weight', [1, 1], true); add(T + 'v_lora_simple.B_and_lamb.weight', [1, 1], true); add(T + 'v_lora_simple.B_and_lamb.bias', [1], true); }
      else { add(T + 'v_lora_simple.A.weight', [2, D]); add(T + 'v_lora_simple.B_and_lamb.weight', [D, 2]); add(T + 'v_lora_simple.B_and_lamb.bias', [D]); }
      for (const w of ['a_lora_simple', 'd_lora_mlp']) { add(T + w + '.A.weight', [4, D]); add(T + w + '.B_and_lamb.weight', [D, 4]); add(T + w + '.B_and_lamb.bias', [D]); }
      add(T + 'lora_A_g.weight', [4, D]); add(T + 'lora_B_g.weight', [D, 4]);
      add(T + 'out_group_norm.weight', [D]); add(T + 'out_group_norm.bias', [D]);
      if (s.mixer.includes(l)) {
        add(C + 'layer_norm.weight', [D]); add(C + 'layer_norm.bias', [D]); add(C + 'lerp_k', [1, 1, D]);
        add(C + 'W_k.weight', [D, D]); add(C + 'W_v.weight', [D, D]);
      } else {
        add(C + 'layer_norm.weight', [1], true); add(C + 'layer_norm.bias', [1], true); add(C + 'lerp_k', [1, 1, 1], true);
        add(C + 'W_k.weight', [1, 1], true); add(C + 'W_v.weight', [1, 1], true);
      }
    }
  });
  return m;
}
