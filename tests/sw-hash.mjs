// A fingerprint of the app's files (js/, css/, icons/, index.html, the manifest), kept in sw.js next to CACHE.
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
  for (const dir of ['css', 'js', 'icons']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) list.push(`${dir}/${f}`);
  }
  return list;
}

export function computeHash() {
  const h = crypto.createHash('sha256');
  for (const f of appFiles()) {
    // Line endings are ignored, so a Windows checkout gives the same hash.
    const raw = fs.readFileSync(path.join(ROOT, f));
    // Pictures are hashed as they are; text files with line endings ignored.
    h.update(f + '\0');
    h.update(/\.(png|jpe?g|webp|ico)$/.test(f) ? raw : raw.toString('utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export const savedHash = () => fs.readFileSync(SW, 'utf8').match(HASH_LINE)?.[1];
export function saveHash(hash) {
  fs.writeFileSync(SW, fs.readFileSync(SW, 'utf8').replace(HASH_LINE, `// files-hash: ${hash}`));
}
