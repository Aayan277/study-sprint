// A worker for tests/own-replay.test.js: answers every spec, except that the spec 'crash' ends the process with exit code 3, 'silent' exits with code 0, and 'post-exit' answers, stops listening (so the next spec it is given never runs) and exits a moment later.
import { parentPort } from 'node:worker_threads';
const onSpec = ({ spec }) => {
  if (spec.key === 'crash') process.exit(3);
  if (spec.key === 'silent') process.exit(0);
  parentPort.postMessage({ ok: true, user: spec.key, runs: {} });
  if (spec.key === 'post-exit') { parentPort.off('message', onSpec); setTimeout(() => process.exit(0), 50); }
};
parentPort.on('message', onSpec);
