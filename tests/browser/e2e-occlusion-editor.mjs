// Image occlusion, stage 2: the box editor with real pointer input. A phone (375×812, real multi-touch through the
// browser's own input channel) draws, moves, resizes, pinches, groups and labels; a desktop (1440×900, mouse, wheel and
// keys) does the same. Also editing a note that was already reviewed.
// Run with: node tests/browser/run.mjs occlusion-editor
import { chromium } from './pw.mjs';
const SP = process.argv[2];
const URL = 'http://localhost:8123/';
const browser = await chromium.launch();
const errors = [];
const watch = p => {
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
};
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// A 3000×2000 picture with a few shapes, as PNG bytes.
async function makePicture(page) {
  return Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 3000, 2000); grad.addColorStop(0, '#f6d365'); grad.addColorStop(1, '#fda085');
    g.fillStyle = grad; g.fillRect(0, 0, 3000, 2000);
    g.fillStyle = '#2b3a67'; g.beginPath(); g.ellipse(1500, 1000, 700, 500, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222'; g.font = '180px sans-serif';
    g.fillText('Aorta', 300, 500); g.fillText('Atrium', 1900, 400); g.fillText('Valve', 1200, 1800);
    return (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer().then(b => [...new Uint8Array(b)].map(x => String.fromCharCode(x)).join('')).then(btoa);
  }), 'base64');
}

// ====================================================================================== phone
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  watch(page);
  const noSideways = async what => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && (document.querySelector('dialog.occ-ed')?.scrollWidth ?? 0) <= innerWidth), `no sideways scroll ${what}`);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  async function swipe(a, b, steps = 8) {
    await touch('touchStart', [a]);
    for (let i = 1; i <= steps; i++) await touch('touchMove', [[a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps]]);
    await touch('touchEnd', []);
  }
  const tap = async p => { await touch('touchStart', [p]); await touch('touchEnd', []); };
  const rect = async () => page.locator('.occ-ed-canvas').evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = async (fx, fy) => { const r = await rect(); return [r.x + r.w * fx, r.y + r.h * fy]; };
  const masks = () => page.evaluate(() => [...document.querySelectorAll('.occ-ed-mask')].map(e => ({ id: e.dataset.id, x: parseFloat(e.style.left) / 100, y: parseFloat(e.style.top) / 100, w: parseFloat(e.style.width) / 100, h: parseFloat(e.style.height) / 100, sel: e.classList.contains('sel'), handles: e.querySelectorAll('.occ-ed-h').length, num: e.querySelector('.occ-ed-num').textContent, aria: e.getAttribute('aria-label') })));
  const scale = () => page.locator('.occ-ed-canvas').evaluate(e => +getComputedStyle(e).getPropertyValue('--s'));
  const count = () => page.textContent('#occEdCount');
  const sameBox = (m, want) => near(m.x, want[0]) && near(m.y, want[1]) && near(m.w, want[2]) && near(m.h, want[3]);

  await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
  const deckId = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const deck = { id: db.newId(), name: 'Heart', color: '#8F80FF', created: Date.now() };
    await db.saveDeck(deck);
    return deck.id;
  });
  const png = await makePicture(page);

  // ---- 1. Add card → Image occlusion → choose a picture → the editor opens ----
  await page.goto(URL + '#/deck/' + deckId); await page.waitForSelector('#brAddFirst');
  await page.click('#brAddFirst'); await page.waitForSelector('#acForm');
  const chips = await page.evaluate(() => [...document.querySelectorAll('.kind-switch .chip span')].map(s => { const r = s.getBoundingClientRect(); return { t: s.textContent, h: r.height, right: r.right, left: r.left }; }));
  ok(chips.length === 3 && chips[2].t === 'Image occlusion' && chips.every(c => c.right <= 375 && c.left >= 0 && c.h >= 44), 'the kind switch has a third chip, Image occlusion, inside 375px with 44px targets');
  await page.locator('.kind-switch .chip', { hasText: 'Image occlusion' }).click();
  ok(await page.locator('#acOcc').isVisible() && !(await page.locator('#acBasic').isVisible()) && await page.locator('#acOccChoose').isVisible(), 'the Image occlusion pane shows a Choose a picture button');
  ok(await page.locator('#acOccBody').isHidden(), 'no preview, header or labels before a picture is chosen');
  await noSideways('in the Add card sheet (Image occlusion)');
  await page.click('#sheet button[type=submit][form=acForm], #acForm button[type=submit]');
  ok(await page.locator('#acErr').isVisible() && (await page.textContent('#acErr')) === 'Choose a picture first.', 'Add without a picture says "Choose a picture first."');
  await page.setInputFiles('#acOccFile', { name: 'heart.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('dialog.occ-ed[open]');
  await page.waitForSelector('.occ-ed-img[src]');
  const media = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const all = await db.getAll('media');
    const m = all[all.length - 1];
    const bmp = await createImageBitmap(new Blob([m.data], { type: m.type }));
    return { n: all.length, w: bmp.width, h: bmp.height };
  });
  ok(media.w === 2048 && media.h === 1365, `the picture is kept at 2048×1365 (${media.w}×${media.h})`);
  ok((await count()) === 'No boxes yet' && await page.locator('.occ-ed-hint').isVisible(), 'the editor opens empty, with the first-use hint');
  ok((await page.locator('.occ-ed-hint').textContent()).includes('Pinch with two fingers'), 'the hint says how to zoom');
  await page.waitForTimeout(150);
  const tools = await page.evaluate(() => [...document.querySelectorAll('.occ-ed-tool, .occ-ed-bar button')].map(b => { const r = b.getBoundingClientRect(); return { t: b.dataset.tool || b.dataset.act, w: r.width, h: r.height, l: r.left, r: r.right }; }));
  ok(tools.length === 9 && tools.every(t => t.w >= 44 && t.h >= 44 && t.l >= 0 && t.r <= 375), 'every editor button is at least 44px and inside the screen: ' + tools.map(t => `${t.t} ${Math.round(t.w)}×${Math.round(t.h)}`).join(', '));
  ok(await page.evaluate(() => { const d = document.querySelector('dialog.occ-ed').getBoundingClientRect(); return d.width === innerWidth && d.height === innerHeight; }), 'on a phone the editor fills the screen');
  const stageStyle = await page.locator('.occ-ed-stage').evaluate(e => ({ ta: getComputedStyle(e).touchAction, ob: getComputedStyle(e).overscrollBehavior }));
  ok(stageStyle.ta === 'none' && stageStyle.ob.includes('contain'), 'the drawing area blocks page scroll and zoom (touch-action none)');
  await noSideways('in the editor');

  // ---- 2. draw three boxes with one finger; a 3px swipe makes nothing ----
  const boxA = [0.1, 0.2, 0.2, 0.15], boxB = [0.5, 0.5, 0.2, 0.2], boxC = [0.65, 0.1, 0.25, 0.2];
  const draw = async b => swipe(await at(b[0], b[1]), await at(b[0] + b[2], b[1] + b[3]));
  const scrollBefore = await page.evaluate(() => scrollY);
  await draw(boxA);
  ok(!(await page.locator('.occ-ed-hint').isVisible()), 'the hint goes away when you start');
  await draw(boxB);
  await draw(boxC);
  let ms = await masks();
  ok(ms.length === 3 && sameBox(ms[0], boxA) && sameBox(ms[1], boxB) && sameBox(ms[2], boxC), 'three swipes made three boxes at the swiped places: ' + ms.map(m => [m.x, m.y, m.w, m.h].map(v => v.toFixed(3)).join(',')).join(' | '));
  ok((await count()) === '3 boxes · 3 cards' && ms.map(m => m.num).join() === '1,2,3', 'the count line and the box numbers follow: ' + (await count()));
  ok(ms[2].sel && ms[2].handles === 4, 'the box just drawn is selected, with four corner handles');
  const handle = await page.evaluate(() => { const h = document.querySelector('.occ-ed-h'); const r = h.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  ok(near(handle.w, 14, 1.5), `the handles are 14px on screen (${handle.w.toFixed(1)})`);
  const p0 = await at(0.9, 0.9);
  await swipe(p0, [p0[0] + 3, p0[1] + 2], 2);
  ok((await masks()).length === 3, 'a 3px swipe makes nothing (and just deselects)');
  ok(await page.evaluate(y => scrollY === y, scrollBefore), 'the page did not scroll while drawing');

  // ---- 3. select, move, resize ----
  await tap(await at(0.2, 0.275));                                  // inside box A
  ms = await masks();
  ok(ms[0].sel && !ms[1].sel && !ms[2].sel && ms[0].handles === 4, 'tapping a box selects it');
  const a0 = await at(0.2, 0.275);
  await swipe(a0, [a0[0] + 40, a0[1] + 30]);
  ms = await masks();
  const r0 = await rect();
  ok(near(ms[0].x, boxA[0] + 40 / r0.w, 0.006) && near(ms[0].y, boxA[1] + 30 / r0.h, 0.006) && near(ms[0].w, boxA[2], 0.002), 'dragging a selected box moves it without changing its size');
  const se = await at(ms[0].x + ms[0].w, ms[0].y + ms[0].h);
  await swipe([se[0] + 5, se[1] + 4], [se[0] + 35, se[1] + 34]);       // grab near the corner
  const after = (await masks())[0];
  ok(near(after.x, ms[0].x, 0.002) && near(after.y, ms[0].y, 0.002) && near(after.w, ms[0].w + 30 / r0.w, 0.008) && near(after.h, ms[0].h + 30 / r0.h, 0.008), 'dragging the bottom-right handle resizes the box and keeps its corner');
  ok(await page.evaluate(() => scrollY === 0), 'still no page scroll');

  // ---- 4. undo, redo, pinch, draw while zoomed ----
  await page.click('[data-tool=undo]');
  ok(near((await masks())[0].w, ms[0].w, 0.002), 'Undo takes the resize back');
  await page.click('[data-tool=redo]');
  ok(near((await masks())[0].w, after.w, 0.002), 'Redo does it again');
  const st = await page.locator('.occ-ed-stage').boundingBox();
  const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 30 - i * 11, cy], [cx + 30 + i * 11, cy]]);
  await touch('touchEnd', []);
  const s1 = await scale();
  ok(s1 > 1.5 && (await masks()).length === 3, `a two-finger pinch zooms (${s1.toFixed(2)}×) and makes no box`);
  const boxD = [0.52, 0.72, 0.08, 0.06];
  await draw(boxD);
  ms = await masks();
  ok(ms.length === 4 && sameBox(ms[3], boxD), 'drawing while zoomed lands on the right part of the picture: ' + [ms[3].x, ms[3].y, ms[3].w, ms[3].h].map(v => v.toFixed(3)).join(','));
  // a finger that becomes a pinch leaves no box
  {
    const a = await at(0.45, 0.74);
    await touch('touchStart', [a]);
    await touch('touchMove', [[a[0] + 10, a[1] + 10]]);
    await touch('touchMove', [[a[0] + 20, a[1] + 20], [a[0] + 120, a[1] + 20]]);
    await touch('touchMove', [[a[0] + 30, a[1] + 20], [a[0] + 140, a[1] + 20]]);
    await touch('touchEnd', []);
  }
  ok((await masks()).length === 4 && !(await page.locator('.occ-ed-draft').count()), 'a first finger that gets a second one leaves no box behind');
  {
    const a = await at(0.45, 0.74);                                 // the system takes the touch: no box either
    await touch('touchStart', [a]); await touch('touchMove', [[a[0] + 30, a[1] + 25]]); await touch('touchCancel', []);
    ok((await masks()).length === 4 && !(await page.locator('.occ-ed-draft').count()), 'a touchCancel in the middle of a drag leaves no box');
  }
  await page.screenshot({ path: SP + '/occ-editor-zoomed-375.png' });
  await page.click('[data-tool=fit]');
  ok((await scale()) === 1, 'Fit shows the whole picture again');
  // a touch inside a small box (under 60px on screen) moves it; the corner is not grabbed
  {
    await tap(await at(boxD[0] + boxD[2] / 2, boxD[1] + boxD[3] / 2));
    const d = (await masks())[3], br = await at(d.x + d.w - 0.002, d.y + d.h - 0.002), r = await rect();
    ok(Math.max(d.w * r.w, d.h * r.h) < 60, 'box D is under 60px on screen');
    await swipe(br, [br[0] + 14, br[1] + 10]);
    const d2 = (await masks())[3];
    ok(near(d2.w, d.w, 0.0015) && near(d2.h, d.h, 0.0015) && d2.x > d.x + 0.003, 'a touch near the corner of a small box moves it instead of resizing it');
    await page.click('[data-tool=undo]');
  }

  // ---- 5. group two, label, split ----
  await tap(await at(boxB[0] + 0.1, boxB[1] + 0.1));                // select B
  ok(await page.textContent('[data-tool=group] span') === 'Group', 'Group is offered for one box');
  await page.click('[data-tool=group]');
  ok(await page.locator('[data-tool=group]').evaluate(e => e.classList.contains('on')) && (await page.locator('.occ-ed-note').textContent()).includes('Tap the other boxes'), 'Group with one box starts join mode and says what to do');
  await tap(await at(boxC[0] + 0.1, boxC[1] + 0.1));                // add C
  ok((await page.textContent('[data-tool=group] span')) === 'Join 2', 'the button reads Join 2');
  await page.click('[data-tool=group]');
  ms = await masks();
  ok((await count()) === '4 boxes · 3 cards' && ms[1].num === ms[2].num, 'joining two boxes makes them one card: ' + (await count()));
  await page.click('[data-tool=label]');
  ok(await page.locator('.occ-ed-label').isVisible() && (await page.textContent('#occEdLabelCap')).startsWith('Label for part'), 'Label opens the label row');
  await page.fill('#occEdLabel', 'Aorta');
  await page.keyboard.press('Enter');
  ok(await page.locator('.occ-ed-label').isHidden() && /label Aorta/.test((await masks())[1].aria) && /label Aorta/.test((await masks())[2].aria), 'the label goes on both boxes of the group');
  await page.click('[data-tool=group]');                            // the grouped box is still selected → Split
  ok((await count()) === '4 boxes · 4 cards', 'with a whole group selected, the same button splits it: ' + (await count()));
  await page.click('[data-tool=undo]');
  ok((await count()) === '4 boxes · 3 cards', 'Undo puts the group back');

  // ---- 6. Done → the form ----
  await page.screenshot({ path: SP + '/occ-editor-375.png' });
  await noSideways('with four boxes');
  await page.click('[data-act=done]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok(await page.locator('#acOccBody').isVisible() && (await page.textContent('#acOccMakes')) === 'Makes 3 cards', 'Done returns to the form with "Makes 3 cards"');
  ok(await page.evaluate(() => document.activeElement?.id === 'acOccEdit'), 'after the first Done the focus is on Edit boxes (not lost on the page)');
  ok(await page.locator('#acOcc .occ').count() === 1 && await page.locator('#acOcc .occ-mask').count() === 4, 'the form shows the picture with its four boxes');
  const lbls = await page.locator('#acOcc .occ-lbl input').evaluateAll(l => l.map(i => i.value));
  ok(lbls.join('|') === '||Aorta' || lbls.join('|') === '|Aorta|' || lbls.join('|') === 'Aorta||', 'the Labels list has the label: ' + lbls.join('|'));
  await page.fill('#acOccHead', 'Heart anatomy');
  await noSideways('in the form with a picture');
  await page.screenshot({ path: SP + '/occ-add-form-375.png' });
  // Edit boxes comes back with the same boxes
  await page.click('#acOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  ok((await masks()).length === 4 && (await count()) === '4 boxes · 3 cards', 'Edit boxes reopens the editor with the same boxes');
  await page.click('[data-act=cancel]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok(await page.locator('#acForm').isVisible(), 'Cancel without changes closes at once (no question)');

  // ---- 7. Add → three sibling cards ----
  await page.fill('#acOccExtra', 'Mnemonic: apex');
  await page.click('#sheet button[type=submit][form=acForm], #acForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Added 3 cards'));
  ok(true, 'the toast says "Added 3 cards"');
  const saved = await page.evaluate(async deckId => {
    const db = await import('./js/db.js');
    const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId).sort((a, b) => a.occlusion.n - b.occlusion.n);
    return { n: cs.length, ids: cs.map(c => c.id), same: new Set(cs.map(c => c.noteId)).size === 1 && !!cs[0].noteId, image: new Set(cs.map(c => c.backImage)).size === 1 && !!cs[0].backImage,
      w: cs[0].occlusion.w, h: cs[0].occlusion.h, header: cs[0].occlusion.header, backs: cs.map(c => c.back), fronts: cs.map(c => c.front), nmasks: cs[0].occlusion.masks.length, groups: cs.map(c => c.occlusion.n) };
  }, deckId);
  ok(saved.n === 3 && saved.same && saved.image && saved.w === 2048 && saved.h === 1365 && saved.nmasks === 4, 'three siblings share a note id, the picture (backImage), w 2048 and four boxes');
  ok(saved.backs.filter(Boolean).join() === 'Aorta' && saved.header === 'Heart anatomy' && saved.fronts[0] === 'Heart anatomy: hidden part 1 of 3', 'the label and header are on the cards: ' + saved.backs.join('|'));
  ok(await page.locator('#acOccBody').isHidden() && await page.locator('#acOccChoose').isVisible() && await page.locator('#acForm').isVisible(), 'the form is ready for the next picture');
  ok(await page.evaluate(async deckId => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === deckId).every(c => c.noteExtra === 'Mnemonic: apex'), deckId), 'the Extra typed in the Add form is saved on every card (noteExtra)');

  // ---- 8. editing a note that was reviewed: delete a group ----
  await page.evaluate(async ids => {
    const db = await import('./js/db.js');
    const now = Date.now();
    await db.putStates(ids.map((id, i) => ({ cardId: id, due: now + (i + 2) * 86400000, stability: 5 + i, difficulty: 4 + i, reps: 3 + i, lapses: i, state: 2, scheduledDays: i + 2 })));
  }, saved.ids);
  const states0 = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cardStates')).sort((a, b) => a.cardId.localeCompare(b.cardId)));
  await page.click('#acDone'); await page.waitForFunction(() => !document.querySelector('#sheet[open]'));
  await page.waitForSelector('.crow');
  await page.locator('.crow', { hasText: 'hidden part 1 of 3' }).click();
  await page.waitForSelector('#ceOccEdit');
  await page.click('#ceOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  ms = await masks();
  ok(ms.filter(m => m.sel).length === 1 && ms.length === 4, 'Edit boxes opens with this card\'s part selected: ' + ms.filter(m => m.sel).length + ' selected');
  // select the box of part 3 (the last group) and delete it
  const lastBox = ms.find(m => m.num === '3');
  await tap(await at(lastBox.x + lastBox.w / 2, lastBox.y + lastBox.h / 2));
  ok((await masks()).find(m => m.id === lastBox.id).sel, 'tapping selects the box of part 3');
  await page.click('[data-tool=delete]');
  ok((await count()) === '3 boxes · 2 cards', 'Delete removes it: ' + (await count()));
  const nsNow = () => page.$$eval('.occ-ed-mask', els => els.map(e => +e.dataset.n));
  const topN = Math.max(...await nsNow());
  await page.click('[data-tool=add]'); const addedN = Math.max(...await nsNow());
  await page.click('[data-tool=delete]'); await page.click('[data-tool=add]');
  const reN = Math.max(...await nsNow());
  ok(addedN > topN && reN === addedN + 1, `a number is never reused, even after deleting the highest part (${topN} → ${addedN} → ${reN})`);
  await page.click('[data-tool=delete]');
  ok((await count()) === '3 boxes · 2 cards', 'the extra boxes are gone again');
  await page.click('[data-act=done]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok((await page.textContent('#ceOccMakes')) === 'Makes 2 cards', 'the card form now says "Makes 2 cards"');
  await page.fill('#ceOccExtra', 'Edited extra');
  await page.click('#ceForm button[type=submit], button[type=submit][form=ceForm]');
  await page.waitForSelector('#ceFormConfirm .confirm');
  const ask = await page.textContent('#ceFormConfirm .confirm');
  ok(/Box 3 was removed: its card and review history go too/.test(ask), 'the confirm names the box: ' + ask.trim().slice(0, 90));
  ok((await page.evaluate(async deckId => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === deckId).length, deckId)) === 3, 'nothing was removed before confirming');
  await noSideways('with the removal question');
  await page.click('#cfNo');
  ok((await page.evaluate(async deckId => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === deckId).length, deckId)) === 3 && await page.locator('#ceForm').isVisible(), 'Cancel keeps all three cards');
  await page.click('#ceForm button[type=submit], button[type=submit][form=ceForm]');
  await page.waitForSelector('#cfYes'); await page.click('#cfYes');
  await page.evaluate(async deckId => {      // (waitForFunction does not await an async predicate: poll in the page)
    const db = await import('./js/db.js'), end = Date.now() + 10000;
    while (Date.now() < end) {
      const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId);
      if (cs.length === 2 && cs.every(c => c.occlusion.masks.length === 3)) return;
      await new Promise(r => setTimeout(r, 25));
    }
  }, deckId);
  await page.click('#sheet .sheet-x');
  const rest = await page.evaluate(async deckId => {
    const db = await import('./js/db.js');
    const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId).sort((a, b) => a.occlusion.n - b.occlusion.n);
    return { ids: cs.map(c => c.id), masks: cs[0].occlusion.masks.length, same: JSON.stringify(cs[0].occlusion.masks) === JSON.stringify(cs[1].occlusion.masks), states: (await db.getAll('cardStates')).sort((a, b) => a.cardId.localeCompare(b.cardId)) };
  }, deckId);
  ok(rest.ids.join() === saved.ids.slice(0, 2).join() && rest.masks === 3 && rest.same, 'confirming removed only that card; the other two keep their ids and the new boxes');
  ok(await page.evaluate(async deckId => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === deckId).every(c => c.noteExtra === 'Edited extra'), deckId), 'the Extra typed in the edit form is saved on the cards (noteExtra)');
  ok(JSON.stringify(rest.states) === JSON.stringify(states0.filter(s => rest.ids.includes(s.cardId))) && rest.states.length === 2, 'the other cards keep their schedules exactly');

  // ---- 9. Cancel with changes asks first (in the page, never confirm()) ----
  let dialogSeen = false;
  page.on('dialog', d => { dialogSeen = true; d.dismiss(); });
  await page.waitForSelector('.crow');
  await page.locator('.crow').first().click();
  await page.waitForSelector('#ceOccEdit'); await page.click('#ceOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  const before = (await masks()).length;
  await draw([0.85, 0.8, 0.1, 0.1]);
  ok((await masks()).length === before + 1, 'drew one more box');
  await page.click('[data-act=cancel]');
  ok(await page.locator('.occ-ed-confirm').isVisible() && (await page.textContent('#occEdCfT')) === 'Discard your changes?', 'Cancel with changes asks "Discard your changes?" inside the editor');
  ok(await page.evaluate(() => document.activeElement?.dataset.act === 'keep'), 'focus is on Keep editing');
  await noSideways('with the discard question');
  await page.screenshot({ path: SP + '/occ-editor-discard-375.png' });
  await page.click('[data-act=keep]');
  ok(await page.locator('.occ-ed-confirm').isHidden() && (await masks()).length === before + 1, 'Keep editing goes back to the boxes');
  await page.keyboard.press('Escape');                              // Esc deselects first, then cancels
  await page.keyboard.press('Escape');
  ok(await page.locator('.occ-ed-confirm').isVisible(), 'Escape also asks when there are changes');
  await page.click('[data-act=discard]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok(!dialogSeen && await page.locator('#ceForm').isVisible() && (await page.textContent('#ceOccMakes')) === 'Makes 2 cards', 'Discard closes the editor and the form is unchanged (no browser pop-up was used)');
  await page.click('#sheet .sheet-x');

  // ---- 10. the new cards in Review ----
  await page.evaluate(async deckId => {
    const db = await import('./js/db.js');
    for (const c of (await db.getAll('cards')).filter(c => c.deckId === deckId)) await db.clearStates([c.id]);
  }, deckId);
  await page.goto(URL + '#/today'); await page.waitForSelector('.tdeck');
  await page.locator(`[data-start="${deckId}"]`).click(); await page.waitForSelector('#flash');
  await page.waitForSelector('.rv-front .occ-img[src]', { timeout: 5000 });
  ok(await page.locator('.rv-front .occ-ask').count() >= 1 && (await page.locator('.rv-front .occ-mask').count()) === 3, 'Review shows the picture made in the editor with its boxes');
  await page.screenshot({ path: SP + '/occ-editor-review-375.png' });
  await noSideways('in Review');
  // the box editor opened over Review (E → Edit boxes) leaves Review's keys alone
  await page.keyboard.press('Space');                               // flip, so the rating keys would count
  await page.keyboard.press('e'); await page.waitForSelector('#ceOccEdit');
  await page.click('#ceOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  for (const k of ['1', '2', '3', '4', 'Space', 'Enter', 'z', 'm', '-', '@', 'e', 'r']) await page.keyboard.press(k);
  const reviewed = await page.evaluate(async deckId => {
    const db = await import('./js/db.js');
    const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId);
    return { logs: (await Promise.all(cs.map(c => db.getCardLogs(c.id)))).flat().length, states: (await db.getAll('cardStates')).length, zoom: document.querySelectorAll('dialog.occ-view').length, editors: document.querySelectorAll('dialog.occ-ed').length, buried: cs.some(c => c.buriedUntil || c.suspended) };
  }, deckId);
  ok(reviewed.logs === 0 && reviewed.states === 0 && !reviewed.buried && reviewed.zoom === 0 && reviewed.editors === 1, 'Review keys (1-4, Space, Enter, Z, M, -, @, E, R) do nothing while the editor is open over Review: ' + JSON.stringify(reviewed));
  await page.click('[data-act=cancel]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  await page.click('#sheet .sheet-x');

  // ---- 11. join and split on a reviewed note keep that card's schedule ----
  const cardsNow = () => page.evaluate(async deckId => {
    const db = await import('./js/db.js');
    const cs = (await db.getAll('cards')).filter(c => c.deckId === deckId).sort((a, b) => a.occlusion.n - b.occlusion.n);
    const st = await db.getAll('cardStates');
    return cs.map(c => ({ id: c.id, n: c.occlusion.n, state: JSON.stringify(st.find(x => x.cardId === c.id) ?? null) }));
  }, deckId);
  await page.evaluate(async ids => {
    const db = await import('./js/db.js'), now = Date.now();
    await db.putStates(ids.map((id, i) => ({ cardId: id, due: now + (i + 3) * 86400000, stability: 9 + i, difficulty: 3 + i, reps: 5 + i, lapses: i, state: 2, scheduledDays: i + 3 })));
  }, rest.ids);
  const before2 = await cardsNow();
  const settle = async want => { for (let i = 0; i < 50; i++) { const c = await cardsNow(); if (c.length === want) return c; await page.waitForTimeout(100); } return cardsNow(); };
  const saveForm = () => page.click('#ceForm button[type=submit], button[type=submit][form=ceForm]');
  await page.goto(URL + '#/deck/' + deckId); await page.waitForSelector('.crow');
  await page.locator('.crow', { hasText: 'hidden part 2 of 2' }).click();      // the higher number, so "lowest wins" would pick the other card
  await page.waitForSelector('#ceOccEdit'); await page.click('#ceOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  const other = (await masks()).find(m => !m.sel), mine = (await masks()).find(m => m.sel);
  await tap(await at(other.x + other.w / 2, other.y + other.h / 2));      // the other card's box first ...
  await page.click('[data-tool=group]');
  await tap(await at(mine.x + mine.w / 2, mine.y + mine.h / 2));          // ... then this card's
  await page.click('[data-tool=group]');
  ok((await count()) === '3 boxes · 1 card', 'joined into one card: ' + (await count()));
  await page.click('[data-act=done]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  await saveForm(); await page.waitForSelector('#cfYes'); await page.click('#cfYes');
  let after2 = await settle(1);
  ok(after2.length === 1 && after2[0].id === before2[1].id && after2[0].state === before2[1].state, 'joining the other card\'s box to the opened card keeps the opened card (not the lowest number) and its schedule');
  await page.click('#sheet .sheet-x');
  await page.locator('.crow').first().click();
  await page.waitForSelector('#ceOccEdit'); await page.click('#ceOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  ok((await page.textContent('[data-tool=group] span')) === 'Split', 'with the whole card selected the button splits');
  await page.click('[data-tool=group]');
  await page.click('[data-act=done]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  await saveForm();
  after2 = await settle(3);
  const kept = after2.find(c => c.id === before2[1].id);
  ok(after2.length === 3 && kept?.n === before2[1].n && kept.state === before2[1].state, 'splitting a reviewed card keeps its number and schedule; the new parts are new cards');
  await page.click('#sheet .sheet-x');

  // ---- 12. a sibling whose number is missing from the boxes keeps it reserved ----
  await page.evaluate(async deckId => {
    const db = await import('./js/db.js'), occ = await import('./js/occlusion.js');
    const base = (await db.getAll('cards')).find(c => c.deckId === deckId);
    // card 4 exists, but its box is not among the boxes the cards hold (as after a sync heal)
    const own = [1, 2, 3].map(n => ({ id: 'm' + n, n, shape: 'rect', x: 0.1 + (n - 1) * 0.25, y: 0.1, w: 0.2, h: 0.2 }));
    for (const n of [1, 2, 3, 4]) {
      const { front, back } = occ.occFrontBack({ header: 'Seed', masks: own }, Math.min(n, 3));
      await db.saveCards([{ ...base, id: 'seed' + n, noteId: 'seedNote', front: n === 4 ? 'Seed: four' : front, back, occlusion: { ...base.occlusion, n, header: 'Seed', masks: own } }]);
    }
    await db.putStates([{ cardId: 'seed4', due: Date.now() + 5 * 86400000, stability: 20, difficulty: 6, reps: 9, lapses: 1, state: 2, scheduledDays: 5 }]);
  }, deckId);
  await page.reload(); await page.waitForSelector('.crow');
  const seed4 = () => page.evaluate(async () => { const db = await import('./js/db.js'); return JSON.stringify([(await db.getAll('cards')).find(c => c.id === 'seed4'), (await db.getAll('cardStates')).find(s => s.cardId === 'seed4')]); });
  const seed4Before = await seed4();
  await page.locator('.crow', { hasText: 'Seed: hidden part 1 of 3' }).click();
  await page.waitForSelector('#ceOccEdit'); await page.click('#ceOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  await draw([0.1, 0.6, 0.2, 0.2]);
  await page.click('[data-act=done]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  await saveForm(); await page.waitForSelector('#cfYes');
  ok(/removed/.test(await page.textContent('#ceFormConfirm .confirm')) && (await seed4()) === seed4Before, 'the new box does not take over card 4: saving asks before removing it, and nothing changed yet');
  await page.click('#cfYes');
  let seedNs = '';
  for (let i = 0; i < 50 && !seedNs.endsWith(',5'); i++) {            // wait for the save to land
    await page.waitForTimeout(100);
    seedNs = await page.evaluate(async () => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.noteId === 'seedNote').map(c => c.occlusion.n).sort((x, y) => x - y).join());
  }
  ok(seedNs === '1,2,3,5', 'the new box got number 5, not the missing 4: ' + seedNs);
  ok(errors.length === 0, 'no page errors on the phone: ' + errors.join(' | '));
  await ctx.close();
}

// ====================================================================================== desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  watch(page);
  const rect = async () => page.locator('.occ-ed-canvas').evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = async (fx, fy) => { const r = await rect(); return [r.x + r.w * fx, r.y + r.h * fy]; };
  const masks = () => page.evaluate(() => [...document.querySelectorAll('.occ-ed-mask')].map(e => ({ id: e.dataset.id, x: parseFloat(e.style.left) / 100, y: parseFloat(e.style.top) / 100, w: parseFloat(e.style.width) / 100, h: parseFloat(e.style.height) / 100, sel: e.classList.contains('sel'), num: e.querySelector('.occ-ed-num').textContent })));
  const scale = () => page.locator('.occ-ed-canvas').evaluate(e => +getComputedStyle(e).getPropertyValue('--s'));
  const count = () => page.textContent('#occEdCount');
  async function drag(a, b, steps = 10) {
    await page.mouse.move(a[0], a[1]); await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps);
    await page.mouse.up();
  }
  const drawBox = async b => drag(await at(b[0], b[1]), await at(b[0] + b[2], b[1] + b[3]));

  await page.goto(URL + '#/decks'); await page.waitForSelector('.deck');
  const deckId = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const deck = { id: db.newId(), name: 'Heart', color: '#8F80FF', created: Date.now() };
    await db.saveDeck(deck);
    return deck.id;
  });
  const png = await makePicture(page);
  await page.goto(URL + '#/deck/' + deckId); await page.waitForSelector('#brAddFirst');
  await page.click('#brAddFirst'); await page.waitForSelector('#acForm');
  await page.locator('.kind-switch .chip', { hasText: 'Image occlusion' }).click();
  ok((await page.textContent('#acOccChoose')).includes('paste a screenshot'), 'on a computer the picker also offers drop and paste');
  // drop a file on the box
  await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'heart.png', { type: 'image/png' }));
    const zone = document.getElementById('acOccPick');
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await page.waitForSelector('dialog.occ-ed[open]'); await page.waitForSelector('.occ-ed-img[src]');
  ok(true, 'dropping a picture opens the editor');
  const dlg = await page.locator('dialog.occ-ed').boundingBox();
  ok(Math.abs(dlg.width - 1200) <= 2 && Math.abs(dlg.height - 828) <= 2 && Math.abs(dlg.x - 120) <= 2, `on a computer the editor is a 1200×828 window in the middle (${Math.round(dlg.width)}×${Math.round(dlg.height)})`);
  ok((await page.locator('.occ-ed-hint').textContent()).includes('Pinch or Ctrl/⌘+scroll to zoom · scroll or Space+drag to move'), 'the first-use hint speaks of Ctrl/⌘+scroll, scroll and Space');

  // draw three boxes with the mouse
  await drawBox([0.1, 0.2, 0.2, 0.15]); await drawBox([0.5, 0.5, 0.2, 0.2]); await drawBox([0.65, 0.1, 0.25, 0.2]);
  let ms = await masks();
  ok(ms.length === 3 && near(ms[1].x, 0.5, 0.01) && near(ms[1].w, 0.2, 0.01) && near(ms[2].h, 0.2, 0.01), 'the mouse draws boxes');
  // the wheel zooms at the cursor: the point of the picture under it stays under it
  const cur = await at(0.7, 0.6);
  const fr0 = await rect();
  const frac = [(cur[0] - fr0.x) / fr0.w, (cur[1] - fr0.y) / fr0.h];
  await page.mouse.move(cur[0], cur[1]);
  await page.mouse.wheel(0, -400);                                  // a plain wheel moves the picture, it does not zoom
  await page.waitForTimeout(100);
  ok((await scale()) === 1, 'a plain wheel at 1× does not zoom');
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -400); await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const s1 = await scale(), fr1 = await rect();
  const back = [fr1.x + fr1.w * frac[0], fr1.y + fr1.h * frac[1]];
  ok(s1 > 1.5 && Math.abs(back[0] - cur[0]) <= 2 && Math.abs(back[1] - cur[1]) <= 2, `Ctrl+wheel zooms to ${s1.toFixed(2)}× around the cursor (off by ${Math.abs(back[0] - cur[0]).toFixed(1)}, ${Math.abs(back[1] - cur[1]).toFixed(1)}px)`);
  // a plain wheel (or two-finger scroll) while zoomed moves the picture
  const tw = await page.locator('.occ-ed-canvas').evaluate(e => e.style.transform);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(100);
  ok(tw !== await page.locator('.occ-ed-canvas').evaluate(e => e.style.transform) && near(await scale(), s1, 1e-6) && (await masks()).length === 3, 'a plain wheel while zoomed pans the picture and keeps the zoom');
  // a double-click does not zoom the editor
  await page.mouse.dblclick(cur[0], cur[1]);
  ok(near(await scale(), s1, 1e-6), 'a double-click in the editor does not zoom');
  // Space + drag moves the zoomed picture
  const t0 = await page.locator('.occ-ed-canvas').evaluate(e => e.style.transform);
  await page.keyboard.down('Space'); await drag([600, 450], [540, 420], 5); await page.keyboard.up('Space');
  ok(t0 !== await page.locator('.occ-ed-canvas').evaluate(e => e.style.transform) && (await masks()).length === 3, 'Space + drag moves the picture and draws nothing');
  await page.click('[data-tool=fit]');
  ok((await scale()) === 1, 'Fit (or 0) shows it all');

  // Shift-click + G
  const [pa, pb] = [await at(0.2, 0.275), await at(0.6, 0.6)];
  await page.mouse.click(pa[0], pa[1]);
  await page.keyboard.down('Shift'); await page.mouse.click(pb[0], pb[1]); await page.keyboard.up('Shift');
  ms = await masks();
  ok(ms.filter(m => m.sel).length === 2, 'Shift-click adds a second box to the selection');
  await page.keyboard.press('g');
  ok((await count()) === '3 boxes · 2 cards', 'G groups the selected boxes: ' + (await count()));
  // arrows nudge; shift = 10×; Alt resizes
  await page.mouse.click(pa[0], pa[1]);
  const x0 = (await masks())[0];
  await page.keyboard.press('ArrowRight');
  ok(near((await masks())[0].x, x0.x + 0.005, 0.0006), 'ArrowRight nudges a box by 0.5%');
  await page.keyboard.press('Shift+ArrowDown');
  ok(near((await masks())[0].y, x0.y + 0.05, 0.001), 'Shift+Arrow nudges by 5%');
  await page.keyboard.press('Alt+ArrowRight');
  ok(near((await masks())[0].w, x0.w + 0.005, 0.0006), 'Alt+Arrow makes the box wider');
  await page.keyboard.press('Control+z');
  ok(near((await masks())[0].w, x0.w, 0.0006), 'Ctrl+Z undoes the resize');
  await page.keyboard.press('Control+Shift+z');
  ok(near((await masks())[0].w, x0.w + 0.005, 0.0006), 'Ctrl+Shift+Z redoes it');
  // arrows keep working for a zoomed picture only when nothing is selected
  await page.keyboard.press('Escape');
  ok((await masks()).every(m => !m.sel), 'Esc deselects');
  // Delete / undo
  await page.mouse.click(pb[0], pb[1]);
  await page.keyboard.press('Delete');
  ok((await masks()).length === 2, 'Delete removes the selected box');
  await page.keyboard.press('Control+z');
  ok((await masks()).length === 3, 'Ctrl+Z brings it back');
  // Add box
  await page.click('[data-tool=add]');
  ms = await masks();
  const added = ms[ms.length - 1];
  ok(ms.length === 4 && added.sel && near(added.x + added.w / 2, 0.5, 0.02) && near(added.w, 0.2, 0.01), 'Add box puts a selected 20% box in the middle');
  // label by keyboard
  await page.keyboard.press('l');
  ok(await page.evaluate(() => document.activeElement?.id === 'occEdLabel'), 'L opens the label row with the cursor in it');
  const snap = JSON.stringify(await masks());
  for (const k of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift+ArrowDown']) await page.keyboard.press(k);
  ok(JSON.stringify(await masks()) === snap && (await count()) === '4 boxes · 3 cards', 'Backspace, Delete and the arrows typed in the label field leave the boxes alone');
  await page.keyboard.type('Valve');
  await page.keyboard.press('Enter');
  ok(/label Valve/.test(await page.locator('.occ-ed-mask').last().getAttribute('aria-label')), 'typing a label labels the selected box');
  // Tab reaches the masks
  await page.keyboard.press('Escape');
  await page.locator('.occ-ed-stage').focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  const tabbed = await page.evaluate(() => ({ mask: !!document.activeElement?.closest('.occ-ed-mask'), label: document.activeElement?.getAttribute('aria-label') }));
  ok(tabbed.mask && /^Part \d of \d, /.test(tabbed.label), 'Tab moves through the boxes, each with a name: ' + tabbed.label);
  ok((await masks()).filter(m => m.sel).length === 1, 'a box that gets the focus from Tab is selected');
  // keyboard: the zoom keys still work on the page the editor sits on, arrows nudge instead of panning the zoomed picture
  await page.keyboard.press('+');
  ok((await scale()) > 1, '+ zooms');
  await page.keyboard.press('0');
  await page.mouse.click(10, 10);                                   // click on the backdrop: nothing happens
  ok(await page.locator('dialog.occ-ed').isVisible(), 'the editor stays open (it is modal)');
  await page.mouse.move(700, 500);
  await page.screenshot({ path: SP + '/occ-editor-desk.png' });

  // Esc closes only the editor, not the card sheet behind it; Done keeps the boxes
  await page.keyboard.press('Escape');                              // deselect
  await page.keyboard.press('Escape');                              // changes → asks
  ok(await page.locator('.occ-ed-confirm').isVisible(), 'Escape with changes asks first');
  await page.keyboard.press('Escape');
  ok(await page.locator('.occ-ed-confirm').isHidden(), 'Escape on the question keeps editing');
  await page.click('[data-act=done]'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok(await page.locator('#sheet').evaluate(e => e.open) && (await page.textContent('#acOccMakes')).startsWith('Makes 3 cards'), 'Done closes only the editor; the Add card panel is still open with "Makes 3 cards"');
  // Esc inside an editor with no changes closes only the editor, not the panel behind it
  await page.click('#acOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok(await page.locator('#sheet').evaluate(e => e.open), 'Escape in the editor leaves the card panel open');
  await page.click('#acForm button[type=submit], #sheet button[type=submit][form=acForm]', { clickCount: 2 });               // a double tap on Add must not add twice
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Added 3 cards'));
  await page.waitForTimeout(400);
  const n = await page.evaluate(async deckId => (await (await import('./js/db.js')).getAll('cards')).filter(c => c.deckId === deckId && c.occlusion).length, deckId);
  ok(n === 3, 'Add makes the 3 cards from the desktop session, and a double-click on Add makes only one set');
  // Cancel on a fresh picture: the focus stays in the form (on Edit boxes)
  await page.setInputFiles('#acOccFile', { name: 'heart.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('dialog.occ-ed[open]'); await page.waitForSelector('.occ-ed-img[src]');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok(await page.evaluate(() => document.activeElement?.id === 'acOccEdit'), 'after Cancel on a new picture the focus is on Edit boxes');
  // the Android back button closes the dialog without Cancel or Discard: unsaved boxes are kept (as Done)
  await page.click('#acOccEdit'); await page.waitForSelector('dialog.occ-ed[open]');
  await drawBox([0.2, 0.2, 0.2, 0.2]);
  await page.evaluate(() => document.querySelector('dialog.occ-ed').close());
  await page.waitForFunction(() => !document.querySelector('dialog.occ-ed'));
  ok((await page.textContent('#acOccMakes')) === 'Makes 1 card', 'closing the editor some other way (Android back) keeps the unsaved boxes: ' + await page.textContent('#acOccMakes'));
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on the desktop');
  ok(errors.length === 0, 'no page errors on the desktop: ' + errors.join(' | '));
  await ctx.close();
}
await browser.close();
