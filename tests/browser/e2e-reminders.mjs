// Reminders, phase 1: the daily-reminder calendar file (download on a computer, Share sheet on a phone), the exam-dates file,
// the app-icon badge (navigator.setAppBadge, stubbed here) and the "Remind me to study?" card on Today.
import fs from 'node:fs';
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const errors = [];
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const watch = page => { page.on('pageerror', e => errors.push('pageerror ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); }); };
// The badge API, recorded (headless Chromium has none). STANDALONE makes the page look like the installed app (the switch only shows there).
const STANDALONE = () => Object.defineProperty(navigator, 'standalone', { get: () => true });
const BADGE = () => { window.__badge = []; navigator.setAppBadge = n => { window.__badge.push(['set', n]); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badge.push(['clear']); return Promise.resolve(); }; };
const badgeCalls = page => page.evaluate(() => window.__badge);

// ---------- desktop: Settings → Study → Reminders ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  await ctx.addInitScript(BADGE); await ctx.addInitScript(STANDALONE);
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/'); await page.waitForSelector('.today-hero');
  ok(await page.locator('#remindSlot .remind').count() === 0, 'no reminder card before a session is finished');
  const startText = (await page.textContent('#startBtn'));
  const due = +/(\d+)\s*cards?/.exec(startText)[1];
  await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#remAdd');
  ok((await page.textContent('#remTitle')).trim() === 'Reminders', 'Settings has a Reminders heading in Study');
  ok(await page.evaluate(() => !!document.querySelector('#studyTitle').closest('section').querySelector('#remTitle')), 'it is inside the Study section');
  ok(await page.locator('#examAdd').count() === 0, 'no exam button without exam dates');
  await page.fill('#remTime', '07:45');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#remAdd')]);
  ok(dl.suggestedFilename() === 'study-sprint-daily-reminder.ics', 'downloads study-sprint-daily-reminder.ics');
  const text = fs.readFileSync(await dl.path(), 'utf8');
  ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(text), 'CRLF line endings');
  ok(text.includes('RRULE:FREQ=DAILY\r\n'), 'repeats daily');
  ok(/DTSTART:\d{8}T074500\r\n/.test(text), 'starts at the chosen time, as a local (floating) time');
  ok(text.includes('TRIGGER:PT0S') && text.includes('BEGIN:VALARM'), 'has an alert at the event time');
  ok(text.includes("SUMMARY:Study Sprint: today's cards"), 'title is Study Sprint: today\'s cards');
  ok(/\r\nUID:daily-[0-9a-f-]+@study-sprint\r\n/.test(text), 'a per-device UID');
  ok(/\r\nURL:http:\/\/localhost:8123\/\r\n/.test(text) && text.includes('Open Study Sprint'), 'links to the app');
  ok(text.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75), 'every line is 75 bytes or less');
  ok(await page.inputValue('#remTime') === '07:45' && (await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).reminderTime)) === '07:45', 'the time is remembered');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll (desktop)');
  // keyboard focus on the time box draws the 2px accent ring (the later :focus rule must not turn it transparent)
  await page.keyboard.press('Tab'); await page.focus('#remTime');
  const ring = await page.evaluate(() => { const e = document.querySelector('#remTime'), s = document.createElement('i'); s.style.color = 'var(--accent)'; document.body.append(s);
    const accent = getComputedStyle(s).color; s.remove(); const c = getComputedStyle(e); return { fv: e.matches(':focus-visible'), color: c.outlineColor, accent, width: c.outlineWidth, style: c.outlineStyle }; });
  // high-contrast mode: an on switch and an off switch must not compute to the same track and knob
  await page.emulateMedia({ forcedColors: 'active' });
  const sw = await page.evaluate(() => { const e = document.querySelector('#appBadge'), was = e.checked, one = () => [getComputedStyle(e).backgroundColor, getComputedStyle(e, '::after').backgroundColor];
    e.checked = false; const off = one(); e.checked = true; const on = one(); e.checked = was; return { off, on }; });
  await page.emulateMedia({ forcedColors: 'none' });
  ok(sw.off[0] !== sw.on[0] && sw.off[1] !== sw.on[1], 'forced colors: an on switch and an off switch look different: ' + JSON.stringify(sw));
  ok(ring.fv && ring.color === ring.accent && ring.width === '2px' && ring.style === 'solid', 'the reminder time box shows the accent focus ring from the keyboard: ' + JSON.stringify(ring));
  await page.screenshot({ path: SP + '/rem-settings-desktop.png', fullPage: true });

  // The badge: off until switched on, then the due count, then cleared when switched off.
  ok((await badgeCalls(page)).every(c => c[0] === 'clear'), 'while the setting is off the badge is never set (only cleared)');
  await page.check('#appBadge');
  await page.waitForFunction(() => window.__badge.length > 0);
  const calls = await badgeCalls(page);
  ok(JSON.stringify(calls.at(-1)) === JSON.stringify(['set', due]), `setAppBadge called with the due count (${due}): ` + JSON.stringify(calls));
  ok((await page.evaluate(async () => (await (await import('./js/db.js')).getSettings()).appBadge)) === true, 'the switch is saved');
  await page.uncheck('#appBadge');
  await page.waitForFunction(() => window.__badge.at(-1)[0] === 'clear');
  ok(true, 'turning it off clears the badge');
  await page.check('#appBadge'); await page.waitForFunction(() => window.__badge.at(-1)[0] === 'set');

  // Nothing is worked out during a round, however many answers there are.
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
  await page.waitForTimeout(2600);
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  const mid = (await badgeCalls(page)).length;
  for (let i = 0; i < 2; i++) { await page.click('#showBtn'); await page.click('.rate.r4'); await page.waitForFunction(() => !document.querySelector('.rate') || document.querySelector('.flash-front')); await page.waitForTimeout(300); }
  await page.waitForTimeout(3000);
  ok((await badgeCalls(page)).length === mid, 'the badge is not recomputed during a round (2 answers, 3 s wait)');
  await page.click('#endBtn'); await page.waitForSelector('#keepBtn');
  await page.goto('http://localhost:8123/#/settings');
  // Reviewing changes the count: after the round the badge follows.
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  await page.click('#showBtn'); await page.click('.rate.r4'); await page.waitForFunction(() => !document.querySelector('.rate'));
  const before = (await badgeCalls(page)).length;
  await page.click('#endBtn'); await page.waitForSelector('#keepBtn');
  await page.waitForFunction(n => window.__badge.length > n, before, { timeout: 8000 });
  ok((await badgeCalls(page)).at(-1)[1] === due - 3, 'after three answers the badge shows three fewer');
  // Leaving the app (page hidden) updates it at once.
  const n2 = (await badgeCalls(page)).length;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(n => window.__badge.length > n, n2, { timeout: 8000 });
  ok(true, 'hiding the app shows the badge again (reading nothing when the data is unchanged)');

  // Exam dates
  await page.evaluate(async () => {
    const db = await import('./js/db.js'); const x = new Date(Date.now() + 20 * 86400000);
    const d = (await db.getDecks())[0];
    await db.saveDeck({ ...d, examDate: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` });
  });
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('.today-hero');
  await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#examAdd');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#examAdd')]);
  const ex = fs.readFileSync(await dl2.path(), 'utf8');
  ok(dl2.suggestedFilename() === 'study-sprint-exams.ics' && /DTSTART;VALUE=DATE:\d{8}\r\n/.test(ex) && ex.includes('TRIGGER:-P2DT15H') && ex.includes('SUMMARY:Exam: '), 'exam file: all-day event with alerts');
  await ctx.close();
}

// ---------- desktop, Clinical style ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(BADGE);          // the API exists but this is a browser tab, not the installed app
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/'); await page.waitForSelector('.today-hero');
  await page.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui: 'clinical', skin: 'violet', mode: 'light', oled: false }); });
  await page.goto('http://localhost:8123/#/settings'); await page.reload(); await page.waitForSelector('#remAdd');
  ok(await page.evaluate(() => document.documentElement.dataset.ui === 'clinical'), 'Clinical style is on');
  await page.locator('#remTitle').scrollIntoViewIfNeeded();
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll (Clinical)');
  ok(await page.locator('#appBadge').count() === 0 && (await page.textContent('#badgeRow')).includes('installed app'), 'in a browser tab the badge switch is replaced by a "works in the installed app" note');
  await page.screenshot({ path: SP + '/rem-settings-clinical.png', fullPage: true });
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  await page.click('#showBtn'); await page.click('.rate.r3'); await page.waitForFunction(() => !document.querySelector('.rate'));
  await page.click('#endBtn'); await page.waitForSelector('#keepBtn');
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#remindSlot .remind');
  await page.locator('#remindSlot').scrollIntoViewIfNeeded();
  await page.screenshot({ path: SP + '/rem-card-clinical.png' });
  await ctx.close();
}

// ---------- phone: Share sheet, and the card on Today ----------
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, acceptDownloads: true });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'setAppBadge', { value: undefined }); Object.defineProperty(navigator, 'clearAppBadge', { value: undefined });          // a browser with no badge API
    window.__shared = [];
    navigator.canShare = d => !!d?.files?.length;
    navigator.share = async d => { window.__shared.push({ name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text(), title: d.title }); };
  });
  const page = await ctx.newPage(); watch(page);
  let downloads = 0; page.on('download', () => downloads++);
  await page.goto('http://localhost:8123/'); await page.waitForSelector('.today-hero');
  ok(await page.locator('#remindSlot .remind').count() === 0, 'phone: no card on the first visit');
  
  await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#remAdd');
  ok(await page.locator('#badgeRow').count() === 0, 'a browser without a badge API shows no badge row');
  await page.fill('#remTime', '20:15');
  await page.click('#remAdd');
  await page.waitForFunction(() => window.__shared.length === 1);
  const sh = await page.evaluate(() => window.__shared[0]);
  ok(sh.name === 'study-sprint-daily-reminder.ics' && sh.type === 'text/calendar' && sh.text.includes('DTSTART:') && sh.text.includes('T201500') && sh.text.includes('RRULE:FREQ=DAILY'), 'phone: the file goes to the Share sheet');
  ok(downloads === 0, 'phone: nothing is downloaded when sharing works');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll (phone settings)');
  await page.screenshot({ path: SP + '/rem-settings-phone.png', fullPage: true });

  // Finish a session: the card appears once.
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#startBtn');
  await page.evaluate(() => localStorage.removeItem('study-sprint-remind-dismissed'));       // (the Settings button above counts as having a reminder)
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  await page.click('#showBtn'); await page.click('.rate.r4'); await page.waitForFunction(() => !document.querySelector('.rate'));
  await page.click('#endBtn'); await page.waitForSelector('#keepBtn');
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('#remindSlot .remind');
  ok((await page.textContent('#remindSlot')).includes('Remind me to study?'), 'phone: the card shows after the first finished session');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll (phone card)');
  const [bg, bn] = await Promise.all([page.locator('[data-remind=go]').boundingBox(), page.locator('.inst-btns [data-remind=no]').boundingBox()]);
  ok(Math.abs(bg.y - bn.y) < 4, 'phone: Add and Not now are on one row');
  await page.screenshot({ path: SP + '/rem-card-phone.png' });
  await page.click('[data-remind=no] >> nth=0');
  ok(await page.locator('#remindSlot .remind').count() === 0, 'Not now hides it');
  await page.reload(); await page.waitForSelector('.today-hero');
  ok(await page.locator('#remindSlot .remind').count() === 0, 'and it stays hidden after a reload');
  await ctx.close();
}
{
  // The card's own button.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page);
  await page.goto('http://localhost:8123/'); await page.waitForSelector('#startBtn');
  await page.click('#startBtn'); await page.waitForSelector('#flash');
  await page.click('#showBtn'); await page.click('.rate.r3'); await page.waitForFunction(() => !document.querySelector('.rate'));
  await page.click('#endBtn'); await page.waitForSelector('#keepBtn');
  await page.goto('http://localhost:8123/#/today'); await page.waitForSelector('.today-hero');
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) })));
  await page.waitForSelector('.inst:not(.remind)');
  ok(await page.locator('#remindSlot .remind').count() === 0, 'the reminder card stays hidden while the install card shows');
  await page.click('.inst:not(.remind) [data-inst=no] >> nth=0');
  await page.waitForTimeout(300);
  ok(await page.locator('#remindSlot .remind').count() === 0, 'and does not pop up the moment the install card is dismissed');
  await page.reload(); await page.waitForSelector('#remindSlot .remind');
  ok(true, 'it shows on the next visit');
  await page.screenshot({ path: SP + '/rem-card-desktop.png' });
  await page.fill('#remindTime', '06:30');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-remind=go]')]);
  ok(/DTSTART:\d{8}T063000/.test(fs.readFileSync(await dl.path(), 'utf8')), 'the card adds the reminder at its time');
  ok(await page.locator('#remindSlot .remind').count() === 0, 'and then goes away');
  await ctx.close();
}

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
