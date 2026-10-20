// UI audit, third pass: what the audit's earlier rounds locked in. On a touch phone (coarse pointer): buttons and links are at least 44px tall
// (toolbar icon buttons 40x40), keyboard hints are hidden (and shown with a mouse), and the screens the audit had not reached (picture cards,
// image-occlusion cards and editor, signed-in Sync, Suggest tags with results) do not scroll sideways at 320 and 390px.
// Run with: node tests/browser/run.mjs uiaudit3
import fs from 'node:fs';
import { chromium, sheetSettled } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const APP = 'http://localhost:8123/';
const browser = await chromium.launch({ autoAddCards: true });
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const BIO = JSON.parse(fs.readFileSync(new URL('../fixtures/autotag/biology-mixed.json', import.meta.url), 'utf8')).cards.filter(c => !c.cloze && !c.reverse);

async function open(width, { phone = true, scheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: scheme, serviceWorkers: 'block' });
  await ctx.route(/supabase\.co/, r => r.abort());
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  await p.evaluate(async () => { const db = await import('./js/db.js'); await db.setSetting('whatsNewSeen', '999'); await db.setSetting('fuzz', false); });
  return p;
}
const go = async (p, hash, sel) => { await p.goto(APP + hash); await p.reload(); await p.waitForSelector(sel, { timeout: 15000 }); };
const noSideways = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && (() => { const s = document.getElementById('sheet'); return !s || s.scrollWidth <= s.clientWidth + 1; })()), `no sideways scroll ${what}`);
const sizeOf = (p, sel) => p.locator(sel).first().evaluate(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
const tall = async (p, sel, what) => { const [w, h] = await sizeOf(p, sel); ok(h >= 44, `${what} is at least 44px tall on a touch screen (${w}x${h})`); };
const visibleHints = p => p.evaluate(() => [...document.querySelectorAll('.key-hint, kbd, .hint.keys')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }).map(e => e.textContent.trim().slice(0, 20)));

// ---------- 1. a touch phone: tap targets and keyboard hints ----------
{
  const p = await open(390);
  ok(await p.evaluate(() => matchMedia('(pointer:coarse)').matches && !matchMedia('(hover:hover)').matches), 'the phone context has a coarse pointer and no hover');
  await go(p, '#/today', '.today-hero');
  await tall(p, 'a.brand', 'the Study Sprint header link');
  await tall(p, '.sec-head a.link', '"All decks" on Today');
  await go(p, '#/deck/sample', '.crow');
  for (const [sel, what] of [['#brTags', 'Tools'], ['#brSelect', 'Select'], ['#brAdd', '+ Add card'], ['#back', '‹ Decks'], ['#addExam', 'Add exam date'], ['#testBtn', 'Practice test']]) { ok(await p.locator(sel).count() > 0, `${what} is on the deck page`); await tall(p, sel, what); }
  await go(p, '#/decks', '.deck');
  await tall(p, '.starters > summary', '"Starter decks"');
  { const [w, h] = await sizeOf(p, '.deck .icon-btn'); ok(w >= 40 && h >= 40, `the deck's edit icon is at least 40x40 (${w}x${h})`); }
  await go(p, '#/settings', '#exportBtn');
  await tall(p, '.set-nav a', 'a Settings section chip');
  ok(await p.locator('#oled').count() === 1, 'the OLED black switch is in Settings');
  { const [w, h] = await sizeOf(p, '#oled'); ok(h >= 20 && h <= 32 && w <= 56, `a toggle switch stays pill-sized on a touch screen (${w}x${h})`); }
  await go(p, '#/settings/sync', '#syncEmail'); ok(await p.locator('.pw-show').count() === 1, 'Show password is on the sign-in form'); await tall(p, '.pw-show', 'Show password');
  await go(p, '#/import', '#pasteBox');
  await tall(p, '#tab-paste', 'the Import "Paste" tab');
  await go(p, '#/stats', '.chart');
  await tall(p, '.chart-table > summary', '"Show as table"');
  ok(await p.locator('.chart-table > summary').first().evaluate(e => getComputedStyle(e).display === 'list-item'), '"Show as table" keeps its disclosure triangle');
  // the editor toolbar and Review's top buttons are icon buttons: at least 40x40
  await go(p, '#/deck/sample', '.crow'); await p.locator('.crow').first().click(); await p.waitForSelector('#ceForm');
  { const [w, h] = await sizeOf(p, '.fmt-tools button'); ok(w >= 40 && h >= 40, `an editor toolbar button is at least 40x40 (${w}x${h})`); }
  await p.keyboard.press('Escape'); await sheetSettled(p);
  await go(p, '#/review/sample', '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn'); await p.waitForSelector('#flash');
  for (const sel of ['#endBtn', '#moreBtn', '#scratchBtn']) { const [w, h] = await sizeOf(p, sel); ok(w >= 40 && h >= 40, `Review ${sel} is at least 40x40 (${w}x${h})`); }
  ok((await visibleHints(p)).length === 0, 'no keyboard hints on a touch phone (Review front): ' + (await visibleHints(p)).join(','));
  await p.click('#showBtn'); await p.waitForSelector('.rate');
  ok((await visibleHints(p)).length === 0, 'no keyboard hints on a touch phone (Review back): ' + (await visibleHints(p)).join(','));
  await go(p, '#/play', '#startBtn');
  ok((await visibleHints(p)).length === 0, 'no keyboard hints on a touch phone (Play setup)');
  await p.click('#startBtn'); await p.waitForSelector('#pCard');
  ok((await visibleHints(p)).length === 0, 'no keyboard hints on a touch phone (Play question)');
  // the card actions sheet draws its key letters in the page, and hides them on touch (last: leaving it open, nothing navigates after)
  await go(p, '#/review/sample', '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn'); await p.waitForSelector('#flash');
  await p.click('#moreBtn'); await p.waitForSelector('.act-row');
  ok(await p.locator('.act-row kbd').count() > 0 && (await visibleHints(p)).length === 0, 'no keyboard hints on a touch phone (card actions sheet, which has them in the page)');
  await p.context().close();
}

// ---------- 2. a desktop with a mouse still shows them ----------
{
  const p = await open(1440, { phone: false });
  await go(p, '#/review/sample', '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn'); await p.waitForSelector('#flash');
  ok((await visibleHints(p)).length >= 1, 'keyboard hints show on a desktop (Review): ' + (await visibleHints(p)).join(','));
  await p.context().close();
}

// ---------- 3. the screens the audit had not reached, at 390 and 320 wide ----------
for (const width of [390, 320]) {
  const p = await open(width);
  const seed = await p.evaluate(async () => {
    const db = await import('./js/db.js'), media = await import('./js/media.js'), occ = await import('./js/occlusion.js');
    const pic = async (w, h, hue) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      g.fillStyle = `hsl(${hue},60%,60%)`; g.fillRect(0, 0, w, h); g.fillStyle = '#223'; g.beginPath(); g.ellipse(w / 2, h / 2, w / 4, h / 4, 0, 0, 7); g.fill();
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      return media.addImageInfo(new File([blob], 'p.png', { type: 'image/png' }), { maxSide: media.OCCLUSION_SIDE });
    };
    const now = Date.now(), a = await pic(1600, 1000, 20), b = await pic(900, 1200, 200);
    await db.addDeckWithCards({ id: 'pic', name: 'Anatomy pictures', color: '#E5484D', created: now }, [
      { id: 'pic-0', deckId: 'pic', front: 'Name the labelled chamber of the heart shown in this long diagram caption', back: 'Right atrium', frontImage: a.id, backImage: b.id, tags: [], created: now }]);
    await db.saveDeck({ id: 'occ', name: 'Heart occlusion', color: '#8F80FF', created: now });
    const masks = [{ id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.1, label: 'Aorta' }, { id: 'm2', n: 2, shape: 'ellipse', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }];
    await db.saveNote(occ.planOcclusionSave([], { masks, header: 'Heart anatomy', w: a.width, h: a.height, image: a.id }), { deckId: 'occ', noteId: db.newId(), tags: [] });
    return true;
  });
  ok(seed, `${width}px: picture and occlusion decks made`);
  const review = async deck => { await go(p, '#/review/' + deck, '#startBtn, #flash'); if (await p.$('#startBtn')) await p.click('#startBtn'); await p.waitForSelector('#flash'); await p.waitForTimeout(400); };
  await review('pic'); await noSideways(p, `${width}px: picture card, front`);
  await p.click('#showBtn'); await p.waitForSelector('.rate'); await noSideways(p, `${width}px: picture card, back`);
  await review('occ'); await noSideways(p, `${width}px: occlusion card, front`);
  await p.click('#showBtn'); await p.waitForSelector('.rate'); await noSideways(p, `${width}px: occlusion card, back`);
  await go(p, '#/deck/occ', '.crow'); await p.locator('.crow').first().click(); await p.waitForSelector('#ceOccEdit');
  await noSideways(p, `${width}px: occlusion card editor`);
  await p.click('#ceOccEdit'); await p.waitForSelector('dialog.occ-ed[open]'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog.occ-ed').scrollWidth <= innerWidth), `${width}px: no sideways scroll in the occlusion editor`);
  { const [w, h] = await sizeOf(p, '.occ-ed-tool'); ok(h >= 40 && w >= 40, `${width}px: an occlusion editor tool is at least 40x40 (${w}x${h})`); }
  await p.click('.occ-ed-x');
  await p.waitForFunction(() => !document.querySelector('dialog.occ-ed[open]') || document.querySelector('[data-act=discard]')?.offsetParent);
  if (await p.isVisible('[data-act=discard]')) await p.click('[data-act=discard]');
  await p.waitForFunction(() => !document.querySelector('dialog.occ-ed[open]'));
  await p.keyboard.press('Escape'); await sheetSettled(p);
  // Suggest tags with real results
  await p.evaluate(() => sessionStorage.removeItem('study-sprint-import-draft'));
  await go(p, '#/import', '#pasteBox'); await p.fill('#pasteBox', BIO.map(c => `${c.front} - ${c.back}`).join('\n'));
  await p.waitForSelector('#preview:not([hidden])'); await p.selectOption('#deckSel', '__new'); await p.fill('#newName', 'Biology mixed'); await p.click('#saveBtn'); await p.waitForSelector('.crow');
  await p.click('#deckMore'); await p.click('#autoTag'); await p.waitForSelector('.tag-sugs li', { timeout: 30000 });
  await noSideways(p, `${width}px: Suggest tags with results`);
  { const [w, h] = await sizeOf(p, '.tag-sugs .tag-name'); ok(h >= 44, `${width}px: a suggested tag's name box is at least 44px tall (${w}x${h})`); }
  ok(await p.evaluate(() => { const l = document.querySelector('#tagFolder').getBoundingClientRect(), t = document.querySelector('.tag-sugs').getBoundingClientRect(); return t.top - l.bottom >= 8; }), `${width}px: the tag list is not jammed against the folder box`);
  await p.click('#atCancel'); await sheetSettled(p);
  // signed-in Sync
  await go(p, '#/settings', '#syncEmail');
  await p.fill('#syncEmail', `me${width}@example.com`); await p.fill('#syncPw', 'secret123'); await p.click('#syncCreate');
  await p.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 20000 });
  await noSideways(p, `${width}px: Settings, signed in`);
  await go(p, '#/settings/sync', '#syncStatus'); await noSideways(p, `${width}px: Sync section, signed in`);
  await p.context().close();
}
ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
