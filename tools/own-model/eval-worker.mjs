// One evaluation worker: gets a learner spec, loads it, scores every model on it, sends the record back.
import { parentPort, workerData } from 'node:worker_threads';
import { loadLearner } from './common.mjs';
import { evalLearner, loadModelFile, makeRsReader, makeRwkvReader } from './eval-core.mjs';

if (new Date(2020, 5, 1).getTimezoneOffset() !== 0) throw new Error('The evaluation worker needs TZ=UTC.');
const { models, ft, rsDir, rwkvDir, fitFsrs } = workerData;
const own = models.map(m => {
  const f = m.params ? { params: Float64Array.from(m.params), size: m.size, ablate: m.ablate } : loadModelFile(m.path);
  return { key: m.key, params: f.params, size: f.size, ablate: f.ablate, finetune: m.finetune || null };
});
const ctx = { own, ft, fitFsrs, rs: rsDir ? makeRsReader(rsDir) : null, rwkv: rwkvDir ? makeRwkvReader(rwkvDir) : null };

parentPort.on('message', ({ spec }) => {
  let out;
  try { out = evalLearner(loadLearner(spec), ctx); } catch (e) { out = { ok: false, error: String(e?.message || e).slice(0, 300), models: {} }; }
  out.user = spec.key;
  parentPort.postMessage(out);
});
