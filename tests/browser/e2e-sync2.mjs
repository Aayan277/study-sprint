import { chromium } from './pw.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const SP = process.argv[2];
const browser = await chromium.launch();
const fake = fakeSupabase();
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const errors = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, serviceWorkers: 'block' });
  await ctx.route('https://lakxeftzlpvydzulxrbi.supabase.co/**', fake.handle);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} pageerror ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|422)/.test(m.text())) errors.push(`${name} console ${m.text()}`); });   // 400/422: the deliberate wrong-password tries
  await page.goto('http://localhost:8123/#/decks'); await page.waitForSelector('.deck');
  return page;
}
const run = (page, fn, arg) => page.evaluate(fn, arg);
const syncNow = page => run(page, async () => { await (await import('./js/sync.js')).syncNow(); return (await import('./js/sync.js')).lastStatus(); });
const snapshot = page => run(page, async () => {
  const db = await import('./js/db.js');
  const [decks, cards, states, logs, settings] = await Promise.all([db.getDecks(), db.getAll('cards'), db.getAll('cardStates'), db.getAll('reviewLog'), db.getSettings()]);
  return { decks: decks.map(d => d.name).sort(), deckIds: decks.map(d => d.id), cards: Object.fromEntries(cards.map(c => [c.id, c])), states: Object.fromEntries(states.map(s => [s.cardId, s])), logs: logs.map(l => l.uid), settings };
});
const signInUI = async (page, { create = false, email = 'me@example.com', pw = 'secret123' } = {}) => {
  await page.goto('http://localhost:8123/#/settings'); await page.waitForSelector('#syncEmail');
  await page.fill('#syncEmail', email); await page.fill('#syncPw', pw);
  await page.click(create ? '#syncCreate' : '#syncForm button[type=submit]');
};
const waitSynced = page => page.waitForFunction(() => /^Synced/.test(document.querySelector('#syncStatus')?.textContent || ''), null, { timeout: 15000 });

// ---- device A: study, then create the account ----
const A = await device('A');
const bio = await run(A, async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'bio', name: 'Biology', color: '#46A758', created: Date.now() },
    ['Cell', 'Gene', 'Enzyme'].map((f, i) => ({ id: `bio-${i}`, deckId: 'bio', front: f, back: f + '!', tags: [], created: Date.now() + i })));
  await db.saveReview({ cardId: 'bio-0', due: Date.now() + 86400000, stability: 2, difficulty: 5, reps: 1, lapses: 0, state: 2 }, { cardId: 'bio-0', timestamp: Date.now(), source: 'review', rating: 3, correct: true, state: 0 });
  await db.setSetting('newPerDay', 30);
  await db.setSetting('theme', { skin: 'sage', mode: 'dark' });
  return true;
});
await signInUI(A, { create: true });
await waitSynced(A);
let server = fake.userRows('me@example.com');
const count = store => server.filter(r => r.store === store && !r.deleted).length;
ok(count('decks') === 2 && count('cards') === 15 && count('cardStates') === 1 && count('reviewLog') === 1, `A's data reached the server (${count('decks')} decks, ${count('cards')} cards)`);
ok(server.some(r => r.store === 'settings' && r.id === 'newPerDay' && r.data.value === 30) && !server.some(r => r.id === 'theme'), 'study settings synced, theme not');
ok(server.every(r => r.store !== 'reviewLog' || !('id' in r.data)), "review rows don't carry the local counter");
ok(await A.isVisible('#signOutBtn') && (await A.textContent('#syncBox')).includes('me@example.com'), 'Settings shows the account');
await A.screenshot({ path: SP + '/sync-signedin.png', fullPage: true });

// ---- device B: its own deck, wrong password, then sign in ----
const B = await device('B');
await run(B, async () => {
  const db = await import('./js/db.js');
  await db.addDeckWithCards({ id: 'chem', name: 'Chemistry', color: '#3E63DD', created: Date.now() }, [{ id: 'chem-0', deckId: 'chem', front: 'Atom', back: 'Smallest unit', tags: [], created: Date.now() }]);
});
await signInUI(B, { pw: 'wrongpass' });
await B.waitForSelector('#syncErr:not([hidden])');
ok((await B.textContent('#syncErr')) === 'Wrong email or password.', 'wrong password explained');
await B.screenshot({ path: SP + '/sync-signin.png', fullPage: true });
await B.fill('#syncPw', 'secret123'); await B.click('#syncCreate');
await B.waitForFunction(() => document.querySelector('#syncErr')?.textContent.includes('already an account'));
ok(true, 'creating the same account twice explained');
await B.click('#syncForm button[type=submit]');
await waitSynced(B);
let b = await snapshot(B);
ok(b.decks.join('|') === 'Biology|Chemistry|Intro to Psychology (sample)', 'B merged: both devices\' decks, one sample deck: ' + b.decks.join('|'));
ok(Object.keys(b.cards).length === 16 && b.states['bio-0']?.stability === 2 && b.logs.length === 1, 'B got the cards, schedule and review history');
ok(b.settings.newPerDay === 30 && b.settings.theme.skin === 'violet', 'B got newPerDay, kept its own theme');
await B.waitForFunction(() => document.querySelector('#npd')?.value === '30');
ok(await B.inputValue('#npd') === '30' && (await B.textContent('#whereNote')).includes('synced to your account'), 'B\'s Settings screen shows the synced value and the synced note');
let a = await snapshot(A);
await syncNow(A); a = await snapshot(A);
ok(a.decks.includes('Chemistry') && a.cards['chem-0'], 'A got B\'s deck');

// ---- conflicts and deletes ----
await run(A, async () => { const db = await import('./js/db.js'); const c = await db.get('cards', 'bio-0'); await db.saveCards([{ ...c, back: 'A edit' }]); });
await new Promise(r => setTimeout(r, 30));
await run(B, async () => { const db = await import('./js/db.js'); const c = await db.get('cards', 'bio-0'); await db.saveCards([{ ...c, back: 'B edit' }]); });
await syncNow(A); await syncNow(B); await syncNow(A);
a = await snapshot(A); b = await snapshot(B);
ok(a.cards['bio-0'].back === 'B edit' && b.cards['bio-0'].back === 'B edit', 'same card edited on both: the newest edit wins everywhere');

await run(B, async () => (await import('./js/db.js')).deleteCards(['bio-1']));
await new Promise(r => setTimeout(r, 30));
await run(A, async () => { const db = await import('./js/db.js'); const c = await db.get('cards', 'bio-1'); await db.saveCards([{ ...c, back: 'edited after the delete' }]); });
await syncNow(B); await syncNow(A); await syncNow(B);
a = await snapshot(A); b = await snapshot(B);
ok(a.cards['bio-1']?.back === 'edited after the delete' && b.cards['bio-1']?.back === 'edited after the delete', 'edited on A after B deleted it: the edit wins');

await run(A, async () => (await import('./js/db.js')).deleteCards(['bio-2']));
await run(A, async () => (await import('./js/db.js')).deleteDeck('sample'));
await syncNow(A); await syncNow(B);
b = await snapshot(B);
ok(!b.cards['bio-2'] && !b.decks.includes('Intro to Psychology (sample)') && !Object.keys(b.cards).some(id => id.startsWith('sample-')), 'deletes on A reach B (a card, and the sample deck with its cards)');

// ---- reviews, undo and settings ----
const undone = await run(B, async () => {
  const db = await import('./js/db.js');
  await db.saveReview({ cardId: 'chem-0', due: Date.now() + 3 * 86400000, stability: 3, difficulty: 4, reps: 1, lapses: 0, state: 2 }, { cardId: 'chem-0', timestamp: Date.now(), source: 'review', rating: 4, correct: true, state: 0 });
  const id = await db.saveReview({ cardId: 'bio-0', due: Date.now(), stability: 1, difficulty: 6, reps: 2, lapses: 1, state: 3 }, { cardId: 'bio-0', timestamp: Date.now(), source: 'review', rating: 1, correct: false, state: 2 });
  const uid = (await db.getAll('reviewLog')).find(l => l.id === id).uid;
  const prev = { cardId: 'bio-0', due: Date.now() + 86400000, stability: 2, difficulty: 5, reps: 1, lapses: 0, state: 2 };
  await db.undoReview('bio-0', prev, id);
  return uid;
});
await syncNow(B); await syncNow(A);
a = await snapshot(A);
ok(a.states['chem-0']?.stability === 3 && a.logs.length === 2 && !a.logs.includes(undone), `B's review reached A, the undone one didn't (${a.logs.length} reviews)`);
ok(a.states['bio-0'].lapses === 0, 'undo reached A too (schedule put back)');

// automatic sync a few seconds after a change (no Sync now)
const before = fake.log.length;
await run(B, async () => (await import('./js/db.js')).setSetting('leechThreshold', 5));
await new Promise(r => setTimeout(r, 6000));
server = fake.userRows('me@example.com');
ok(fake.log.length > before && server.some(r => r.id === 'leechThreshold' && r.data.value === 5), 'changes sync by themselves a few seconds later');
await syncNow(A); a = await snapshot(A);
ok(a.settings.leechThreshold === 5, 'A got the new setting');

// the screen updates when changes arrive
await B.goto('http://localhost:8123/#/decks'); await B.waitForSelector('.deck');
await run(A, async () => { const db = await import('./js/db.js'); await db.addDeckWithCards({ id: 'phys', name: 'Physics', color: '#F76B15', created: Date.now() }, []); });
await syncNow(A); await syncNow(B);
await B.waitForFunction(() => document.querySelector('#screen').textContent.includes('Physics'), null, { timeout: 5000 }).then(() => ok(true, 'B\'s deck list redraws when changes arrive'), () => ok(false, 'B\'s deck list redraws when changes arrive'));

// ---- sign-in that expired, offline, sign out ----
await run(A, async () => { const db = await import('./js/db.js'); const s = await db.getSettings(); await db.setSetting('syncAuth', { ...s.syncAuth, expires_at: 1 }); });
let st = await syncNow(A);
ok(st.state === 'done' && fake.log.some(l => l.includes('grant_type=refresh_token')), 'an expired sign-in is refreshed automatically');

await A.goto('http://localhost:8123/#/settings'); await A.waitForSelector('#syncStatus');
fake.setDown(true);
const errCount = errors.length;
await A.click('#syncNowBtn');
await A.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith("Couldn't sync"));
ok((await A.textContent('#syncStatus')).includes("Couldn't reach the sync server"), 'offline/paused server explained: ' + await A.textContent('#syncStatus'));
errors.splice(errCount);   // the expected "Sync failed" console errors
fake.setDown(false);
await A.click('#syncNowBtn'); await waitSynced(A);
ok(true, 'syncs again once the server is back');

const decksBefore = (await snapshot(A)).decks;
await A.click('#signOutBtn'); await A.click('#soKeep'); await A.waitForSelector('#syncEmail');
ok((await snapshot(A)).decks.join() === decksBefore.join(), 'signing out keeps this device\'s data');
await signInUI(A); await waitSynced(A);
a = await snapshot(A); b = await snapshot(B);
ok(a.decks.join() === decksBefore.join() && Object.keys(a.cards).length === Object.keys(b.cards).length, 'signing back in: no duplicates');
ok(!fake.log.some(l => false) && !errors.some(e => e.includes('cannot affect row a second time')), 'no conflicting rows sent');

// ---- a third device with nothing on it ----
const C = await device('C');
await signInUI(C); await waitSynced(C);
const c = await snapshot(C);
ok(c.decks.join() === b.decks.join() && !c.decks.includes('Intro to Psychology (sample)'), 'a new device gets everything, and its fresh sample deck loses to the delete: ' + c.decks.join('|'));
ok(c.logs.length === a.logs.length && c.settings.leechThreshold === 5, 'history and settings too');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
