// Pictures are downloaded when a card first needs them, not all during sync (js/lazy-media.js, backlog 16), with the fake server:
// a fresh device syncs without a bulk download, opening a card fetches its picture, offline shows a quiet placeholder that fills in
// when the connection is back, the 30-day sweep and "Re-upload everything" do not treat a file this device lacks as unused or lost,
// and exports fetch what is missing first (or say what could not be included).
import { chromium, deckMenu } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { execFileSync } from 'node:child_process';
const SP = process.argv[2];
const browser = await chromium.launch({ autoAddCards: true })      // builds devices with cards, then signs in on purpose to merge them (pw.mjs);
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
const SUPA = 'https://lakxeftzlpvydzulxrbi.supabase.co/**';
const downloads = [];          // every file download from the account: { who, id }
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route(SUPA, route => {
    const req = route.request(), m = /\/storage\/v1\/object\/authenticated\/media\/[^/]+\/(.+)$/.exec(new URL(req.url()).pathname);
    if (m && req.method() === 'GET') downloads.push({ who: name, id: decodeURIComponent(m[1]) });
    return fake.handle(route);
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name} ${e.stack}`));
  p.on('console', m => { if (m.type() === 'error' && !/status of (400|401|404|422)|Picture sync failed|Sync failed|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck');
  return p;
}
const run = (p, fn, arg) => p.evaluate(fn, arg);
const syncNow = p => run(p, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
const waitSynced = p => p.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 20000 });
const signIn = async (p, create) => {
  await p.goto(APP + '#/decks'); await p.waitForSelector('.deck, .empty'); await p.goto(APP + '#/settings'); await p.waitForSelector('#syncEmail');
  await p.fill('#syncEmail', 'me@example.com'); await p.fill('#syncPw', 'secret123'); await p.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
  await waitSynced(p);
};
const held = p => run(p, async () => (await import('./js/db.js')).mediaKeys());
const count = who => downloads.filter(d => d.who === who).length;
const KB = 20;                                                    // each test picture is 20 KB

// ---- A: an account with 60 picture cards: 10 due, 40 new, 10 not due for a month ----
const A = await device('A');
await run(A, async () => {
  const db = await import('./js/db.js');
  await db.deleteDeck('sample');
  const now = Date.now();
  const cards = Array.from({ length: 60 }, (_, i) => ({ id: 'lz' + (i + 1), deckId: 'lz', front: 'Question ' + (i + 1), back: 'Answer ' + (i + 1), tags: [], created: now - 1e6 + i, frontImage: 'pic-' + (i + 1) }));
  const st = (i, due) => ({ cardId: 'lz' + i, state: 2, due, stability: 5, difficulty: 5, reps: 3, lapses: 0, lastReview: now - 5 * 86400000 });
  const cardStates = [...Array.from({ length: 10 }, (_, k) => st(k + 1, now - 86400000)), ...Array.from({ length: 10 }, (_, k) => st(k + 51, now + 30 * 86400000))];
  await db.addImport({ decks: [{ id: 'lz', name: 'Lazy', color: '#3E63DD', created: now - 2e6 }], cards, cardStates });
  for (let i = 1; i <= 60; i++) await db.putMedia({ id: 'pic-' + i, type: 'image/jpeg', data: new Uint8Array(20 * 1024).fill(i).buffer, size: 20 * 1024, created: now - 2 * 86400000, uploaded: false });
});
await signIn(A, true);
await syncNow(A);
const filesOnServer = () => [...fake.files.keys()].filter(k => k.startsWith('user-1/')).length;
ok(filesOnServer() === 60, 'set up: 60 pictures are in the account');
ok(count('A') === 0, 'the device that made them downloaded nothing');

// ---- a fresh device: no bulk download ----
const B = await device('B');
await run(B, async () => (await import('./js/db.js')).deleteDeck('sample'));
await signIn(B, false);
const bHeld = await held(B);
console.log(`   B downloaded ${count('B')} of ${filesOnServer()} pictures (${count('B') * KB} KB of ${filesOnServer() * KB} KB)`);
ok(count('B') === 30 && bHeld.length === 30, `a fresh device fetched only what it will study soon: 10 due + 20 new = ${count('B')}`);
ok(['pic-1', 'pic-10', 'pic-11', 'pic-30'].every(id => bHeld.includes(id)), 'the due cards and the first new cards have their pictures');
ok(!bHeld.includes('pic-31') && !bHeld.includes('pic-55'), 'later new cards and cards not due for a month have none yet');
const mt = await run(B, async () => (await import('./js/db.js')).mediaTotals());
ok(mt.pictures === 30 * 20 * 1024, 'the "on this device" total counts only the files held: ' + mt.pictures);
await syncNow(B); await syncNow(B);
ok(count('B') === 30, 'more syncs fetch nothing more');

// ---- opening a card fetches its picture ----
await run(B, async () => { const db = await import('./js/db.js'); const now = Date.now(); await db.putStates([{ cardId: 'lz31', state: 2, due: now - 10 * 86400000, stability: 5, difficulty: 5, reps: 3, lapses: 0, lastReview: now - 20 * 86400000 }]); });
await B.goto(APP + '#/decks'); await B.goto(APP + '#/review'); await B.waitForSelector('#startBtn'); await B.click('#startBtn');
await B.waitForSelector('.flash-front img.card-img[src^="blob:"]');
ok(downloads.filter(d => d.who === 'B' && d.id === 'pic-31').length === 1, 'the card on screen fetched its own picture, once');
ok(count('B') >= 31 && !downloads.some(d => d.who === 'B' && ['pic-45', 'pic-60', 'pic-55'].includes(d.id)), `and nothing else that is far off (${count('B')} downloads in all)`);
ok((await held(B)).includes('pic-31'), 'the picture is kept on the device for next time');
await B.click('#endBtn').catch(() => {});

// ---- offline: a quiet placeholder, then it fills in when the connection is back ----
await run(B, async () => { const db = await import('./js/db.js'); const now = Date.now(); await db.putStates([{ cardId: 'lz45', state: 2, due: now - 20 * 86400000, stability: 5, difficulty: 5, reps: 3, lapses: 0, lastReview: now - 40 * 86400000 }]); });
await B.goto(APP + '#/decks'); await B.waitForSelector('.deck');
await run(B, () => import('./js/finish-extras.js'));          // (a screen the offline test would otherwise load for the first time)
await B.context().setOffline(true);
const before = count('B');
await B.goto(APP + '#/review'); await B.waitForSelector('#startBtn'); await B.click('#startBtn');
await B.waitForSelector('.flash-front .img-missing');
const alt = await B.textContent('.flash-front .img-missing');
ok(/Picture not downloaded yet\. It will load when you're online/.test(alt), 'offline: the card says so quietly: ' + alt);
ok(count('B') === before, 'and sent no request while offline');
ok(await B.locator('.flash-front .img-missing button.img-retry[aria-label]').count() === 1 && !(await B.$('.flash-front .img-missing[role]')), 'the line has a real Try again button and is not a live region');
await B.screenshot({ path: SP + '/lazy-offline.png' });
await B.click('.flash-front .img-missing', { position: { x: 5, y: 5 } });
await B.waitForSelector('.rate');
ok(true, 'a tap on the placeholder still flips the card');
await B.context().setOffline(false);
await B.waitForSelector('.flash-front img.card-img[src^="blob:"]', { timeout: 15000 });
ok(downloads.some(d => d.who === 'B' && d.id === 'pic-45'), 'back online: the picture loads by itself');
ok(!(await B.$('.flash-front .img-missing')) && await B.isVisible('.flash-front img.card-img'), 'and the placeholder is gone');
await B.click('#endBtn').catch(() => {});

// ---- the sweep and the re-upload ignore files this device never downloaded ----
const marksNow = () => run(B, async () => (await import('./js/db.js')).mediaMarks());
const heldNow = await held(B);
ok(!heldNow.includes('pic-56') && !heldNow.includes('pic-57') && !heldNow.includes('pic-58'), 'set up: B does not hold pic-56, 57, 58');
await run(B, async () => {                       // pic-56: marked a month ago by another device, but a card here uses it
  const m = await import('./js/media-sweep.js'), db = await import('./js/db.js');
  await db.setSetting(m.markKey('pic-56'), Date.now() - 40 * 86400000); await db.setSetting(m.seenKey('pic-56'), Date.now() - 40 * 86400000);
  await db.setSetting(m.markKey('pic-57'), m.GONE);          // pic-57: the account lost it; this device never had it
});
fake.files.delete('user-1/pic-57');
const uploadsBefore = fake.uploads.length;
const st1 = await syncNow(B); await syncNow(B);
ok(fake.files.has('user-1/pic-56'), 'a file a card here uses is not swept just because B lacks it');
ok(!('pic-56' in (await marksNow()).marks), 'and its old mark is cleared (a card uses it)');
ok(fake.uploads.length === uploadsBefore && !fake.files.has('user-1/pic-57'), 'B does not try to send a file it never had');
ok(!st1.note, 'no complaint about files it does not have: ' + st1.note);
const mediaToUpload = await run(B, async () => (await (await import('./js/db.js')).mediaToUpload()).map(m => m.id));
ok(mediaToUpload.length === 0, 'nothing is waiting to be sent from B');
// the card that uses the lost file shows the "isn't in your account" wording, not "will load when online"
await run(B, async () => { const db = await import('./js/db.js'); const now = Date.now(); await db.putStates([{ cardId: 'lz57', state: 2, due: now - 30 * 86400000, stability: 5, difficulty: 5, reps: 3, lapses: 0, lastReview: now - 40 * 86400000 }]); });
await B.goto(APP + '#/decks'); await B.goto(APP + '#/review'); await B.waitForSelector('#startBtn'); await B.click('#startBtn');
await B.waitForSelector('.flash-front .img-missing');
ok(/isn't in your account any more/.test(await B.textContent('.flash-front .img-missing')), 'a file the account no longer has says so: ' + await B.textContent('.flash-front .img-missing'));
await B.click('#endBtn').catch(() => {});

// Re-upload everything: B sends what it holds, and only that
const serverHad = filesOnServer();
fake.files.clear();                                // the server loses every file
const upFrom = fake.uploads.length;
await run(B, async () => { await (await import('./js/sync.js')).resendEverything(); });
await B.waitForTimeout(300); const st2 = await syncNow(B);
const sent = fake.uploads.slice(upFrom).map(u => u.path.replace('user-1/', ''));
const bHeldNow = await held(B);
ok(sent.length === bHeldNow.length && sent.every(id => bHeldNow.includes(id)), `Re-upload sends the ${bHeldNow.length} files B holds and nothing else (${sent.length} sent, ${serverHad} were there)`);
ok(!/lost|missing|full/i.test(st2.note || ''), 'and does not count the others as lost: ' + (st2.note || 'no note'));

// ---- export fetches what is missing first, or says what it could not include ----
// Put the files back on the server (A is the device that has them all).
await run(A, async () => { await (await import('./js/sync.js')).resendEverything(); }); await A.waitForTimeout(300); await syncNow(A);
ok(filesOnServer() === 60, 'set up: A sent its files back: ' + filesOnServer());
const exportBackup = async (p, name) => {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('#exportBtn')]);
  await dl.saveAs(SP + '/' + name);
  return JSON.parse((await import('node:fs')).readFileSync(SP + '/' + name, 'utf8'));
};
await B.goto(APP + '#/decks'); await B.goto(APP + '#/settings'); await B.waitForSelector('#exportBtn');
await B.waitForFunction(() => /will download when a card needs/.test(document.querySelector('#mediaLine')?.textContent || ''));
ok(true, 'Settings says how many pictures are still to download: ' + await B.textContent('#mediaLine'));
// offline: it warns and waits for a second tap
await B.context().setOffline(true);
const heldIdsBeforeExport = await held(B), heldBeforeExport = heldIdsBeforeExport.length;
await B.click('#exportBtn');
await B.waitForFunction(() => /Export without them/.test(document.querySelector('#exportBtn')?.textContent || ''));
ok(/pictures and sounds aren't on this device yet, so they aren't included\. Connect to the internet/.test(await B.textContent('#backupNote')), 'offline: the backup says what is missing: ' + await B.textContent('#backupNote'));
let backup = await exportBackup(B, 'lazy-offline.json');
ok(backup.media.length === heldBeforeExport && backup.media.length < 60, `"Export without them" saves what the device holds (${backup.media.length} pictures)`);
ok(/not included/.test(await B.textContent('#toast')), 'and the toast says some were left out: ' + await B.textContent('#toast'));
// online: it downloads the missing ones, then exports everything
await B.context().setOffline(false);
await B.goto(APP + '#/decks'); await B.goto(APP + '#/settings'); await B.waitForSelector('#exportBtn');
const dlBefore = count('B'), heldIdsNow = await held(B);
backup = await exportBackup(B, 'lazy-online.json');
ok(backup.media.length === 60, `online: it fetches the missing pictures first and the backup has all ${backup.media.length}`);
const fetched = downloads.filter(d => d.who === 'B').slice(dlBefore).map(d => d.id);
ok(fetched.length === 60 - heldIdsNow.length && fetched.every(id => !heldIdsNow.includes(id)), `and downloaded only what was missing (${fetched.length} files; it held ${heldIdsNow.length})`);

// ---- an Anki deck export on a third fresh device ----
const C = await device('C');
await run(C, async () => (await import('./js/db.js')).deleteDeck('sample'));
await signIn(C, false);
const cHeld = (await held(C)).length;
await C.goto(APP + '#/deck/lz'); await C.waitForSelector('.crow');
await deckMenu(C); await C.click('#exportDeck'); await C.waitForSelector('#exApkg');
const [dl] = await Promise.all([C.waitForEvent('download', { timeout: 60000 }), C.click('#exApkg')]);
await dl.saveAs(SP + '/lazy.apkg');
const names = JSON.parse(execFileSync('unzip', ['-p', SP + '/lazy.apkg', 'media']).toString());
ok(Object.keys(names).length === 60, `Anki export fetched the missing pictures first (C held ${cHeld}, the file has ${Object.keys(names).length})`);

// a restore from a backup replaces the cards without delete markers: the list of files cards used is started again
await run(B, async () => { const db = await import('./js/db.js'); await db.setSetting('mediaRefs', { userId: 'x', ids: ['pic-1', 'old-pic'] }); await db.importAll(await db.exportAll()); });
ok(await run(B, async () => (await (await import('./js/db.js')).getSettings()).mediaRefs === undefined), 'a restore (without "everywhere") forgets the list of files cards used, so no file is marked for it');
const D = await device('D');
await run(D, async () => (await import('./js/db.js')).deleteDeck('sample'));
await signIn(D, false);
const dHeld = (await held(D)).length;
const rowsLeftNow = () => fake.userRows('me@example.com').length;
const marksD = () => run(D, async () => (await import('./js/db.js')).mediaMarks());
// ---- a lazy device deletes a card whose picture it never held: the file is still marked, then swept ----
const dHeld0 = await held(D);
ok(!dHeld0.includes('pic-59'), 'set up: D has never held pic-59');
await run(D, async () => { await (await import('./js/db.js')).deleteCards(['lz59']); });
await syncNow(D);
ok('pic-59' in (await marksD()).marks, 'D marks pic-59 for deletion although it never held it');
ok(fake.files.has('user-1/pic-59'), 'and the account keeps it for now');
await run(D, async () => { const m = await import('./js/media-sweep.js'), db = await import('./js/db.js'); await db.setSetting(m.markKey('pic-59'), Date.now() - 31 * 86400000); await db.setSetting(m.seenKey('pic-59'), Date.now() - 31 * 86400000); });
await syncNow(D);
ok(!fake.files.has('user-1/pic-59') && (await marksD()).gone.includes('pic-59'), 'after 30 days it is deleted from the account');

// ---- a bad connection stops a bulk download early ----
let refused = 0;
const refuse = r => { refused++; return r.abort('connectionrefused'); };
await D.context().route(SUPA, refuse);
const dl2 = await run(D, async () => { const r = await (await import('./js/sync.js')).downloadAllMedia(); return { left: r.left.length, got: r.got, reason: r.reason }; });
await D.context().unroute(SUPA, refuse);
ok(dl2.got === 0 && dl2.left > 20 && dl2.reason === 'offline', `no connection: it reports ${dl2.left} files left`);
ok(refused > 0 && refused < 12, `and gave up after ${refused} tries, not one per file`);

// ---- Delete my account: Cancel during its download deletes nothing too ----
const E = await device('E');
await run(E, async () => (await import('./js/db.js')).deleteDeck('sample'));
await signIn(E, false);
const slowE = async r => { await new Promise(ok => setTimeout(ok, 400)); return r.fallback(); };
await E.context().route(SUPA, slowE);
await E.goto(APP + '#/decks'); await E.goto(APP + '#/settings'); await E.waitForSelector('#delAcctBtn'); await E.click('#delAcctBtn'); await E.waitForSelector('#daYes');
await E.fill('#daText', 'DELETE'); await E.click('#daYes');
await E.waitForFunction(() => /Download, then delete/.test(document.querySelector('#daYes')?.textContent || ''));
await E.click('#daYes');
await E.waitForFunction(() => /Saving pictures here first/.test(document.querySelector('#daYes')?.textContent || ''));
await E.click('#daNo');
await E.waitForTimeout(4000);
ok(rowsLeftNow() > 0 && fake.users.has('me@example.com') && (await run(E, async () => !!(await (await import('./js/db.js')).getSettings()).syncAuth)), 'Delete my account: Cancel during the download deletes nothing and stays signed in');
await E.context().unroute(SUPA, slowE);

// ---- Delete my synced data: says what it will do, can be cancelled, offers "anyway", and saves the pictures first ----
const openDelete = async () => { await D.goto(APP + '#/decks'); await D.goto(APP + '#/settings'); await D.waitForSelector('#delServerBtn'); await D.click('#delServerBtn'); await D.waitForSelector('#dsYes'); };
const rowsLeft = () => fake.userRows('me@example.com').length;
await openDelete();
await D.click('#dsYes');
await D.waitForFunction(() => /Download, then delete/.test(document.querySelector('#dsYes')?.textContent || ''));
ok(/first download \d+ pictures and sounds \(about [\d.]+ (KB|MB)\)/.test(await D.textContent('#dsNote')), 'the first tap says how much it will download: ' + await D.textContent('#dsNote'));
ok(rowsLeft() > 0, 'and deletes nothing yet');
await D.context().route(SUPA, refuse);
await D.click('#dsYes');
await D.waitForFunction(() => /Delete anyway/.test(document.querySelector('#dsYes')?.textContent || ''));
ok(/Nothing was deleted|couldn't be downloaded/.test(await D.textContent('#dsNote')) && rowsLeft() > 0, 'offline: it says some could not be saved and offers Delete anyway; nothing deleted');
await D.context().unroute(SUPA, refuse);
await D.click('#sheet .btn.ghost');                                   // Cancel
// cancelling while it downloads (slowed down) deletes nothing
const slow = async r => { await new Promise(ok => setTimeout(ok, 400)); return r.fallback(); };
await D.context().route(SUPA, slow);
await openDelete(); await D.click('#dsYes'); await D.waitForFunction(() => /Download, then delete/.test(document.querySelector('#dsYes')?.textContent || ''));
await D.click('#dsYes');
await D.waitForFunction(() => /Saving pictures here first/.test(document.querySelector('#dsYes')?.textContent || ''));
await D.click('#dsNo');
await D.waitForTimeout(4000);
ok(rowsLeft() > 0 && (await run(D, async () => !!(await (await import('./js/db.js')).getSettings()).syncAuth)), 'Cancel during the download: nothing deleted and still signed in');
await D.context().unroute(SUPA, slow);
// and going through with it saves every picture here first
await openDelete(); await D.click('#dsYes'); await D.waitForFunction(() => /Download, then delete/.test(document.querySelector('#dsYes')?.textContent || ''));
await D.click('#dsYes');
await D.waitForFunction(() => /Your synced data was deleted/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 30000 });
ok(rowsLeft() === 0 && (await held(D)).length >= 59, `after Delete: the server is empty and this device holds ${(await held(D)).length} pictures (it had ${dHeld})`);

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
if (errors.length) process.exitCode = 1;
await browser.close();
