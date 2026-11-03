// Speed check for the lab's memory engine (not part of npm test).
//   node tools/rwkv-lab/bench.mjs <path to weights file>
import fs from 'node:fs';
import { parseWeights, validateWeights } from '../../js/rwkv-weights.js';
import { createModel } from '../../js/rwkv-model.js';
import { Engine } from '../../js/rwkv-engine.js';
import { encodeEntity, decodeEntity } from '../../js/rwkv-state.js';

const file = process.argv[2];
if (!file) { console.log('usage: node tools/rwkv-lab/bench.mjs <weights file>'); process.exit(1); }
const bytes = fs.readFileSync(file);
let t = performance.now();
const { tensors } = parseWeights(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const v = validateWeights(tensors);
console.log('load + validate', (performance.now() - t).toFixed(0), 'ms', v.ok ? 'ok' : v.errors);

const model = createModel(tensors);
let s = 1;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
const f = Float32Array.from({ length: 92 }, rnd);
const none = [null, null, null, null, null];
const warm = model.step(f, none, false).next;
for (let i = 0; i < 300; i++) { model.step(f, warm, true); model.step(f, warm, false); }
const R = 3000;
for (const [label, skip] of [['question / what-if step (nothing committed)', true], ['update step (committed states)', false]]) {
  t = performance.now();
  for (let i = 0; i < R; i++) model.step(f, warm, skip);
  console.log(label.padEnd(46), ((performance.now() - t) / R).toFixed(3), 'ms');
}
t = performance.now();
for (let i = 0; i < 2000; i++) decodeEntity(0, encodeEntity(0, warm[0]));
console.log('card state encode + decode'.padEnd(46), ((performance.now() - t) / 2000).toFixed(3), 'ms');

const eng = new Engine(tensors);
const row = i => ({ logId: i, cardKey: 'c:' + (i % 200), noteKey: 'c:' + (i % 200), deckKey: 'd:1', presetKey: 'p:default', t: 1.7e12 + i * 600000, day: 20000 + Math.floor(i / 80), rating: 3, ms: 5000 });
const N = 2000;
t = performance.now();
for (let i = 0; i < N; i++) eng.review(row(i), { keepToken: false });
console.log('engine review (question + update, int8 state)'.padEnd(46), ((performance.now() - t) / N).toFixed(3), 'ms per review');
t = performance.now();
const now = row(N + 1);
for (let i = 0; i < 200; i++) eng.whatIf(now, 6000);
console.log('what-if for one card (4 steps)'.padEnd(46), ((performance.now() - t) / 200).toFixed(3), 'ms');
