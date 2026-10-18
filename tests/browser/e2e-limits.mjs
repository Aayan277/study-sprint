// Account limits and open sign-ups: the full-account message, the usage line (amber at 80%), pictures over 1.5 MB,
// "Delete my account" (type DELETE), sign-up with email confirmation pending, rate limits, the captcha box, and
// the Anki import warning for a long history. Uses the fake Supabase (tests/browser/fake-supabase.mjs).
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const MB = 1024 * 1024;
const FULL = "Your account is full: pictures and sounds use 180 MB of 180 MB. New ones are saved on this device and will sync when there's room. Remove some, or ask the account owner for more space.";

async function device(name, fake, { stub } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  if (stub) await ctx.route('**/js/captcha-frame.html*', route => route.fulfill({ status: 200, contentType: 'text/html', body: stub }));
  const page = await ctx.newPage();
  // (The captcha box runs in a sandboxed iframe; the test harness's own service-worker blocker complains there. Not the app.)
  page.on('pageerror', e => { if (!/Service worker is disabled because the context is sandboxed/.test(e.message)) errors.push(`${name} pageerror ${e.stack}`); });
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Sync failed|Picture sync failed|ERR_CONNECTION_REFUSED|Usage check failed|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const openSettings = async page => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *'); };
const fill = async (page, { email = 'me@example.com', pw = 'secret123' } = {}) => { await page.fill('#syncEmail', email); await page.fill('#syncPw', pw); };
const signInUI = async (page, o = {}) => { await openSettings(page); await fill(page, o); await page.click(o.create ? '#syncCreate' : '#syncForm button[type=submit]'); };
const waitSynced = page => page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
const syncNow = page => run(page, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const addPictures = (page, sizes) => run(page, async sizes => {
  const db = await import('./js/db.js');
  for (const [i, n] of sizes.entries()) await db.putMedia({ id: `pic-${i}`, type: 'image/jpeg', data: new Uint8Array(n).buffer, size: n, created: Date.now(), uploaded: false });
}, sizes);
const unsent = page => run(page, async () => (await (await import('./js/db.js')).mediaToUpload()).length);

// ================= 1. account full / amber / usage line =================
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await run(A, async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#46A758', created: Date.now() }, [{ id: 'bio-0', deckId: 'bio', front: 'Cell', back: 'x', tags: [], created: Date.now() }]); });
  await signInUI(A, { create: true }); await waitSynced(A);
  await A.waitForFunction(() => /of 180 MB/.test(document.querySelector('#usageLine')?.textContent || ''));
  ok(/^In your account: data .* · pictures and sounds 0 MB of 180 MB$/.test(await A.textContent('#usageLine')), 'Settings → Your data shows the usage line: ' + await A.textContent('#usageLine'));
  ok(await A.$eval('#usageLine', e => !e.classList.contains('warn') && !e.classList.contains('full')), 'an empty account has no warning');

  // 150 MB used: 83%, amber
  fake.files.set('user-1/old', { type: 'image/jpeg', data: { length: 150 * MB } });
  await openSettings(A);
  await A.waitForFunction(() => /150 MB of 180 MB/.test(document.querySelector('#usageLine')?.textContent || ''));
  ok(await A.$eval('#usageLine', e => e.classList.contains('warn')), 'from 80% the usage line is amber');
  ok((await A.textContent('#usageNote')).includes('Pictures and sounds: 150 MB of 180 MB.'), 'with the amber warning: ' + await A.textContent('#usageNote'));
  await A.locator('#usageRow').scrollIntoViewIfNeeded(); await A.screenshot({ path: SP + '/limits-amber.png' });

  // full at 180 MB: a new picture waits, the card change still syncs
  fake.files.set('user-1/old', { type: 'image/jpeg', data: { length: 180 * MB } });
  await addPictures(A, [200 * 1024, 300 * 1024]);
  await run(A, async () => { const db = await import('./js/db.js'); await db.saveCards([{ id: 'bio-1', deckId: 'bio', front: 'Gene', back: 'y', tags: [], created: Date.now() }]); });
  const st = await syncNow(A);
  ok(st.note === FULL, 'full account: the exact message is the sync note: ' + st.note);
  ok(await unsent(A) === 2 && [...fake.files.keys()].filter(k => k !== 'user-1/old').length === 0, 'the pictures stay on the device, nothing is uploaded');
  await run(A, async () => { const db = await import('./js/db.js'); await db.putMedia({ id: 'snd-1', type: 'audio/mpeg', data: new Uint8Array(5000).buffer, size: 5000, created: Date.now(), uploaded: false }); });
  const stS = await syncNow(A);
  ok(stS.note === FULL && await unsent(A) === 3, 'a sound waits with the pictures, with the same message');
  ok(fake.userRows('me@example.com').some(r => r.store === 'cards' && r.id === 'bio-1'), 'but the new card still synced');
  await openSettings(A);
  await A.waitForFunction(() => /180 MB of 180 MB/.test(document.querySelector('#usageLine')?.textContent || ''));
  ok(await A.$eval('#usageLine', e => e.classList.contains('full')) && (await A.textContent('#usageNote')) === FULL, 'the usage line turns full and shows the message');
  await A.locator('#usageRow').scrollIntoViewIfNeeded(); await A.screenshot({ path: SP + '/limits-full.png' });

  // room again: the waiting pictures go
  fake.files.delete('user-1/old');
  const st2 = await syncNow(A);
  ok(!st2.note && await unsent(A) === 0 && fake.mediaUsed('user-1') === 500 * 1024 + 5000, 'when there is room again, the waiting pictures upload and the note goes');

  // another device filled the account meanwhile: the server refuses, the rest waits
  fake.files.set('user-1/old', { type: 'image/jpeg', data: { length: 180 * MB } });
  await run(A, async () => { const db = await import('./js/db.js'); await db.putMedia({ id: 'late', type: 'image/jpeg', data: new Uint8Array(1000).buffer, size: 1000, created: Date.now(), uploaded: false }); });
  const orig = fake.handle;
  const st3 = await syncNow(A);
  ok(st3.note === FULL && await unsent(A) === 1, 'a refused upload is also kept on the device with the same message');

  // limits.sql not run yet: sync still works, no usage line
  fake.files.delete('user-1/old'); fake.setLimitsSql(false);
  const st4 = await syncNow(A);
  ok(!st4.note && await unsent(A) === 0, 'without limits.sql, pictures still upload (the server decides)');
  await openSettings(A);
  await A.waitForTimeout(500);
  ok(await A.$eval('#usageRow', e => e.hidden), 'and the usage line is hidden');
  fake.setLimitsSql(true);

  // a per-account limit from the quotas table
  fake.setLimit('me@example.com', 1 * MB);
  await openSettings(A);
  await A.waitForFunction(() => /of 1 MB/.test(document.querySelector('#usageLine')?.textContent || ''));
  ok(true, 'a limit set in the quotas table shows: ' + await A.textContent('#usageLine'));
  await A.context().close();
}

// ================= 2. a picture over 1.5 MB after shrinking =================
{
  const fake = fakeSupabase();
  const P = await device('P', fake);
  const r = await run(P, async () => {
    const { addImage, addImageInfo, OCCLUSION_SIDE } = await import('./js/media.js');
    // Even pure noise shrinks to about 1.1 MB at 1280px (2.8 MB at 2048px), so the re-encode is faked to come out
    // at a chosen size: the check after it is what is being tested.
    const realToBlob = HTMLCanvasElement.prototype.toBlob;
    let bytes = 0;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { if (!bytes) return realToBlob.call(this, cb, type, q); cb(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })); };
    const noisy = async () => { const c = document.createElement('canvas'); c.width = c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64); return new Promise(res => realToBlob.call(c, res, 'image/png')); };
    const plain = async side => {
      const c = document.createElement('canvas'); c.width = c.height = side;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#4488cc'; ctx.fillRect(0, 0, side, side); ctx.fillStyle = '#fff'; ctx.fillRect(side / 4, side / 4, side / 2, side / 2);
      return new Promise(res => realToBlob.call(c, res, 'image/png'));
    };
    const out = {};
    bytes = 1.6 * 1024 * 1024;
    try { await addImage(await noisy()); out.big = 'accepted'; } catch (e) { out.big = e.message; out.code = e.code; }
    out.count = (await (await import('./js/db.js')).getAll('media')).length;
    bytes = 1.5 * 1024 * 1024;
    out.edge = !!(await addImage(await plain(1280)));
    bytes = 2.5 * 1024 * 1024;
    try { out.occ = (await addImageInfo(await plain(2048), { maxSide: OCCLUSION_SIDE })).id ? 'accepted' : 'no'; } catch (e) { out.occ = e.message; }
    bytes = 3.2 * 1024 * 1024;
    try { out.occBig = (await addImageInfo(await plain(2048), { maxSide: OCCLUSION_SIDE })).id ? 'accepted' : 'no'; } catch (e) { out.occBig = e.message; }
    bytes = 0;
    out.fine = !!(await addImage(await plain(1280)));
    return out;
  });
  ok(/^That picture is still [\d.]+ MB after shrinking it, and the limit is 1\.5 MB\./.test(r.big) && r.code === 'too_big', 'a picture still over 1.5 MB after shrinking is refused: ' + r.big);
  ok(r.count === 0, 'and nothing was saved');
  ok(r.edge && r.fine, 'a picture of exactly 1.5 MB and an ordinary one are accepted');
  ok(r.occ === 'accepted', 'an image-occlusion picture of 2.5 MB is accepted (its limit is 3 MB)');
  ok(/^That picture is still [\d.]+ MB after shrinking it, and the limit is 3 MB\./.test(r.occBig), 'and one of 3.2 MB is refused: ' + r.occBig);
  await P.context().close();
}

// ================= 3. delete my account =================
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await run(A, async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#46A758', created: Date.now() }, [{ id: 'bio-0', deckId: 'bio', front: 'Cell', back: 'x', tags: [], created: Date.now() }]); });
  await signInUI(A, { create: true }); await waitSynced(A);
  await addPictures(A, [1000]); await syncNow(A);
  ok(fake.files.size === 1 && fake.userRows('me@example.com').length > 0, 'set up: an account with data and a picture on the server');
  await openSettings(A);
  ok((await A.textContent('#delAcctBtn')) === 'Delete my account', 'the Sync section has a "Delete my account" button');
  await A.click('#delAcctBtn');
  await A.waitForSelector('#daText');
  const dlg = await A.textContent('#sheet');
  ok(/Your data on this device is kept/.test(dlg) && /signed out/.test(dlg), 'the dialog says the data on this device is kept');
  ok(await A.$eval('#daYes', b => b.disabled), 'the button is off until you type DELETE');
  await A.fill('#daText', 'delete');
  ok(await A.$eval('#daYes', b => b.disabled), 'lower case "delete" is not enough');
  await A.fill('#daText', 'DELETE x');
  ok(await A.$eval('#daYes', b => b.disabled), 'nor is extra text');
  await A.fill('#daText', 'DELETE');
  ok(!(await A.$eval('#daYes', b => b.disabled)), 'DELETE turns it on');
  await A.screenshot({ path: SP + '/limits-delete.png' });
  await A.click('#daYes');
  await A.waitForSelector('#syncEmail');
  ok(fake.deleted.includes('me@example.com') && !fake.users.has('me@example.com'), 'the account is gone from the server');
  ok(fake.files.size === 0 && fake.rows.size === 0, 'and so are its pictures and data');
  const left = await run(A, async () => { const db = await import('./js/db.js'); const s = await db.getSettings(); return { decks: (await db.getDecks()).map(d => d.name), cards: (await db.getAll('cards')).length, auth: !!s.syncAuth, state: s.syncState }; });
  ok(left.decks.includes('Biology') && left.cards >= 1 && !left.auth && !left.state, 'this device is signed out and keeps its decks and cards');
  ok((await A.textContent('#toast')).includes('Your data is still on this device'), 'a message says so');
  await A.fill('#syncEmail', 'me@example.com'); await A.fill('#syncPw', 'secret123'); await A.click('#syncForm button[type=submit]');
  await A.waitForFunction(() => /Wrong email or password/.test(document.querySelector('#syncErr')?.textContent || ''));
  ok(true, 'signing in to the deleted account fails');

  // without limits.sql the button explains what to do
  const fake2 = fakeSupabase(); fake2.setLimitsSql(false);
  const B = await device('B', fake2);
  await signInUI(B, { create: true }); await waitSynced(B);
  await B.click('#delAcctBtn'); await B.fill('#daText', 'DELETE'); await B.click('#daYes');
  await B.waitForSelector('#daErr:not([hidden])');
  ok(/isn.t available on the sync server yet/.test(await B.textContent("#daErr")) && fake2.users.has('me@example.com'), 'if limits.sql has not been run, it says so and deletes nothing: ' + await B.textContent('#daErr'));
  await A.context().close(); await B.context().close();
}

// ================= 4. sign-up with email confirmation =================
{
  const fake = fakeSupabase({ confirmEmail: true });
  const A = await device('A', fake);
  await signInUI(A, { create: true });
  await A.waitForSelector('#pendOk');
  const t = await A.textContent('#sheet');
  ok(/Check your email/.test(t) && t.includes('me@example.com') && /sign in/.test(t), 'sign-up asks you to check your email: ' + t.replace(/\s+/g, ' ').slice(0, 120));
  ok(fake.confirmations.at(-1)?.email === 'me@example.com' && fake.confirmations.at(-1).redirectTo === APP, 'the confirmation link is asked to open the app: ' + fake.confirmations.at(-1)?.redirectTo);
  ok(!(await run(A, async () => !!(await (await import('./js/db.js')).getSettings()).syncAuth)), 'nobody is signed in yet');
  await A.screenshot({ path: SP + '/limits-confirm.png' });
  await A.click('#pendOk');
  // signing in before confirming
  await A.click('#syncForm button[type=submit]');
  await A.waitForFunction(() => /waiting for email confirmation/.test(document.querySelector('#syncErr')?.textContent || ''));
  ok(true, 'signing in before confirming says it is waiting for the email: ' + await A.textContent('#syncErr'));
  // asking again sends it again
  await A.click('#syncCreate'); await A.waitForSelector('#pendOk');
  ok(fake.confirmations.length === 2, 'Create account again sends the link again');
  await A.click('#pendOk');
  // opening the link
  await A.goto(fake.confirmLink('me@example.com', APP));
  await A.waitForFunction(() => /Email confirmed/.test(document.querySelector('#toast')?.textContent || ''));
  ok(new URL(A.url()).hash === '#/settings', 'the confirm link: the sign-in is taken out of the address');
  ok(!(await run(A, async () => !!(await (await import('./js/db.js')).getSettings()).syncAuth)), 'and it does not sign this device in by itself');
  await A.waitForSelector('#syncEmail'); await fill(A); await A.click('#syncForm button[type=submit]'); await waitSynced(A);
  ok(true, 'after confirming, signing in works');
  await A.context().close();

  // rate limits
  const f2 = fakeSupabase({ confirmEmail: true }); f2.setRateLimited(true);
  const R = await device('R', f2);
  await signInUI(R, { create: true });
  await R.waitForFunction(() => !document.querySelector('#syncErr')?.hidden);
  ok(/Too many emails were sent just now/.test(await R.textContent('#syncErr')), 'an email rate limit has a clear message: ' + await R.textContent('#syncErr'));
  await R.context().close();
}

// ================= 5. the captcha box =================
{
  const token = 'cf-turnstile-token-1';
  const stub = `<!doctype html><script>parent.postMessage({ from: 'study-sprint-captcha', type: 'token', token: '${token}' }, '*')</script>`;
  const fake = fakeSupabase({ captcha: true });
  const off = await device('off', fakeSupabase());
  ok(await run(off, async () => (await import('./js/captcha.js')).captchaOn()) === false, 'with no site key set, the captcha is off');
  await off.context().close();

  const C = await device('C', fake, { stub });
  await run(C, async () => { (await import('./js/sync-config.js')).CAPTCHA.siteKey = 'test-site-key-123'; });
  ok(await run(C, async () => (await import('./js/captcha.js')).captchaOn()), 'with a site key, the captcha is on');
  ok(await C.evaluate(() => !document.querySelector('script[src*="challenges.cloudflare.com"], script[src*="hcaptcha"]')), 'the provider script is not in the app page');
  await signInUI(C, { create: true }); await waitSynced(C);
  ok(fake.captchaTokens.includes(token), 'sign-up carried the captcha token');
  ok(await C.evaluate(() => !document.querySelector('iframe')), 'the box is removed after use');
  // sign-in and reset also need it
  await C.click('#signOutBtn'); await C.click('#soKeep'); await C.waitForSelector('#syncEmail');
  fake.captchaTokens.length = 0;
  await fill(C); await C.click('#syncForm button[type=submit]'); await waitSynced(C);
  ok(fake.captchaTokens.length === 1, 'sign-in carries a token too');
  await C.click('#signOutBtn'); await C.click('#soKeep'); await C.waitForSelector('#syncEmail');
  await C.fill('#syncEmail', 'me@example.com'); await C.click('#forgotBtn'); await C.waitForSelector('#fpOk');
  ok(fake.recoveries.at(-1)?.email === 'me@example.com' && fake.captchaTokens.length === 2, 'and so does the password reset email');
  await C.context().close();

  // the box failing to load
  const failStub = `<!doctype html><script>parent.postMessage({ from: 'study-sprint-captcha', type: 'error' }, '*')</script>`;
  const D = await device('D', fakeSupabase({ captcha: true }), { stub: failStub });
  await run(D, async () => { (await import('./js/sync-config.js')).CAPTCHA.siteKey = 'test-site-key-123'; });
  await signInUI(D, { create: true });
  await D.waitForFunction(() => !document.querySelector('#syncErr')?.hidden);
  ok(/The bot check didn’t load\. Try again, or contact the site owner/.test(await D.textContent('#syncErr')), 'if the box cannot load, a clear message appears: ' + await D.textContent('#syncErr'));
  ok(!(await D.$eval('#syncCreate', b => b.disabled)), 'and the buttons work again');
  await D.context().close();

  // a message from some other page can't pass for the box
  const E = await device('E', fakeSupabase({ captcha: true }), { stub: '<!doctype html><p>waiting</p>' });
  await run(E, async () => { (await import('./js/sync-config.js')).CAPTCHA.siteKey = 'test-site-key-123'; });
  await openSettings(E); await fill(E); await E.click('#syncCreate');
  await E.waitForSelector('#captchaBox iframe');
  await E.evaluate(() => postMessage({ from: 'study-sprint-captcha', type: 'token', token: 'forged' }, '*'));
  await E.waitForTimeout(400);
  ok(await E.evaluate(() => !!document.querySelector('#captchaBox iframe')) && !(await E.$eval('#syncCreate', b => !b.disabled)), 'a forged message from the app page itself is ignored');
  await E.context().close();
}

// ================= 6. Anki import warning: more than 50,000 reviews =================
{
  const fake = fakeSupabase();
  const I = await device('I', fake);
  const b64 = await I.evaluate(async () => {
    const { loadSqlJs, FFLATE_URL } = await import('./js/anki-read.js');
    const { unzipSync, zipSync } = await import(FFLATE_URL);
    const files = unzipSync(new Uint8Array(await (await fetch('tests/browser/files/anki-legacy.apkg')).arrayBuffer()));
    const SQL = await loadSqlJs();
    const name = files['collection.anki21'] ? 'collection.anki21' : 'collection.anki2';      // the one the app reads
    const db = new SQL.Database(files[name]);
    const cid = db.exec('select id from cards limit 1')[0].values[0][0];
    db.run('begin');
    const st = db.prepare('insert into revlog (id,cid,usn,ease,ivl,lastIvl,factor,time,type) values (?,?,?,?,?,?,?,?,?)');
    const now = Date.now();
    for (let i = 0; i < 50001; i++) st.run([now - 1000 * (i + 1), cid, -1, 3, 1, 0, 2500, 3000, 1]);
    st.free(); db.run('commit');
    files[name] = db.export(); db.close();
    const zip = zipSync(files);
    let s = ''; for (let i = 0; i < zip.length; i += 8192) s += String.fromCharCode(...zip.subarray(i, i + 8192));
    return btoa(s);
  });
  await I.goto(APP + '#/import'); await I.waitForSelector('#tab-file'); await I.click('#tab-file');
  await I.setInputFiles('#fileIn', { name: 'big-history.apkg', mimeType: 'application/zip', buffer: Buffer.from(b64, 'base64') });
  await I.waitForFunction(() => /Anki/.test(document.querySelector('#found')?.textContent || ''), null, { timeout: 60000 });
  await I.waitForTimeout(500);
  ok(/This deck has 50,001 reviews of history/.test(await I.textContent('#found')), 'a long Anki history is warned about before importing');
  await I.screenshot({ path: SP + '/limits-import.png' });
  await I.goto(APP + '#/import'); await I.waitForSelector('#tab-file'); await I.click('#tab-file');
  await I.setInputFiles('#fileIn', 'tests/browser/files/anki-legacy.apkg');
  await I.waitForFunction(() => document.querySelector('#found')?.textContent.includes('Anki'), null, { timeout: 30000 });
  ok(!/reviews of history/.test(await I.textContent('#found')), 'a small deck has no warning');
  await I.context().close();
}

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
