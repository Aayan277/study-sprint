// RWKV lab: a tiny web server for running this folder on your own computer. No packages needed; Node is enough.
//   node tools/rwkv-lab/serve.mjs        (or: npm run lab)
// It only answers on this computer (127.0.0.1, port 8137), so nothing on your network can reach it. Open http://localhost:8137
// A fixed port keeps the lab's saved data (your cards copy, the weights file, the lab's memory) in one place in the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_ROOT = fs.realpathSync(ROOT);
const HOST = '127.0.0.1', PORT = 8137;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm'
};

// Only the app is served: not hidden folders (.git), downloaded packages, tests or tools.
const hidden = rel => rel.split(path.sep).some(part => part.startsWith('.') || part === 'node_modules' || part === 'tests' || part === 'tools');

export function createServer() {
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `localhost:${PORT}` && host !== `${HOST}:${PORT}`) { res.writeHead(421); res.end(); return; }      // only the two addresses this server is for
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    const file = path.resolve(ROOT, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    const rel = path.relative(ROOT, file);
    let real = null;
    try { real = fs.realpathSync(file); } catch { /* not there */ }
    const inside = real && !path.relative(REAL_ROOT, real).startsWith('..') && !path.isAbsolute(path.relative(REAL_ROOT, real));      // (a link that points out of the folder is refused)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || hidden(rel) || !inside || fs.statSync(real).isDirectory()) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.on('error', err => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. The lab may already be running in another window: open http://localhost:${PORT}`
      : `The lab server could not start: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Study Sprint RWKV lab is running.\nOpen this address in Chrome, Edge or Safari:  http://localhost:${PORT}\nTo stop it, press Ctrl+C in this window.`);
  });
}
