// Settings → Sync → "Re-upload everything" (for a lost or restored server), a card with an over-long id being named
// separately from a too-big one, and the editor refusing a card that is too big to sync. Uses the fake Supabase.
import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';

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
const openSettings = async page => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *'); };
const waitSynced = page => page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
const syncNow = page => run(page, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const serverHas = (fake, id) => fake.userRows('me@example.com').some(r => r.store === 'cards' && r.id === id);
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return fn(); };
const myCard = (page, id) => run(page, async id => (await (await import('./js/db.js')).getAll('cards')).find(c => c.id === id), id);

const fake = fakeSupabase();
const A = await device('A', fake);
await openSettings(A); await A.fill('#syncEmail', 'me@example.com'); await A.fill('#syncPw', 'secret123'); await A.click('#syncCreate'); await waitSynced(A);

// ---- a lost server: nothing is sent again by itself ----
await run(A, async () => {
  const db = await import('./js/db.js');
  await db.saveCards([{ id: 'c-1', deckId: 'sample', front: 'Mitochondria', back: 'Powerhouse', tags: [], created: Date.now() }]);
  await db.putMedia({ id: 'pic-1', type: 'image/jpeg', data: new Uint8Array(500).buffer, size: 500, created: Date.now(), uploaded: false });
});
await syncNow(A);
ok(serverHas(fake, 'c-1') && fake.files.size === 1, 'set up: the card and the picture are on the server');
fake.rows.clear(); fake.files.clear();                       // the server loses everything
await syncNow(A);
ok(!serverHas(fake, 'c-1') && fake.files.size === 0, 'a normal sync does not bring them back (this device thinks the server has them)');

// ---- the button ----
await openSettings(A);
await A.click('#resendBtn');
await A.waitForSelector('#rsYes');
ok(/lost your data/.test(await A.textContent('#sheet')), 'the sheet explains when to use it');
await A.screenshot({ path: SP + '/resend-sheet.png' });
await A.click('#rsNo');
ok(!serverHas(fake, 'c-1'), 'Cancel sends nothing');
await A.click('#resendBtn'); await A.click('#rsYes');
await A.waitForFunction(() => !document.getElementById('sheet').open);
ok(await until(() => serverHas(fake, 'c-1') && fake.files.size === 1), 'after Re-upload, the card and the picture are on the server again');

// ---- the race: Re-upload pressed while one sync runs and another waits ----
fake.rows.clear(); fake.files.clear();
await run(A, async () => {
  const s = await import('./js/sync.js');
  s.syncNow(); s.syncNow();          // one running, one queued
  await s.resendEverything();
});
ok(await until(() => serverHas(fake, 'c-1') && fake.files.size === 1), 'RACE: with syncs running and queued, the card and picture still go up again');
await A.waitForTimeout(500);
ok(!(await run(A, async () => (await (await import('./js/db.js')).getSettings()).resendPending)), 'and the flag is cleared');

// ---- newer data on the server is not overwritten ----
const mine = fake.userRows('me@example.com').find(r => r.id === 'c-1');
fake.rows.set(`${mine.user_id}|cards|c-1`, { ...mine, data: { ...mine.data, back: 'Newer answer from another device' }, updated_at: Date.now() + 5000 });
await run(A, async () => { const s = await import('./js/sync.js'); await s.resendEverything(); });
await A.waitForTimeout(500); await syncNow(A);
ok(fake.userRows('me@example.com').find(r => r.id === 'c-1').data.back === 'Newer answer from another device', 'a newer copy on the server is kept');
ok((await myCard(A, 'c-1')).back === 'Newer answer from another device', 'and this device picks it up');

// ---- an id that is too long is not called "too large" ----
await run(A, async () => {
  const db = await import('./js/db.js');
  await db.saveCards([{ id: 'x'.repeat(250), deckId: 'sample', front: 'Card with a huge id', back: 'b', tags: [], created: Date.now() }]);
});
const st = await syncNow(A);
ok(/can't sync because its internal ID is too long: “Card with a huge id”/.test(st.note || '') && !/too large/.test(st.note), 'long id wording: ' + st.note);

// ---- the editor stops a card that is too big ----
await A.goto(APP + '#/browse'); await A.waitForSelector('#brAdd');
await A.click('#brAdd'); await A.waitForSelector('#acFront');
await A.fill('#acFront', 'Big one'); await A.fill('#acBack', 'x'.repeat(70000));
await A.click('button[type=submit][form=acForm]');
await A.waitForFunction(() => !document.getElementById('acErr').hidden);
ok(/too large to save/.test(await A.textContent('#acErr')), 'adding a huge card is refused: ' + await A.textContent('#acErr'));
ok(!(await run(A, async () => (await (await import('./js/db.js')).getAll('cards')).some(c => c.front === 'Big one'))), 'and it was not saved');
await A.fill('#acBack', 'short'); await A.click('button[type=submit][form=acForm]');
await A.waitForFunction(() => document.getElementById('acFront').value === '');
ok(await run(A, async () => (await (await import('./js/db.js')).getAll('cards')).some(c => c.front === 'Big one')), 'shortened, it saves');

// ---- Find and replace leaves a card that would become too large unchanged, and says so ----
await run(A, async () => {
  const db = await import('./js/db.js');
  await db.saveCards([
    { id: 'fr-big', deckId: 'sample', front: 'Zebra big', back: 'a'.repeat(59900) + ' zebra', tags: [], created: Date.now() },
    { id: 'fr-ok', deckId: 'sample', front: 'Zebra small', back: 'a zebra', tags: [], created: Date.now() }
  ]);
});
await A.goto(APP + '#/decks'); await A.goto(APP + '#/browse'); await A.waitForSelector('#brAdd'); await A.waitForFunction(() => !document.getElementById('sheet')?.open);
await A.click('#brSelect'); await A.click('#brAll'); await A.click('#brActions'); await A.waitForSelector('#frBox');
await A.click('#frBox summary'); await A.fill('#frFind', 'zebra'); await A.fill('#frWith', 'okapi okapi okapi okapi okapi okapi');
await A.waitForFunction(() => /Changes \d+ cards?/.test(document.querySelector('#frCount')?.textContent || ''));
await A.click('#frGo'); await A.waitForFunction(() => /Replaced in/.test(document.querySelector('#toast')?.textContent || ''));
ok(/1 card was too large and was left unchanged/.test(await A.textContent('#toast')), 'Find & replace says one card was left unchanged: ' + await A.textContent('#toast'));
ok((await myCard(A, 'fr-big')).back.endsWith(' zebra') && /okapi/.test((await myCard(A, 'fr-ok')).back), 'the big card is unchanged and the small one is replaced');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
