import { chromium } from './pw.mjs';
const b = await chromium.launch(); const p = await (await b.newContext({ viewport:{width:375,height:740}, deviceScaleFactor:2 })).newPage();
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await p.goto('http://localhost:8123/#/import'); await p.waitForSelector('#pasteBox');
await p.click('#tab-sheet');
await p.fill('#sheetUrl', 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0');
await p.click('#sheetForm button');
await p.waitForFunction(() => /Found/.test(document.querySelector('#found').textContent) || !document.querySelector('#loadErr').hidden, null, { timeout: 20000 });
console.log('sheets:', (await p.textContent('#found')) || (await p.textContent('#loadErr')));
await p.screenshot({ path: process.argv[2] + '/i3-sheet.png' });
// history: deck list -> import -> save -> back should land on the deck list
await p.click('#tab-paste'); await p.fill('#pasteBox', 'x - y'); await p.waitForSelector('#preview:not([hidden])');
await p.fill('#newName', 'Hist'); await p.click('#saveBtn'); await p.waitForSelector('.crow');
await p.goBack(); await p.waitForTimeout(500);
console.log(p.url().endsWith('#/decks') ? 'PASS back after save goes to decks' : 'FAIL back went to ' + p.url());
await b.close();
