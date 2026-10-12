// A fingerprint of the app's files (js/, css/, index.html, the manifest), kept in sw.js next to CACHE.
// tests/sw.test.js compares it with the files, so an app change can't ship without bumping CACHE.
// After bumping CACHE in sw.js, run: node tests/update-sw-hash.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const SW = path.join(ROOT, 'sw.js');
const HASH_LINE = /^\/\/ files-hash: ([0-9a-f]*)$/m;

function appFiles() {
  const list = ['index.html', 'manifest.webmanifest'];
  for (const dir of ['css', 'js']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) list.push(`${dir}/${f}`);
  }
  return list;
}

export function computeHash() {
  const h = crypto.createHash('sha256');
  for (const f of appFiles()) {
    // Line endings are ignored, so a Windows checkout gives the same hash.
    h.update(f + '\0' + fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return h.digest('hex').slice(0, 16);
}

export const savedHash = () => fs.readFileSync(SW, 'utf8').match(HASH_LINE)?.[1];
export function saveHash(hash) {
  fs.writeFileSync(SW, fs.readFileSync(SW, 'utf8').replace(HASH_LINE, `// files-hash: ${hash}`));
}
