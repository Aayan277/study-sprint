// The Own trust test in Settings: the switch needs Own switched on, FSRS-6 and 90% desired retention (otherwise it is off limits and one
// short warning line says why); turning it on shows the results table (labels and numbers) with both groups; turning it off keeps the table;
// the ? link goes to its help answer; every control has a name. The model file is built here, at test time. Nothing reaches the network.
import { chromium } from './pw.mjs';
import { writeOwnFile } from '../../js/own-file.js';
import { initParams } from '../../js/own-model.js';

const goodBytes = Buffer.from(writeOwnFile({ size: 's', params: Float32Array.from(initParams('s', 3)), trainedOn: [{ id: 'sim-v1', licence: 'ours' }], seed: 3, gitStamp: 'test', createdAt: '2026-11-06T00:00:00.000Z' }));
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [], supa = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror ' + e.message));
await ctx.route('**/*.supabase.co/**', r => { supa.push(r.request().url()); r.abort(); });
const setSetting = (k, v) => page.evaluate(async ([k, v]) => { const db = await import('./js/db.js'); await db.setSetting(k, v); }, [k, v]);
const openOwn = async (wait = true) => {
  await page.goto('http://localhost:8123/#/settings'); await page.reload(); await page.waitForSelector('#advanced');
  await page.evaluate(() => { document.getElementById('advanced').open = true; });
  const open = await page.evaluate(() => document.getElementById('ownSection').open);
  if (!open) await page.click('#ownSection > summary');
  await page.waitForSelector('#ownLoad');
  if (wait) await page.waitForSelector('#ownTrust');
};

await openOwn(false);
await page.setInputFiles('#ownFile', { name: 'test.own', mimeType: 'application/octet-stream', buffer: goodBytes });
await page.waitForSelector('#ownName');
await page.waitForSelector('#ownTrust');

// off limits while Own is off
ok(await page.locator('#ownTrust').isDisabled(), 'the trust switch is off limits while Own is off');
ok(await page.locator('#ownTrustTable').count() === 0, 'no results table before the test has ever run');
await page.check('#ownOn');
await page.waitForFunction(() => document.querySelector('#ownOn').checked && !document.querySelector('#ownOn').disabled);
await page.waitForFunction(() => !document.querySelector('#ownTrust').disabled);
ok(await page.locator('#ownTrustWarn').count() === 0, 'FSRS-6 at 90% (the default): no warning');

// on: the table
await page.check('#ownTrust');
await page.waitForSelector('#ownTrustTable');
await page.waitForFunction(() => document.querySelector('#ownTrust').checked && !document.querySelector('#ownTrust').disabled);
const rows = await page.$$eval('#ownTrustTable tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent.trim())));
ok(rows.length === 2 && rows[0][0] === 'Trust rule' && rows[1][0] === 'FSRS-6', 'the table has both groups: ' + JSON.stringify(rows));
ok(rows.every(r => r.length === 5 && r[1] === '0' && r[2] === '0' && r[3] === '–' && r[4] === '–'), 'a new test shows zeros and dashes');
const heads = await page.$$eval('#ownTrustTable thead th', ths => ths.map(t => t.textContent.trim()));
ok(/Cards/.test(heads.join()) && /Reviews/.test(heads.join()) && /Pass rate/.test(heads.join()) && /per card per week/.test(heads.join()), 'column names: ' + heads.join(' | '));
ok(/^\d+\.\d$/.test(await page.textContent('#ownTrustDays')), 'days running shows: ' + await page.textContent('#ownTrustDays'));
ok(await page.getAttribute('#ownBody a[href="#/help/own-trust-test"]', 'aria-label') === 'About the trust test', 'the ? link is named and goes to the trust test answer');

// the numbers come from the review log: write rows with an arm and look again
await page.evaluate(async () => {
  const db = await import('./js/db.js'), now = Date.now(), st = (await db.getAll('cardStates'))[0];
  void st;
  const mk = (arm, cardId, rating) => ({ cardId, timestamp: now, source: 'review', mode: 'flip', correct: rating > 1, ms: 3000, rating, state: 2, arm, due: now - 3 * 86400000 });
  for (const l of [mk('trust', 'x1', 3), mk('trust', 'x2', 1), mk('fsrs', 'x3', 4)]) await db.addLog(l);
});
await openOwn();
const rows2 = await page.$$eval('#ownTrustTable tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent.trim())));
ok(rows2[0][1] === '2' && rows2[0][2] === '2' && rows2[0][3] === '50.0%', 'trust group counts its cards, reviews and pass rate: ' + JSON.stringify(rows2[0]));
ok(rows2[1][1] === '1' && rows2[1][2] === '1' && rows2[1][3] === '100.0%', 'FSRS-6 group too: ' + JSON.stringify(rows2[1]));

// no helper text: only labels, buttons and numbers
await page.addStyleTag({ content: '#ownBody .sr-only{display:none!important}' });
const sentences = await page.$$eval('#ownBody p', els => els.filter(e => e.offsetParent !== null).map(e => e.id || e.className));
ok(sentences.length === 0, 'no sentences while all is well: ' + sentences);
const names = await page.$$eval('#ownBody button, #ownBody input, #ownBody a', els => els.map(e => ({ id: e.id || e.className, name: e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].textContent.trim()) || e.textContent.trim() })));
ok(names.every(n => n.name), 'every control has a name: ' + names.map(n => n.name).join(' | '));

// off: the table stays, the switch is clear
await page.uncheck('#ownTrust');
await page.waitForFunction(() => !document.querySelector('#ownTrust').checked && !document.querySelector('#ownTrust').disabled);
ok(await page.locator('#ownTrustTable').count() === 1, 'switching off keeps the results');
await openOwn();
ok(!(await page.locator('#ownTrust').isChecked()) && await page.locator('#ownTrustTable').count() === 1, 'off and the table are remembered after a reload');
await page.check('#ownTrust');
await page.waitForFunction(() => document.querySelector('#ownTrust').checked && !document.querySelector('#ownTrust').disabled);
// the settings stop qualifying while the test is on: the switch stays usable to turn it off, and one warning says why
await setSetting('targetRetention', 0.85);
await openOwn();
ok(await page.locator('#ownTrust').isEnabled() && await page.locator('#ownTrust').isChecked(), 'at 85% with the test on, the switch can still be turned off');
ok(/Needs FSRS-6 at 90% desired retention\./.test(await page.textContent('#ownTrustWarn')), 'one warning says why: ' + await page.textContent('#ownTrustWarn'));
await page.uncheck('#ownTrust');
await page.waitForFunction(() => !document.querySelector('#ownTrust').checked);
await openOwn();
ok(await page.locator('#ownTrust').isDisabled() && await page.locator('#ownTrustWarn').count() === 0, 'off at 85%: the switch is off limits and there is no red line');
await setSetting('targetRetention', 0.9); await setSetting('fsrsVersion', 7);
await openOwn();
ok(await page.locator('#ownTrust').isDisabled() && await page.locator('#ownTrustWarn').count() === 0, 'with FSRS-7 it is off limits too');
await setSetting('fsrsVersion', 6);

// the help answer
await page.goto('http://localhost:8123/#/help/own-trust-test'); await page.waitForSelector('#h-own-trust-test');
const help = await page.textContent('#h-own-trust-test');
ok(/experiment/i.test(help) && /half/.test(help) && /couple of months/.test(help), 'the help answer explains the test');

ok(supa.length === 0, 'no request to Supabase');
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
