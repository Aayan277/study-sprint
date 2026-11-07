// One replay worker: gets a user spec, loads the user, runs the 16 simulations, sends the record back.
import { parentPort, workerData } from 'node:worker_threads';
import { loadLearner } from './common.mjs';
import { loadModelFile } from './eval-core.mjs';
import { replayUser } from './replay-core.mjs';
import { createOwnModel } from '../../js/own-model.js';

if (new Date(2020, 5, 1).getTimezoneOffset() !== 0) throw new Error('The replay worker needs TZ=UTC.');
const { modelPath, cfg } = workerData;
const f = loadModelFile(modelPath);
const ctx = { ...cfg, params: f.params, size: f.size, model: createOwnModel(f.params, f.size) };

parentPort.on('message', ({ spec }) => {
  let out;
  try { out = replayUser(loadLearner(spec), ctx); } catch (e) { out = { ok: false, error: String(e?.message || e).slice(0, 300), runs: {} }; }
  out.user = spec.key;
  out.cfg = cfg.id;
  parentPort.postMessage(out);
});
