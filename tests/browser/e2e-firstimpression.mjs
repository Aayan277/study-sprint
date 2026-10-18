// First impression: the first-run fixes (sample cards that match the promise, an empty Today that is not a dead end),
// the install card (timing, dismissal, hidden when installed), the link-preview tags, and the manifest and icons.
import { chromium, realChromium } from './pw.mjs';
import fs from 'node:fs';
const URL = 'http://localhost:8123/';
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const browser = await chromium.launch();
const real = await realChromium.launch();
const open = async (b, { w = 375, h = 812, ua, init } = {}) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', reducedMotion: 'reduce', ...(ua ? { userAgent: ua } : {}) });
  if (b === real) { /* real first run: no skip flag */ }
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  return p;
};
const fireInstallEvent = p => p.evaluate(() => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  window.__prompted = 0; e.prompt = async () => { window.__prompted++; }; e.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(e);
});
// Finish a Review session: rate one card, then end the session (Review's finish screen), then back to Today.
const finishSession = async p => {
  await p.click('#startBtn'); await p.waitForSelector('#flash, .rv-card');
  await p.keyboard.press('Space'); await p.waitForSelector('.rate'); await p.keyboard.press('3');
  await p.waitForTimeout(150);
  await p.click('#endBtn'); await p.waitForSelector('#againBtn'); await p.click('#againBtn'); await p.waitForSelector('.today-hero');
};

// ---------- D2: the sample cards match the promise ----------
let p = await open(real);
await p.goto(URL); await p.waitForSelector('#wlNext'); await p.click('#wlNext');
await p.fill('#wlName', 'Cell Biology'); await p.click('#wlForm button[type=submit]'); await p.waitForSelector('#wlSample');
const firstOpt = await p.$eval('.wl-opts > :first-child', e => ({ id: e.id, t: e.textContent }));
ok(firstOpt.id === 'wlSample' && /sample cards/i.test(firstOpt.t) && /Fastest/.test(firstOpt.t), 'step 3 puts "Try it with sample cards" first, labelled Fastest');
ok(/psychology/i.test(await p.textContent('#wlSample .wl-opt-d')) && /Cell Biology/.test(await p.textContent('#wlSample .wl-opt-d')), 'the label says the cards are psychology and that the course deck stays ready');
await p.click('#wlSample'); await p.waitForSelector('#showBtn');
for (const r of [1, 3, 4]) { await p.click('#showBtn'); await p.click('.rate.r' + r); await p.waitForTimeout(80); }
await p.waitForSelector('.fr-when');
const when = await p.$$eval('.fr-when li', l => l.map(x => x.textContent));
ok(when.length === 3 && when.every(t => /in \d+ (minutes?|hours?|days?)/.test(t)), 'the done screen shows when each card comes back: ' + JSON.stringify(when));
ok(/in 1 minute/.test(when[0]) && /in 10 minutes/.test(when[1]), 'Again comes back in 1 minute, Good in 10 minutes');
ok((await p.textContent('.fr-next')).includes('Add your Cell Biology cards'), 'it offers "Add your Cell Biology cards"');
const href = await p.getAttribute('#wlAdd', 'href');
const deckId = await p.evaluate(async () => (await (await import('./js/db.js')).getDecks()).find(d => d.name === 'Cell Biology').id);
ok(href === '#/import/' + deckId, 'the button opens Import with Cell Biology chosen');
await p.click('#wlGo'); await p.waitForSelector('.today-hero');
const row = await p.evaluate(() => { const r = [...document.querySelectorAll('.tdeck')].find(x => x.textContent.includes('Cell Biology')); return { cls: r.className, t: r.textContent, href: r.getAttribute('href'), tick: !!r.querySelector('.td-go .ico[viewBox] path[d="M5 12.5l4.5 4.5L19 7.5"]') }; });
ok(/fr-emptydeck/.test(row.cls) && !/done/.test(row.cls) && /Add cards/.test(row.t) && /No cards yet/.test(row.t) && !row.tick, 'an empty course on Today shows "+ Add cards", not a green done tick');
ok(row.href === '#/import/' + deckId, 'and it links to Import for that course');
await p.context().close();

// Skip lands on a helpful empty Today
p = await open(real);
await p.goto(URL); await p.waitForSelector('#wlSkip'); await p.click('#wlSkip'); await p.waitForSelector('.empty');
const txt = await p.textContent('.empty');
ok(/Nothing to study yet/.test(txt) && await p.locator('.empty a:has-text("Paste notes")').isVisible() && await p.locator('#trySample').isVisible() && await p.locator('.fr-how').isVisible(), 'Skip lands on an empty Today with Paste notes, Try sample cards and How it works');
await p.click('.fr-how'); await p.waitForSelector('#wlNext');
ok(p.url().endsWith('#/welcome/again') && !(await p.locator('.tabs').isVisible()), 'How it works re-opens the welcome screen');
await p.click('#wlSkip'); await p.waitForSelector('.empty');
await p.click('#trySample'); await p.waitForSelector('.guide #showBtn');
ok(p.url().endsWith('#/welcome/review/sample') && (await p.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).length)) === 12, 'Try sample cards adds the 12 sample cards and starts the guided review');
for (let i = 0; i < 3; i++) { await p.click('#showBtn'); await p.click('.rate.r3'); await p.waitForTimeout(80); }
await p.waitForSelector('#wlGo');
ok((await p.textContent('.fr-next')).includes('Add your own cards') && (await p.getAttribute('#wlAdd', 'href')) === '#/import', 'with no course, the done screen offers "Add your own cards"');
await p.click('#wlGo'); await p.waitForSelector('.today-hero');
ok(!(await p.content()).includes('fr-emptydeck'), 'the sample deck has cards, so no "Add cards" row');
await p.context().close();

// ---------- D5: the install card ----------
p = await open(browser);
await p.goto(URL); await p.waitForSelector('.today-hero');
await fireInstallEvent(p); await p.waitForTimeout(150);
ok(await p.locator('.inst:not(.remind)').count() === 0, 'install card: not on first paint, even when the browser says the app can be installed');
await finishSession(p);
ok(await p.locator('.inst:not(.remind)').isVisible() && (await p.textContent('.inst')).includes('Install Study Sprint'), 'install card: shows on Today after the first finished Review session');
ok(await p.locator('.inst [data-inst=go]').isVisible() && (await p.textContent('.inst')).includes('Not now'), 'install card: Install and Not now');
ok((await p.getAttribute('.inst-icon', 'src')) === 'icons/icon-192.png', 'install card: uses the app icon');
// the settings row
await p.click('#gearBtn'); await p.waitForSelector('#installRow');
ok(await p.locator('#installBtn').isVisible(), 'Settings has an Install app row with a button');
await p.click('#installBtn'); await p.waitForTimeout(150);
ok(await p.evaluate(() => window.__prompted) === 1, 'the Settings button starts the browser install');
await p.goto(URL + '#/today'); await p.waitForSelector('.today-hero');
await p.evaluate(() => localStorage.removeItem('study-sprint-install-dismissed'));
await p.close();
// dismissal is remembered per device
p = await open(browser);
await p.goto(URL); await p.waitForSelector('.today-hero'); await fireInstallEvent(p);
await finishSession(p);
await p.waitForSelector('.inst');
await p.click('.inst [data-inst=no] >> nth=0');
ok(await p.locator('.inst:not(.remind)').count() === 0, 'install card: Not now closes it');
await p.reload(); await p.waitForSelector('.today-hero'); await fireInstallEvent(p); await p.waitForTimeout(200);
ok(await p.locator('.inst:not(.remind)').count() === 0 && await p.evaluate(() => localStorage.getItem('study-sprint-install-dismissed')) === '1', 'install card: stays closed after a reload (remembered on this device)');
await p.context().close();
// Install button
p = await open(browser);
await p.goto(URL); await p.waitForSelector('.today-hero'); await fireInstallEvent(p);
await finishSession(p); await p.waitForSelector('.inst');
await p.click('.inst [data-inst=go]'); await p.waitForTimeout(200);
ok(await p.evaluate(() => window.__prompted) === 1 && await p.locator('.inst:not(.remind)').count() === 0, 'install card: Install starts the browser install and closes the card');
await p.context().close();
// iPhone Safari: the steps
p = await open(browser, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
await p.goto(URL); await p.waitForSelector('.today-hero');
ok(await p.locator('.inst:not(.remind)').count() === 0, 'iOS: no card on first paint');
await finishSession(p); await p.waitForSelector('.inst');
const ios = await p.textContent('.inst');
ok(/Add to Home Screen/.test(ios) && /Share/.test(ios) && await p.locator('.inst .inst-share svg').count() === 1 && await p.locator('.inst [data-inst=go]').count() === 0, 'iOS Safari: "Add to Home Screen" steps with the Share icon, no Install button');
await p.context().close();
// iPhone Chrome: nothing to offer
p = await open(browser, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1' });
await p.goto(URL); await p.waitForSelector('.today-hero'); await finishSession(p);
ok(await p.locator('.inst:not(.remind)').count() === 0, 'iOS Chrome: no card (only Safari can add to the Home Screen)');
await p.context().close();
// already installed: hidden, in both ways the browser says so
for (const [how, init] of [['navigator.standalone', () => Object.defineProperty(navigator, 'standalone', { value: true })],
  ['display-mode: standalone', () => { const mm = matchMedia.bind(window); window.matchMedia = q => /display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); }]]) {
  p = await open(browser, { init });
  await p.goto(URL); await p.waitForSelector('.today-hero'); await fireInstallEvent(p);
  await finishSession(p); await p.waitForTimeout(200);
  ok(await p.locator('.inst:not(.remind)').count() === 0, 'installed (' + how + '): no install card');
  await p.click('#gearBtn'); await p.waitForSelector('#installRow');
  ok(/installed app/.test(await p.textContent('#installRow')) && await p.locator('#installBtn').count() === 0, 'installed (' + how + '): Settings says so, with no Install button');
  await p.context().close();
}

// ---------- D3, D4: link previews, icons and the manifest ----------
p = await open(browser);
await p.goto(URL); await p.waitForSelector('.today-hero');
const meta = async (sel, attr = 'content') => p.locator(sel).first().getAttribute(attr);
const BASE = 'https://aayan277.github.io/study-sprint/';
const img = await meta('meta[property="og:image"]');
ok(img.startsWith(BASE) && img.endsWith('.png'), 'og:image is an absolute address on the live site: ' + img);
ok(await meta('meta[property="og:url"]') === BASE && await meta('link[rel=canonical]', 'href') === BASE, 'og:url and the canonical link point at the live site');
ok(await meta('meta[property="og:type"]') === 'website' && (await meta('meta[property="og:title"]')).includes('Study Sprint') && (await meta('meta[property="og:description"]')).length > 40, 'og:type, og:title and og:description are there');
ok(await meta('meta[name="twitter:card"]') === 'summary_large_image' && (await meta('meta[name="twitter:image"]')).startsWith(BASE), 'Twitter card is summary_large_image with an absolute image');
ok(/spaced repetition/.test(await meta('meta[name=description]')) && /Works offline/.test(await meta('meta[name=description]')), 'the page description is the sharp one');
// the image itself (served from this folder: the same file the live address will serve)
const og = await (await p.request.get(URL + img.slice(BASE.length))).body();
ok(og.readUInt32BE(16) === 1200 && og.readUInt32BE(20) === 630 && og.length < 300 * 1024, 'the og image is 1200x630 and under 300 KB: ' + Math.round(og.length / 1024) + ' KB');
ok(await meta('link[rel=icon][type="image/svg+xml"]', 'href') === 'icons/favicon.svg' && await p.locator('link[rel=icon][type="image/png"]').count() === 1, 'the SVG favicon and the PNG fallback');
ok((await p.locator('meta[name=theme-color]').evaluateAll(m => m.map(x => x.media).sort().join('|'))) .includes('dark') && await p.locator('meta[name=theme-color]').count() === 2, 'separate dark and light theme-color metas');
ok(await meta('meta[name=apple-mobile-web-app-status-bar-style]') === 'black-translucent', 'iOS status bar is black-translucent');
const png = async path => { const r = await p.request.get(URL + path); const b = await r.body(); return { ok: r.ok(), w: b.readUInt32BE(16), h: b.readUInt32BE(20), sig: b.slice(1, 4).toString() }; };
const man = await (await p.request.get(URL + 'manifest.webmanifest')).json();
ok(!('orientation' in man) && man.background_color === '#08090C' && man.theme_color === '#08090C', 'manifest: no orientation lock, splash colors #08090C');
ok(man.categories.includes('education') && man.display_override.includes('standalone') && /spaced repetition/.test(man.description), 'manifest: categories, display_override and description');
ok(['Review', 'Play', 'Add cards'].every(n => man.shortcuts.some(s => s.short_name === n)), 'manifest: shortcuts Review, Play, Add cards');
ok(man.screenshots.some(s => s.form_factor === 'narrow') && man.screenshots.some(s => s.form_factor === 'wide'), 'manifest: narrow and wide screenshots');
for (const s of man.screenshots) { const r = await png(s.src); ok(r.ok && s.sizes === r.w + 'x' + r.h, 'screenshot ' + s.src + ' exists and is ' + s.sizes); }
for (const purpose of ['any', 'maskable', 'monochrome']) ok(man.icons.some(i => i.purpose === purpose), 'manifest has a "' + purpose + '" icon');
for (const i of man.icons) {
  if (i.type === 'image/png') { const r = await png(i.src); ok(r.ok && r.sig === 'PNG' && i.sizes === r.w + 'x' + r.h, 'icon ' + i.src + ' is reachable and ' + i.sizes); }
  else ok((await p.request.get(URL + i.src)).ok(), 'icon ' + i.src + ' is reachable');
}
ok((await png('icons/apple-touch-icon.png')).w === 180, 'the Apple touch icon is 180x180');
const sw = await (await p.request.get(URL + 'sw.js')).text();
ok(['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon-monochrome-512.png', 'favicon.svg', 'apple-touch-icon.png'].every(f => sw.includes("'icons/" + f + "'")) && sw.includes("'js/install.js'"), 'sw.js saves the icons and install.js for offline');
await p.context().close();

await real.close(); await browser.close();
if (errors.length) { console.log('ERRORS\n' + errors.join('\n')); process.exitCode = 1; }
