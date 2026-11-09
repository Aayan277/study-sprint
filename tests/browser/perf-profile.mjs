// CPU profile of answering cards in Review (see perf-next-card.mjs for the timing run). Prints the functions with the most self time
// across ANSWERS answers, grouped by file. Not part of the suite. Run: CPU_THROTTLE=1 node tests/browser/perf-profile.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
process.env.APP_PORT = String(server.address().port);
const { chromium } = await import('./pw.mjs');
const N = +process.env.ANSWERS || 60, CARDS = +process.env.CARDS || 2000;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
await page.evaluate(async total => {
  const db = await import('./js/db.js');
  await db.deleteDeck('sample');
  const now = Date.now(), D = 86400000;
  await db.saveDeck({ id: 'P', name: 'Perf', course: '', color: '#46A758', parentId: '', created: now - 9000 });
  const cards = [], states = [];
  for (let i = 0; i < total; i++) {
    const id = `p${i}`;
    cards.push({ id, deckId: 'P', front: `Question ${i}: what is the meaning of term number ${i}?`, back: `Answer ${i}: a reasonably short explanation of term ${i}.`, tags: ['t' + (i % 20)], created: now - 100000 + i });
    states.push({ cardId: id, due: now - (1 + (i % 9)) * D, stability: 5 + (i % 40), difficulty: 4 + (i % 5), reps: 3 + (i % 6), lapses: 0, state: 2, lastReview: now - 10 * D, elapsedDays: 10, scheduledDays: 8, learningSteps: 0 });
  }
  for (let i = 0; i < total; i += 500) { await db.saveCards(cards.slice(i, i + 500)); await db.putStates(states.slice(i, i + 500)); }
}, CARDS);
await page.goto('about:blank'); await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
for (let i = 0; i < N; i++) {
  const f = await page.locator('#flash .rv-front .flash-front').first().textContent();
  await page.keyboard.press('Space'); await page.waitForSelector('#flash.flipped');
  await page.keyboard.press('3');
  await page.waitForFunction(prev => document.querySelector('#flash .rv-front .flash-front')?.textContent !== prev, f);
}
const { profile } = await cdp.send('Profiler.stop');
const dt = profile.timeDeltas, self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + dt[i]));
const byFn = new Map(), byFile = new Map();
let total = 0;
for (const [id, us] of self) {
  const n = byId.get(id), cf = n.callFrame;
  if (cf.functionName === '(idle)' || cf.functionName === '(program)') continue;
  total += us;
  const file = cf.url.replace(/^.*localhost:8123\//, '') || '(native)';
  const key = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
  byFn.set(key, (byFn.get(key) || 0) + us);
  byFile.set(file, (byFile.get(file) || 0) + us);
}
const ms = us => (us / 1000 / N).toFixed(2);
console.log(`busy main-thread time per answer: ${ms(total)} ms (${N} answers)`);
console.log('--- by file (ms per answer)');
for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(ms(v).padStart(7), k);
console.log('--- by function');
for (const [k, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(ms(v).padStart(7), k);
await browser.close(); server.close();
