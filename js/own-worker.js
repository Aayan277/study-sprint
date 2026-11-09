// Own model: the Web Worker. It only carries messages to the engine room (own-core.js) and back. No network.
//   page -> worker  { id, type, ...payload }
//   worker -> page  { id, type: 'done', result } | { id, type: 'error', message } | { id, type: 'progress', done, total }
import { OwnCore } from './own-core.js';

const core = new OwnCore();
self.onmessage = async e => {
  const { id, type, ...payload } = e.data || {};
  try {
    const result = await core.handle(type, payload, p => self.postMessage({ id, type: 'progress', ...p }));
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
