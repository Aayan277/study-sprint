import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
const APP = 'http://localhost:8123/';
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.stack}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|422)|Sync failed|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${name} console ${m.text()}`); });
  await page.goto(APP + '#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const syncNow = page => run(page, async () => { const s = await import('./js/sync.js'); await s.syncNow(); return s.lastStatus(); });
// "Synced" can show between two runs: signing in starts a sync while another one is still going, and syncNow() then queues a second run
// behind it. So wait for the state that matters: keep syncing until a run has nothing left to send or take (everything is on the server).
const settleRaw = page => run(page, async () => {
  const s = await import('./js/sync.js');
  for (let i = 0; i < 10; i++) { await s.syncNow(); const l = s.lastStatus(); if (l.state === 'done' && !l.sent && !l.applied) return l; }
  return s.lastStatus();
});
const settle = async (page, what = 'sign-in') => { const l = await settleRaw(page); ok(l.state === 'done' && !l.sent && !l.applied, `${what}: syncing settled (nothing left to send or take): ${l.state}, sent ${l.sent}, applied ${l.applied}`); };
const snapshot = page => run(page, async () => {
  const db = await import('./js/db.js');
  const [decks, cards, logs, states, settings] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('reviewLog'), db.getAll('cardStates'), db.getSettings()]);
  return { decks: decks.map(d => d.name).sort(), cards: cards.length, cardIds: cards.map(c => c.id), logs: logs.map(l => l.uid), states: Object.fromEntries(states.map(s => [s.cardId, s])), settings, signedIn: !!settings.syncAuth };
});
const openSettings = async page => { await page.goto(APP + '#/decks'); await page.waitForSelector('.deck, .empty'); await page.goto(APP + '#/settings'); await page.waitForSelector('#syncBox > *'); };
const signInUI = async (page, { create = false, email = 'me@example.com', pw = 'secret123' } = {}) => {
  await openSettings(page);
  await page.fill('#syncEmail', email); await page.fill('#syncPw', pw);
  await page.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
};
const waitSynced = page => page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });
const toastText = page => page.textContent('#toast');

// ---- set up: A makes the account, B signs in ----
const A = await device('A');
await run(A, async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#46A758', created: Date.now() }, ['Cell', 'Gene'].map((f, i) => ({ id: `bio-${i}`, deckId: 'bio', front: f, back: f + '!', tags: [], created: Date.now() + i })));
});
await signInUI(A, { create: true }); await waitSynced(A);
const B = await device('B');
await signInUI(B); await waitSynced(B);

// ---- forgot password ----
const C = await device('C');
await openSettings(C);
await C.click('#forgotBtn');
ok((await C.textContent('#syncErr')).includes('Type your email above first'), 'forgot password needs the email first');
await C.fill('#syncEmail', 'me@example.com'); await C.click('#forgotBtn');
await C.waitForSelector('#fpOk');
ok(fake.recoveries.at(-1)?.email === 'me@example.com' && fake.recoveries.at(-1).redirectTo === APP, 'reset email requested, linking back to the app: ' + fake.recoveries.at(-1)?.redirectTo);
await C.screenshot({ path: SP + '/s3-forgot.png' });
await C.click('#fpOk');
// opening the link from the email
await C.goto(fake.recoveryLink('me@example.com', APP));
await C.waitForSelector('#pwForm');
ok(new URL(C.url()).hash === '#/settings', 'the sign-in is taken out of the address');
ok((await C.textContent('#sheet')).includes('Set a new password for me@example.com'), 'the reset sheet names the account');
await C.fill('#pw1', 'newpass456'); await C.fill('#pw2', 'newpass45'); await C.click('button[type=submit][form=pwForm]');
ok((await C.textContent('#pwErr')).includes("don't match"), 'mismatched passwords caught');
await C.screenshot({ path: SP + '/s3-newpw.png' });
const rowsBefore = fake.userRows('me@example.com').length;
await C.fill('#pw2', 'newpass456'); await C.click('button[type=submit][form=pwForm]');
// C has the sample deck and never signed in: the password is set, but it must not sign in and send that deck
await C.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Password saved for me@example.com'));
ok((await toastText(C)).includes('sign in from Settings') && fake.users.get('me@example.com').password === 'newpass456', 'never-synced device with data: password saved, told to sign in from Settings');
{
  const c = await snapshot(C);
  ok(!c.signedIn && !c.settings.syncState && fake.userRows('me@example.com').length === rowsBefore, 'and it is not signed in, nothing was pushed');
}
ok(await run(C, () => sessionStorage.getItem('resetLink')) === null, 'reset link forgotten after use');
// Open a reset link on a page, set the password, and give back the toast it ends with.
const resetVia = async (page, password) => {
  await page.waitForSelector('#toast[hidden]', { state: 'attached' });   // the last toast is gone, so the next one is new
  await page.goto(fake.recoveryLink('me@example.com', APP));
  await page.waitForSelector('#sheet[open] #pwForm');   // the old, closed sheet is still in the page
  await page.fill('#pw1', password); await page.fill('#pw2', password); await page.click('button[type=submit][form=pwForm]');
  await page.waitForSelector('#toast:not([hidden])');
  return toastText(page);
};
// an empty device (no decks, cards or reviews) signs in after the reset and gets the account's data
const E = await device('E');
await run(E, async () => { const db = await import('./js/db.js'); await db.resetAll(); await db.setSetting('seeded', true); });   // seeded: the sample deck doesn't come back
ok((await resetVia(E, 'emptypass1')).includes("You're signed in"), 'empty device: password saved and signed in');
await waitSynced(E);
ok((await snapshot(E)).decks.includes('Biology'), 'and it synced the account\'s data');
// a device already signed in as that account stays signed in
ok((await resetVia(E, 'emptypass2')).includes("You're signed in") && (await snapshot(E)).signedIn, 'same account already signed in: still signed in');
// a device that last synced as that account (signed out since) signs in again, even with data
await run(E, async () => (await import('./js/sync.js')).signOut({}));
ok((await resetVia(E, 'newpass456')).includes("You're signed in") && (await snapshot(E)).signedIn, 'device that last synced as that account: signed in again');
// now sign C in the normal way, so the rest of this test has a device signed in as me
await signInUI(C, { pw: 'newpass456' }); await waitSynced(C);
ok((await snapshot(C)).decks.includes('Biology'), 'C signed in from Settings and synced');
await C.goto(APP + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
await C.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('expired'));
ok(new URL(C.url()).hash === '#/settings', 'an expired link is explained');
// the link's own error text is never shown
await C.goto(APP + '#error=server_error&error_description=Visit+evil.example+to+fix+this');
await C.waitForFunction(() => document.querySelector('#toast')?.textContent.includes("didn’t work"));
ok(!(await toastText(C)).includes('evil'), 'text from the link is not displayed');
// a link for another account is refused while this device is signed in to a different one
const X = await device('X');
await run(X, async () => { const s = await import('./js/sync.js'); await s.createAccount('other@example.com', 'secret123'); });
await C.goto(fake.recoveryLink('other@example.com', APP));
await C.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('other@example.com'));
ok((await toastText(C)).includes('signed in as me@example.com') && !(await C.isVisible('#pwForm')), 'a link for a different account is refused, with no password form');
ok(fake.users.get('other@example.com').password === 'secret123' && (await run(C, async () => (await (await import('./js/sync.js')).account()).email)) === 'me@example.com', 'nothing changed: still signed in as me@example.com');
// change password while signed in
await openSettings(C);
await C.click('#pwBtn'); await C.fill('#pw1', 'changed789'); await C.fill('#pw2', 'changed789'); await C.click('button[type=submit][form=pwForm]');
await C.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Password changed');
ok(fake.users.get('me@example.com').password === 'changed789', 'change password while signed in');

// ---- same card reviewed offline on two devices ----
await syncNow(A); await syncNow(B);
fake.setDown(true);
await run(A, async () => { const db = await import('./js/db.js'); await db.saveReview({ cardId: 'bio-0', due: Date.now() + 2 * 86400000, stability: 2, difficulty: 5, reps: 1, lapses: 0, state: 2 }, { cardId: 'bio-0', timestamp: Date.now(), source: 'review', rating: 3, correct: true, state: 0 }); });
await new Promise(r => setTimeout(r, 30));
await run(B, async () => { const db = await import('./js/db.js'); await db.saveReview({ cardId: 'bio-0', due: Date.now() + 5 * 86400000, stability: 5, difficulty: 4, reps: 1, lapses: 0, state: 2 }, { cardId: 'bio-0', timestamp: Date.now(), source: 'review', rating: 4, correct: true, state: 0 }); });
fake.setDown(false);
await syncNow(A); await syncNow(B); await syncNow(A);
let a = await snapshot(A), b = await snapshot(B);
ok(a.logs.length === 2 && b.logs.length === 2 && a.states['bio-0'].stability === 5 && b.states['bio-0'].stability === 5, 'reviewed offline on both: both answers kept, the newest schedule wins');

// ---- restore a backup while signed in ----
const backup = await run(A, async () => (await import('./js/db.js')).exportAll());
await run(B, async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'chem', name: 'Chemistry', color: '#3E63DD', created: Date.now() }, [{ id: 'chem-0', deckId: 'chem', front: 'Atom', back: 'a', tags: [], created: Date.now() }]); });
await syncNow(B); await syncNow(A);
ok((await snapshot(A)).decks.includes('Chemistry'), 'A got Chemistry before the restore');
await openSettings(A);
const file = SP + '/backup-a.json';
(await import('node:fs')).writeFileSync(file, JSON.stringify(backup));
await A.setInputFiles('#importIn', file);
await A.waitForSelector('#rbYes');
ok((await A.textContent('#sheet')).includes('and in your sync account too'), 'restore explains it replaces the account too');
await A.click('#rbYes'); await A.waitForSelector('.deck');
await A.waitForTimeout(500); await syncNow(A); await syncNow(B);
a = await snapshot(A); b = await snapshot(B);
ok(!a.decks.includes('Chemistry') && !b.decks.includes('Chemistry') && b.decks.includes('Biology'), 'restored everywhere: Chemistry (not in the backup) is gone from B too');
ok(a.signedIn, 'still signed in after restoring');

// ---- sign out: keep, and remove with unsynced changes ----
await openSettings(B);
await B.click('#signOutBtn'); await B.waitForFunction(() => document.querySelector('#soNote')?.textContent.includes('Everything here is synced'));
await B.screenshot({ path: SP + '/s3-signout.png' });
await B.click('#soKeep'); await B.waitForSelector('#syncEmail');
b = await snapshot(B);
ok(!b.signedIn && b.decks.includes('Biology'), 'sign out, keep: data stays');
await signInUI(B, { pw: 'changed789' }); await waitSynced(B); await settle(B);
fake.setDown(true);
await run(B, async () => { const db = await import('./js/db.js'); const c = await db.get('cards', 'bio-1'); await db.saveCards([{ ...c, back: 'offline edit' }]); });
await openSettings(B);
await B.click('#signOutBtn'); await B.waitForFunction(() => /couldn't sync yet/.test(document.querySelector('#soNote')?.textContent || ''));
await B.click('#soRemove');
await B.waitForFunction(() => /synced yet and would be lost/.test(document.querySelector('#soNote')?.textContent || ''), null, { timeout: 5000 }).then(() => ok(true, 'removing with unsynced changes warns first'), () => ok(false, 'removing with unsynced changes warns first'));
await B.click('#soRemove'); await B.waitForSelector('.deck');
b = await snapshot(B);
ok(!b.signedIn && b.decks.join() === 'Intro to Psychology (sample)' && !b.settings.syncState, 'second tap: signed out and this device is fresh');
fake.setDown(false);

// ---- stale warning ----
await run(A, async () => { const db = await import('./js/db.js'); const s = await db.getSettings(); await db.setSetting('syncState', { ...s.syncState, lastSync: Date.now() - 5 * 86400000 }); });
fake.setDown(true);
await A.goto(APP + '#/decks'); await A.waitForSelector('.deck');
await syncNow(A);
await A.waitForFunction(() => document.querySelector('#toast')?.textContent.includes("hasn't worked for 5 days"), null, { timeout: 5000 }).then(() => ok(true, 'warns when sync has failed for days'), () => ok(false, 'warns when sync has failed for days'));
fake.setDown(false);

// ---- reset everywhere ----
await signInUI(B, { pw: 'changed789' }); await waitSynced(B); await settle(B);
await run(A, async () => (await import('./js/db.js')).setSetting('newPerDay', 40));
await syncNow(A); await syncNow(B);
ok((await snapshot(B)).settings.newPerDay === 40, 'B has newPerDay 40 before the reset');
await openSettings(A);
await A.click('#dangerZone > summary'); await A.click('#resetBtn'); await A.waitForSelector('#rsAll');
await A.screenshot({ path: SP + '/s3-reset.png' });
await A.click('#rsAll'); await A.waitForSelector('.empty, .deck');
await syncNow(B);
a = await snapshot(A); b = await snapshot(B);
ok(a.decks.length === 0 && a.cards === 0 && a.signedIn, 'reset everywhere: A is empty and still signed in');
ok(b.decks.length === 0 && b.cards === 0 && b.logs.length === 0 && b.settings.newPerDay === 20, 'and B is emptied too, settings back to defaults');

// ---- delete synced data, reset just this device ----
await run(B, async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'geo', name: 'Geography', color: '#46A758', created: Date.now() }, []); });
await syncNow(B);
ok(fake.userRows('me@example.com').length > 0, 'server has rows');
await openSettings(B);
await B.click('#delServerBtn'); await B.click('#dsYes'); await B.waitForSelector('#syncEmail');
b = await snapshot(B);
ok(fake.userRows('me@example.com').length === 0 && !b.signedIn && b.decks.includes('Geography'), 'delete synced data: server empty, B signed out, B keeps its copy');
await signInUI(B, { pw: 'changed789' }); await waitSynced(B); await settle(B);
ok(fake.userRows('me@example.com').some(r => r.store === 'decks' && r.id === 'geo'), 'signing in again sends this device\'s data back up');
// A deck that came from another device (A) must be sent again too, not only B's own
await run(A, async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'hist', name: 'History', color: '#46A758', created: Date.now() }, [{ id: 'hist-0', deckId: 'hist', front: 'Rome', back: 'x', tags: [], created: Date.now() }]); });
await syncNow(A); await syncNow(B);
ok((await snapshot(B)).decks.includes('History'), 'B pulled the History deck from A');
await openSettings(B);
await B.click('#delServerBtn'); await B.click('#dsYes'); await B.waitForSelector('#syncEmail');
ok(fake.userRows('me@example.com').length === 0, 'server emptied again');
await signInUI(B, { pw: 'changed789' }); await waitSynced(B); await settle(B);
ok(fake.userRows('me@example.com').some(r => r.store === 'decks' && r.id === 'hist') && fake.userRows('me@example.com').some(r => r.store === 'cards' && r.id === 'hist-0'),
  'signing in again also re-sends a deck and card that came from another device');
await openSettings(B);
await B.click('#dangerZone > summary'); await B.click('#resetBtn'); await B.click('#rsHere'); await B.waitForSelector('.deck');
b = await snapshot(B);
ok(!b.signedIn && b.decks.join() === 'Intro to Psychology (sample)' && fake.userRows('me@example.com').some(r => r.id === 'geo' && !r.deleted), 'reset just this device: B fresh and signed out, account untouched');

// ---- progress on a big first sync ----
const D = await device('D');
await run(D, async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'big', name: 'Big', color: '#46A758', created: Date.now() }, Array.from({ length: 1200 }, (_, i) => ({ id: `big-${i}`, deckId: 'big', front: `Q${i}`, back: `A${i}`, tags: [], created: Date.now() + i })));
  window.__progress = [];
  addEventListener('sync', e => { if (e.detail.progress) window.__progress.push(e.detail.progress); });
});
await signInUI(D, { pw: 'changed789' }); await waitSynced(D); await settle(D);
const progress = await run(D, () => window.__progress);
ok(progress.some(p => /^Sending \d[\d,]* of 1,2\d\d changes/.test(p)), 'progress shown while sending a big first sync: ' + progress.slice(0, 2).join(' | '));

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
