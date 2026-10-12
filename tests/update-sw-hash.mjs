// Run this after bumping CACHE in sw.js: it saves the new fingerprint of the app files in sw.js.
//   node tests/update-sw-hash.mjs
import { computeHash, saveHash } from './sw-hash.mjs';

const hash = computeHash();
saveHash(hash);
console.log('sw.js files-hash is now', hash);
