// RWKV lab: reading the weights file the owner chooses. The file is untrusted input: every read is bounds-checked and
// nothing is trusted until validateWeights has passed. No network, no storage here.
// Container: a magic string, a tensor count, then per tensor a name, a rank, the dims and the numbers (see the model's
// published file description). Two flavours: "ARWKVWEIGHTS1" (all float32) and "ARWKVWEIGHTS8PC1" (2-D weights as int8 with a scale per row).
import { expectedTensors, TOTAL_TENSORS, TOTAL_NUMBERS, DUMMY_MAX } from './rwkv-spec.js';

const MAGIC_F32 = 'ARWKVWEIGHTS1', MAGIC_INT8 = 'ARWKVWEIGHTS8PC1';
export const LIMITS = { bytes: 20 * 1024 * 1024, count: 2000, name: 256, rank: 4 };

export class WeightsError extends Error {}
const bad = msg => { throw new WeightsError(msg); };

const startsWith = (u8, text) => {
  if (u8.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (u8[i] !== text.charCodeAt(i)) return false;
  return true;
};

// -> { format: 'int8' | 'f32', tensors: Map(name -> { shape, data: Float32Array }) }. Throws WeightsError with a plain-English message.
export function parseWeights(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) bad("This isn't an RWKV weights file.");
  const size = arrayBuffer.byteLength;
  if (size > LIMITS.bytes) bad('This file is too big to be the RWKV weights.');
  const u8 = new Uint8Array(arrayBuffer), dv = new DataView(arrayBuffer);
  let format, pos;
  if (startsWith(u8, MAGIC_INT8)) { format = 'int8'; pos = MAGIC_INT8.length; }
  else if (startsWith(u8, MAGIC_F32)) { format = 'f32'; pos = MAGIC_F32.length; }
  else bad("This isn't an RWKV weights file.");
  const short = () => bad('This file is damaged (it ends too early).');
  const need = n => { if (n < 0 || pos + n > size) short(); };
  const u8At = () => { need(1); return dv.getUint8(pos++); };
  const u16At = () => { need(2); const v = dv.getUint16(pos, true); pos += 2; return v; };
  const u32At = () => { need(4); const v = dv.getUint32(pos, true); pos += 4; return v; };
  const count = u32At();
  if (count > LIMITS.count) bad('This file lists too many tensors to be the RWKV weights.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tensors = new Map();
  const floats = n => { need(n * 4); const out = new Float32Array(arrayBuffer.slice(pos, pos + n * 4)); pos += n * 4; return out; };
  for (let t = 0; t < count; t++) {
    const nameLen = u16At();
    if (nameLen > LIMITS.name) bad('This file has a tensor name that is too long.');
    need(nameLen);
    let name;
    try { name = decoder.decode(u8.subarray(pos, pos + nameLen)); } catch { bad('This file is damaged (a tensor name is not text).'); }
    pos += nameLen;
    if (tensors.has(name)) bad(`This file lists ${name} twice.`);
    const kind = format === 'int8' ? u8At() : 0;
    if (kind !== 0 && kind !== 1) bad('This file uses a tensor type that is not supported.');
    const rank = u8At();
    if (rank < 1 || rank > LIMITS.rank) bad('This file has a tensor with an unsupported shape.');
    const shape = [];
    let n = 1;
    for (let r = 0; r < rank; r++) {
      const d = u32At();
      shape.push(d);
      n *= d;
      if (n > size) short();             // can't fit in the file
    }
    let data;
    if (kind === 0) data = floats(n);
    else {
      const rows = shape[0];
      const scales = floats(rows);
      need(n);
      const codes = new Int8Array(arrayBuffer, pos, n);
      data = new Float32Array(n);
      const cols = rows ? n / rows : 0;
      for (let r = 0, i = 0; r < rows; r++) { const s = scales[r]; for (let c = 0; c < cols; c++, i++) data[i] = codes[i] * s; }
      pos += n;
    }
    tensors.set(name, { shape, data });
  }
  if (pos !== size) bad('This file has extra data at the end.');
  return { format, tensors };
}

// -> { ok, errors: string[] }  Checks every expected name and shape, the total count and that all numbers are finite.
export function validateWeights(tensors) {
  const errors = [];
  const want = expectedTensors();
  let total = 0, missing = 0;
  for (const [name, spec] of want) {
    const t = tensors.get(name);
    if (!t) { if (++missing <= 3) errors.push(`Missing tensor ${name}.`); continue; }
    total += t.data.length;
    if (spec.dummy) {
      if (t.data.length > DUMMY_MAX) errors.push(`Wrong size for ${name}: ${t.data.length} numbers, expected a placeholder.`);
    } else if (t.shape.length !== spec.shape.length || t.shape.some((d, i) => d !== spec.shape[i])) {
      errors.push(`Wrong shape for ${name}: ${t.shape.join('×')}, expected ${spec.shape.join('×')}.`);
    }
    if (errors.length > 8) break;
  }
  if (missing > 3) errors.push(`${missing} tensors are missing in total.`);
  if (!errors.length) {
    if (tensors.size !== TOTAL_TENSORS) errors.push(`Wrong model: expected ${TOTAL_TENSORS} tensors, found ${tensors.size}.`);
    if (total !== TOTAL_NUMBERS) errors.push(`Wrong model: expected ${TOTAL_NUMBERS.toLocaleString('en-US')} numbers, found ${total.toLocaleString('en-US')}.`);
  }
  if (!errors.length) {
    for (const [name, t] of tensors) {
      for (let i = 0; i < t.data.length; i++) if (!Number.isFinite(t.data[i])) { errors.push(`${name} contains a value that is not a number.`); break; }
      if (errors.length) break;
    }
  }
  return { ok: errors.length === 0, errors };
}
