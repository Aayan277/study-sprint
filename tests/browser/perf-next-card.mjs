// How long does it take from pressing a rating key to the next card being on screen?
// Not part of the suite (run.mjs only runs e2e*.mjs and sweep.mjs). Run it with:
//   node tests/browser/perf-next-card.mjs            (phone 390x844 with CPU_THROTTLE=4, then desktop 1280x800 unthrottled)
//   ANSWERS=50 CARDS=2000 node tests/browser/perf-next-card.mjs
// Seeds a synthetic deck (CARDS cards, most of them due), starts Review, and for each of ANSWERS cards presses Space and then "3".
// In the page, a capture-phase keydown listener takes the time of the key (performance.now), and a MutationObserver sees the next
// card's front arrive in the page: "dom" is key to new front in the DOM, "paint" is key to the first frame after it (the second
// requestAnimationFrame callback, i.e. after the browser has painted the new card). Prints median and p95 of each.
// The app is served from this checkout on a free port (like run.mjs); nothing leaves the machine.
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

const N = +process.env.ANSWERS || 50, CARDS = +process.env.CARDS || 2000;
const SETUPS = [
  { name: 'phone 390x844, CPU x4', throttle: 4, viewport: { width: 390, height: 844 }, mobile: true },
  { name: 'desktop 1280x800, no throttle', throttle: 1, viewport: { width: 1280, height: 800 }, mobile: false }
].filter(s => !process.env.ONLY || s.name.startsWith(process.env.ONLY));

const APP = 'http://localhost:8123/';
const stat = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

const results = [];
for (const setup of SETUPS) {
  // (pw.mjs reads CPU_THROTTLE when it is loaded, so each setup is its own child process)
  if (!process.env.CHILD) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, CHILD: setup.name, CPU_THROTTLE: String(setup.throttle) }, stdio: 'inherit' });
    if (r.status) process.exitCode = r.status;
    continue;
  }
  if (process.env.CHILD !== setup.name) continue;
  const { chromium } = await import('./pw.mjs');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: setup.viewport, serviceWorkers: 'block', ...(setup.mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.stack));
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  await page.evaluate(async total => {
    const db = await import('./js/db.js');
    await db.deleteDeck('sample');
    const now = Date.now(), D = 86400000;
    await db.saveDeck({ id: 'P', name: 'Perf', course: '', color: '#46A758', parentId: '', created: now - 9000 });
    const cards = [], states = [];
    for (let i = 0; i < total; i++) {
      const id = `p${i}`;
      cards.push({ id, deckId: 'P', front: `Question ${i}: what is the meaning of term number ${i}?`, back: `Answer ${i}: a reasonably short explanation of term ${i}.`, tags: ['t' + (i % 20)], created: now - 100000 + i });
      // 70% due today or overdue, 30% not due yet
      const due = i % 10 < 7 ? now - (1 + (i % 9)) * D : now + (2 + (i % 30)) * D;
      states.push({ cardId: id, due, stability: 5 + (i % 40), difficulty: 4 + (i % 5), reps: 3 + (i % 6), lapses: i % 4 === 0 ? 1 : 0, state: 2, lastReview: now - 10 * D, elapsedDays: 10, scheduledDays: 8, learningSteps: 0 });
    }
    for (let i = 0; i < total; i += 500) { await db.saveCards(cards.slice(i, i + 500)); await db.putStates(states.slice(i, i + 500)); }
  }, CARDS);
  await page.goto('about:blank'); await page.goto(APP + '#/today'); await page.waitForSelector('#startBtn');
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  // Watching in the page.
  await page.evaluate(() => {
    const w = window.__perf = { t0: 0, samples: [], pending: false, last: document.querySelector('#flash .rv-front .flash-front')?.textContent };
    addEventListener('keydown', e => { if (e.key === '3') w.t0 = performance.now(); }, true);
    new MutationObserver(() => {
      const f = document.querySelector('#flash .rv-front .flash-front')?.textContent;
      if (!f || f === w.last || !w.t0) return;
      w.last = f;
      const dom = performance.now() - w.t0, t0 = w.t0;
      w.t0 = 0;
      requestAnimationFrame(() => requestAnimationFrame(() => w.samples.push({ dom, paint: performance.now() - t0 })));
    }).observe(document.getElementById('screen') || document.body, { childList: true, subtree: true, characterData: true });
  });
  for (let i = 0; i < N; i++) {
    await page.keyboard.press('Space');
    await page.waitForSelector('#flash.flipped');
    await page.keyboard.press('3');
    await page.waitForFunction(n => window.__perf.samples.length > n, i, { timeout: 15000 });
  }
  const samples = await page.evaluate(() => window.__perf.samples);
  const phases = await page.evaluate(() => window.__phases || null);
  const out = { setup: setup.name, cards: CARDS, answers: N, dom: stat(samples.map(s => s.dom)), paint: stat(samples.map(s => s.paint)) };
  if (phases) {
    out.phases = {};
    for (const k of Object.keys(phases[0] || {})) out.phases[k] = stat(phases.map(p => p[k]));
  }
  console.log(JSON.stringify(out));
  if (errors.length) { console.log('PAGE ERRORS', errors.slice(0, 3)); process.exitCode = 1; }
  await browser.close();
}
server.close();
