// A small pool of worker threads for the replay test. Each worker gets one spec at a time and answers with one record.
// A worker that exits without answering (any exit code, e.g. a crash or an out-of-memory kill) marks the spec it held as failed and is replaced
// by a new worker; a worker that dies before it was given a spec, or too many replacements, ends the run with an error.
import { Worker } from 'node:worker_threads';

// opts: { workerUrl, workerData, jobs, env }. list: specs ({ key, ... }). onResult(record, finishedCount) for every spec, ok or failed.
export function runPool(list, onResult, { workerUrl, workerData, jobs, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (!list.length) return resolve();
    let next = 0, finished = 0, respawns = 0, over = false;
    const live = new Set();
    const stop = () => { over = true; for (const x of live) { x.ending = true; x.terminate(); } };
    const end = err => { if (over) return; stop(); if (err) reject(err); else resolve(); };
    const report = r => { onResult(r, ++finished); if (finished === list.length) end(); };
    const spawn = () => {
      const w = new Worker(workerUrl, { workerData, env });
      w.cur = null; w.err = ''; w.ending = false;
      live.add(w);
      const feed = () => {
        if (next < list.length) { w.cur = list[next++]; w.postMessage({ spec: w.cur }); }
        else { w.cur = null; w.ending = true; w.terminate(); }
      };
      w.on('message', r => { if (over) return; w.cur = null; report(r); if (!over) feed(); });
      w.on('error', e => { w.err = String(e?.message || e).slice(0, 200); });
      w.on('exit', code => {
        live.delete(w);
        if (w.ending || over) return;
        const spec = w.cur;
        w.cur = null;
        if (!spec) return end(new Error(`A worker exited (code ${code}) without a user to run.${w.err ? ` ${w.err}` : ''}`));
        report({ ok: false, user: spec.key, error: `the worker exited with code ${code}${w.err ? `: ${w.err}` : ''}`, runs: {} });
        if (over) return;
        if (++respawns > list.length + jobs) return end(new Error('Too many workers exited; stopping.'));
        spawn();
      });
      feed();
    };
    for (let k = 0; k < Math.min(jobs, list.length); k++) spawn();
  });
}
