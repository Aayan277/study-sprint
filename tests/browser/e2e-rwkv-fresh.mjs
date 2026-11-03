// RWKV lab: "fresh" must be trustworthy. (1) The first answer after a page load is fed to the model once, not twice. (2) A review row that
// was deleted outside the lab is not hidden by a later answer (the state turns stale), while undo through the lab keeps it fresh.
// Run with: node tests/browser/run.mjs rwkv-fresh
import fs from 'node:fs';
import { chromium } from './pw.mjs';
import { fakeWeights } from '../rwkv-fake-weights.mjs';
const SP = process.argv[2];
fs.mkdirSync(SP + '/files', { recursive: true });
fs.writeFileSync(SP + '/files/fake-rwkv-fresh.bin', Buffer.from(fakeWeights({ seed: 5, format: 'int8' }).buffer));
const URL = 'http://localhost:8123/';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
await ctx.route(/supabase\.co/, route => route.abort());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const run = (fn, arg) => page.evaluate(fn, arg);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return false; await sleep(150); } };
const labState = () => run(async () => (await import('./js/rwkv-labdb.js')).get('meta', 'state'));
const livePreds = () => run(async () => (await (await import('./js/rwkv-labdb.js')).getAll('preds')).filter(p => p.src === 'live'));
const status = () => run(async () => { const s = await (await import('./js/rwkv-lab.js')).getLab().status(); return { state: s.state, reason: s.reason }; });
const modelRowCount = () => run(async () => {
  const db = await import('./js/db.js'), { modelRows } = await import('./js/rwkv-features.js');
  return modelRows(await db.getAll('reviewLog'), await db.getAll('cards'), await db.getAll('decks')).length;
});

await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
await run(async () => {
  const db = await import('./js/db.js'), { rate } = await import('./js/srs.js'), { schedulerOptions } = await import('./js/sched-settings.js');
  await db.deleteDeck('sample');
  await db.setSetting('fuzz', false);
  const opts = schedulerOptions({ fuzz: false }), DAY = 86400000, now = Date.now();
  await db.addDeckWithCards({ id: 'lab', name: 'Lab', color: '#5B48E8', created: now },
    Array.from({ length: 5 }, (_, i) => ({ id: `lab-${i}`, deckId: 'lab', front: `Question ${i}`, back: `Answer ${i}`, tags: [], created: now + i })));
  for (let c = 0; c < 5; c++) {
    let st = null;
    for (const [i, ago] of [30, 22, 9].entries()) {
      const when = now - ago * DAY - c * 60000;
      const log = { cardId: `lab-${c}`, timestamp: when, source: 'review', mode: 'flip', correct: true, ms: 3000, rating: 3, state: st ? st.state : 0 };
      st = rate(`lab-${c}`, st, 3, opts, when);
      await db.saveReview(i === 2 ? { ...st, due: now - 3600000 } : st, log);
    }
  }
});
// weights, rebuild, shadow on (through the lab's own code)
await page.goto(URL + '#/lab'); await page.waitForSelector('#labPick');
await page.setInputFiles('#labFile', SP + '/files/fake-rwkv-fresh.bin');
await page.waitForFunction(() => !document.getElementById('labWInfo').hidden, null, { timeout: 8000 });
await page.click('#labRebuild');
await page.waitForFunction(() => /5 cards · rebuilt/.test(document.getElementById('labMInfo').textContent) && document.getElementById('labProg').hidden, null, { timeout: 60000 });
await page.click('#labShadow');
await waitFor(() => run(async () => (await (await import('./js/rwkv-labdb.js')).getSettings()).shadow));
ok((await status()).state === 'fresh', 'after a rebuild and shadow on the state is fresh');

const answerOne = async () => {
  await page.goto(URL + '#/decks'); await page.reload(); await page.waitForSelector('.deck');
  await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn'); await page.click('#startBtn'); await page.waitForSelector('#flash .flash-front');
  await sleep(500);
  await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
  await page.waitForFunction(() => !document.querySelector('#flash .flash-front') || true);
  await sleep(500);
  await run(async () => { const l = (await import('./js/rwkv-lab.js')).getLab(); await l.call('flush', {}, 10000); });
};

// ---- B1: the first answer after a page load ----
await answerOne();
const st1 = await labState();
const rowsInLog = await modelRowCount();
ok(st1.rows === rowsInLog, `the model saw each row once: state.rows ${st1.rows}, model rows in the log ${rowsInLog}`);
const live = await livePreds();
ok(live.length === 1 && live[0].elapsedDays >= 8, 'the first answer after a reload has a live prediction with the real gap: ' + JSON.stringify(live.map(p => p.elapsedDays)));
ok((await status()).state === 'fresh', 'and the state is fresh');

// ---- B2: a deletion made outside the lab, while the page stays open, is not hidden by the next answer ----
await page.goto(URL + '#/decks'); await page.reload(); await page.waitForSelector('.deck');
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn'); await page.click('#startBtn'); await page.waitForSelector('#flash .flash-front');
await sleep(500);
const nLive = (await livePreds()).length;
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await waitFor(async () => (await livePreds()).length === nLive + 1);
await run(async () => {                                               // (what deleting a card in Browse, or Play's "I was right", does to the log)
  const db = await import('./js/db.js');
  const old = (await db.getAll('reviewLog')).filter(l => l.source === 'review').sort((a, b) => a.timestamp - b.timestamp)[0];
  await db.deleteLogRow(old.id);
});
await page.waitForSelector('#flash .flash-front'); await sleep(300);
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await waitFor(async () => (await livePreds()).length === nLive + 2);
await run(async () => { await (await import('./js/rwkv-lab.js')).getLab().call('flush', {}, 10000); });
const s2 = await status();
ok(s2.state === 'stale', 'a row deleted outside the lab, then one more answer in the same page: the state is stale, not fresh (' + s2.state + ')');

// ---- ...and a told undo keeps it fresh: rebuild, answer, undo in the session ----
await page.goto(URL + '#/lab'); await page.waitForSelector('#labRebuild');
await page.click('#labRebuild');
await page.waitForFunction(() => /rebuilt/.test(document.getElementById('labMInfo').textContent) && document.getElementById('labProg').hidden && document.getElementById('labMWarn').hidden, null, { timeout: 60000 });
ok((await status()).state === 'fresh', 'rebuilt: fresh again');
await page.reload(); await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn'); await page.click('#startBtn'); await page.waitForSelector('#flash .flash-front');
await sleep(500);
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
await waitFor(async () => (await livePreds()).length >= 1);
await page.waitForSelector('text=Undo last').then(() => page.click('text=Undo last')).catch(() => {});
await sleep(800);
await run(async () => { await (await import('./js/rwkv-lab.js')).getLab().call('flush', {}, 10000); });
ok((await status()).state === 'fresh', 'an answer taken back in the session leaves the state fresh (' + JSON.stringify(await status()) + ')');
ok(errors.length === 0, 'no page or console errors ' + errors.join(' | '));
await browser.close();
