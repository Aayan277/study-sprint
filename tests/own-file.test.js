// Tests for the .own model file format (js/own-file.js): round trip, and every way a bad file is refused. Made-up numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeOwnFile, parseOwnFile, checkHeader, OwnFileError, OWN_MAGIC, OWN_FILE_LIMITS } from '../js/own-file.js';
import { paramCount, SIZES, OWN_FEATURE_VERSION } from '../js/own-spec.js';
import { initParams } from '../js/own-model.js';

const trainedOn = [{ id: 'sim-v1', licence: 'ours' }];
const make = (over = {}) => writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn, seed: 3, gitStamp: 'abc1234', createdAt: '2026-11-06T00:00:00.000Z', info: { epochs: 2, source: 'sim' }, ...over });
const refuses = (bytes, re) => assert.throws(() => parseOwnFile(bytes), e => e instanceof OwnFileError && re.test(e.message), `expected a refusal like ${re}`);
const withHeader = (edit) => {
  const good = make(), dv = new DataView(good.buffer), hlen = dv.getUint32(9, true);
  const h = JSON.parse(new TextDecoder().decode(good.subarray(13, 13 + hlen)));
  edit(h);
  const json = new TextEncoder().encode(JSON.stringify(h)), body = good.subarray(13 + hlen);
  const out = new Uint8Array(13 + json.length + body.length);
  out.set(good.subarray(0, 9)); new DataView(out.buffer).setUint32(9, json.length, true); out.set(json, 13); out.set(body, 13 + json.length);
  return out;
};

test('a model survives a write and a read: header and every parameter', () => {
  const params = Float32Array.from(initParams('s', 3));
  const bytes = make();
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 9)), OWN_MAGIC);
  const { header, params: back } = parseOwnFile(bytes);
  assert.deepEqual(header.trainedOn, trainedOn);
  assert.equal(header.paramCount, paramCount('s'));
  assert.equal(header.size, 's'); assert.deepEqual(header.sizes, SIZES.s);
  assert.equal(header.featureVersion, OWN_FEATURE_VERSION);
  assert.equal(header.seed, 3); assert.equal(header.gitStamp, 'abc1234'); assert.deepEqual(header.info, { epochs: 2, source: 'sim' });
  assert.equal(back.length, params.length);
  for (let i = 0; i < params.length; i++) assert.equal(back[i], params[i]);
  assert.equal(bytes.length, 9 + 4 + new DataView(bytes.buffer).getUint32(9, true) + params.length * 4);
});

test('the bigger research size round-trips too, and Float64 input is stored as float32', () => {
  const p = initParams('m', 1);
  const { header, params } = parseOwnFile(writeOwnFile({ size: 'm', params: p, trainedOn }));
  assert.equal(header.size, 'm'); assert.equal(params.length, paramCount('m'));
  assert.equal(params[5], Math.fround(p[5]));
});

test('refuses: wrong marker, empty, too short, truncated, trailing bytes', () => {
  const good = make();
  refuses(new Uint8Array(0), /isn't an Own model file/);
  refuses(Uint8Array.from(Buffer.from('PK\u0003\u0004 and so on, not a model')), /isn't an Own model file/);
  const wrong = good.slice(); wrong[0] = 0x58;
  refuses(wrong, /isn't an Own model file/);
  refuses(good.subarray(0, 11), /incomplete/);
  refuses(good.subarray(0, 40), /incomplete/);
  refuses(good.subarray(0, good.length - 4), /incomplete/);
  refuses(Uint8Array.from([...good, 0]), /extra data/);
});

test('refuses: header length that is zero, huge, or runs past the end', () => {
  const good = make();
  const edit = n => { const b = good.slice(); new DataView(b.buffer).setUint32(9, n, true); return b; };
  refuses(edit(0), /header/);
  refuses(edit(OWN_FILE_LIMITS.maxHeaderBytes + 1), /header/);
  refuses(edit(0xffffffff), /header/);
  refuses(edit(16000), /header/);
  refuses(good.subarray(0, 200), /incomplete/);
  const junk = good.slice(); junk[13] = 0x7b; junk[14] = 0x7b;                     // "{{" is not JSON
  refuses(junk, /header is not readable/);
});

test('refuses a file over the size limit before reading it', () => {
  refuses(new Uint8Array(OWN_FILE_LIMITS.maxBytes + 1), /too big/);
});

test('refuses: values that are not numbers (NaN and infinity in the parameters)', () => {
  const good = make(), dv = new DataView(good.buffer), at = good.length - 40;
  dv.setFloat32(at, NaN, true);
  refuses(good, /not a number/);
  dv.setFloat32(at, Infinity, true);
  refuses(good, /not a number/);
  assert.throws(() => writeOwnFile({ size: 's', params: Float32Array.from({ length: paramCount('s') }, (_, i) => (i === 7 ? NaN : 0)), trainedOn }), OwnFileError);
});

test('refuses: shapes that do not match the stated size, a different app version, unknown size', () => {
  refuses(withHeader(h => { h.sizes.card = 33; }), /memory sizes/);
  refuses(withHeader(h => { delete h.sizes.hidden; }), /memory sizes/);
  refuses(withHeader(h => { h.sizes = null; }), /memory sizes/);
  refuses(withHeader(h => { h.paramCount += 1; }), /number of parameters/);
  refuses(withHeader(h => { h.size = 'm'; }), /memory sizes/);
  refuses(withHeader(h => { h.size = 'xl'; }), /size this app does not know/);
  refuses(withHeader(h => { h.size = '__proto__'; }), /size this app does not know/);
  refuses(withHeader(h => { h.featureVersion = 2; }), /different app version/);
  refuses(withHeader(h => { h.arch = 'other'; }), /different app version/);
  // the body must match the stated count: stating m with s numbers is refused above; stating fewer numbers than the file holds is "extra data"
});

test('refuses: malformed or unknown header fields', () => {
  refuses(withHeader(h => { h.extra = 1; }), /unexpected/);
  refuses(withHeader(h => { h.trainedOn = 'sim'; }), /trained on/);
  refuses(withHeader(h => { h.trainedOn = [{ id: 'x' }]; }), /trained on/);
  refuses(withHeader(h => { h.trainedOn = [{ id: 'x', licence: 'y', more: 1 }]; }), /trained on/);
  refuses(withHeader(h => { h.trainedOn = Array.from({ length: 9 }, () => ({ id: 'a', licence: 'b' })); }), /trained on/);
  refuses(withHeader(h => { h.seed = 1.5; }), /seed/);
  refuses(withHeader(h => { h.gitStamp = 5; }), /incomplete/);
  refuses(withHeader(h => { h.info = [1]; }), /notes/);
  refuses(withHeader(h => { h.info = { a: { b: 1 } }; }), /notes/);
  refuses(withHeader(h => { h.info = { a: 'x'.repeat(500) }; }), /notes/);
  refuses(withHeader(h => { h.info = Object.fromEntries(Array.from({ length: 61 }, (_, i) => ['k' + i, 1])); }), /notes/);
  refuses(withHeader(h => { h.info = { a: null }; }), /notes/);
});

test('the writer checks its input as strictly as the reader', () => {
  assert.throws(() => writeOwnFile({ size: 's', params: new Float32Array(5), trainedOn }), OwnFileError);
  assert.throws(() => writeOwnFile({ size: 'q', params: new Float32Array(5), trainedOn }), OwnFileError);
  assert.throws(() => writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 1)), trainedOn: [{ id: 5, licence: 'x' }] }), OwnFileError);
  assert.throws(() => checkHeader(null), OwnFileError);
});

test('a header cannot smuggle a prototype key through', () => {
  const bytes = withHeader(h => { Object.defineProperty(h, '__proto__', { value: { polluted: 1 }, enumerable: true }); });
  refuses(bytes, /unexpected|not readable/);
  assert.equal({}.polluted, undefined);
});
