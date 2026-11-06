// Speed check for the Own model (not part of npm test). Run:  node tools/own-model/bench.mjs [--events 20000]
// Prints milliseconds per review, per what-if, and training speed on this machine. Guide: review <= 0.5 ms, what-if <= 2 ms.
process.env.TZ = 'UTC';
import { Engine } from '../../js/own-engine.js';
import { initParams, createOwnModel, StateStore, eventsFromRows } from '../../js/own-model.js';
import { Tape } from '../../js/own-grad.js';
import { paramCount } from '../../js/own-spec.js';
import { mulberry32 } from '../../js/fsrs-fit.js';
import { studyDay } from '../../js/own-features.js';

const arg = (name, d) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('events', 20000), CARDS = 1500, DAY = 86400000;

// a made-up learner: random cards (notes of 1 to 2, 3 decks), about 100 answers a day
function makeRows(n, seed) {
  const rng = mulberry32(seed), rows = [];
  let t = Date.UTC(2026, 0, 5, 12);
  for (let i = 0; i < n; i++) {
    t += i % 100 === 99 ? DAY - 99 * 20000 : 20000;
    const c = Math.floor(rng() * CARDS);
    rows.push({ logId: i, cardKey: 'c:' + c, noteKey: 'n:' + (c >> 1), deckKey: 'd:' + (c % 3), presetKey: 'p:default', t, day: studyDay(t), rating: 1 + Math.floor(rng() * 4), ms: 3000 + rng() * 9000, kind: 'train' });
  }
  return rows;
}
const time = (fn, reps) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < reps; i++) fn(i); return Number(process.hrtime.bigint() - t0) / 1e6 / reps; };

for (const size of ['s', 'm']) {
  const params = Float32Array.from(initParams(size, 1));
  const rows = makeRows(N, 7);
  const e = new Engine(params, { size });
  for (const r of rows.slice(0, 2000)) e.review(r, { keepToken: false });         // warm up
  const e2 = new Engine(params, { size });
  const msReview = time(i => e2.review(rows[i], { keepToken: false }), N);
  const msUndo = time(i => { const o = e2.review({ ...rows[N - 1], logId: 1e9 + i, t: rows[N - 1].t + (i + 1) * 1000 }); e2.undo(o.token.logId); }, 2000);
  const probe = rows.slice(-200);
  const msWhat = time(i => e2.whatIf(probe[i % 200], 8000), 4000);
  const saved = e2.toJSON();
  const jsonBytes = JSON.stringify(saved).length;
  // training: chunks of 128 events, forward + backward
  const m = createOwnModel(Float64Array.from(params), size);
  const events = eventsFromRows(rows.slice(0, 128 * 40));
  const tape = new Tape(), grads = new Float64Array(paramCount(size));
  const store = new StateStore();
  m.trainChunk(tape, grads, events.slice(0, 128), store);                           // warm up
  const t0 = process.hrtime.bigint();
  for (let c = 0; c < 40; c++) m.trainChunk(tape, grads, events.slice(c * 128, c * 128 + 128), store);
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const evPerSec = 128 * 40 / secs;
  console.log(JSON.stringify({
    size, params: paramCount(size), node: process.version, events: N,
    msPerReview: +msReview.toFixed(4), msPerUndoPair: +msUndo.toFixed(4), msPerWhatIf: +msWhat.toFixed(4),
    trainEventsPerSec: Math.round(evPerSec), trainSecPer1MEvents: Math.round(1e6 / evPerSec),
    savedStateJsonKB: Math.round(jsonBytes / 1024), cards: e2.cards.size,
    bytesPerCardF32: e2.cards.get('c:0').byteLength + e2.curves.get('c:0').byteLength
  }));
}
