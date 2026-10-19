// Server limits seen from the app (review round): a record too big to sync is named and the rest still syncs; the
// server's own size refusal is worked around; the synced-data limit and the whole-project ceilings hold rows back
// without losing them (and deletes always go); the real captcha frame (sandboxed, talking only to the app's address);
// and the captcha giving up with a message instead of hanging.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const MB = 1024 * 1024;

async function device(name, fake, { route } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  if (route) await route(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', e => { if (!/Service worker is disabled because the context is sandboxed/.test(e.message)) errors.push(`${name} pageerror ${e.stack}`); });
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Sync failed|Picture sync failed|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const openSettings = async page => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *'); };
const signInUI = async (page, { create = false, email = 'me@example.com', pw = 'secret123' } = {}) => {
  await openSettings(page); await page.fill('#syncEmail', email); await page.fill('#syncPw', pw);
  await page.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
};
const waitSynced = page => page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
const syncNow = page => run(page, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const addCards = (page, cards) => run(page, async cards => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.saveCards(cards.map(([id, front, size], i) => ({ id, deckId: 'sample', front, back: 'x'.repeat(size || 20), tags: [], created: now + i })));
}, cards);
const serverHas = (fake, id) => fake.userRows('me@example.com').some(r => r.store === 'cards' && r.id === id);
const start = async (fake, o) => { const A = await device('A', fake, o); await signInUI(A, { create: true }); await waitSynced(A); return A; };

// ================= a record too big to sync =================
{
  const fake = fakeSupabase();
  const A = await start(fake);
  await addCards(A, [['ok-1', 'Fine card'], ['big-1', 'The enormous card about mitochondria', 70000], ['ok-2', 'Another fine card']]);
  const st = await syncNow(A);
  ok(serverHas(fake, 'ok-1') && serverHas(fake, 'ok-2') && !serverHas(fake, 'big-1'), 'the big card is left out and the others sync');
  ok(st.note === '1 card is too large to sync: “The enormous card about mitochondria”. Shorten it to sync.', 'the note names the card: ' + st.note);
  await openSettings(A);
  ok((await A.textContent('#syncStatus')).includes('1 card is too large to sync: “The enormous card about mitochondria”'), 'Settings → Sync shows it');
  await A.screenshot({ path: SP + '/limits2-toolarge.png' });
  // still there on the next sync (the bookmark moved on, but the flag stays until it's fixed)
  const st2 = await syncNow(A);
  ok(/too large to sync/.test(st2.note || ''), 'and the next sync still says so');
  // shortened: it goes, and the note disappears
  await addCards(A, [['big-1', 'The enormous card about mitochondria', 300]]);
  const st3 = await syncNow(A);
  ok(serverHas(fake, 'big-1') && !st3.note, 'shortened, it syncs and the note goes');
  // too big again, then deleted: the note goes too
  await addCards(A, [['big-2', 'Second giant', 70000]]);
  ok(/too large/.test((await syncNow(A)).note), 'another big card is flagged');
  await run(A, async () => { await (await import('./js/db.js')).deleteCards(['big-2']); });
  ok(!(await syncNow(A)).note, 'deleting it clears the note');
  await A.context().close();
}

// ================= the server refuses a record the app thought was fine =================
{
  const fake = fakeSupabase();
  const A = await start(fake);
  fake.setRecordMax(2000);                       // as if the server counted differently
  const cards = Array.from({ length: 12 }, (_, i) => [`r-${i}`, `Card ${i}`, i === 5 ? 3000 : 50]);
  await addCards(A, cards);
  const st = await syncNow(A);
  ok(cards.filter(([id]) => id !== 'r-5').every(([id]) => serverHas(fake, id)) && !serverHas(fake, 'r-5'), 'one refused row does not block the batch: the other 11 are on the server');
  ok(/1 card is too large to sync: “Card 5”/.test(st.note || ''), 'and it is named: ' + st.note);
  fake.setRecordMax(65536);
  await A.context().close();
}

// ================= the account's synced-data limit =================
{
  const fake = fakeSupabase();
  const A = await start(fake);
  await addCards(A, [['pre-0', 'Already on the server']]);
  await syncNow(A);
  const writes = () => fake.log.filter(l => l.startsWith('POST /rest/v1/sync_items')).length;
  fake.setDataLimit('me@example.com', 5 * MB);
  fake.setDataUsed('me@example.com', 5 * MB - fake.dataUsed('me@example.com') - 1500);    // room for about 3 small cards
  await addCards(A, Array.from({ length: 10 }, (_, i) => [`d-${i}`, `Data card ${i}`, 200]));
  const w0 = writes();
  const st = await syncNow(A);
  const onServer = Array.from({ length: 10 }, (_, i) => `d-${i}`).filter(id => serverHas(fake, id)).length;
  ok(onServer === 0 && writes() - w0 === 1, `a refusal for space stops the sending: one request, nothing went, all 10 are held (${onServer} on the server, ${writes() - w0} write request)`);
  ok(/^Your account's synced data is full \(5 MB of 5 MB\)\. New changes are saved on this device/.test(st.note || ''), 'the message: ' + st.note);
  await openSettings(A);
  await A.waitForFunction(() => /of 5 MB/.test(document.querySelector('#usageLine')?.textContent || ''));
  ok((await A.textContent('#usageLine')).includes('data 5 MB of 5 MB'), 'the usage line shows the data limit: ' + await A.textContent('#usageLine'));
  ok(/Synced data: .* of 5 MB|synced data is full/.test(await A.textContent('#usageNote')), 'with a note under it (amber from 80%): ' + await A.textContent('#usageNote'));
  // deleting always goes through, even when full
  const onId = 'pre-0';
  await run(A, async id => { await (await import('./js/db.js')).deleteCards([id]); }, onId);
  await syncNow(A);
  ok(fake.userRows('me@example.com').some(r => r.id === onId && r.deleted), 'a delete is accepted while the account is full');
  // room again: everything held goes
  fake.setDataLimit('me@example.com', 80 * MB);
  const st2 = await syncNow(A);
  ok(Array.from({ length: 10 }, (_, i) => `d-${i}`).filter(id => id !== onId).every(id => serverHas(fake, id)) && !st2.note, 'with room again, every held row is sent and the note goes');
  await A.context().close();
}

// ================= the whole project is full =================
{
  const fake = fakeSupabase();
  const A = await start(fake);
  const FULL = "The sync server is full right now. Everything is safe on this device and will sync when there's room.";
  fake.setServerFull(true);
  await addCards(A, [['s-1', 'Held card']]);
  const st = await syncNow(A);
  ok(!serverHas(fake, 's-1') && st.note === FULL, 'synced data: held with the message: ' + st.note);
  // pictures: the account has room, the project doesn't
  fake.setMediaFull(true);
  await run(A, async () => { const db = await import('./js/db.js'); await db.putMedia({ id: 'pic-x', type: 'image/jpeg', data: new Uint8Array(2000).buffer, size: 2000, created: Date.now(), uploaded: false }); });
  const st2 = await syncNow(A);
  ok(st2.note.includes(FULL) && fake.files.size === 0, 'pictures: held with the same message');
  ok(await run(A, async () => (await (await import('./js/db.js')).mediaToUpload()).length) === 1, 'the picture waits on the device');
  fake.setServerFull(false); fake.setMediaFull(false);
  const st3 = await syncNow(A);
  ok(serverHas(fake, 's-1') && fake.files.size === 1 && !st3.note, 'when there is room, both go and the note goes');
  // reviews are never blocked by the picture ceiling
  fake.setMediaFull(true);
  await addCards(A, [['s-2', 'Card while pictures are full']]);
  await syncNow(A);
  ok(serverHas(fake, 's-2'), 'cards still sync while the picture ceiling is hit');
  await A.context().close();
}

// ================= the real captcha frame =================
{
  // The provider's script is faked at its own address; the app's own frame page (js/captcha-frame.html) is the real one.
  const fakeProvider = `window.turnstile = { render: (sel, o) => setTimeout(() => o.callback('real-frame-token'), 50) }; setTimeout(() => window.ssCaptchaReady(), 0);`;
  const routeProvider = ctx => ctx.route('https://challenges.cloudflare.com/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: fakeProvider }));
  const fake = fakeSupabase({ captcha: true });
  const C = await device('C', fake, { route: routeProvider });
  await run(C, async () => { (await import('./js/sync-config.js')).CAPTCHA.siteKey = 'test-site-key-123'; });
  await signInUI(C, { create: true }); await waitSynced(C);
  ok(fake.captchaTokens.includes('real-frame-token'), 'the real frame page hands the token to the app');
  await C.context().close();

  // The frame only talks to the app's own address, and nothing is sent to '*'.
  const src = await run(await device('S', fakeSupabase()), async () => await (await fetch('js/captcha-frame.html')).text());
  ok(/, APP\);/.test(src) && !/'\*'/.test(src) && /ancestorOrigins/.test(src), 'the frame posts to the app origin only and checks who embedded it');

  // No answer in time: a message, not a hang.
  const silent = ctx => ctx.route('**/js/captcha-frame.html*', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>nothing happens</p>' }));
  const D = await device('D', fakeSupabase({ captcha: true }), { route: silent });
  await run(D, async () => { const c = (await import('./js/sync-config.js')).CAPTCHA; c.siteKey = 'test-site-key-123'; c.waitMs = 1500; });
  await signInUI(D, { create: true });
  await D.waitForFunction(() => !document.querySelector('#syncErr')?.hidden, null, { timeout: 8000 });
  ok(await D.textContent('#syncErr') === 'The “are you a person?” check didn’t load. Check your connection and try again.', 'no token in time: ' + await D.textContent('#syncErr'));
  ok(!(await D.$eval('#syncCreate', b => b.disabled)) && !(await D.$('#captchaBox iframe')), 'the buttons work again and the box is gone');
  await D.context().close();
}

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
