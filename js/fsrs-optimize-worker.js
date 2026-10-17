// The optimizer's background thread (module worker). It keeps the page smooth while js/fsrs-fit.js works.
// Started by js/optimize-sheet.js. No imports from the internet: the standard weights and their ranges come in the message.
//   in:   { type: 'fit', input }          input as described in fitChecked() of fsrs-fit.js (fit() plus the relearning steps of each card's deck)
//   out:  { type: 'progress', phase, progress }  (at most about every 100 ms)
//         { type: 'done', result }  or  { type: 'error', message }
// Cancel is worker.terminate() from the page, so nothing is saved by this file.
import { fitChecked } from './fsrs-fit.js';

self.onmessage = e => {
  if (e.data?.type !== 'fit') return;
  try {
    const it = fitChecked(e.data.input);
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
