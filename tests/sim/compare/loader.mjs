// Node resolve hook: (1) the app's CDN ts-fsrs URL -> local ts-fsrs@5.4.2 installed in ./deps (outside the repo);
// (2) the app's ./db.js (IndexedDB) -> memdb.mjs, an in-memory shim of the few functions loadAll() uses.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const CDN = 'https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs';
const FSRS = pathToFileURL(path.join(here, 'deps/node_modules/ts-fsrs/dist/index.mjs')).href;
const MEMDB = pathToFileURL(path.join(here, 'memdb.mjs')).href;

export async function resolve(specifier, context, next) {
  if (specifier === CDN) return { url: FSRS, shortCircuit: true };
  if (specifier === './db.js' && context.parentURL && /\/js\/[^/]+\.js$/.test(context.parentURL)) return { url: MEMDB, shortCircuit: true };
  return next(specifier, context);
}
