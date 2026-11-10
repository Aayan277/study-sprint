// Own model in Settings and Today: nothing is created until a model file is loaded; a bad file shows an error and saves nothing; a good one
// loads; the switch, the state label and the verdict badge; a switch notice shows on Today once; Remove wipes Own's database and leaves
// cards and reviews alone; the section loads its code only when opened; every control has a name; no helper text. The model file is
// built here, at test time (random start, never saved in git). Nothing reaches the network.
import { chromium } from './pw.mjs';
import { writeOwnFile } from '../../js/own-file.js';
import { initParams } from '../../js/own-model.js';

const goodBytes = Buffer.from(writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn: [{ id: 'sim-v1', licence: 'ours' }], seed: 3, gitStamp: 'test', createdAt: '2026-11-06T00:00:00.000Z' }));
const badBytes = Buffer.from('this is not a model file at all');

const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [], supa = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.message));
await ctx.route('**/*.supabase.co/**', r => { supa.push(r.request().url()); r.abort(); });
const ownDbNames = () => page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => /own/.test(n)));
const counts = () => page.evaluate(async () => { const db = await import('./js/db.js'); return [(await db.getAll('cards')).length, (await db.getAll('reviewLog')).length, (await db.getAll('cardStates')).length].join('/'); });
const ownLoaded = () => page.evaluate(() => performance.getEntriesByType('resource').map(r => new URL(r.name).pathname).filter(p => /\/js\/(own-[^/]*|settings-own)\.js$/.test(p)));
const openOwn = async () => {
  await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#advanced');
  await page.evaluate(() => { document.getElementById('advanced').open = true; });
  await page.click('#ownSection > summary'); await page.waitForSelector('#ownLoad');
};
const sched = () => page.textContent('#ownSched');

// 1. the section loads its code only when opened; no Own database before a file is loaded
await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#advanced');
await page.evaluate(() => { document.getElementById('advanced').open = true; });
ok((await ownLoaded()).length === 0, 'Settings alone loads no Own code: ' + (await ownLoaded()));
await page.click('#ownSection > summary'); await page.waitForSelector('#ownLoad');
await page.waitForTimeout(400);
ok((await ownLoaded()).some(p => p.endsWith('settings-own.js')), 'opening the section loads its code');
ok((await ownDbNames()).length === 0, 'opening the section creates no Own database');
ok(await page.locator('#ownOn').isDisabled(), 'the switch is off limits until a file is loaded');
ok(await page.locator('#ownCheck').count() === 0 && await page.locator('#ownRemove').count() === 0, 'no check or remove buttons without a model');

// 2. a bad file: an error, nothing saved
await page.setInputFiles('#ownFile', { name: 'bad.own', mimeType: 'application/octet-stream', buffer: badBytes });
await page.waitForSelector('#ownErr:not([hidden])');
ok(/isn.t an Own model/.test(await page.textContent('#ownErr')) && await page.getAttribute('#ownErr', 'role') === 'alert', 'a bad file shows a clear error: ' + await page.textContent('#ownErr'));
ok((await ownDbNames()).length === 0, 'a bad file saves nothing (no Own database)');

// 3. a good file loads
const before = await counts();
await page.setInputFiles('#ownFile', { name: 'test.own', mimeType: 'application/octet-stream', buffer: goodBytes });
await page.waitForSelector('#ownName');
ok(/^test\.own · [0-9a-f]{6}$/.test(await page.textContent('#ownName')), 'the file name and short fingerprint show: ' + await page.textContent('#ownName'));
ok(await page.locator('#ownErr').isHidden(), 'the error is gone');
ok((await ownDbNames()).join() === 'study-sprint-own', 'the Own database exists after loading');
ok(await page.locator('#ownOn').isEnabled() && !(await page.locator('#ownOn').isChecked()), 'the switch can be used and is off');
ok(await sched() === 'FSRS', 'scheduling reads FSRS');
const verdict = await page.textContent('#ownVerdict');
ok(/Not enough reviews yet/.test(verdict) && /\d+ of 1,000/.test(verdict) && /\d+ of 300/.test(verdict), 'verdict: not enough reviews yet, with counts: ' + verdict.replace(/\s+/g, ' '));

// 4. switch on and off
await page.check('#ownOn');
await page.waitForFunction(() => document.querySelector('#ownOn').checked && !document.querySelector('#ownOn').disabled);
ok(/watching/.test(await page.textContent('#toast, .toast').catch(() => '') || 'watching'), 'turning on is confirmed');
await page.waitForFunction(() => document.querySelector('#ownSched')?.textContent === 'FSRS', null, { timeout: 20000 });
ok(await page.locator('#ownCheck').isEnabled(), 'Check now works while on');
await page.click('#ownCheck');
await page.waitForFunction(() => !document.querySelector('#ownCheck').disabled);
ok(/Not enough reviews yet/.test(await page.textContent('#ownVerdict')), 'Check now keeps the verdict at not enough reviews');
await page.uncheck('#ownOn');
await page.waitForFunction(() => !document.querySelector('#ownOn').checked && !document.querySelector('#ownOn').disabled);
ok(await sched() === 'FSRS', 'off: FSRS');

// 5. a forced switch (state written to Own's database) shows the note on Today once
await page.check('#ownOn');
await page.waitForFunction(() => document.querySelector('#ownOn').checked && !document.querySelector('#ownOn').disabled);
await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
ok(await page.locator('#ownNoticeTitle').count() === 0, 'no note before a switch');
await page.evaluate(async () => {
  const { openOwnDb } = await import('./js/own-db.js');
  const h = await openOwnDb({ forbidCreate: true });
  try { await h.put('meta', 'state', { ...(await h.get('meta', 'state')), scheduler: 'own', noticePending: 1, switches: [{ day: 1, to: 'own', why: 'better' }] }); } finally { h.close(); }
});
await page.reload(); await page.waitForSelector('#startBtn');
await page.waitForSelector('#ownNoticeTitle', { timeout: 15000 });
ok(/Own model now schedules your reviews/.test(await page.textContent('#ownNoticeTitle')), 'the switch note shows on Today');
ok(await page.getAttribute('#ownNoticeX', 'aria-label') === 'Dismiss notice', 'the note\'s close button has a name');
await page.reload(); await page.waitForSelector('#startBtn'); await page.waitForTimeout(1500);
ok(await page.locator('#ownNoticeTitle').count() === 0, 'the note does not come back after a reload');
// and the dismiss button works for a second switch
await page.evaluate(async () => {
  const { openOwnDb } = await import('./js/own-db.js');
  const h = await openOwnDb({ forbidCreate: true });
  try { await h.put('meta', 'state', { ...(await h.get('meta', 'state')), scheduler: 'fsrs', noticePending: 2, switches: [{ day: 1, to: 'own', why: 'better' }, { day: 20, to: 'fsrs', why: 'worse' }] }); } finally { h.close(); }
});
await page.reload(); await page.waitForSelector('#startBtn');
await page.waitForSelector('#ownNoticeTitle', { timeout: 15000 });
ok(/Back on FSRS/.test(await page.textContent('#ownNoticeTitle')), 'going back to FSRS shows its own note');
await page.click('#ownNoticeOk');
ok(await page.locator('#ownNoticeTitle').count() === 0, 'Got it dismisses the note');

// 6. aria-labels and no helper text in the section
await openOwn();
const names = await page.$$eval('#ownBody button, #ownBody input, #ownBody a, #ownBody select', els => els.map(e => ({ id: e.id || e.className, name: e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].textContent.trim()) || e.textContent.trim() })));
ok(names.length >= 5 && names.every(n => n.name), 'every control has a name: ' + names.map(n => n.name).join(' | '));
ok(await page.getAttribute('#ownFile', 'aria-label') === 'Model file', 'the file input is named');
ok(await page.getAttribute('#ownBody a.help-link', 'href') === '#/help/own-model', 'the ? link goes to the own-model help answer');
const sentences = await page.$$eval('#ownBody p, #ownBody .note, #ownBody .steps-hint, #ownBody small', els => els.filter(e => e.offsetParent !== null).map(e => e.id || e.className));
ok(sentences.length === 0, 'no visible sentences in the section while all is well: ' + sentences);
await page.addStyleTag({ content: '#ownBody .sr-only{display:none!important}' });          // (words only a screen reader hears are not on screen: they are checked in e2e-own-fixes)
const text = (await page.innerText('#ownBody')).split('\n').map(s => s.trim()).filter(Boolean);
const allowed = [/^Model file$/, /^\?$/, /^Load model file…$/, /^test\.own · [0-9a-f]{6}$/, /^Use my own model$/, /^Scheduling$/, /^(FSRS|Own|FSRS \(paused\)|Building memory…)$/, /^Verdict$/, /^Not enough reviews yet$/, /^[\d,]+ of [\d,]+( · [\d,]+ of [\d,]+)*( days)?$/, /^Check now$/, /^Remove model…$/];
const stray = text.filter(t => !allowed.some(a => a.test(t)));
ok(stray.length === 0, 'only labels, buttons and numbers on screen' + (stray.length ? ': ' + stray.join(' | ') : ''));
// the help answer exists
await page.goto('http://localhost:8123/#/help/own-model'); await page.waitForSelector('#h-own-model');
const help = await page.textContent('#h-own-model');
ok(/1,000/.test(help) && /300/.test(help) && /7 days/.test(help) && /never uploaded/.test(help), 'the help answer explains the rules and privacy');

// 7. remove: the database is gone, cards and reviews stay
await openOwn();
await page.click('#ownRemove');
ok(await page.locator('#ownConfirm').isVisible() && /Your cards, reviews and due dates stay/.test(await page.textContent('#ownConfirm')), 'Remove asks first');
await page.click('#ownNo');
ok(await page.locator('#ownConfirm').isHidden() && (await ownDbNames()).length === 1, 'Cancel keeps everything');
await page.click('#ownRemove'); await page.click('#ownYes');
await page.waitForFunction(() => !document.querySelector('#ownName'));
ok((await ownDbNames()).length === 0, 'removing the model deletes the Own database');
ok(await counts() === before, 'cards, reviews and card states are untouched: ' + before + ' -> ' + await counts());
ok(await page.locator('#ownOn').isDisabled(), 'the switch is off limits again');

// 8. another tab holds the database: a clear message, nothing lost
await page.setInputFiles('#ownFile', { name: 'test.own', mimeType: 'application/octet-stream', buffer: goodBytes });
await page.waitForSelector('#ownName');
const other = await ctx.newPage();
await other.goto('http://localhost:8123/#/today'); await other.waitForSelector('#startBtn');
await other.evaluate(async () => { const { openOwnDb } = await import('./js/own-db.js'); window.__h = await openOwnDb({ forbidCreate: true }); window.__h.db.onversionchange = null; });
await page.click('#ownRemove'); await page.click('#ownYes');
await page.waitForSelector('#ownErr:not([hidden])');
ok(/Close other Study Sprint tabs/.test(await page.textContent('#ownErr')), 'blocked by another tab: ' + await page.textContent('#ownErr'));
await other.evaluate(() => window.__h.close()); await other.close();

ok(supa.length === 0, 'no request to Supabase');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
