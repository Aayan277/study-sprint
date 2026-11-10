// One shadow worker: gets a user spec, loads the user, runs the watch-first loop, sends the record back.
import { parentPort, workerData } from 'node:worker_threads';
import { loadLearner } from './common.mjs';
import { loadModelFile } from './eval-core.mjs';
import { shadowUser } from './shadow-core.mjs';

if (new Date(2020, 5, 1).getTimezoneOffset() !== 0) throw new Error('The shadow worker needs TZ=UTC.');
const { modelPath, cfg } = workerData;
const f = loadModelFile(modelPath);
const ctx = { ...cfg, params: f.params, size: f.size, ablate: f.ablate };

parentPort.on('message', ({ spec }) => {
  let out;
  try { out = shadowUser({ ...loadLearner(spec), half: spec.half }, ctx); } catch (e) { out = { ok: false, error: String(e?.message || e).slice(0, 300) }; }
  out.user = spec.key;
  out.cfg = cfg.id;
  parentPort.postMessage(out);
});
