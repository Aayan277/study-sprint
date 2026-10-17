// Runs the browser tests: each one opens the app in a real (hidden) browser, clicks through it and
// prints PASS or FAIL for every check. Run with: npm run test:browser   (or one: npm run test:browser review)
//
// Needs Playwright and Chromium once on a computer: npm install --no-save playwright && npx playwright install chromium
// The app is served from this folder while the tests run (the tests open http://localhost:8123; see below). Screenshots and
// downloads go in tests/browser/out (not saved in git).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.md': 'text/plain; charset=utf-8' };

// Output folder, with the input files the tests read from out/files.
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['files', 'exports', 'desk']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
for (const f of fs.readdirSync(path.join(HERE, 'files'))) fs.copyFileSync(path.join(HERE, 'files', f), path.join(OUT, 'files', f));

// A tiny web server for the app (no caching, like the live site after an update).
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
// Each run serves the app on its own free port, so several checkouts can test at once. The tests still open
// http://localhost:8123: tests/browser/pw.mjs tells the browser to send that address to this run's port (APP_PORT),
// so the page keeps the same origin (storage, service worker) whichever port it really comes from.
await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
const APP_PORT = server.address().port;

const only = process.argv[2];
const tests = fs.readdirSync(HERE).filter(f => /^(e2e.*|sweep)\.mjs$/.test(f) && (!only || f.includes(only))).sort();
let failed = 0;
for (const t of tests) {
  const out = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(HERE, t), OUT], { cwd: ROOT, env: { ...process.env, APP_PORT: String(APP_PORT) } });
    let text = '';
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { text += d; });
    const timer = setTimeout(() => { child.kill(); text += '\nFAIL timed out after 5 minutes'; }, 5 * 60 * 1000);
    child.on('close', code => { clearTimeout(timer); resolve({ text, code }); });
  });
  const passes = (out.text.match(/^PASS/gm) || []).length;
  // Problems: FAIL and ERROR(S) lines, any "Error:", and a file that checked nothing (a silent file proves nothing).
  const problems = out.text.split('\n').filter(l => /^FAIL|^ERROR|Error:/.test(l));
  if (!passes) problems.push('no PASS lines: this file checked nothing');
  const bad = problems.length || out.code;
  if (bad) failed++;
  console.log(`${bad ? '✗' : '✓'} ${t}: ${passes} passed${bad ? `, ${problems.length || 'crashed'} problem(s)` : ''}`);
  problems.slice(0, 8).forEach(l => console.log('    ' + l));
  if (out.code && !problems.length) out.text.trim().split('\n').slice(-6).forEach(l => console.log('    ' + l));   // a crash: its last lines
}
server.close();
console.log(failed ? `\n${failed} of ${tests.length} test files had problems.` : `\nAll ${tests.length} test files passed.`);
process.exit(failed ? 1 : 0);
