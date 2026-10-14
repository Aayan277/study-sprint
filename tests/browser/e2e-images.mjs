import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
async function device(name, viewport = { width: 375, height: 740 }, mobile = true) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', isMobile: mobile, hasTouch: mobile });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name} ${e.stack}`));
  p.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422)|Picture sync failed|Sync failed/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  return p;
}
const run = (p, fn, arg) => p.evaluate(fn, arg);
const syncNow = p => run(p, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const waitSynced = p => p.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 20000 });
const signIn = async (p, create) => {
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck'); await p.goto(APP + '#/settings'); await p.waitForSelector('#syncEmail');
  await p.fill('#syncEmail', 'me@example.com'); await p.fill('#syncPw', 'secret123'); await p.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
  await waitSynced(p);
};
// A big test photo (3000×2000 PNG), drawn in the browser.
const A = await device('A');
const png = Buffer.from(await run(A, async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 3000, height: 2000 });
  const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#36c'; g.fillRect(500, 500, 2000, 1000);
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');
const photo = { name: 'heart.png', mimeType: 'image/png', buffer: png };

// ---- add a picture to a card ----
await A.goto(APP + '#/deck/sample'); await A.waitForSelector('.crow');
await A.locator('.crow').nth(0).click(); await A.waitForSelector('#ceFront');
await A.setInputFiles('#ceFrontFile', photo);
await A.waitForSelector('#ceFrontImg img.img-thumb[src^="blob:"]');
ok(true, 'picked photo shows as a thumbnail');
await A.screenshot({ path: SP + '/img-panel.png' });
await A.click('button[type=submit][form=ceForm]'); await A.waitForTimeout(400);
let info = await run(A, async () => {
  const db = await import('./js/db.js'); const c = await db.get('cards', 'sample-0'); const m = await db.getMedia(c.frontImage);
  const bmp = await createImageBitmap(new Blob([m.data], { type: m.type }));
  return { frontImage: c.frontImage, type: m.type, size: m.size, w: bmp.width, h: bmp.height };
});
ok(info.frontImage && info.type === 'image/jpeg' && info.w === 1280 && info.h === 853 && info.size < 200000, `shrunk to ${info.w}×${info.h} JPEG, ${Math.round(info.size / 1024)} KB (from ${Math.round(png.length / 1024)} KB)`);
await A.click('.sheet-x');
ok(await A.locator('.crow').nth(0).locator('.pic-mark').count() === 1, 'card list marks cards with pictures');
// a card whose back is only a picture
await A.click('#brAdd'); await A.waitForSelector('#acFront');
await A.fill('#acFront', 'Which organ is this?');
ok(await A.locator('button[type=submit][form=acForm]').isDisabled() && (await A.textContent('#acWhy')).includes('back'), 'empty back: Add is disabled and the reason asks for the back');
await A.evaluate(() => document.getElementById('acForm').requestSubmit());          // Ctrl+Enter still gets the message
ok((await A.textContent('#acErr')).includes('text or a picture'), 'empty back caught');
await A.setInputFiles('#acBackFile', photo); await A.waitForSelector('#acBackImg img[src^="blob:"]');
await A.click('button[type=submit][form=acForm]'); await A.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Card added');
ok(!(await A.$('#acBackImg img')), 'form clears for the next card');
await A.click('#acDone');
const picCard = await run(A, async () => (await (await import('./js/db.js')).getAll('cards')).find(c => c.front === 'Which organ is this?'));
ok(picCard && !picCard.back && picCard.backImage, 'picture-only back saved');
// review shows it
await A.goto(APP + '#/review'); await A.waitForSelector('#startBtn'); await A.click('#startBtn'); await A.waitForSelector('.flash');
for (let i = 0; i < 14 && !(await A.$('.flash-front img')); i++) { await A.keyboard.press(' '); await A.waitForSelector('.rate'); await A.keyboard.press('3'); await A.waitForTimeout(120); }
await A.waitForSelector('.flash-front img.card-img[src^="blob:"]');
ok(true, 'Review shows the picture on the card');
await A.screenshot({ path: SP + '/img-review.png' });
await A.click('#endBtn');

// ---- sync to another device ----
await signIn(A, true);
const mine = () => [...fake.files.keys()].filter(k => k.startsWith('user-1/'));
ok(mine().length === 2, 'both pictures uploaded to the account: ' + mine().length);
const B = await device('B');
await signIn(B, false);
const bHas = await run(B, async ids => { const db = await import('./js/db.js'); return Promise.all(ids.map(id => db.getMedia(id).then(Boolean))); }, [info.frontImage, picCard.backImage]);
ok(bHas.every(Boolean), 'the other device downloads them during sync (works offline after)');
await B.goto(APP + '#/deck/sample'); await B.waitForSelector('.crow');
await B.locator('.crow').nth(0).click(); await B.waitForSelector('#ceFrontImg img[src^="blob:"]');
ok(true, 'and shows them');
await B.click('.sheet-x');

// ---- removing a picture removes it from the account too ----
await A.goto(APP + '#/deck/sample'); await A.waitForSelector('.crow');
await A.locator('.crow').nth(0).click(); await A.waitForSelector('[data-img-remove="ceFront"]');
await A.click('[data-img-remove="ceFront"]'); await A.click('button[type=submit][form=ceForm]'); await A.waitForTimeout(300); await A.click('.sheet-x');
await run(A, async id => { const db = await import('./js/db.js'); const m = await db.getMedia(id); await db.putRemoteMedia({ ...m, created: 0 }); }, info.frontImage);   // pretend it's old
await syncNow(A);
ok(!fake.files.has(`user-1/${info.frontImage}`) && fake.files.has(`user-1/${picCard.backImage}`), 'unused picture removed here and from the account; the used one stays');
await syncNow(B);
ok(!(await run(B, async () => (await (await import('./js/db.js')).get('cards', 'sample-0')).frontImage)), 'B sees the picture removed');

// ---- storage not set up: the rest still syncs ----
fake.setBucket(false);
await B.goto(APP + '#/deck/sample'); await B.waitForSelector('.crow');
await B.locator('.crow').nth(1).click(); await B.waitForSelector('#ceFront');
await B.setInputFiles('#ceFrontFile', photo); await B.waitForSelector('#ceFrontImg img[src^="blob:"]');
await B.click('button[type=submit][form=ceForm]'); await B.waitForTimeout(300); await B.click('.sheet-x');
await B.goto(APP + '#/settings'); await B.waitForSelector('#syncNowBtn');
await B.click('#syncNowBtn'); await B.waitForFunction(() => /Pictures can.t sync yet/.test(document.querySelector('#syncStatus')?.textContent || ''));
ok((await B.textContent('#syncStatus')).startsWith('Synced'), 'without picture storage: cards still sync, with a note: ' + await B.textContent('#syncStatus'));
fake.setBucket(true);
await B.click('#syncNowBtn'); await B.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || '') && !/Pictures/.test(document.querySelector('#syncStatus').textContent), null, { timeout: 20000 });
ok(mine().length === 2, 'once storage is set up, the waiting picture uploads: ' + mine().length);

// ---- backups carry pictures ----
const backup = await run(B, async () => (await import('./js/db.js')).exportAll());
ok(backup.media.length >= 2 && backup.media.every(m => typeof m.data === 'string' && m.data.length > 1000), `backup includes ${backup.media.length} pictures`);
const C = await device('C');
await run(C, async b => { const db = await import('./js/db.js'); await db.importAll(b); }, backup);
const cHas = await run(C, async id => !!(await (await import('./js/db.js')).getMedia(id)), picCard.backImage);
ok(cHas, 'restoring the backup brings the pictures back');

// ---- delete my synced data removes the pictures too ----
await A.goto(APP + '#/settings'); await A.waitForSelector('#delServerBtn');
await A.click('#delServerBtn'); await A.click('#dsYes'); await A.waitForSelector('#syncEmail');
ok(mine().length === 0, 'Delete my synced data removes the pictures from the account');

// ---- computer: picture button in the Word-style box ----
const D = await device('D', { width: 1440, height: 900 }, false);
await D.goto(APP + '#/deck/sample'); await D.waitForSelector('.crow');
await D.locator('.crow').nth(3).click(); await D.waitForSelector('#ceBack');
await D.setInputFiles('#ceBackFile', photo); await D.waitForSelector('#ceBackImg img[src^="blob:"]');
await D.click('button[type=submit][form=ceForm]'); await D.waitForTimeout(300);
ok(!!(await run(D, async () => (await (await import('./js/db.js')).get('cards', 'sample-3')).backImage)), 'computer: picture added from the Word-style box');
await D.screenshot({ path: SP + '/img-desktop.png' });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
