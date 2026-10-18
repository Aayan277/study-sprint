// A full account or server must not cause a storm of requests (audit: 19 / 301 / 304 write requests for 10 / 200 / 2000 waiting rows):
// the first refusal for space stops the sending (one write request), the rest is held, deletes still go, and automatic syncs then
// stay quiet (no pushing, pulling goes on) for 15 minutes, doubling up to 6 hours. A person's Sync now pushes once; a push that
// goes through clears the wait. The wait survives a reload.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const MIN = 60000;

async function device(name, fake) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422|429|404)|Sync failed|Picture sync failed|Failed to load resource/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const signUp = async page => {
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *');
  await page.fill('#syncEmail', 'me@example.com'); await page.fill('#syncPw', 'secret123'); await page.click('#syncCreate');
  await page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
};
const person = page => run(page, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const auto = page => run(page, async () => { const s = await import('./js/sync.js'); const r = await s.syncNow({ skipIfBusy: true }); return { r, ...s.lastStatus() }; });
const addCards = (page, n, tag) => run(page, async ({ n, tag }) => {
  const db = await import('./js/db.js'); const now = Date.now();
  await db.saveCards(Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, deckId: 'sample', front: `Card ${tag} ${i}`, back: 'x', tags: [], created: now + i })));
}, { n, tag });
const backoff = page => run(page, async () => (await (await import('./js/db.js')).getSettings()).pushBackoff || null);
const writes = fake => fake.log.filter(l => l.startsWith('POST /rest/v1/sync_items')).length;
const pulls = fake => fake.log.filter(l => l.startsWith('GET /rest/v1/sync_items')).length;
const onServer = (fake, tag) => fake.userRows('me@example.com').filter(r => r.store === 'cards' && r.id.startsWith(tag + '-') && !r.deleted).length;

// ================= the project is full, with many rows waiting =================
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await signUp(A);
  fake.setServerFull(true);
  await addCards(A, 1200, 'f');
  let w = writes(fake);
  const st = await person(A);
  ok(writes(fake) - w === 1, `a full server costs one write request for 1,200 waiting rows (${writes(fake) - w})`);
  ok(onServer(fake, 'f') === 0 && /sync server is full/.test(st.note || ''), 'nothing went, and the note says the server is full: ' + st.note);
  const b1 = await backoff(A);
  ok(b1 && b1.wait === 15 * MIN && b1.until > Date.now() + 14 * MIN && b1.until <= Date.now() + 15 * MIN, 'the first wait is 15 minutes');

  // automatic syncs inside the wait send nothing, but still pull
  w = writes(fake); const p = pulls(fake);
  const a1 = await auto(A);
  const a2 = await auto(A);
  ok(writes(fake) === w && pulls(fake) - p === 2, `automatic syncs inside the wait send nothing (${writes(fake) - w} writes) and still pull (${pulls(fake) - p} pulls)`);
  ok(a1.state === 'done' && /sync server is full/.test(a2.note || ''), 'and the full note stays visible: ' + a2.note);
  // a change made meanwhile is held with the rest (the 4-second timer calls the same automatic sync)
  await addCards(A, 3, 'g');
  await auto(A);
  ok(writes(fake) === w, 'a new change inside the wait is not sent either');

  // a delete still goes during the wait (it frees space): one request, and nothing else
  await run(A, async () => { await (await import('./js/db.js')).deleteCards(['sample-0']); });
  w = writes(fake);
  await auto(A);
  ok(writes(fake) - w === 1 && fake.userRows('me@example.com').some(r => r.id === 'sample-0' && r.deleted), 'a delete is still sent during the wait (one request)');
  w = writes(fake);
  await auto(A);
  ok(writes(fake) === w, 'and the next automatic sync sends nothing again');

  // the wait survives closing the app
  await A.goto(APP + '#/decks'); await A.reload(); await A.waitForSelector('.deck');
  await new Promise(r => setTimeout(r, 1500));          // (the app's own sync on opening)
  const b2 = await backoff(A);
  ok(b2 && b2.until === b1.until && writes(fake) === w, 'after a reload the wait is still there and nothing was sent');

  // Sync now bypasses it once; refused again, the wait doubles
  const st2 = await person(A);
  ok(writes(fake) - w === 1 && /sync server is full/.test(st2.note || ''), 'Sync now pushes once even inside the wait (one request; the delete already sent is not sent again)');
  const b3 = await backoff(A);
  ok(b3.wait === 30 * MIN, 'refused again: the wait doubles to 30 minutes');
  w = writes(fake);
  await auto(A);
  ok(writes(fake) === w, 'and automatic syncs are quiet again');

  // the wait ends by itself: the next automatic sync tries once
  await run(A, async () => { const db = await import('./js/db.js'); const b = (await db.getSettings()).pushBackoff; await db.setSetting('pushBackoff', { ...b, until: Date.now() - 1000 }); });
  await auto(A);
  ok(writes(fake) - w === 1, 'once the wait is over, an automatic sync tries once (one request)');
  ok((await backoff(A)).wait === 60 * MIN, 'and the wait doubles again (60 minutes)');

  // there is room again: Sync now sends everything, and the wait is gone
  fake.setServerFull(false);
  const st3 = await person(A);
  ok(onServer(fake, 'f') === 1200 && onServer(fake, 'g') === 3 && !st3.note, 'with room again, Sync now sends all of it and the note goes');
  ok(await backoff(A) === null, 'a push that went through clears the wait');
  await A.context().close();
}

// ================= the account's data space is full: the same, and deletes still go =================
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await signUp(A);
  await addCards(A, 5, 'k');
  await person(A);
  ok(onServer(fake, 'k') === 5, 'five cards are on the server');
  fake.setDataLimit('me@example.com', 5 * 1024 * 1024);
  fake.setDataUsed('me@example.com', 5 * 1024 * 1024 - fake.dataUsed('me@example.com') - 200);
  await addCards(A, 400, 'n');
  await run(A, async () => { await (await import('./js/db.js')).deleteCards(['k-0', 'k-1']); });
  const w = writes(fake);
  const st = await person(A);
  ok(writes(fake) - w === 2, `deletes go first, then one refused batch of puts (${writes(fake) - w} requests)`);
  ok(onServer(fake, 'k') === 3 && onServer(fake, 'n') === 0, 'the deletes were accepted, the new cards are held');
  ok(/synced data is full/.test(st.note || ''), 'the note says the account is full: ' + st.note);
  const w2 = writes(fake);
  await auto(A);
  ok(writes(fake) === w2, 'and automatic syncs wait');
  await A.context().close();
}

// ================= the project went read-only (Postgres 25006) =================
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await signUp(A);
  // a server that answers every write with "read-only transaction"
  await A.context().route('https://lakxeftzlpvydzulxrbi.supabase.co/rest/v1/sync_items**', route => {
    if (route.request().method() !== 'POST') return fake.handle(route);
    fake.log.push('POST /rest/v1/sync_items (read-only)');
    return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '25006', message: 'cannot execute INSERT in a read-only transaction' }) });
  });
  await addCards(A, 600, 'r');
  const w = writes(fake);
  const st = await person(A);
  ok(writes(fake) - w === 1 && /sync server is full right now/.test(st.note || ''), 'read-only: one request, and the "server full" wording: ' + st.note);
  await A.context().close();
}

// ================= the project is over its file ceiling (media_server_full) =================
for (const status of [400, 500]) {
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await signUp(A);
  const addPics = n => run(A, async n => {
    const db = await import('./js/db.js');
    for (let i = 0; i < n; i++) await db.putMedia({ id: `pic-${status}-${i}-${Math.random()}`, type: 'image/jpeg', data: new Uint8Array(300).buffer, size: 300, created: Date.now(), uploaded: false });
  }, n);
  const mediaBackoff = () => run(A, async () => (await (await import('./js/db.js')).getSettings()).mediaBackoff || null);
  fake.setMediaServerFull(status);
  await addPics(5);
  let u = fake.uploads.length;
  const st = await person(A);
  ok(fake.uploads.length - u === 1, `${status}: a full project costs one upload request, not one per file (${fake.uploads.length - u})`);
  ok(/sync server is full/.test(st.note || '') && fake.files.size === 0, `${status}: the note says the server is full: ${st.note}`);
  const b = await mediaBackoff();
  ok(b && b.wait === 15 * MIN && b.kind === 'media', `${status}: uploads back off for 15 minutes`);
  u = fake.uploads.length;
  const st2 = await auto(A);
  ok(fake.uploads.length === u && /sync server is full/.test(st2.note || ''), `${status}: an automatic sync inside the wait uploads nothing and keeps the note`);
  await person(A);
  ok(fake.uploads.length - u === 1 && (await mediaBackoff()).wait === 30 * MIN, `${status}: Sync now tries once, and the wait doubles`);
  fake.setMediaServerFull(0);
  const st3 = await person(A);
  ok(fake.files.size === 5 && !st3.note && await mediaBackoff() === null, `${status}: with room again everything goes up, the note goes, the wait is cleared`);
  await A.context().close();
}
// the safety net: two server errors in a row (5xx without any explanation) stop the upload loop
{
  const fake = fakeSupabase();
  const A = await device('A', fake);
  await signUp(A);
  await A.context().route('https://lakxeftzlpvydzulxrbi.supabase.co/storage/v1/object/media/**', route => {
    if (route.request().method() !== 'POST') return fake.handle(route);
    fake.uploads.push({ path: 'x', type: 'x' });
    return route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: 'bad gateway' }) });
  });
  await run(A, async () => {
    const db = await import('./js/db.js');
    for (let i = 0; i < 8; i++) await db.putMedia({ id: 'q' + i, type: 'image/jpeg', data: new Uint8Array(300).buffer, size: 300, created: Date.now(), uploaded: false });
  });
  const u = fake.uploads.length;
  await person(A);
  ok(fake.uploads.length - u === 2, `two 5xx answers in a row stop the upload loop (${fake.uploads.length - u} of 8 tried)`);
  await A.context().close();
}

ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
await browser.close();
