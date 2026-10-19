// "What's new" after an update: not for new installs, shown once after an update, dismissed for good, never on an empty Today,
// and it fits at 320px in both styles and both modes.
import { realChromium } from './pw.mjs';
import fs from 'node:fs';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const APP = 'http://localhost:8123/';
const VERSION = fs.readFileSync(new URL('../../js/app.js', import.meta.url), 'utf8').match(/const APP_VERSION = '([^']+)'/)[1];
const browser = await realChromium.launch();
const errors = [];
// only the onboarding flag: the What's-new skip flag the other tests carry is absent
const open = async (opts = {}, skipOnboarding = true) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', reducedMotion: 'reduce', ...opts });
  if (skipOnboarding) await ctx.addInitScript(() => { try { localStorage.setItem('study-sprint-skip-onboarding', '1'); } catch { /* fine */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
  return p;
};
const seenOf = p => p.evaluate(async () => (await (await import('./js/db.js')).getSettings()).whatsNewSeen);
const setSeen = (p, v) => p.evaluate(async v => { await (await import('./js/db.js')).setSetting('whatsNewSeen', v); }, v);
const today = async p => { await p.goto(APP + '#/today'); await p.waitForSelector('.today-hero, .empty'); await p.waitForTimeout(200); };

// (a) a new install never sees it
let p = await open();
await p.goto(APP); await p.waitForSelector('.today-hero');
await p.waitForTimeout(200);
ok(await p.locator('.wn').count() === 0, '(a) a fresh install (skip path): no card');
ok(await seenOf(p) === VERSION, '(a) and it is marked as up to date: ' + await seenOf(p));
await p.context().close();
p = await open({}, false);
await p.goto(APP); await p.waitForSelector('#wlSkip'); await p.click('#wlSkip'); await p.waitForSelector('.empty');
ok(await seenOf(p) === VERSION, '(a) the real first run (Skip) is marked up to date too');

// (b) after an update
await p.context().close();
p = await open();
await p.goto(APP); await p.waitForSelector('.today-hero');
await setSeen(p, '4.36');
await today(p); await p.reload(); await p.waitForSelector('.wn');
ok(await p.isVisible('.wn'), '(b) with an older version seen: the card shows');
ok((await p.textContent('#wnTitle')) === `New in Study Sprint ${VERSION}`, '(b) title: ' + await p.textContent('#wnTitle'));
ok(await p.locator('.wn li').count() >= 1, '(b) it lists at least one change');
ok(!!(await p.getAttribute('#wnX', 'aria-label')), '(b) the × has a label');
ok(await p.locator('.inst').count() === 0, '(b) it is not an install card');
ok(await p.locator('.wn[role=alert], .wn[autofocus]').count() === 0 && await p.evaluate(() => !document.activeElement?.closest('.wn')), '(b) it does not take focus');

// (c) Got it
await p.click('#wnOk'); await p.waitForSelector('.wn', { state: 'detached' });
ok(await p.locator('.wn').count() === 0, '(c) Got it removes the card');
ok(await p.evaluate(() => document.activeElement?.id) === 'startBtn', '(c) focus goes to Start: ' + await p.evaluate(() => document.activeElement?.id));
ok(await seenOf(p) === VERSION, '(c) and it is remembered');
await p.reload(); await p.waitForSelector('.today-hero'); await p.waitForTimeout(200);
ok(await p.locator('.wn').count() === 0, '(c) after a reload the card stays away');
// the × does the same
await setSeen(p, '4.36'); await p.reload(); await p.waitForSelector('.wn');
await p.click('#wnX'); await p.waitForSelector('.wn', { state: 'detached' });
ok(await p.locator('.wn').count() === 0 && await seenOf(p) === VERSION, '(c) the × dismisses it for good');

// (d) never recorded: only when there is an entry for this exact version
const hasEntry = await p.evaluate(async v => (await import('./js/whats-new.js')).NOTES.some(n => n.version === v && n.items.length), VERSION);
await setSeen(p, null); await p.reload(); await p.waitForSelector('.today-hero'); await p.waitForTimeout(300);
ok((await p.locator('.wn').count() === 1) === hasEntry, `(d) nothing recorded: the card shows only if NOTES has an entry for ${VERSION} (${hasEntry})`);

// (e) an empty Today
await setSeen(p, '4.36');
await p.evaluate(async () => { const db = await import('./js/db.js'); for (const d of await db.getDecks()) await db.deleteDeck(d.id); });
await p.reload(); await p.waitForSelector('.empty'); await p.waitForTimeout(300);
ok(await p.locator('.wn').count() === 0, '(e) an empty Today never shows it');
await p.context().close();

// (f) 320px, both styles, both modes
for (const [ui, mode] of [['original', 'light'], ['original', 'dark'], ['clinical', 'light'], ['clinical', 'dark']]) {
  p = await open({ viewport: { width: 320, height: 640 } });
  await p.goto(APP); await p.waitForSelector('.today-hero');
  await p.evaluate(async ([ui, mode]) => { const db = await import('./js/db.js'); await db.setSetting('theme', { ui, skin: 'violet', mode, oled: false }); await db.setSetting('whatsNewSeen', '4.36'); }, [ui, mode]);
  await p.reload(); await p.waitForSelector('.wn');
  const m = await p.evaluate(() => ({ w: document.documentElement.scrollWidth <= innerWidth, ok: document.getElementById('wnOk').getBoundingClientRect(), x: document.getElementById('wnX').getBoundingClientRect(), theme: document.documentElement.dataset.theme, ui: document.documentElement.dataset.ui }));
  ok(m.w && m.ui === ui && m.theme === mode, `(f) 320px ${ui} ${mode}: no sideways scroll`);
  ok(m.ok.width >= 24 && m.ok.height >= 24 && m.x.width >= 24 && m.x.height >= 24, `(f) 320px ${ui} ${mode}: Got it ${Math.round(m.ok.height)}px and × ${Math.round(m.x.width)}px are at least 24px`);
  await p.context().close();
}
await browser.close();
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
