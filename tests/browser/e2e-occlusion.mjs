// Image occlusion (stage 1) in a real browser: the 2048px picture, saving a note, Review (front, zoom, flip, peek, typing),
// Browse (badge, editing a label), Play, importing Anki's occlusion notes, export and back, backups and syncing.
// Run with: node tests/browser/run.mjs occlusion
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const URL = 'http://localhost:8123/';
const noSideways = async (p, what) => ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scroll ${what}`);

await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');

// ---- 1. the picture: 2048px for occlusion, 1280px for everything else ----
const big = await page.evaluate(async () => {
  const media = await import('./js/media.js');
  const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 3000, 2000); grad.addColorStop(0, '#f6d365'); grad.addColorStop(1, '#fda085');
  g.fillStyle = grad; g.fillRect(0, 0, 3000, 2000);
  g.fillStyle = '#222'; g.font = '200px sans-serif'; g.fillText('Heart', 1000, 1000);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'heart.png', { type: 'image/png' });
  const a = await media.processImage(file, { maxSide: media.OCCLUSION_SIDE });
  const b = await media.processImage(file);
  const info = await media.addImageInfo(file, { maxSide: media.OCCLUSION_SIDE });
  const db = await import('./js/db.js');
  const stored = await db.getMedia(info.id);
  return { a: [a.width, a.height, a.srcWidth, a.srcHeight], b: [b.width, b.height, b.srcWidth], info, type: stored.type, side: media.OCCLUSION_SIDE };
});
ok(big.a.join() === '2048,1365,3000,2000', 'a 3000×2000 picture is kept at 2048×1365 and reports its source size ' + big.a.join('x'));
ok(big.b[0] === 1280 && big.b[1] === 853 && big.b[2] === 3000, 'without the option the limit is still 1280');
ok(big.info.width === 2048 && big.info.height === 1365 && !!big.info.id && big.type === 'image/jpeg', 'addImageInfo returns the id and the saved size');

// ---- 2. a note of three groups, saved the way the editor will ----
const seed = await page.evaluate(async big => {
  const db = await import('./js/db.js'), occ = await import('./js/occlusion.js');
  const deck = { id: db.newId(), name: 'Heart', color: '#8F80FF', created: Date.now() };
  await db.saveDeck(deck);
  const noteId = db.newId();
  const masks = [
    { id: 'm1', n: 1, shape: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.1, label: 'Aorta' },
    { id: 'm2', n: 2, shape: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, label: 'Left ventricle' },
    { id: 'm3', n: 2, shape: 'ellipse', x: 0.75, y: 0.1, w: 0.2, h: 0.2 },
    { id: 'm4', n: 3, shape: 'polygon', x: 0.1, y: 0.6, w: 0.3, h: 0.3, points: [[0.1, 0.9], [0.4, 0.9], [0.25, 0.6]] }];
  const plan = occ.planOcclusionSave([], { masks, header: 'Heart anatomy', w: big.info.width, h: big.info.height, image: big.info.id });
  await db.saveNote(plan, { deckId: deck.id, noteId, tags: ['anatomy'], noteExtra: 'Blood leaves here' });
  const cards = (await db.getAll('cards')).filter(c => c.noteId === noteId).sort((a, b) => a.occlusion.n - b.occlusion.n);
  return { deckId: deck.id, noteId, ids: cards.map(c => c.id), fronts: cards.map(c => c.front), backs: cards.map(c => c.back), extra: cards.map(c => c.noteExtra), w: cards[0].occlusion.w, backImage: cards.every(c => c.backImage === big.info.id) };
}, big);
ok(seed.ids.length === 3 && seed.fronts[1] === 'Heart anatomy: hidden part 2 of 3' && seed.backs.join('|') === 'Aorta|Left ventricle|' && seed.w === 2048 && seed.backImage, 'saved 3 sibling cards with fallback front/back, the picture in backImage and w 2048');

// ---- 3. Review ----
await page.goto(URL + '#/today'); await page.waitForSelector('.tdeck');
await page.locator(`[data-start="${seed.deckId}"]`).click(); await page.waitForSelector('#flash');
ok((await page.textContent('.rv-counts .c-new')) === '1', 'Review shows 1 of the 3 siblings (one a day)');
await page.waitForSelector('.rv-front .occ-img[src]', { timeout: 5000 });
const first = await page.evaluate(() => { const c = document.querySelector('.rv-front .occ'); return { aria: c.getAttribute('aria-label'), ask: [...c.querySelectorAll('.occ-ask')].map(e => e.getAttribute('aria-label')), hidden: c.querySelectorAll('.occ-mask[aria-hidden=true]').length, ar: c.style.aspectRatio, w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height }; });
ok(first.aria === 'Heart anatomy: 3 hidden parts' && first.ask.length >= 1 && first.ask.every(a => /^Hidden part \d of 3: name this part$/.test(a)), 'front: the picture is a group, the asked box has an accessible name ' + first.ask.join('; '));
ok(first.hidden === 4 - first.ask.length && near(first.w / first.h, 2048 / 1365, 0.02), 'front: the other boxes are hidden from screen readers, and the box has the picture\'s shape');
const nowN = +first.ask[0].match(/part (\d)/)[1];
// the boxes sit where their % says (within 1px) on the picture
const rects = await page.evaluate(() => { const fig = document.querySelector('.rv-front .occ').getBoundingClientRect(); return [...document.querySelectorAll('.rv-front .occ-mask')].map(m => { const r = m.getBoundingClientRect(); return [(r.left - fig.left) / fig.width, (r.top - fig.top) / fig.height, r.width / fig.width, r.height / fig.height, fig.width, fig.height]; }); });
const want = [[0.1, 0.2, 0.2, 0.1], [0.5, 0.5, 0.2, 0.2], [0.75, 0.1, 0.2, 0.2], [0.1, 0.6, 0.3, 0.3]];
ok(rects.length === 4 && rects.every((r, i) => want[i].every((v, k) => near(r[k] * (k % 2 ? r[5] : r[4]), v * (k % 2 ? r[5] : r[4]), 1))), 'each box matches its percentages within 1px');
await page.screenshot({ path: SP + '/occ-review-front-375.png' });
await noSideways(page, 'in Review (front)');

// the zoom button opens the viewer and does not flip the card
await page.click('.rv-front .occ-zoom');
await page.waitForSelector('dialog.occ-view[open]');
ok(await page.locator('.rv-front').evaluate(e => !e.inert) && !(await page.locator('#flash').evaluate(e => e.classList.contains('flipped'))), 'zoom opens the viewer and the card does not flip');
ok(await page.locator('dialog.occ-view .occ-zoom').count() === 0 && await page.locator('dialog.occ-view .occ-mask').count() === 4, 'the viewer shows the same boxes, without its own zoom button');
await page.screenshot({ path: SP + '/occ-zoom-375.png' });
await noSideways(page, 'with the viewer open');
const z0 = await page.locator('.occ-view-canvas').evaluate(e => getComputedStyle(e).getPropertyValue('--s'));
await page.click('[data-z=in]');
const z1 = await page.locator('.occ-view-canvas').evaluate(e => getComputedStyle(e).getPropertyValue('--s'));
ok(+z0 === 1 && +z1 > 1.4, `the + button zooms (${z0} → ${z1})`);
await page.keyboard.press('0');
ok(+(await page.locator('.occ-view-canvas').evaluate(e => getComputedStyle(e).getPropertyValue('--s'))) === 1, '0 fits the picture again');
await page.keyboard.press('Space');                       // Review's keys are ignored while the viewer is open
ok(!(await page.locator('#flash').evaluate(e => e.classList.contains('flipped'))), 'Review keys are ignored while the viewer is open');
await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.occ-view'));
ok(await page.evaluate(() => document.activeElement?.classList.contains('occ-zoom')), 'closing the viewer puts focus back on the zoom button');

// two-finger pinch with real touch input (CDP)
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
await page.keyboard.press('z'); await page.waitForSelector('dialog.occ-view[open]');
{
  const st = await page.locator('.occ-view-stage').boundingBox();
  const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 30 - i * 12, cy], [cx + 30 + i * 12, cy]]);
  await touch('touchEnd', []);
  const s = +(await page.locator('.occ-view-canvas').evaluate(e => getComputedStyle(e).getPropertyValue('--s')));
  ok(s > 2, `a two-finger pinch zooms (${s.toFixed(2)}×)`);
  // one finger drags it
  const before = await page.locator('.occ-view-canvas').evaluate(e => e.style.transform);
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - i * 10, cy - i * 5]]);
  await touch('touchEnd', []);
  ok(before !== await page.locator('.occ-view-canvas').evaluate(e => e.style.transform), 'one finger moves a zoomed picture');
}
await page.click('[data-close]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-view'));

// flip: the box is uncovered, the others stay covered, the label shows
await page.click('.rv-front .flash-hint');
await page.waitForFunction(() => document.querySelector('#flash').classList.contains('flipped'));
const back = await page.evaluate(() => { const b = document.querySelector('.rv-back'); return { reveal: b.querySelectorAll('.occ-reveal').length, covered: b.querySelectorAll('.occ-mask:not(.occ-reveal)').length, label: b.querySelector('.occ-label').textContent, extra: b.querySelector('.flash-extra')?.textContent, inert: document.querySelector('.rv-front').inert, aria: b.querySelector('.occ-reveal')?.getAttribute('aria-label') }; });
ok(back.reveal >= 1 && back.reveal + back.covered === 4 && back.covered >= 1, 'back: only the asked box is uncovered, the others stay covered');
ok(back.extra === 'Blood leaves here' && back.inert === true, 'back: the note\'s Extra shows, and the front is inert');
ok(back.label === (nowN === 1 ? 'Aorta' : nowN === 2 ? 'Left ventricle' : 'No label') && /^(Answer: |Uncovered part)/.test(back.aria), 'back: the label (or "No label") and the box\'s accessible name: ' + back.label + ' / ' + back.aria);
await page.waitForTimeout(500);
await page.screenshot({ path: SP + '/occ-review-back-375.png' });
await noSideways(page, 'in Review (back)');
// peek
await page.click('.rv-back .occ-peek');
ok(await page.locator('.rv-back .occ').evaluate(e => e.classList.contains('peek')) && (await page.locator('.rv-back .occ-peek').getAttribute('aria-pressed')) === 'true', 'Show whole picture uncovers every box (aria-pressed)');
ok(await page.evaluate(() => [...document.querySelectorAll('.rv-back .occ-mask:not(.occ-reveal)')].every(m => getComputedStyle(m).opacity === '0')), '... and the covers are gone');
await page.keyboard.press('m');
ok((await page.locator('.rv-back .occ-peek').getAttribute('aria-pressed')) === 'false', 'M toggles it back');
// rating ends the session (one sibling a day)
await page.keyboard.press('4'); await page.waitForSelector('.stats4');
ok((await page.textContent('.stats4')).includes('1'), 'rated: the other two siblings wait for tomorrow');

// typed answers only for labelled boxes
await page.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', true); });
await page.goto(URL + '#/today'); await page.waitForSelector('.tdeck');
const d5 = new Date(Date.now() + 5 * 864e5), ymd = `${d5.getFullYear()}-${String(d5.getMonth() + 1).padStart(2, '0')}-${String(d5.getDate()).padStart(2, '0')}`;
await page.evaluate(async ([deckId, ymd]) => {
  const db = await import('./js/db.js'), sd = await import('./js/study-data.js');
  for (const c of (await db.getAll('cards')).filter(c => c.deckId === deckId && c.occlusion)) await db.clearStates([c.id]);
  await db.saveDeck({ ...(await db.getDeck(deckId)), examDate: ymd });
  sd.launchStudy({ deckIds: [deckId], deckId, kind: 'prep' });      // Exam prep shows every sibling
}, [seed.deckId, ymd]);
await page.waitForSelector('#flash');
// walk through the siblings: whichever shows, typing is offered exactly when it has a label
const seen = new Set();
for (let i = 0; i < 3; i++) {
  await page.waitForSelector('#flash');
  const info = await page.evaluate(() => ({ label: document.querySelector('.rv-back .occ-label')?.textContent, typed: !!document.getElementById('typeIn'), note: document.getElementById('longNote')?.textContent || '' }));
  seen.add(info.label + '|' + info.typed + '|' + info.note);
  if (info.typed) { await page.fill('#typeIn', info.label.toLowerCase()); await page.click('#typeForm button[type=submit]'); await page.waitForSelector('.typed.ok'); }
  else await page.keyboard.press('Space');
  await page.keyboard.press('4');
  if (i < 2) await page.waitForSelector('#flash');
}
const seenList = [...seen].sort();
ok(seenList.join(' / ') === ['Aorta|true|', 'Left ventricle|true|', 'No label|false|No label on this box: say it in your head, then flip.'].sort().join(' / '), 'typed answer: offered for labelled boxes only; the unlabelled one says so: ' + seenList.join(' / '));
await page.evaluate(async () => { await (await import('./js/db.js')).setSetting('reviewTyping', false); });
await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');

// ---- 4. Browse: the badge, and editing a label ----
await page.goto(URL + '#/deck/' + seed.deckId); await page.waitForSelector('.crow');
const badges = await page.locator('.crow .ckind').allTextContents();
ok(badges.sort().join() === '1/3,2/3,3/3', 'Browse rows have a k/G badge: ' + badges.join());
await noSideways(page, 'in the card list');
const before = await page.evaluate(async deckId => {
  const db = await import('./js/db.js');
  const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId && c.occlusion).sort((a, b) => a.occlusion.n - b.occlusion.n);
  return cs.map(c => ({ id: c.id, state: c.updatedAt }));
}, seed.deckId);
await page.locator('.crow', { hasText: 'hidden part 1 of 3' }).click();
await page.waitForSelector('#ceOccLbl1');
ok((await page.inputValue('#ceOccLbl1')) === 'Aorta' && (await page.locator('#ceOcc .occ').count()) === 1 && (await page.textContent('#ceOccMakes')) === 'Makes 3 cards', 'the editor shows the picture, "Makes 3 cards" and a label box for each part');
ok(await page.locator('label:has(#ceOccLbl3)').count() === 1 && (await page.getAttribute('#ceOccLbl3', 'aria-label')) === 'Label for part 3', 'label boxes have accessible names');
await page.screenshot({ path: SP + '/occ-browse-edit-375.png' });
await noSideways(page, 'in the card editor');
await page.fill('#ceOccLbl1', 'Aortic arch'); await page.fill('#ceOccLbl3', 'Atrium'); await page.fill('#ceOccHead', 'Heart');
await page.click('button[type=submit][form=ceForm], #ceForm button[type=submit]');
await page.waitForTimeout(500);
const after = await page.evaluate(async deckId => {
  const db = await import('./js/db.js');
  const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId && c.occlusion).sort((a, b) => a.occlusion.n - b.occlusion.n);
  return { ids: cs.map(c => c.id), backs: cs.map(c => c.back), fronts: cs.map(c => c.front), same: cs.every(c => JSON.stringify(c.occlusion.masks) === JSON.stringify(cs[0].occlusion.masks)), states: (await db.getAll('cardStates')).length, logs: (await db.getAll('reviewLog')).length, stamps: new Set(cs.map(c => c.noteEditedAt)).size };
}, seed.deckId);
ok(after.ids.join() === seed.ids.join() && after.backs.join('|') === 'Aortic arch|Left ventricle|Atrium' && after.fronts[0] === 'Heart: hidden part 1 of 3', 'editing labels and the header saved to every sibling, with the same ids');
ok(after.same && after.stamps === 1 && after.states >= 3 && after.logs >= 3, 'every sibling has the same boxes, one edit time, and keeps its schedule and history');
// an invalid edit (the picture or boxes can't change in stage 1, but a destroyed state must not be saved)

// ---- 5. Play: the other boxes' labels are the wrong options ----
await page.evaluate(async deckId => {
  const db = await import('./js/db.js'), occ = await import('./js/occlusion.js');
  // a fourth labelled box so multiple choice has 4 different answers
  const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId && c.occlusion);
  const masks = [...cs[0].occlusion.masks.map(m => (m.id === 'm4' ? { ...m, label: 'Atrium' } : m)), { id: 'm5', n: 4, shape: 'rect', x: 0.8, y: 0.8, w: 0.1, h: 0.1, label: 'Pulmonary vein' }];
  const plan = occ.planOcclusionSave(cs, { masks, header: 'Heart', w: cs[0].occlusion.w, h: cs[0].occlusion.h, image: cs[0].backImage });
  await db.saveNote(plan, { deckId, noteId: cs[0].noteId, tags: cs[0].tags });
}, seed.deckId);
await page.goto(URL + '#/play'); await page.waitForSelector('#pDeck');
await page.selectOption('#pDeck', seed.deckId);
await page.click('#startBtn'); await page.waitForSelector('#pPrompt .occ');
const play = await page.evaluate(() => ({ opts: [...document.querySelectorAll('#options .lbl')].map(o => o.textContent).sort(), zoom: document.querySelectorAll('#pPrompt .occ-zoom').length, ask: document.querySelectorAll('#pPrompt .occ-ask').length, label: document.getElementById('pLabel').textContent }));
ok(play.opts.join('|') === ['Aortic arch', 'Atrium', 'Left ventricle', 'Pulmonary vein'].join('|'), 'Play multiple choice: the four labels of the picture, siblings included: ' + play.opts.join(', '));
ok(play.zoom === 0 && play.ask >= 1, 'Play shows the picture with the asked box, without a zoom button');
await page.screenshot({ path: SP + '/occ-play-375.png' });
await noSideways(page, 'in Play');
await page.click('#quitBtn');

if (errors.length) { console.log('FAIL page errors:\n' + errors.join('\n')); process.exitCode = 1; } else console.log('PASS no page errors');
await browser.close();
