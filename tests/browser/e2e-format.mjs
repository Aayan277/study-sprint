import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const card = (p, id) => p.evaluate(async i => (await import('./js/db.js')).get('cards', i), id);

// ---------- phone: toolbar + preview ----------
let p = await (await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', isMobile: true, hasTouch: true })).newPage();
p.on('pageerror', e => errors.push(e.stack));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(0).click(); await p.waitForSelector('#ceBack');
ok(await p.evaluate(() => document.querySelector('#ceBack').tagName) === 'TEXTAREA', 'phone: a plain text box with buttons');
await p.fill('#ceBack', 'Learning by pairing\nneutral stimulus\nresponse');
await p.evaluate(() => { const t = document.querySelector('#ceBack'); t.focus(); t.setSelectionRange(12, 19); });   // "pairing"
await p.click('[data-fmt=bold][data-for=ceBack]');
ok(await p.inputValue('#ceBack') === 'Learning by **pairing**\nneutral stimulus\nresponse', 'B wraps the selection');
await p.evaluate(() => { const t = document.querySelector('#ceBack'); t.setSelectionRange(26, 50); });               // the last two lines
await p.click('[data-fmt=list][data-for=ceBack]');
ok(await p.inputValue('#ceBack') === 'Learning by **pairing**\n- neutral stimulus\n- response', '• makes the selected lines a list');
ok((await p.innerHTML('#ceBackPrev')) === 'Learning by <b>pairing</b><ul><li>neutral stimulus</li><li>response</li></ul>' && await p.isVisible('#ceBackPrev'), 'preview shows the formatting');
await p.screenshot({ path: SP + '/fmt-phone.png' });
await p.click('#ceForm button[type=submit]'); await p.waitForTimeout(400);
ok((await card(p, 'sample-0')).back === 'Learning by **pairing**\n- neutral stimulus\n- response', 'saved as marks');
ok((await p.locator('.crow').nth(0).locator('.b').textContent()).startsWith('Learning by pairing'), 'list row shows plain text');
// a short bold answer, typed plainly in Review
await p.evaluate(async () => { const db = await import('./js/db.js'); const c = await db.get('cards', 'sample-1'); await db.saveCards([{ ...c, front: 'Opposite of *hot*?', back: '**cold**' }]); });
await p.evaluate(async () => (await import('./js/db.js')).setSetting('reviewTyping', true));
await p.goto('http://localhost:8123/#/review'); await p.waitForSelector('#startBtn'); await p.click('#startBtn'); await p.waitForSelector('.flash');
for (let i = 0; i < 12 && !(await p.textContent('.flash-front')).includes('Opposite'); i++) {
  if (await p.$('#typeIn')) { await p.click('#showBtn'); } else { await p.keyboard.press(' '); }
  await p.waitForSelector('.rate'); await p.keyboard.press('3'); await p.waitForTimeout(150);
}
ok((await p.innerHTML('.flash-front')) === 'Opposite of <i>hot</i>?', 'Review shows the formatting on the card');
await p.fill('#typeIn', 'cold'); await p.press('#typeIn', 'Enter'); await p.waitForSelector('.typed');
ok((await p.textContent('.typed')).includes('Correct') && (await p.innerHTML('.flash-back')) === '<b>cold</b>', 'typing "cold" is right for a bold answer');
await p.keyboard.press('3');
// Play shows plain text
await p.goto('http://localhost:8123/#/play'); await p.waitForSelector('#startBtn');
await p.$eval('input[name=qtype][value=front]', el => el.click());
await p.click('#startBtn'); await p.waitForSelector('#pCard');
let seenStar = false;
for (let i = 0; i < 8; i++) {
  const txt = (await p.textContent('#pPrompt')) + (await p.$$eval('.opt .lbl', o => o.map(x => x.textContent).join('|')));
  if (txt.includes('*') || /^- /m.test(txt)) seenStar = true;
  await p.keyboard.press('1'); await p.waitForSelector('#nextBtn'); await p.click('#nextBtn').catch(() => {}); await p.waitForTimeout(150);
}
ok(!seenStar, 'Play shows plain text, no marks');
await p.click('#quitBtn').catch(() => {});

// ---------- computer: Word-style box ----------
p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })).newPage();
p.on('pageerror', e => errors.push(e.stack));
await p.goto('http://localhost:8123/#/decks'); await p.waitForSelector('.deck');
await p.goto('http://localhost:8123/#/deck/sample'); await p.waitForSelector('.crow');
await p.locator('.crow').nth(2).click(); await p.waitForSelector('#ceBack');
ok(await p.evaluate(() => document.querySelector('#ceBack').isContentEditable), 'computer: a Word-style box');
await p.click('#ceBack');
await p.keyboard.press('Control+a'); await p.keyboard.type('Removing something ');
await p.keyboard.press('Control+b'); await p.keyboard.type('unpleasant'); await p.keyboard.press('Control+b');
await p.keyboard.type(' to make a behavior ');
await p.keyboard.press('Control+i'); await p.keyboard.type('more'); await p.keyboard.press('Control+i');
await p.keyboard.type(' likely');
ok((await p.innerHTML('#ceBack')).includes('<b>unpleasant</b>'), 'Ctrl+B makes text bold as you type');
// paste with styling from another site: plain text only
await p.evaluate(() => {
  const el = document.querySelector('#ceBack'); el.focus();
  const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
  const dt = new DataTransfer(); dt.setData('text/html', '<span style="color:red;font-size:40px">.</span>'); dt.setData('text/plain', '.');
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
ok(!(await p.innerHTML('#ceBack')).includes('color'), 'pasting brings in plain text only');
await p.screenshot({ path: SP + '/fmt-desktop.png' });
await p.click('#ceForm button[type=submit]'); await p.waitForTimeout(400);
ok((await card(p, 'sample-2')).back === 'Removing something **unpleasant** to make a behavior *more* likely.', 'saved as marks: ' + (await card(p, 'sample-2')).back);
// the bullet button in the Word-style box
await p.click('#ceBack'); await p.keyboard.press('Control+a'); await p.keyboard.type('one');
await p.click('[data-fmt=list][data-for=ceBack]');
await p.keyboard.press('End'); await p.keyboard.press('Enter'); await p.keyboard.type('two');
await p.click('#ceForm button[type=submit]'); await p.waitForTimeout(400);
ok((await card(p, 'sample-2')).back === '- one\n- two', 'bullet list saved as marks: ' + JSON.stringify((await card(p, 'sample-2')).back));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
