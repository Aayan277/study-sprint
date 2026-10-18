import { chromium } from './pw.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.stack));
await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
const note = async () => { await page.goto('about:blank'); await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#backupNote'); return { text: await page.textContent('#backupNote'), warn: await page.$eval('#backupNote', e => e.classList.contains('warn')) }; };
// few cards (the sample deck is under 50): a plain line, no nudge
let n = await note();
ok(n.text === 'No backup yet on this device.' && !n.warn, 'few cards, no backup: plain line: ' + n.text);
// 60 cards and still no backup: the nudge
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'big', name: 'Big', color: '#46A758', created: Date.now() },
    Array.from({ length: 60 }, (_, i) => ({ id: 'b' + i, deckId: 'big', front: 'Q' + i, back: 'A' + i, tags: [], created: i })));
});
n = await note();
ok(n.warn && /^No backup yet on this device\. .*backup file/.test(n.text), 'many cards, no backup: nudge: ' + n.text);
// exporting clears it
await page.click('#exportBtn');
await page.waitForFunction(() => document.querySelector('#backupNote')?.textContent.startsWith('Last backup: today'));
ok(!(await page.$eval('#backupNote', e => e.classList.contains('warn'))), 'after Export backup: "Last backup: today", no nudge');
// 40 days later: nudge again; and the backup file does not carry the date
await page.evaluate(async () => (await import('./js/db.js')).setSetting('lastBackup', Date.now() - 40 * 864e5));
n = await note();
ok(n.warn && n.text.startsWith('Last backup: 40 days ago.'), '40 days old: nudge: ' + n.text);
const inFile = await page.evaluate(async () => Object.hasOwn((await (await import('./js/db.js')).exportAll({ sounds: true })).settings, 'lastBackup'));
ok(!inFile, 'lastBackup is not written into the backup file');
// restoring an old backup that carries a lastBackup keeps this device's own date
const kept = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const mine = Date.now() - 5 * 864e5;
  await db.setSetting('lastBackup', mine);
  const data = await db.exportAll({ sounds: true });
  data.settings.lastBackup = 123;
  await db.importAll(data);
  return (await db.getSettings()).lastBackup === mine;
});
ok(kept, 'restoring a backup keeps this device\'s own lastBackup');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
