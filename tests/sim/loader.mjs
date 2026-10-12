// A tiny Node loader so the simulation can run the app's real modules. The app loads ts-fsrs from a CDN
// address, which Node can't open; this points that address at a local copy of the same version.
//   Install it once:  npm install --no-save ts-fsrs@5.4.2      (or set TS_FSRS_PATH to its dist/index.mjs)
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CDN = 'https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.mjs';
const here = path.dirname(new URL(import.meta.url).pathname);

export async function resolve(specifier, context, next) {
  if (specifier !== CDN) return next(specifier, context);
  const local = process.env.TS_FSRS_PATH || path.resolve(here, '../../node_modules/ts-fsrs/dist/index.mjs');
  if (!existsSync(local)) throw new Error('ts-fsrs 5.4.2 is needed: run `npm install --no-save ts-fsrs@5.4.2` (or set TS_FSRS_PATH to its dist/index.mjs)');
  return { url: pathToFileURL(local).href, shortCircuit: true };
}
