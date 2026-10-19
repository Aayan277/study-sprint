// The background thread (module worker) for the text jobs that work out key words: "Suggest cards" from a reading (js/reading-cards.js)
// and "Suggest tags" for a deck (js/autotag.js). It keeps the page smooth while they work. Started by js/keywords-job.js.
// Nothing here touches the page or the database: the text comes in the message and the suggestions go back in the answer.
//   in:   { type: 'reading', input }          'reading': suggestSteps() of reading-cards.js
//         { type: 'autotag', input }          'autotag': autotagSteps() of autotag.js
//   out:  { type: 'progress', phase, progress }  (at most about every 100 ms)
//         { type: 'done', result }  or  { type: 'error', message }
// Cancel is worker.terminate() from the page, so nothing is saved by this file.
import { suggestSteps } from './reading-cards.js';
import { autotagSteps } from './autotag.js';

const JOBS = { reading: suggestSteps, autotag: autotagSteps };

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
