// The background thread (module worker) for the heavy FSRS jobs. It keeps the page smooth while they work.
// Started by js/optimize-sheet.js (the fit) and js/worker-job.js (the health check and the retention helper).
// No imports from the internet: the standard weights and their ranges come in the message.
//   in:   { type: 'fit' | 'health' | 'sim', input }     'fit': fitChecked() of fsrs-fit.js; 'health': healthFit() of fit-health.js;
//                                                       'sim': simulateAll() of retention-sim.js
//   out:  { type: 'progress', phase, progress }  (at most about every 100 ms)
//         { type: 'done', result }  or  { type: 'error', message }
// Cancel is worker.terminate() from the page, so nothing is saved by this file.
import { fitChecked } from './fsrs-fit.js';
import { healthFit } from './fit-health.js';
import { simulateAll } from './retention-sim.js';

const JOBS = { fit: fitChecked, health: healthFit, sim: simulateAll };

self.onmessage = e => {
  const job = JOBS[e.data?.type];
  if (!job) return;
  try {
    const it = job(e.data.input);
    let last = 0;
    for (;;) {
      const r = it.next();
      if (r.done) { self.postMessage({ type: 'done', result: r.value }); return; }
      const now = Date.now();
      if (now - last >= 100) { last = now; self.postMessage({ type: 'progress', phase: r.value.phase, progress: r.value.progress }); }
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
