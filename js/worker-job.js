// Runs one of the lighter FSRS jobs ('health' = the health check, 'sim' = the retention helper) in the optimizer's worker
// (js/fsrs-optimize-worker.js), or on the page in small slices when workers are not available. The same pattern as runFit()
// in optimize-sheet.js, for jobs that are generators: they yield progress and return a result.
//   runJob(type, input, { onProgress, timeoutMs, useWorker }) → { promise, cancel }
// The promise always resolves (never rejects) with { status: 'done', result, inWorker } | { status: 'cancelled' } |
// { status: 'timeout' } | { status: 'error', message }. Nothing is saved by it.
import { healthFit } from './fit-health.js';
import { simulateAll } from './retention-sim.js';

const GENERATORS = { health: healthFit, sim: simulateAll };
const SLICE_MS = 30;

export function runJob(type, input, { onProgress = () => {}, timeoutMs = 30000, useWorker = true } = {}) {
  let finish, worker = null, timer = 0, stopped = false;
  const promise = new Promise(resolve => {
    finish = outcome => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (worker) { worker.terminate(); worker = null; }
      resolve(outcome);
    };
  });
  const cancel = () => finish({ status: 'cancelled' });
  timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

  const runOnPage = () => {
    let it;
    try { it = GENERATORS[type](input); } catch (err) { finish({ status: 'error', message: String(err?.message || err) }); return; }
    const step = () => {
      if (stopped) return;
      const end = performance.now() + SLICE_MS;
      try {
        for (;;) {
          const r = it.next();
          if (r.done) { finish({ status: 'done', result: r.value, inWorker: false }); return; }
          onProgress(r.value);
          if (performance.now() >= end) break;
        }
      } catch (err) { finish({ status: 'error', message: String(err?.message || err) }); return; }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  };

  if (!useWorker || typeof Worker === 'undefined') { runOnPage(); return { promise, cancel }; }
  let heard = false;
  try {
    worker = new Worker(new URL('./fsrs-optimize-worker.js', import.meta.url), { type: 'module' });
  } catch { worker = null; runOnPage(); return { promise, cancel }; }
  worker.onmessage = e => {
    heard = true;
    const m = e.data || {};
    if (m.type === 'progress') onProgress({ phase: m.phase, progress: m.progress });
    else if (m.type === 'done') finish({ status: 'done', result: m.result, inWorker: true });
    else if (m.type === 'error') finish({ status: 'error', message: m.message });
  };
  worker.onerror = e => {
    e.preventDefault?.();
    if (stopped) return;
    const w = worker; worker = null; w?.terminate();
    if (!heard) runOnPage(); else finish({ status: 'error', message: e.message || 'The worker stopped.' });
  };
  try { worker.postMessage({ type, input }); } catch (err) { worker.onerror({ message: String(err) }); }
  return { promise, cancel };
}
