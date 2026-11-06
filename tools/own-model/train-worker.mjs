// One training worker (worker_threads). The main thread (train-core.mjs) owns the parameters in shared memory and does the Adam steps;
// a worker owns some "slots". Slot s holds one learner at a time (its events and its remembered states) and, each step, runs the next chunk
// of that learner's events, writing the gradients into slot s's own block of the shared gradient memory. The main thread adds the blocks up in slot
// order, so the sum is the same whatever the number of workers. It also scores learners (forward only) for validation.
import { parentPort, workerData } from 'node:worker_threads';
import { createOwnModel, StateStore, eventsFromRows } from '../../js/own-model.js';
import { Tape } from '../../js/own-grad.js';
import { loadLearner, isLong } from './common.mjs';

if (new Date(2020, 5, 1).getTimezoneOffset() !== 0) throw new Error('The training worker needs TZ=UTC.');
const { size, paramsBuf, gradsBuf, n, chunk } = workerData;
const params = new Float64Array(paramsBuf);
const grads = new Float64Array(gradsBuf);
const model = createOwnModel(params, size);
const tape = new Tape();
const slots = new Map();      // slot -> { events, pos, store }

const prepare = spec => {
  const { rows } = loadLearner(spec);
  return { events: eventsFromRows(rows), rows };
};

parentPort.on('message', msg => {
  try {
    if (msg.type === 'step') {
      const results = [];
      for (const a of msg.assign) {
        if (a.spec) {
          try { slots.set(a.slot, { events: prepare(a.spec).events, pos: 0, store: new StateStore() }); } catch (e) { slots.delete(a.slot); results.push({ slot: a.slot, skipped: String(e.message || e).slice(0, 200), done: true, count: 0, loss: 0 }); continue; }
        }
        const s = slots.get(a.slot);
        const g = grads.subarray(a.slot * n, (a.slot + 1) * n);
        g.fill(0);
        const evs = s.events.slice(s.pos, s.pos + chunk);
        const r = evs.length ? model.trainChunk(tape, g, evs, s.store) : { loss: 0, count: 0 };
        s.pos += evs.length;
        const done = s.pos >= s.events.length;
        if (done) slots.delete(a.slot);
        results.push({ slot: a.slot, loss: r.loss, count: r.count, done, events: a.spec ? s.events.length : undefined });
      }
      parentPort.postMessage({ type: 'step', results });
    } else if (msg.type === 'val') {
      // forward only over each learner's whole history; the loss counts later-day scored rows only
      const out = [];
      for (const { i, spec } of msg.specs) {
        try {
          const { events, rows } = prepare(spec);
          const ps = model.predictChunk(events, new StateStore());
          let loss = 0, count = 0, j = 0;
          for (let k = 0; k < events.length; k++) {
            if (!events[k].score) continue;
            const p = Math.min(1 - 1e-6, Math.max(1e-6, ps[j++]));
            if (isLong(rows[k])) { loss -= events[k].y ? Math.log(p) : Math.log(1 - p); count++; }
          }
          out.push({ i, loss, count });
        } catch (e) { out.push({ i, loss: 0, count: 0, skipped: String(e.message || e).slice(0, 200) }); }
      }
      parentPort.postMessage({ type: 'val', results: out });
    } else if (msg.type === 'reset') {
      slots.clear();
      parentPort.postMessage({ type: 'reset' });
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: String(e?.stack || e).slice(0, 800) });
  }
});
