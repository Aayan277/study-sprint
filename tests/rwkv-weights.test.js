import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeights, validateWeights, WeightsError, LIMITS } from '../js/rwkv-weights.js';
import { expectedTensors, TOTAL_TENSORS, TOTAL_NUMBERS } from '../js/rwkv-spec.js';
import { fakeWeights } from './rwkv-fake-weights.mjs';

test('the expected tensor list has 420 tensors and 331,511 numbers', () => {
  const e = expectedTensors();
  assert.equal(e.size, TOTAL_TENSORS);
  let n = 0;
  for (const t of e.values()) n += t.count;
  assert.equal(n, TOTAL_NUMBERS);
});

for (const format of ['int8', 'f32']) {
  test(`a ${format} file reads back exactly and passes validation`, () => {
    const { buffer, values } = fakeWeights({ seed: 3, format });
    const r = parseWeights(buffer);
    assert.equal(r.format, format);
    assert.equal(r.tensors.size, 420);
    for (const [name, v] of values) {
      const got = r.tensors.get(name);
      assert.deepEqual(got.shape, v.shape, name);
      assert.deepEqual(Array.from(got.data), Array.from(v.data), name);
    }
    assert.deepEqual(validateWeights(r.tensors), { ok: true, errors: [] });
  });
}

test('int8 numbers are code times the row scale', () => {
  const name = 'p_linear.weight';
  const { buffer } = fakeWeights({ seed: 4, format: 'int8', only: n => n === name || n === 'p_linear.bias' });
  // build by hand: one tiny int8 tensor
  const enc = new TextEncoder(), nm = enc.encode('t');
  const b = new ArrayBuffer(16 + 4 + 2 + 1 + 1 + 1 + 8 + 8 + 4);
  const u8 = new Uint8Array(b), dv = new DataView(b);
  u8.set(enc.encode('ARWKVWEIGHTS8PC1'), 0);
  let p = 16; dv.setUint32(p, 1, true); p += 4; dv.setUint16(p, 1, true); p += 2; u8.set(nm, p); p += 1;
  u8[p++] = 1; u8[p++] = 2; dv.setUint32(p, 2, true); p += 4; dv.setUint32(p, 2, true); p += 4;
  dv.setFloat32(p, 0.5, true); p += 4; dv.setFloat32(p, 0.25, true); p += 4;
  dv.setInt8(p++, 10); dv.setInt8(p++, -127); dv.setInt8(p++, 4); dv.setInt8(p++, 8);
  const r = parseWeights(b.slice(0, p));
  assert.deepEqual(Array.from(r.tensors.get('t').data), [5, -63.5, 1, 2]);
  assert.ok(buffer.byteLength > 0);
});

const rejects = (buf, re) => assert.throws(() => parseWeights(buf), e => e instanceof WeightsError && re.test(e.message), String(re));

test('bad files are refused with a plain message', () => {
  const { buffer } = fakeWeights({ seed: 5, format: 'int8' });
  rejects(new TextEncoder().encode('hello world, not weights').buffer, /isn't an RWKV weights file/);
  rejects(new ArrayBuffer(0), /isn't an RWKV weights file/);
  rejects(buffer.slice(0, buffer.byteLength - 10), /ends too early/);
  rejects(buffer.slice(0, 30), /ends too early/);
  const extra = new Uint8Array(buffer.byteLength + 3); extra.set(new Uint8Array(buffer));
  rejects(extra.buffer, /extra data/);
  const many = buffer.slice(0); new DataView(many).setUint32(16, 1e9, true);
  rejects(many, /too many tensors/);
  const longName = buffer.slice(0); new DataView(longName).setUint16(20, 60000, true);
  rejects(longName, /name that is too long/);
  assert.throws(() => parseWeights('nope'), WeightsError);
  assert.throws(() => parseWeights(new ArrayBuffer(LIMITS.bytes + 1)), WeightsError);
});

test('a dimension that cannot fit in the file is refused, not allocated', () => {
  const enc = new TextEncoder();
  const b = new ArrayBuffer(13 + 4 + 2 + 1 + 1 + 1 + 8);
  const u8 = new Uint8Array(b), dv = new DataView(b);
  u8.set(enc.encode('ARWKVWEIGHTS1'), 0);
  dv.setUint32(13, 1, true); dv.setUint16(17, 1, true); u8[19] = 0x74; u8[20] = 2;
  dv.setUint32(21, 0xffffffff, true); dv.setUint32(25, 0xffffffff, true);
  rejects(b, /ends too early/);
});

test('validation finds a wrong shape, a missing tensor, a wrong size and a NaN', () => {
  const ok = parseWeights(fakeWeights({ seed: 6, format: 'f32' }).buffer).tensors;
  const wrongShape = new Map(ok); wrongShape.set('p_linear.weight', { shape: [128, 4], data: ok.get('p_linear.weight').data });
  let v = validateWeights(wrongShape);
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /Wrong shape for p_linear.weight: 128×4, expected 4×128\./);
  const missing = new Map(ok); missing.delete('prehead_norm.bias');
  v = validateWeights(missing);
  assert.match(v.errors[0], /Missing tensor prehead_norm.bias/);
  const nan = new Map(ok); const d = Float32Array.from(ok.get('prehead_norm.bias').data); d[3] = NaN; nan.set('prehead_norm.bias', { shape: [64], data: d });
  v = validateWeights(nan);
  assert.match(v.errors[0], /prehead_norm.bias contains a value that is not a number/);
  const extra = new Map(ok); extra.set('surprise', { shape: [1], data: new Float32Array(1) });
  v = validateWeights(extra);
  assert.match(v.errors[0], /Wrong model: expected 420 tensors, found 421/);
  const fat = new Map(ok); fat.set('rwkv_modules.0.blocks.0.time_mixer.v_lora_simple.A.weight', { shape: [2, 64], data: new Float32Array(128) });
  v = validateWeights(fat);
  assert.match(v.errors[0], /placeholder/);
});
