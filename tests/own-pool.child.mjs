// A worker for tests/own-replay.test.js: answers every spec, except that the spec 'crash' ends the process with exit code 3 and 'silent' exits with code 0.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ spec }) => {
  if (spec.key === 'crash') process.exit(3);
  if (spec.key === 'silent') process.exit(0);
  parentPort.postMessage({ ok: true, user: spec.key, runs: {} });
});
