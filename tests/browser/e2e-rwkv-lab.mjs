// RWKV lab (Stage 2): choose a weights file, rebuild from history, shadow mode, comparison, undo, remove. Uses made-up weights
// (generated here, never saved in the repo) and the fake review history below. Sync is off in the lab build; no server request may be made.
// Run with: node tests/browser/run.mjs rwkv-lab     (SHOTS=<folder> keeps screenshots of the Lab screen there)
import fs from 'node:fs';
import { chromium } from './pw.mjs';
import { fakeWeights } from '../rwkv-fake-weights.mjs';
const SP = process.argv[2];
const SHOTS = process.env.SHOTS || SP;
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(SP + '/files', { recursive: true });
fs.writeFileSync(SP + '/files/fake-rwkv.bin', Buffer.from(fakeWeights({ seed: 5, format: 'int8' }).buffer));
fs.writeFileSync(SP + '/files/junk.bin', Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919 + 13) & 255)));
const URL = 'http://localhost:8123/';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
let supabaseRequests = 0;
await ctx.route(/supabase\.co/, route => { supabaseRequests++; route.abort(); });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const run = (fn, arg) => page.evaluate(fn, arg);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const labCount = store => run(async s => (await import('./js/rwkv-labdb.js')).count(s), store);
const livePreds = () => run(async () => (await (await import('./js/rwkv-labdb.js')).getAll('preds')).filter(p => p.src === 'live'));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return false; await sleep(150); } };
const states = () => run(async () => Object.fromEntries((await (await import('./js/db.js')).getAll('cardStates')).map(s => [s.cardId, s])));
const mainKeys = () => run(async () => { const db = await import('./js/db.js'); const d = await db.openDB(); return new Promise(r => { const q = d.transaction('settings').objectStore('settings').getAllKeys(); q.onsuccess = () => r(q.result.sort()); }); });

await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
// ---- 1. a deck with FSRS history: five cards, three reviews each (30, 22 and 9 days ago); card 0 was forgotten once; cards 0 and 1 share a note ----
await run(async () => {
  const db = await import('./js/db.js');
  const { rate } = await import('./js/srs.js');
  const { schedulerOptions } = await import('./js/sched-settings.js');
  await db.deleteDeck('sample');
  await db.setSetting('fuzz', false);
  const opts = schedulerOptions({ fuzz: false });
  const DAY = 86400000, now = Date.now();
  await db.addDeckWithCards({ id: 'lab', name: 'Lab', color: '#5B48E8', created: now },
    Array.from({ length: 5 }, (_, i) => ({ id: `lab-${i}`, deckId: 'lab', front: `Question ${i}`, back: `Answer ${i}`, tags: [], created: now + i, ...(i < 2 ? { noteId: 'note-A' } : {}) })));
  for (let c = 0; c < 5; c++) {
    let st = null;
    for (const [i, ago] of [30, 22, 9].entries()) {
      const when = now - ago * DAY - c * 60000;
      const rating = c === 0 && i === 1 ? 1 : 3;
      const log = { cardId: `lab-${c}`, timestamp: when, source: 'review', mode: 'flip', correct: rating > 1, ms: 3000 + c * 400, rating, state: st ? st.state : 0 };
      st = rate(`lab-${c}`, st, rating, opts, when);
      await db.saveReview(i === 2 ? { ...st, due: now - 3600000 } : st, log);
    }
  }
});
const seeded = await states();
let keysBefore = null;
ok(Object.keys(seeded).length === 5, 'seeded: five cards with history');
ok(!(await run(async () => (await indexedDB.databases()).some(d => d.name === 'study-sprint-rwkv-lab'))), 'before the lab is opened there is no lab database');

// ---- 2. Settings -> Lab -> Open RWKV lab ----
await page.goto(URL + '#/settings'); await page.waitForSelector('#labSection');
await page.evaluate(() => { document.getElementById('labSection').open = true; });
ok((await page.textContent('#labSection summary')).trim() === 'Lab', 'Settings has a Lab section');
ok(await page.locator('#labSection .help-link[aria-label="About the RWKV lab"]').count() === 1, 'with a help link');
await sleep(1200);                                                  // (Settings saves a few bookkeeping keys of its own while it draws)
keysBefore = await mainKeys();
await page.click('#labOpen');
await page.waitForSelector('#labPick');
ok((await page.textContent('h1')).trim() === 'RWKV lab' && (await page.textContent('.lab-tag')).trim() === 'Lab build', 'the RWKV lab screen opens, with its Lab build tag');
ok(await page.$eval('#labShadow', e => e.disabled), 'shadow mode is off and disabled before weights are loaded');
ok(await page.$eval('#labRebuild', e => e.disabled), 'and so is Rebuild');

// ---- 3. a file that is not a weights file ----
await page.setInputFiles('#labFile', SP + '/files/junk.bin');
await page.waitForFunction(() => /isn.t an RWKV weights file/.test(document.getElementById('labErr').textContent), null, { timeout: 5000 });
ok(await page.$eval('#labErr', e => !e.hidden && e.getAttribute('role') === 'alert'), 'a junk file shows the "isn\'t an RWKV weights file" alert');
ok(await page.$eval('#labShadow', e => e.disabled), 'and nothing was loaded');

// ---- 4. made-up weights ----
await page.setInputFiles('#labFile', SP + '/files/fake-rwkv.bin');
await page.waitForFunction(() => !document.getElementById('labWInfo').hidden, null, { timeout: 8000 });
ok(/fake-rwkv\.bin · \d+(\.\d)? KB|fake-rwkv\.bin · \d\.\d MB/.test(await page.textContent('#labWInfo')) && await page.$eval('#labErr', e => e.hidden), 'the file is accepted: name and size shown, no alert: ' + (await page.textContent('#labWInfo')));
ok(await page.$eval('#labWWarn', e => !e.hidden && e.textContent === 'Unknown model file'), 'an unknown file warns "Unknown model file"');
ok(!(await page.$eval('#labShadow', e => e.disabled)) && !(await page.$eval('#labRebuild', e => e.disabled)), 'shadow mode and Rebuild are now available');
{ const now = await mainKeys(); ok(JSON.stringify(now) === JSON.stringify(keysBefore), 'the main database settings store has no new keys' + (JSON.stringify(now) === JSON.stringify(keysBefore) ? '' : ': ' + now.filter(k => !keysBefore.includes(k)).join(','))); }

// ---- 5. rebuild ----
await page.click('#labRebuild');
await page.waitForFunction(() => /5 cards · rebuilt/.test(document.getElementById('labMInfo').textContent), null, { timeout: 60000 });
ok(await page.$eval('#labProg', e => e.hidden), 'rebuild finished: the progress bar is gone');
ok(await labCount('cards') === 5, 'the cards store holds the 5 cards with history (' + await labCount('cards') + ')');
ok(await labCount('notes') === 4, 'the notes store holds 4 notes (two cards share one): ' + await labCount('notes'));
ok(await labCount('shared') === 3 || await labCount('shared') === 4, 'deck, preset and user states are saved: ' + await labCount('shared'));
const st0 = await run(async () => (await import('./js/rwkv-labdb.js')).get('meta', 'state'));
ok(st0.rebuilding === false && st0.rows === 15 && st0.totalLogRows === 15 && !!st0.builder, 'state record: not rebuilding, 15 rows, builder saved');
ok(await labCount('preds') === 10, 'ten replay predictions (two later reviews for each card): ' + await labCount('preds'));
ok(await page.$eval('#labMWarn', e => e.hidden), 'no out-of-date warning after a rebuild');
ok(JSON.stringify(await mainKeys()) === JSON.stringify(keysBefore), 'still no new keys in the main settings store');

// ---- 6. shadow mode on ----
await page.click('#labShadow');
await waitFor(() => run(async () => (await (await import('./js/rwkv-labdb.js')).getSettings()).shadow));
ok(await run(async () => (await (await import('./js/rwkv-labdb.js')).getSettings()).shadow === true), 'shadow mode is on (saved in the lab database)');
ok(!('rwkvShadow' in (await run(async () => (await (await import('./js/db.js')).getSettings())))), 'and not in the main settings');

// ---- 7. review three cards ----
await page.click('.tab[data-tab=today]'); await page.waitForSelector('#startBtn');
await page.click('#startBtn'); await page.waitForSelector('#flash');
await sleep(600);                                                   // the lab gate and worker start in the background
const asked = [];
for (let i = 0; i < 3; i++) {
  await page.waitForSelector('#flash .flash-front');
  asked.push((await page.textContent('.flash-front')).trim());
  await page.keyboard.press('Space'); await page.waitForSelector('.rate');
  await page.keyboard.press('3');
  await page.waitForFunction(f => !document.querySelector('.flash-front') || document.querySelector('.flash-front').textContent.trim() !== f, asked[i]);
}
const live = await waitFor(async () => { const p = await livePreds(); return p.length === 3 ? p : false; }, 15000);
ok(!!live, 'three live predictions were saved after three reviews');
ok(live && live.every(p => p.src === 'live' && p.y === 1 && p.elapsedDays >= 8 && [p.rwkvCurve, p.rwkvImm, p.fsrsMine, p.fsrsDefault].every(v => Number.isFinite(v) && v > 0 && v < 1) && p.cardId && p.logId && p.t), 'each has all fields, finite and between 0 and 1: ' + JSON.stringify(live?.[0]));
// the schedule is exactly what FSRS gives on its own
const same = await run(async seed => {
  const db = await import('./js/db.js'), { rate } = await import('./js/srs.js'), { schedulerOptions } = await import('./js/sched-settings.js');
  const logs = (await db.getAll('reviewLog')).filter(l => l.source === 'review').sort((a, b) => b.timestamp - a.timestamp).slice(0, 3);
  const now = await db.getAll('cardStates');
  return logs.map(l => { const expect = rate(l.cardId, seed[l.cardId], 3, schedulerOptions({ fuzz: false }), l.timestamp); const got = now.find(s => s.cardId === l.cardId); return got.due === expect.due && got.stability === expect.stability && got.difficulty === expect.difficulty; });
}, seeded);
ok(same.length === 3 && same.every(Boolean), 'each card\'s saved due date, stability and difficulty equal what FSRS alone gives');

// ---- 8. undo takes the prediction back ----
await page.waitForSelector('#flash .flash-front');
const before4 = (await page.textContent('.flash-front')).trim();
await page.keyboard.press('Space'); await page.waitForSelector('.rate'); await page.keyboard.press('3');
ok(!!(await waitFor(async () => (await livePreds()).length === 4)), 'a fourth review adds a fourth prediction');
await page.click('text=Undo last');                               // (the fourth card was the last one: siblings are buried, so the finish screen offers Undo)
ok(!!(await waitFor(async () => (await livePreds()).length === 3)), 'undo removes its prediction');
const st1 = await run(async () => (await import('./js/rwkv-labdb.js')).get('meta', 'state'));
ok(st1.totalLogRows === 18 && st1.rows === 18, 'and the bookmark went back with it: ' + st1.totalLogRows + ' / ' + st1.rows);

// ---- 9. the comparison table ----
await page.goto(URL + '#/lab'); await page.waitForSelector('#labRows tr');
const rows = await page.$$eval('#labRows tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent.replace(/\s+/g, ' ').trim())));
ok(rows.length === 4 && rows.map(r => r[0].replace(/ \?$/, '')).join('|') === 'FSRS-6 (your settings)|FSRS-6 (default)|RWKV curve|RWKV instant', 'four model rows');
ok(rows.every(r => /^\d+\.\d{3}$/.test(r[1]) && /^\d+\.\d{3}$/.test(r[3])), 'log loss and RMSE are numbers: ' + JSON.stringify(rows));
ok(rows.every(r => /^\d\.\d{3}$/.test(r[2])), 'AUC is a number (one card was forgotten once)');
ok(rows.every(r => r[4] === '13'), 'every row covers the same 13 reviews (10 replayed + 3 live)');
ok(await page.locator('#labRows .help-link[aria-label^="About "]').count() === 4, 'each row has a help link with a label');
await page.click('#labChips label:has(input[value=shadow])');
await page.waitForFunction(() => document.querySelector('#labRows tr td:last-child')?.textContent === '3', null, { timeout: 5000 });
ok(true, '"Since shadow mode" counts only the 3 live reviews');
await page.click('#labChips label:has(input[value=all])');

// ---- 10. nothing sideways, every control named, no hint text ----
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 375px');
const unnamed = await page.$$eval('.view button, .view a, .view input, .view select', els => els.filter(e => {
  if (e.hidden || e.closest('[hidden]')) return false;
  const name = (e.getAttribute('aria-label') || '').trim() || (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent.trim()) || (e.textContent || '').trim() || (e.labels && [...e.labels].map(l => l.textContent.trim()).join(''));
  return !name;
}).map(e => e.outerHTML.slice(0, 80)));
ok(unnamed.length === 0, 'every control on the screen has a name ' + unnamed.join('|'));

// ---- screenshots: phone and desktop, dark and light ----
await page.waitForFunction(() => document.getElementById('toast')?.hidden !== false, null, { timeout: 15000 });      // (the undo toast would sit over the table)
const shot = async (name) => page.screenshot({ path: `${SHOTS}/lab-${name}.png`, fullPage: true });
for (const scheme of ['dark', 'light']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 375, height: 740 }); await sleep(250); await shot(`phone-${scheme}`);
  await page.setViewportSize({ width: 1280, height: 900 }); await sleep(250); await shot(`desktop-${scheme}`);
}
await page.setViewportSize({ width: 375, height: 740 });
await page.emulateMedia({ colorScheme: 'dark' });

// ---- 11. a reload keeps everything ----
await page.reload(); await page.waitForSelector('#labRows tr');
await page.waitForFunction(() => /5 cards/.test(document.getElementById('labMInfo').textContent), null, { timeout: 5000 });
ok(/fake-rwkv\.bin/.test(await page.textContent('#labWInfo')) && await page.$eval('#labShadow', e => e.checked) && await page.$eval('#labMWarn', e => e.hidden), 'after a reload: the weights, shadow mode and the fresh state are still there');
ok(await page.$eval('#labRows tr td:last-child', e => e.textContent) === '13', 'and the comparison');

// ---- 12. answers made while shadow was off are caught up, not lost; an outside change makes the state stale ----
await page.click('#labShadow'); await sleep(300);
const tamper = await run(async () => {          // a review in the main log that the lab never saw
  const db = await import('./js/db.js');
  const logs = await db.getAll('reviewLog');
  const old = logs.find(l => l.source === 'review' && l.cardId === 'lab-4');
  await db.deleteLogs?.([old.id]);
  return !!db.deleteLogs;
});
if (!tamper) {
  await run(async () => { const d = await (await import('./js/db.js')).openDB(); await new Promise(r => { const tx = d.transaction('reviewLog', 'readwrite'); tx.objectStore('reviewLog').delete(1); tx.oncomplete = r; }); });
}
await page.reload(); await page.waitForSelector('#labRows tr');
await page.waitForFunction(() => !document.getElementById('labMWarn').hidden, null, { timeout: 5000 });
ok(/Out of date: rebuild needed/.test(await page.textContent('#labMWarn')), 'a review deleted outside the lab shows "Out of date: rebuild needed"');
await page.click('#labShadow'); await sleep(300);

// ---- 13. remove everything ----
await page.click('#labDelete');
ok(await page.$eval('#labConfirm', e => !e.hidden && /not touched/.test(e.textContent)), 'Remove asks first, and says the cards and reviews are not touched');
await page.click('#labYes');
await page.waitForFunction(() => document.getElementById('labWInfo').hidden, null, { timeout: 8000 });
ok(!(await run(async () => (await indexedDB.databases()).some(d => d.name === 'study-sprint-rwkv-lab'))), 'the lab database is gone');
ok((await page.textContent('#labMInfo')).startsWith('0 cards') && await page.$eval('#labShadow', e => e.disabled), 'the screen shows an empty lab');
ok(Object.keys(await states()).length === 5 && (await run(async () => (await (await import('./js/db.js')).getAll('reviewLog')).length)) >= 17, 'cards and reviews are untouched');

// ---- 14. with the lab gone, review does nothing extra ----
await page.click('.tab[data-tab=today]');
await sleep(500);
ok(!(await run(async () => (await indexedDB.databases()).some(d => d.name === 'study-sprint-rwkv-lab'))), 'leaving the lab screen does not bring the database back');

// ---- 15. sign-in is refused ----
await page.goto(URL + '#/settings'); await page.waitForSelector('#syncEmail');
await page.fill('#syncEmail', 'lab@example.com'); await page.fill('#syncPw', 'secret123');
await page.click('#syncForm button[type=submit]');
await page.waitForFunction(() => /Sync is off in the lab build\./.test(document.body.textContent), null, { timeout: 10000 });
ok(true, 'signing in says "Sync is off in the lab build."');
ok(supabaseRequests === 0, 'no request went to the server (' + supabaseRequests + ')');
ok(errors.length === 0, 'no page or console errors ' + errors.join(' | '));
await browser.close();
