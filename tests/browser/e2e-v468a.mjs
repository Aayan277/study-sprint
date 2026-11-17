// 4.68 WP-A: Anki import options sit behind one summary line and a Change link (remembered on this device).
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// The fold starts closed on the first load of this tab only (a reload keeps what the page saved).
await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('t468')) { sessionStorage.setItem('t468', '1'); localStorage.setItem('study-sprint-fold-import-anki', '0'); } } catch { /* no storage */ } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const open = async file => {
  await page.goto('about:blank');          // (a same-page hash change would keep the last file's text on screen)
  await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file'); await page.click('#tab-file');
  await page.setInputFiles('#fileIn', SP + '/files/' + file);
  await page.waitForFunction(f => document.getElementById('fileName')?.textContent === f && /Found \d+ card/.test(document.querySelector('#found')?.textContent || ''), file, { timeout: 30000 });
};

await open('anki-sched-new.apkg');
ok(await page.isVisible('#ankiSum'), 'the summary line shows for an Anki file');
const sum = (await page.textContent('#ankiSumText')).trim();
ok(/^Keeps review history/.test(sum) && !/pictures/.test(sum), 'it says what comes along: ' + sum);
ok(!(await page.isVisible('#importOpts')) && !(await page.isVisible('#progRow')), 'the switches are not visible');
ok((await page.textContent('#ankiChange')).trim() === 'Change' && (await page.getAttribute('#ankiChange', 'aria-expanded')) === 'false' && (await page.getAttribute('#ankiChange', 'aria-controls')) === 'importOpts', 'Change is a labelled toggle, closed');
ok(await page.isVisible('#saveBtn'), 'at 375px the Add button is visible with the options closed');
ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
await page.screenshot({ path: SP + '/v468a-closed-phone.png', fullPage: true });

await page.click('#ankiChange');
ok(await page.isVisible('#progRow') && await page.isVisible('#ankiProg'), 'Change shows the switches');
ok((await page.textContent('#ankiChange')).trim() === 'Done' && (await page.getAttribute('#ankiChange', 'aria-expanded')) === 'true', 'the label becomes Done, aria-expanded is true');
await page.screenshot({ path: SP + '/v468a-open-phone.png', fullPage: true });
await page.reload(); await page.waitForSelector('#tab-file');
await page.click('#tab-file'); await page.setInputFiles('#fileIn', SP + '/files/anki-sched-new.apkg');
await page.waitForFunction(() => /Found \d+ card/.test(document.querySelector('#found')?.textContent || ''), null, { timeout: 30000 });
ok(await page.isVisible('#progRow') && (await page.textContent('#ankiChange')).trim() === 'Done', 'open is remembered after a reload');

// Turning a switch off changes the line.
await page.click('#ankiProg');
ok(/Leaves out review history/.test(await page.textContent('#ankiSumText')), 'turning off the history switch updates the line: ' + await page.textContent('#ankiSumText'));
await page.click('#ankiProg');
ok(!/Leaves out/.test(await page.textContent('#ankiSumText')), 'and turning it on again takes it back');
await page.click('#ankiChange');
ok(!(await page.isVisible('#progRow')) && (await page.textContent('#ankiChange')).trim() === 'Change', 'Done hides the switches again');
await page.reload(); await page.waitForSelector('#tab-file');
await page.click('#tab-file'); await page.setInputFiles('#fileIn', SP + '/files/anki-sched-new.apkg');
await page.waitForFunction(() => /Found \d+ card/.test(document.querySelector('#found')?.textContent || ''), null, { timeout: 30000 });
ok(!(await page.isVisible('#progRow')), 'closed is remembered too');

// Sounds off
await open('anki-sound-new.apkg');
await page.click('#ankiChange');
await page.click('#ankiSounds');
ok(/Leaves out sounds/.test(await page.textContent('#ankiSumText')), 'Bring sounds off: "Leaves out sounds" - ' + await page.textContent('#ankiSumText'));

// Clinical look, desktop
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => document.documentElement.setAttribute('data-ui', 'clinical'));
await page.screenshot({ path: SP + '/v468a-open-clinical-1440.png', fullPage: true });
await page.click('#ankiChange');
await page.screenshot({ path: SP + '/v468a-closed-clinical-1440.png', fullPage: true });
await page.evaluate(() => document.documentElement.removeAttribute('data-ui'));
await page.screenshot({ path: SP + '/v468a-closed-original-1440.png', fullPage: true });
await page.setViewportSize({ width: 375, height: 740 });
await page.evaluate(() => document.documentElement.setAttribute('data-ui', 'clinical'));
await page.screenshot({ path: SP + '/v468a-closed-clinical-phone.png', fullPage: true });
await page.evaluate(() => document.documentElement.removeAttribute('data-ui'));

await open('anki-new.apkg');
ok(/^Keeps pictures/.test(await page.textContent('#ankiSumText')), 'a deck with pictures says so: ' + await page.textContent('#ankiSumText'));

// A CSV import has no summary, and its rows are not behind Change.
await page.goto('about:blank'); await page.goto('http://localhost:8123/#/import'); await page.waitForSelector('#tab-file');
await page.click('#tab-file'); await page.setInputFiles('#fileIn', SP + '/files/quizlet.txt');
await page.waitForFunction(f => document.getElementById('fileName')?.textContent === f && /Found \d+ card/.test(document.querySelector('#found')?.textContent || ''), 'quizlet.txt', { timeout: 30000 });
ok(!(await page.isVisible('#ankiSum')), 'a text import has no summary line');
ok(await page.evaluate(() => !document.getElementById('importOpts').hidden), 'and its switch area is not hidden');
await open('anki-reversed-new.apkg');
ok(await page.evaluate(() => !document.getElementById('revRow').hidden), 'the reverse-cards row exists for the Anki reversed file');

ok(errors.length === 0, 'no page errors ' + errors.join(' | '));
await browser.close();
